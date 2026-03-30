/**
 * A2A Server Lifecycle Management Module
 * 
 * Handles process spawning, stdout readiness detection, stderr auth error parsing,
 * exit event handling, ring buffer diagnostics, concurrent startup lock, and
 * search counter with forced restart at 1000 searches.
 * 
 * Supports provider-specific configuration:
 * - Custom workspace path (default: ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace)
 * - Non-YOLO mode (GEMINI_YOLO_MODE not set by default)
 * - Patch verification before reuse of existing servers
 */

import { spawn, type ChildProcess, exec } from 'node:child_process';
import { openSync } from 'node:fs';
import { promisify } from 'node:util';
import type { A2AServerState, SearchError } from './types.js';
import { getA2APackageRoot } from './a2a-path.js';
import { checkA2APatched, checkA2AInjectResultPatched, checkA2APendingToolAbortPatched, checkA2AToolCompletionNotifierPatched } from './availability.js';
import { isPortInUse, isServerHealthy } from './port-check.js';
import { debugLog } from './logger.js';
import { resolveWorkspacePath } from './workspace-generator.js';

const execAsync = promisify(exec);

/**
 * Gets the PID of the process listening on a given port.
 * Uses lsof to find the process.
 * 
 * @param port - Port number to check
 * @returns PID or null if not found
 */
