import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as http from 'node:http';
import { getA2APath, getA2APackageRoot } from './a2a-path.js';
import { checkInjectResultPatched } from './inject-result-patch.js';

/**
 * Checks if the Gemini CLI binary is available in PATH.
 * Synchronously searches PATH directories for the gemini executable.
 * Uses existsSync instead of execSync('which gemini') to avoid blocking the event loop.
 */
export function checkCliBinary(): boolean {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return false;
  }
  
  // Split PATH by colon and search for gemini binary
  const paths = pathEnv.split(':');
  for (const dir of paths) {
    const geminiPath = `${dir}/gemini`;
    if (existsSync(geminiPath)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Checks if the OAuth credentials file exists at ~/.gemini/oauth_creds.json.
 * Properly expands the tilde (~) to the home directory path.
 */
export function checkCredentialFile(): boolean {
  const homeDir = process.env.HOME;
  if (!homeDir) {
    return false;
  }
  
  const credPath = `${homeDir}/.gemini/oauth_creds.json`;
  return existsSync(credPath);
}

/**
 * Performs a comprehensive availability check for the Gemini CLI tool.
 * Returns an object with availability status and optional reason for failure.
 * 
 * Checks performed in order:
 * 1. CLI binary presence (gemini in PATH)
 * 2. OAuth credentials file (~/.gemini/oauth_creds.json)
 * 
 * @returns Object with `available` boolean and optional `reason` string
 */
export function checkAvailability(): { available: boolean; reason?: string; a2a?: { installed: boolean; patched: boolean; injectResultPatched: boolean; pendingToolAbortPatched: boolean } } {
  // Check if gemini CLI is installed
  if (!checkCliBinary()) {
    return {
      available: false,
      reason: 'CLI_NOT_FOUND',
    };
  }

  // Check for OAuth credentials
  if (!checkCredentialFile()) {
    return {
      available: false,
      reason: 'NOT_AUTHENTICATED',
    };
  }

  // Check A2A availability (installed and patched)
  const a2aInstalled = checkA2AInstalled();
  const packageRoot = a2aInstalled ? getA2APackageRoot() : null;
  const a2aBundlePath = packageRoot ? join(packageRoot, 'dist', 'a2a-server.mjs') : null;
  const a2aPatched = a2aBundlePath ? checkA2APatched(a2aBundlePath) : false;
  const injectResultPatched = a2aBundlePath ? checkInjectResultPatched(a2aBundlePath) : false;
  const pendingToolAbortPatched = a2aBundlePath ? checkA2APendingToolAbortPatched(a2aBundlePath) : false;

  return { 
    available: true,
    a2a: {
      installed: a2aInstalled,
      patched: a2aPatched,
      injectResultPatched,
      pendingToolAbortPatched,
    }
  };
}

/**
 * Checks if the A2A server binary is installed globally.
 * Uses getA2APath() to resolve the path from `which gemini-cli-a2a-server`.
 * 
 * @returns true if A2A server is installed, false otherwise
 */
export function checkA2AInstalled(): boolean {
  return getA2APath() !== null;
}

/**
 * Checks if the A2A server file has been patched with the _requestedModel support.
 * Reads the file synchronously and checks for the _requestedModel marker string.
 * 
 * @param filePath - Path to the A2A server file to check
 * @returns true if file contains _requestedModel patch marker, false otherwise
 */
export function checkA2APatched(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes('_requestedModel');
  } catch {
    // File not found, permission denied, or other errors
    return false;
  }
}

/**
 * Checks if the A2A server bundle has been patched to preserve pending tools
 * when an input-required task aborts after the SSE connection closes.
 *
 * @param filePath - Path to the A2A server file to check
 * @returns true if the pending-tool abort preservation patch is present, false otherwise
 */
export function checkA2APendingToolAbortPatched(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return content.includes('PATCH: preserve pending tools on input-required abort');
  } catch {
    return false;
  }
}

/**
 * Checks if the A2A server bundle has been patched with inject_result support.
 * Wrapper around checkInjectResultPatched() that resolves the A2A package root
 * and constructs the bundle path automatically.
 * 
 * @returns true if inject_result patch is present, false otherwise
 */
export function checkA2AInjectResultPatched(): boolean {
  const packageRoot = getA2APackageRoot();
  if (!packageRoot) {
    return false;
  }
  
  const bundlePath = join(packageRoot, 'dist', 'a2a-server.mjs');
  return checkInjectResultPatched(bundlePath);
}

/**
 * Checks if the A2A server is running and responding to health checks.
 * Makes an HTTP GET request to the /.well-known/agent-card.json endpoint (A2A spec standard) with a 500ms timeout.
 * 
 * @param port - Port number to check (default: 41242)
 * @returns Promise resolving to true if server responds with 200 OK, false otherwise
 */
export function checkA2ARunning(port: number = 41242): Promise<boolean> {
  return new Promise((resolve) => {
    const url = `http://localhost:${port}/.well-known/agent-card.json`;
    
    const req = http.get(url, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    
    // Set timeout BEFORE ending the request
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    
    req.on('error', () => {
      resolve(false);
    });
    
    req.end();
  });
}

/**
 * Simple boolean check for Gemini CLI availability.
 * Wrapper around checkAvailability() that returns only the boolean.
 */
export function isAvailable(): boolean {
  return checkAvailability().available;
}
