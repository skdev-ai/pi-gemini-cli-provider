import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getA2APath, getA2APackageRoot } from './a2a-path.js';
import { checkA2AInstalled, checkA2APatched, checkA2AInjectResultPatched } from './availability.js';
import { applyInjectResultPatch } from './inject-result-patch.js';

// Resolve extension directory from import.meta.url (works with ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_DIR = join(__dirname, '..'); // Go up from src/ to extension root

/**
 * Custom error class for A2A installation failures.
 * Includes phase information and remediation hints for structured error handling.
 */
export class A2AInstallationError extends Error {
  phase: string;
  remediation: string;
  
  constructor(message: string, phase: string, remediation: string) {
    super(message);
    this.name = 'A2AInstallationError';
    this.phase = phase;
    this.remediation = remediation;
  }
}

/**
 * Context interface for the installer.
 * Provides UI notification and confirmation capabilities.
 */
export interface InstallerContext {
  ui: {
    notify: (message: string) => void;
    confirm: (message: string, options?: { title?: string; detail?: string }) => Promise<boolean>;
  };
}

/**
 * Provider workspace settings for A2A server.
 * Excludes all tools except google_web_search as of v0.34.0.
 * Includes MCP discovery server configuration for pi-gemini-cli-provider.
 */
const PROVIDER_WORKSPACE_SETTINGS = {
  excludeTools: [
    'replace',
    'glob',
    'codebase_investigator',
    'enter_plan_mode',
    'exit_plan_mode',
    'generalist',
    'read_file',
    'list_directory',
    'save_memory',
    'grep_search',
    'run_shell_command',
    'web_fetch',
    'write_file',
    'activate_skill',
    'ask_user',
    'cli_help'
  ],
  folderTrust: true,
  mcpServers: {
    'pi-gemini-cli-provider': {
      command: 'node',
      args: [join(EXT_DIR, 'dist', 'mcp-bridge-server.js')],
    }
  }
};

/**
 * Path to the provider workspace settings file.
 * Located at ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
 */
function getProviderWorkspaceSettingsPath(): string {
  return join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'a2a-workspace', '.gemini', 'settings.json');
}

/**
 * Phase 1: Pre-check - Verifies prerequisites for A2A installation.
 * 
 * Checks:
 * 1. Gemini CLI binary is installed (gemini in PATH)
 * 2. OAuth credentials exist (~/.gemini/oauth_creds.json)
 * 3. Whether A2A is already installed and patched (idempotency check)
 * 
 * @param ctx - Installer context for notifications
 * @throws Error with remediation hint if prerequisites not met
 * @returns true if pre-check passes, false if already installed (idempotent early return)
 */
function preCheck(ctx: InstallerContext): boolean {
  ctx.ui.notify('Checking prerequisites...');
  
  // Check 1: CLI binary
  try {
    execSync('which gemini', { stdio: 'pipe' });
  } catch (error) {
    throw new A2AInstallationError(
      'Gemini CLI not installed. Run: npm install -g @google/gemini-cli',
      'prereq',
      'Run: npm install -g @google/gemini-cli'
    );
  }
  
  // Check 2: OAuth credentials
  const homeDir = homedir();
  const oauthPath = join(homeDir, '.gemini', 'oauth_creds.json');
  if (!existsSync(oauthPath)) {
    throw new A2AInstallationError(
      'Not authenticated. Run: gemini auth login',
      'prereq',
      'Run: gemini auth login'
    );
  }
  
  // Check 3: Already installed and patched?
  const isInstalled = checkA2AInstalled();
  const a2aPath = getA2APath();
  
  if (isInstalled && a2aPath) {
    const hasPatch2 = checkA2APatched(a2aPath);
    const hasPatch3 = checkA2AInjectResultPatched();
    
    if (hasPatch2 && hasPatch3) {
      ctx.ui.notify('A2A already installed and patched with Patch 2 and Patch 3');
      return false; // Signal that installation should skip (idempotent)
    }
    
    if (hasPatch2 && !hasPatch3) {
      ctx.ui.notify('A2A installed with Patch 2, applying Patch 3 (inject_result)...');
      return true; // Proceed to apply Patch 3 only
    }
    
    if (!hasPatch2) {
      ctx.ui.notify('A2A installed but missing required patches, re-applying...');
      return true; // Proceed to apply both patches
    }
  }
  
  return true; // Proceed with installation
}