async function getPidFromPort(port: number): Promise<number | null> {
  try {
    const { stdout } = await execAsync(`lsof -ti :${port}`);
    const pid = parseInt(stdout.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * A2A server startup configuration.
 */
export interface A2AStartupConfig {
  /**
   * Workspace path for A2A server.
   * Default: ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace
   */
  workspacePath?: string;
  /**
   * Whether to enable YOLO mode (GEMINI_YOLO_MODE=1).
   * Default: false (non-YOLO mode for provider safety)
   */
  yoloMode?: boolean;
  /**
   * Port number for A2A server.
   * Default: 41242
   */
  port?: number;
}

// ============================================================================
// Constants
// ============================================================================

const A2A_PORT = 41242;
const STARTUP_TIMEOUT_MS = 30000; // 30s timeout (12s boot + generous margin)
const RING_BUFFER_MAX = 50;
const TASK_COUNT_RESTART_THRESHOLD = 1000;
// Readiness now detected via health check polling, not stdout marker

// ============================================================================
// State
// ============================================================================

/** Singleton state machine */
let serverState: A2AServerState = {
  status: 'idle',
  port: A2A_PORT,
  uptime: null,
  searchCount: 0,
  providerTaskCount: 0,
  lastError: null,
  exitCode: null,
  stdoutBuffer: [],
  stderrBuffer: [],
};

/** Child process reference */
let childProcess: ChildProcess | null = null;

/** Start time for uptime calculation */
let startTime: number | null = null;

/** Concurrent startup lock - prevents duplicate spawns */
let startupPromise: Promise<void> | null = null;

/** Uptime timer reference */
let uptimeTimer: NodeJS.Timeout | null = null;

/** Health check interval reference (for reused servers) */
let healthCheckInterval: NodeJS.Timeout | null = null;

/** Manual stop flag - prevents health monitor from respawning intentionally stopped servers */
let manualStop = false;

// ============================================================================
// Ring Buffer Implementation
// ============================================================================

/**
 * Pushes a line to a ring buffer, maintaining max length.
 * When buffer exceeds max length, oldest item is removed.
 */
function pushToRingBuffer(buffer: string[], line: string, maxLength: number = RING_BUFFER_MAX): void {
  buffer.push(line);
  while (buffer.length > maxLength) {
    buffer.shift();
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Logs a debug message (hidden unless GCS_DEBUG=1, writes to file)
 */
function log(message: string): void {
  debugLog('lifecycle', message);
}

/**
 * Creates a SearchError object
 */
function createSearchError(type: SearchError['type'], message: string): SearchError {
  return { type, message };
}

/**
 * Updates server state atomically
 */
function updateState(updates: Partial<A2AServerState>): void {
  serverState = { ...serverState, ...updates };
}

/**
 * Clears the uptime timer if running
 */
function clearUptimeTimer(): void {
  if (uptimeTimer) {
    clearInterval(uptimeTimer);
    uptimeTimer = null;
  }
}

/**
 * Clears the health check interval if running
 */
function clearHealthCheckInterval(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    log('Health check interval cleared');
  }
}

/**
 * Starts periodic health monitoring for reused servers.
 * Checks every 30s, respawns if health check fails (unless manually stopped).
 */
function startHealthMonitoring(): void {
  // Clear any existing health check
  clearHealthCheckInterval();
  
  // Start health check interval (30s)
  healthCheckInterval = setInterval(async () => {
    try {
      const healthy = await isServerHealthy(A2A_PORT);
      
      if (!healthy) {
        // Check if server was manually stopped
        if (manualStop) {
          log('Health check failed but server was manually stopped, skipping respawn');
          clearHealthCheckInterval();
          clearUptimeTimer();
          updateState({ 
            status: 'stopped',
            uptime: null,
          });
          return;
        }
        
        log('Health check failed: server no longer responding, respawning...');
        
        // Clear health check to prevent multiple concurrent checks
        clearHealthCheckInterval();
        clearUptimeTimer();
        
        // Update state to stopped
        updateState({ 
          status: 'stopped',
          uptime: null,
        });
        
        // Reset child process reference (it was already null for reused server)
        childProcess = null;
        startTime = null;
        
        // Immediately respawn - this will spawn a new process with full monitoring
        try {
          await startServer();
          log('Server respawned successfully after health check failure');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`Server respawn failed: ${message}`);
          updateState({ 
            status: 'error',
            lastError: createSearchError('A2A_RESPAWN_FAILED', `Respawn after health check failure failed: ${message}`)
          });
        }
      } else {
        log('Health check passed');
      }
    } catch (err) {
      // Health check itself failed (network error, etc.) - treat as unhealthy
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, 30000); // 30 seconds
  
  log('Health monitoring started (30s interval)');
}

// ============================================================================
// Core Lifecycle Functions
// ============================================================================

/**
 * Starts the A2A server with fire-and-forget auto-start behavior.
 * 
 * Implements:
 * - Concurrent startup lock (rejects if already starting/running)
 * - Patch verification before spawn
 * - Stdout readiness detection ("Agent Server started" marker)
 * - Stderr auth error parsing (FatalAuthenticationError, Interactive terminal required)
 * - 5s timeout for readiness
 * - Exit event handling with code capture
 * - Ring buffer diagnostics (last 50 stdout/stderr lines)
 * - Provider-specific workspace path and YOLO mode configuration
 * - Reuse of existing servers with patch verification
 * 
 * @param config - Optional startup configuration (workspace path, YOLO mode, port)
 * @returns Promise that resolves when server is running, rejects on error
 */
export async function startServer(config?: A2AStartupConfig): Promise<void> {
  // Clear manual stop flag (intentional start)
  manualStop = false;
  
  // Resolve configuration
  const workspacePath = resolveWorkspacePath({ workspacePath: config?.workspacePath });
  const yoloMode = config?.yoloMode ?? false;
  const port = config?.port ?? A2A_PORT;
  
  // Check if there's an ongoing startup promise (concurrent lock)
  if (startupPromise) {
    log('Waiting for ongoing startup to complete');
    return startupPromise;
  }
  
  // Check concurrent lock - reject if already running (but not starting - that's handled by promise)
  if (serverState.status === 'running') {
    log('Server already running, rejecting duplicate start request');
    throw createSearchError('SEARCH_FAILED', 'Server is already running');
  }

  // Fix 10: Check for existing A2A server before spawning
  log(`Checking for existing A2A server on port ${port}...`);
  
  // Health check first - authoritative test for A2A server
  const healthy = await isServerHealthy(port);
  if (healthy) {
    log('Port check result: Healthy A2A server detected, reusing existing server');
    
    // Capture the PID of the reused server so stopServer() can kill it
    const reusedPid = await getPidFromPort(port);
    if (reusedPid) {
      log(`Captured PID ${reusedPid} for reused server`);
      // Store in a way that stopServer can access - we'll use childProcess even though we didn't spawn it
      // This allows stopServer() to work correctly
      childProcess = { pid: reusedPid } as import('child_process').ChildProcess;
    } else {
      log('Warning: Could not capture PID for reused server - manual stop may fail');
    }
    
    // Verify required patches are present before reusing
    const packageRoot = getA2APackageRoot();
    if (packageRoot) {
      const serverPath = packageRoot + '/dist/a2a-server.mjs';
      const hasPatch2 = checkA2APatched(serverPath);
      const hasPatch3 = checkA2AInjectResultPatched();
      const hasPatch4 = checkA2APendingToolAbortPatched(serverPath);
      const hasPatch5 = checkA2AToolCompletionNotifierPatched(serverPath);

      if (!hasPatch2 || !hasPatch3 || !hasPatch4 || !hasPatch5) {
        log(`Warning: Reusing server but patches missing (Patch2: ${hasPatch2}, Patch3: ${hasPatch3}, Patch4: ${hasPatch4}, Patch5: ${hasPatch5})`);
      } else {
        log('Required patches (Patch 2-5) verified on running server');
      }
    }
    
    // Mark as running without spawning
    startTime = Date.now();
    updateState({ 
      status: 'running',
      uptime: 0,
    });
    
    // Start uptime timer
    uptimeTimer = setInterval(() => {
      if (startTime && serverState.status === 'running') {
        updateState({ uptime: Date.now() - startTime });
      }
    }, 1000);
    
    // Start health monitoring for reused server (no childProcess to monitor)
    startHealthMonitoring();
    
    return; // Reuse existing server
  }
  
  // Health check failed, but port might still be in use by foreign process
  const portInUse = await isPortInUse(port);
  log(`Port check result: Port ${portInUse ? 'IN USE' : 'available'}`);
  
  if (portInUse) {
    log(`Port ${port} is in use but server is not healthy. User should kill the process manually.`);
    throw createSearchError('A2A_PORT_CONFLICT', `Port ${port} is already in use by another process. Please kill the process using this port and retry.`);
  }

  // Create startup promise for concurrent lock
  startupPromise = (async () => {
    try {
      log('Starting A2A server...');
      updateState({ status: 'starting', lastError: null, exitCode: null });

      // Verify patches and get bundle path
      const packageRoot = getA2APackageRoot();
      const serverPath = packageRoot + '/dist/a2a-server.mjs';
      
      if (!checkA2APatched(serverPath)) {
        throw createSearchError('A2A_NOT_PATCHED', `A2A patch not found at ${serverPath}`);
      }
      
      if (!checkA2AInjectResultPatched()) {
        throw createSearchError('A2A_INJECT_RESULT_NOT_PATCHED', 'inject_result patch not found in A2A bundle');
      }

      if (!checkA2APendingToolAbortPatched(serverPath)) {
        throw createSearchError('A2A_PENDING_TOOL_ABORT_NOT_PATCHED', 'pending-tool abort preservation patch not found in A2A bundle');
      }

      if (!checkA2AToolCompletionNotifierPatched(serverPath)) {
        throw createSearchError('A2A_TOOL_COMPLETION_NOTIFIER_NOT_PATCHED', 'toolCompletionNotifier patch not found in A2A bundle');
      }

      // Spawn fully detached: stdio to log files, no pipes to parent.
      // This ensures the server survives parent GSD exit — open pipes
      // keep a parent-child link that delivers SIGHUP on exit.
      const debug = process.env.GCS_DEBUG === '1';
      const stdoutFd = openSync(debug ? '/tmp/a2a-server-stdout.log' : '/dev/null', 'w');
      const stderrFd = openSync(debug ? '/tmp/a2a-server-stderr.log' : '/dev/null', 'w');

      childProcess = spawn('node', [serverPath], {
        stdio: ['ignore', stdoutFd, stderrFd],
        detached: true,
        env: {
          ...process.env,
          USE_CCPA: '1',
          CODER_AGENT_PORT: String(port),
          CODER_AGENT_WORKSPACE_PATH: workspacePath,
          ...(yoloMode ? { GEMINI_YOLO_MODE: 'true' } : {}),
        },
      });

      // Fully detach — no pipes, no exit handler, no reference.
      childProcess.unref();
      log(`Spawned server PID ${childProcess.pid}, polling for readiness...`);

      // Poll health endpoint until ready or timeout
      const startWait = Date.now();
      let ready = false;
      while (Date.now() - startWait < STARTUP_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, 500));
        if (await isServerHealthy(port)) {
          ready = true;
          break;
        }
      }

      if (!ready) {
        // Server didn't start — kill it
        try { process.kill(childProcess.pid!, 'SIGKILL'); } catch { /* already dead */ }
        childProcess = null;
        updateState({
          status: 'error',
          lastError: createSearchError('A2A_STARTUP_TIMEOUT', `Server did not start within ${STARTUP_TIMEOUT_MS}ms`),
        });
        throw createSearchError('A2A_STARTUP_TIMEOUT', `Server did not start within ${STARTUP_TIMEOUT_MS}ms`);
      }

      // Mark as running
      startTime = Date.now();
      updateState({ status: 'running', uptime: 0 });

      // Start uptime timer
      uptimeTimer = setInterval(() => {
        if (startTime && serverState.status === 'running') {
          updateState({ uptime: Date.now() - startTime });
        }
      }, 1000);

      log(`Server is now running (detached, PID ${childProcess.pid})`);
      
    } catch (error) {
      // Update state to error
      updateState({ 
        status: 'error',
        lastError: error as SearchError
      });
      
      // Clean up on error
      clearUptimeTimer();
      if (childProcess && childProcess.pid) {
        childProcess.kill('SIGKILL');
      }
      childProcess = null;
      throw error;
    } finally {
      // Release concurrent lock
      startupPromise = null;
    }
  })();

  return startupPromise;
}

/**
 * Stops the A2A server gracefully.
 * 
 * Sends SIGTERM first, then SIGKILL if needed.
 * Updates state to 'stopped' with null exitCode (graceful stop).
 * 
 * @returns Promise that resolves when server is stopped
 */
export async function stopServer(): Promise<void> {
  log('Stopping A2A server...');
  
  // Set manual stop flag to prevent health monitor from respawning
  manualStop = true;
  
  clearUptimeTimer();
  clearHealthCheckInterval(); // Clear health check for reused servers
  
  if (!childProcess) {
    log('No server process to stop');
    updateState({ status: 'stopped' });
    return;
  }

  const processToStop = childProcess;

  return new Promise((resolve) => {
    let resolved = false;
    
    const finishStop = () => {
      if (!resolved) {
        resolved = true;
        updateState({ status: 'stopped', exitCode: null });
        childProcess = null;
        startTime = null;
        log('Server stopped');
        resolve();
      }
    };

    // Set up exit handler
    processToStop.once('exit', () => {
      finishStop();
    });

    // Send SIGTERM for graceful shutdown
    processToStop.kill('SIGTERM');

    // Escalate to SIGKILL after 3s if still running
    setTimeout(() => {
      if (childProcess && !childProcess.killed) {
        log('Graceful shutdown timed out, sending SIGKILL');
        childProcess.kill('SIGKILL');
      }
    }, 3000);

    // Force resolve after 5s regardless
    setTimeout(() => {
      finishStop();
    }, 5000);
  });
}

/**
 * Returns the current A2A server state.
 * 
 * Provides complete diagnostic visibility including:
 * - Current status (idle|starting|running|stopped|error)
 * - Port number
 * - Uptime in milliseconds
 * - Search count
 * - Last error (if any)
 * - Exit code (if stopped)
 * - Last 50 stdout lines
 * - Last 50 stderr lines
 * 
 * @returns Current A2AServerState
 */
export function getServerState(): A2AServerState {
  return { ...serverState };
}

/**
 * Returns the current search count.
 * 
 * @returns Number of searches processed since session start
 */
export function getSearchCount(): number {
  return serverState.searchCount;
}

/**
 * Returns the current provider task count.
 * 
 * @returns Number of provider tasks processed since session start
 */
export function getProviderTaskCount(): number {
  return serverState.providerTaskCount;
}

/**
 * Increments the search counter and triggers auto-restart at 1000.
 * 
 * When search count reaches 1000:
 * 1. Calls stopServer() to gracefully shut down
 * 2. Resets search count to 0
 * 3. Calls startServer() to restart
 * 
 * @returns Promise that resolves after increment (and restart if needed)
 */
export async function incrementSearchCount(): Promise<void> {
  const newCount = serverState.searchCount + 1;
  updateState({ searchCount: newCount });
  log(`Search count incremented to ${newCount}`);

  // Check combined total — InMemoryTaskStore leaks ALL tasks regardless of source
  const totalTasks = newCount + serverState.providerTaskCount;
  if (totalTasks >= TASK_COUNT_RESTART_THRESHOLD) {
    log(`Combined task count reached ${totalTasks} (threshold: ${TASK_COUNT_RESTART_THRESHOLD}), triggering restart`);
    await stopServer();
    updateState({ searchCount: 0, providerTaskCount: 0 });
    await startServer();
    log('Server restarted with all counters reset to 0');
  }
}

/**
 * Resets the search counter to 0 without restarting.
 * Useful for manual resets or testing.
 */
export function resetSearchCount(): void {
  updateState({ searchCount: 0 });
  log('Search count reset to 0');
}

/**
 * Increments the provider task counter and triggers auto-restart at 1000.
 * 
 * When provider task count reaches 1000:
 * 1. Calls stopServer() to gracefully shut down
 * 2. Resets provider task count to 0
 * 3. Calls startServer() to restart
 * 
 * @returns Promise that resolves after increment (and restart if needed)
 */
export async function incrementProviderTaskCount(): Promise<void> {
  const newCount = serverState.providerTaskCount + 1;
  updateState({ providerTaskCount: newCount });
  log(`Provider task count incremented to ${newCount}`);

  // Check combined total — InMemoryTaskStore leaks ALL tasks regardless of source
  const totalTasks = newCount + serverState.searchCount;
  if (totalTasks >= TASK_COUNT_RESTART_THRESHOLD) {
    log(`Combined task count reached ${totalTasks} (threshold: ${TASK_COUNT_RESTART_THRESHOLD}), triggering restart`);
    await stopServer();
    updateState({ searchCount: 0, providerTaskCount: 0 });
    await startServer();
    log('Server restarted with all counters reset to 0');
  }
}

/**
 * Resets the provider task counter to 0 without restarting.
 * Useful for manual resets or testing.
 */
export function resetProviderTaskCount(): void {
  updateState({ providerTaskCount: 0 });
  log('Provider task count reset to 0');
}

/**
 * Resets the manual stop flag (called on session_start).
 * Ensures health monitor will respawn if server dies in new session.
 */
export function resetManualStopFlag(): void {
  manualStop = false;
  log('Manual stop flag reset');
}

/**
 * Handles child process exit events.
 * Captures exit code, updates state to 'stopped', preserves buffers.
 * Called automatically by the spawn logic, exposed for testing.
 * 
 * @param code - Exit code from child process
 * @param signal - Signal that caused termination
 */
export function handleExit(code: number | null, signal: NodeJS.Signals | null): void {
  log(`Child process exited with code ${code}, signal ${signal}`);
  
  clearUptimeTimer();
  
  // Check if this was an unexpected crash (non-zero exit while running)
  const wasRunning = serverState.status === 'running';
  const crashed = wasRunning && code !== null && code !== 0;
  
  updateState({ 
    status: 'stopped',
    exitCode: code,
  });
  
  // Set error if it was a crash
  if (crashed) {
    updateState({
      lastError: createSearchError('A2A_CRASHED', `Server crashed with exit code ${code}`)
    });
  }
  
  childProcess = null;
  startTime = null;
}

/**
 * Exports for testing - allows tests to mock internal state
 */
export const __testing__ = {
  getState: () => serverState,
  setState: (state: A2AServerState) => { serverState = state; },
  getChildProcess: () => childProcess,
  setChildProcess: (child: ChildProcess | null) => { childProcess = child; },
  getStartTime: () => startTime,
  setStartTime: (time: number | null) => { startTime = time; },
  getStartupPromise: () => startupPromise,
  setStartupPromise: (promise: Promise<void> | null) => { startupPromise = promise; },
  clearUptimeTimer,
  pushToRingBuffer,
  handleExit,
  resetSearchCount,
};