/**
 * Phase 2: Approval - Prompts user for installation approval.
 * 
 * Presents clear warnings about:
 * - Package size (520 packages, ~60s install time)
 * - OAuth authentication requirement
 * - Version pinning for stability
 * - Restricted workspace creation
 * - Patch 2 (_model override) and Patch 3 (inject_result) application
 * 
 * @param ctx - Installer context for confirmation dialog
 * @returns true if user approved, false if cancelled
 */
async function requestApproval(ctx: InstallerContext): Promise<boolean> {
  const message = 'This will install @google/gemini-cli-a2a-server@0.34.0 (520 packages, ~60s)\n\n' +
    'Requires Google OAuth authentication\n' +
    'Version pinned for stability — do not update without re-patching\n' +
    'Creates restricted workspace allowing only google_web_search tool\n' +
    'Applies Patch 2 (_model per-request override) and Patch 3 (inject_result support)';
  
  const approved = await ctx.ui.confirm(message, {
    title: 'Install A2A Server',
    detail: 'Approve installation of Gemini CLI A2A Server for pi-gemini-cli-provider'
  });
  
  if (!approved) {
    ctx.ui.notify('Installation cancelled by user');
  }
  
  return approved;
}

/**
 * Phase 3a: Installation - Installs A2A server globally via npm.
 * 
 * Installs version 0.34.0 (pinned for stability).
 * Handles common errors:
 * - Permission denied → suggests sudo or npm permissions fix
 * - Network errors → suggests checking connection
 * 
 * @param ctx - Installer context for notifications
 * @throws Error with phase-specific remediation hint
 */
function installA2ABinary(ctx: InstallerContext): void {
  ctx.ui.notify('Installing A2A server... this may take up to 60 seconds');
  
  try {
    execSync('npm install -g @google/gemini-cli-a2a-server@0.34.0', { stdio: 'pipe' });
    ctx.ui.notify('Installation complete, creating provider workspace...');
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    
    if (errorMessage.includes('EACCES') || errorMessage.includes('permission denied')) {
      throw new A2AInstallationError(
        'Permission denied during npm install',
        'install',
        'Run with sudo or fix npm permissions: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-global-packages'
      );
    }
    
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('network')) {
      throw new A2AInstallationError(
        'Network error during installation',
        'install',
        'Check your internet connection and retry'
      );
    }
    
    throw new A2AInstallationError(
      `Installation failed: ${errorMessage}`,
      'install',
      'Check npm logs and retry, or run manually: npm install -g @google/gemini-cli-a2a-server@0.34.0'
    );
  }
}

/**
 * Phase 3b: Workspace Creation - Creates provider workspace settings.
 * 
 * Creates ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
 * with excludeTools list that blocks all tools except google_web_search.
 * Includes MCP discovery server configuration.
 * 
 * Includes warning comment about denylist risk:
 * "WARNING: excludeTools is a denylist. New tools added by Google in future versions will be auto-approved."
 * 
 * @param ctx - Installer context for notifications
 * @throws Error if workspace creation fails
 */
function createProviderWorkspace(ctx: InstallerContext): void {
  const settingsPath = getProviderWorkspaceSettingsPath();
  const settingsDir = dirname(settingsPath);
  
  try {
    // Create directory structure
    mkdirSync(settingsDir, { recursive: true });
    
    // Write settings.json with comment header
    const settingsContent = `// WARNING: excludeTools is a denylist. New tools added by Google in future versions will be auto-approved.
// Version pinning to v0.34.0 is the safety net.
${JSON.stringify(PROVIDER_WORKSPACE_SETTINGS, null, 2)}
`;
    
    writeFileSync(settingsPath, settingsContent, 'utf-8');
    ctx.ui.notify('Provider workspace created at ' + settingsPath);
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    throw new A2AInstallationError(
      `Failed to create provider workspace: ${errorMessage}`,
      'workspace',
      'Check file permissions and disk space, or create directory manually'
    );
  }
}

/**
 * Applies patches to the A2A server source file.
 * 
 * Patch 2 (_requestedModel): Injects model selection support
 * Patch 3 (inject_result): Adds inject_result outcome handler
 * 
 * Creates backup files before patching:
 * - .bak: Original file content
 * - .bak.version: Version string for tracking
 * 
 * Skips patching if already patched (idempotent).
 * Warns if version changed and re-applies patches.
 * 
 * @param ctx - Installer context for notifications
 * @throws Error if patching fails or targets not found
 */
function applyPatches(ctx: InstallerContext): void {
  const packageRoot = getA2APackageRoot();
  if (!packageRoot) {
    throw new A2AInstallationError(
      'A2A server package not found after installation',
      'patch',
      'Verify npm install completed successfully and check PATH'
    );
  }
  
  const a2aPath = join(packageRoot, 'dist', 'a2a-server.mjs');
  
  ctx.ui.notify('Applying patches...');
  
  try {
    // Read current content
    let content = readFileSync(a2aPath, 'utf-8');
    
    // Check if already patched
    if (content.includes('_requestedModel') && content.includes('PATCH: inject_result support')) {
      ctx.ui.notify('Already patched with Patch 2 and Patch 3, skipping patch application');
      return;
    }
    
    // Check for version mismatch (if .bak.version exists)
    const bakVersionPath = a2aPath + '.bak.version';
    if (existsSync(bakVersionPath)) {
      const storedVersion = readFileSync(bakVersionPath, 'utf-8').trim();
      if (storedVersion !== '0.34.0') {
        ctx.ui.notify(`Warning: A2A server version changed from ${storedVersion} to 0.34.0. Re-applying patches.`);
      }
    }
    
    // Create backup
    writeFileSync(a2aPath + '.bak', content, 'utf-8');
    writeFileSync(a2aPath + '.bak.version', '0.34.0', 'utf-8');
    
    // Patch 2: _requestedModel injection
    // Find the line after which to inject the model selection code
    const injectionTarget = 'const currentTask = wrapper.task;';
    if (!content.includes(injectionTarget)) {
      throw new Error('Patch target not found: currentTask assignment');
    }
    
    // Correct patch: read _model from message metadata and call setModel()
    const modelSelectionCode = ` const _requestedModel = userMessage.metadata?._model; if (_requestedModel && typeof _requestedModel === "string") { currentTask.config.setModel(_requestedModel); }`;
    
    content = content.replace(
      injectionTarget,
      injectionTarget + modelSelectionCode
    );
    
    // Patch 3: inject_result support
    const injectResultApplied = applyInjectResultPatch(a2aPath);
    if (!injectResultApplied) {
      throw new Error('Failed to apply inject_result patch');
    }
    
    ctx.ui.notify('Patches applied, verifying...');
  } catch (error: any) {
    // Restore from backup on failure
    if (existsSync(a2aPath + '.bak')) {
      const backupContent = readFileSync(a2aPath + '.bak', 'utf-8');
      writeFileSync(a2aPath, backupContent, 'utf-8');
    }
    
    const errorMessage = error.message || String(error);
    
    // Don't wrap patch target errors - they need specific remediation
    if (errorMessage.includes('Patch target not found')) {
      throw new A2AInstallationError(
        errorMessage,
        'patch',
        'A2A server version may have changed. Check installed version or restore from backup'
      );
    }
    
    throw new A2AInstallationError(
      `Patch application failed: ${errorMessage}`,
      'patch',
      'Check file permissions or run manual patching'
    );
  }
}

/**
 * Phase 4: Verification - Validates that patches were applied correctly.
 * 
 * Checks:
 * 1. Patch 2: _requestedModel marker present
 * 2. Patch 3: inject_result marker present
 * 
 * If verification fails:
 * - Restores from .bak backup
 * - Deletes .bak.version
 * - Throws error with specific failure reason
 * 
 * @param ctx - Installer context for notifications
 * @throws Error with specific failure reason and remediation hint
 */
function verifyPatches(ctx: InstallerContext): void {
  const packageRoot = getA2APackageRoot();
  if (!packageRoot) {
    throw new A2AInstallationError(
      'A2A server package not available for verification',
      'verify',
      'Verify npm install completed successfully'
    );
  }
  
  const a2aPath = join(packageRoot, 'dist', 'a2a-server.mjs');
  
  try {
    const content = readFileSync(a2aPath, 'utf-8');
    
    // Verify Patch 2
    if (!content.includes('_requestedModel')) {
      // Restore backup
      if (existsSync(a2aPath + '.bak')) {
        const backupContent = readFileSync(a2aPath + '.bak', 'utf-8');
        writeFileSync(a2aPath, backupContent, 'utf-8');
      }
      if (existsSync(a2aPath + '.bak.version')) {
        rmSync(a2aPath + '.bak.version');
      }
      throw new Error('Patch verification failed: _requestedModel support not applied');
    }
    
    // Verify Patch 3
    if (!content.includes('PATCH: inject_result support')) {
      // Restore backup
      if (existsSync(a2aPath + '.bak')) {
        const backupContent = readFileSync(a2aPath + '.bak', 'utf-8');
        writeFileSync(a2aPath, backupContent, 'utf-8');
      }
      if (existsSync(a2aPath + '.bak.version')) {
        rmSync(a2aPath + '.bak.version');
      }
      throw new Error('Patch verification failed: inject_result support not applied');
    }
    
    ctx.ui.notify('Patches applied and verified successfully');
  } catch (error: any) {
    if (error instanceof A2AInstallationError) {
      throw error; // Re-throw A2AInstallationError as-is
    }
    
    if (error.message.includes('Patch verification failed')) {
      throw new A2AInstallationError(
        error.message,
        'verify',
        'Backup restored. Check file permissions or run manual installation'
      );
    }
    
    const errorMessage = error.message || String(error);
    throw new A2AInstallationError(
      `Verification failed: ${errorMessage}. Check file permissions or run manually.`,
      'verify',
      'Check file permissions and retry, or inspect backup files for debugging'
    );
  }
}

/**
 * Main installation function - orchestrates the four-phase A2A installation flow.
 * 
 * Phases:
 * 1. Pre-check: Verifies CLI binary, OAuth credentials, and idempotency
 * 2. Approval: User confirmation with clear warnings
 * 3. Installation + Workspace + Patching: npm install, create settings, apply patches
 * 4. Verification: Validates patches took effect
 * 
 * Idempotent: Detects already-installed state and skips redundant work.
 * 
 * @param ctx - Installer context providing UI notification and confirmation
 * @returns true if installation completed or was already done, false if cancelled
 * 
 * @example
 * ```typescript
 * await installA2AServer({
 *   ui: {
 *     notify: (msg) => ctx.ui.notify(msg),
 *     confirm: async (msg, opts) => ctx.ui.confirm(msg, opts)
 *   }
 * });
 * ```
 */
export async function installA2AServer(ctx: InstallerContext): Promise<boolean> {
  try {
    // Phase 1: Pre-check
    const shouldProceed = preCheck(ctx);
    if (!shouldProceed) {
      return true; // Already installed, idempotent success
    }
    
    // Phase 2: Approval
    const approved = await requestApproval(ctx);
    if (!approved) {
      return false; // User cancelled
    }
    
    // Phase 3a: Installation
    installA2ABinary(ctx);
    
    // Phase 3b: Workspace creation
    createProviderWorkspace(ctx);
    
    // Phase 3c: Patch application
    applyPatches(ctx);
    
    // Phase 4: Verification
    verifyPatches(ctx);
    
    ctx.ui.notify('A2A server installation complete!');
    return true;
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    ctx.ui.notify(`Installation failed: ${errorMessage}`);
    throw error; // Re-throw for caller handling
  }
}
