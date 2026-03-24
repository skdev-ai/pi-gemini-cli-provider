import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { debugLog } from './logger.js';

// Resolve extension directory from import.meta.url (works with ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_DIR = join(__dirname, '..'); // Go up from src/ to extension root

/**
 * Provider workspace settings for A2A server.
 * Excludes native file/shell tools to force usage through MCP bridge.
 * google_web_search is not excluded (auto-approved for direct A2A use).
 * Includes MCP discovery server configuration for tools.
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
    tools: {
      command: 'node',
      args: [join(EXT_DIR, 'dist', 'mcp-bridge-server.js')],
    }
  }
};

/**
 * Provider workspace configuration options.
 */
export interface WorkspaceConfig {
  /** Optional custom workspace path (defaults to ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace) */
  workspacePath?: string;
  /** Optional custom excludeTools list (defaults to PROVIDER_WORKSPACE_SETTINGS.excludeTools) */
  excludeTools?: string[];
  /** Whether to enable MCP discovery server (default: true) */
  enableMcpServer?: boolean;
}

/**
 * Workspace generation result.
 */
export interface WorkspaceResult {
  /** Path to the generated workspace directory */
  workspacePath: string;
  /** Path to the settings.json file */
  settingsPath: string;
  /** Whether workspace was created (true) or already existed (false) */
  created: boolean;
}

/**
 * Custom error class for workspace generation failures.
 */
export class WorkspaceGenerationError extends Error {
  phase: string;
  remediation: string;
  
  constructor(message: string, phase: string, remediation: string) {
    super(message);
    this.name = 'WorkspaceGenerationError';
    this.phase = phase;
    this.remediation = remediation;
  }
}

/**
 * Logs a debug message (hidden unless GCS_DEBUG=1, writes to file)
 */
function log(message: string): void {
  debugLog('workspace', message);
}

/**
 * Resolves the provider workspace path.
 * Default: ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace
 * 
 * @param config - Optional workspace configuration
 * @returns Resolved workspace path
 */
export function resolveWorkspacePath(config?: WorkspaceConfig): string {
  if (config?.workspacePath) {
    log(`Using custom workspace path: ${config.workspacePath}`);
    return config.workspacePath;
  }
  
  const defaultPath = join(
    homedir(),
    '.pi',
    'agent',
    'extensions',
    'pi-gemini-cli-provider',
    'a2a-workspace'
  );
  
  log(`Using default workspace path: ${defaultPath}`);
  return defaultPath;
}

/**
 * Ensures the .gemini directory exists within the workspace.
 * 
 * @param workspacePath - Path to the workspace directory
 * @returns Path to the .gemini directory
 * @throws WorkspaceGenerationError if directory creation fails
 */
function ensureGeminiDir(workspacePath: string): string {
  const geminiDir = join(workspacePath, '.gemini');
  
  try {
    if (!existsSync(geminiDir)) {
      mkdirSync(geminiDir, { recursive: true });
      log(`Created .gemini directory at ${geminiDir}`);
    } else {
      log(`.gemini directory already exists at ${geminiDir}`);
    }
    
    return geminiDir;
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    throw new WorkspaceGenerationError(
      `Failed to create .gemini directory: ${errorMessage}`,
      'mkdir',
      'Check file permissions and disk space'
    );
  }
}

/**
 * Generates the settings.json content for the provider workspace.
 * 
 * @param config - Workspace configuration options
 * @returns Settings JSON content as string
 */
function generateSettingsContent(config?: WorkspaceConfig): string {
  const enableMcp = config?.enableMcpServer ?? true;
  const excludeTools = config?.excludeTools ?? PROVIDER_WORKSPACE_SETTINGS.excludeTools;
  
  const settings = {
    excludeTools,
    folderTrust: true,
    ...(enableMcp && {
      mcpServers: {
        tools: {
          command: 'node',
          args: [join(EXT_DIR, 'dist', 'mcp-bridge-server.js')],
        }
      }
    })
  };
  
  // Add warning comment header
  const commentHeader = `// WARNING: excludeTools is a denylist. New tools added by Google in future versions will be auto-approved.
// Version pinning to v0.34.0 is the safety net.
`;
  
  return commentHeader + JSON.stringify(settings, null, 2) + '\n';
}

/**
 * Writes the settings.json file to the workspace.
 * 
 * @param geminiDir - Path to the .gemini directory
 * @param config - Workspace configuration options
 * @returns Path to the settings.json file
 * @throws WorkspaceGenerationError if write fails
 */
function writeSettingsFile(geminiDir: string, config?: WorkspaceConfig): string {
  const settingsPath = join(geminiDir, 'settings.json');
  
  try {
    const content = generateSettingsContent(config);
    writeFileSync(settingsPath, content, 'utf-8');
    log(`Written settings.json at ${settingsPath}`);
    return settingsPath;
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    throw new WorkspaceGenerationError(
      `Failed to write settings.json: ${errorMessage}`,
      'write',
      'Check file permissions and disk space'
    );
  }
}

/**
 * Reads and parses the settings.json file from the workspace.
 * 
 * @param workspacePath - Path to the workspace directory
 * @returns Parsed settings object, or null if file doesn't exist
 * @throws WorkspaceGenerationError if file exists but is invalid JSON
 */
export function readSettingsFile(workspacePath: string): typeof PROVIDER_WORKSPACE_SETTINGS | null {
  const settingsPath = join(workspacePath, '.gemini', 'settings.json');
  
  if (!existsSync(settingsPath)) {
    log(`Settings file not found at ${settingsPath}`);
    return null;
  }
  
  try {
    const content = readFileSync(settingsPath, 'utf-8');
    // Remove comment lines before parsing
    const jsonContent = content.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
    return JSON.parse(jsonContent);
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    throw new WorkspaceGenerationError(
      `Failed to parse settings.json: ${errorMessage}`,
      'parse',
      'Check settings.json for valid JSON syntax or delete to regenerate'
    );
  }
}

/**
 * Generates the provider workspace directory structure and settings.
 * 
 * Creates:
 * - ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
 * 
 * With:
 * - excludeTools list (blocks all tools except google_web_search)
 * - MCP discovery server configuration
 * - folderTrust enabled
 * 
 * Idempotent: Skips creation if workspace already exists with valid settings.
 * 
 * @param config - Optional workspace configuration
 * @returns Workspace generation result
 * @throws WorkspaceGenerationError if generation fails
 * 
 * @example
 * ```typescript
 * const result = generateWorkspace();
 * console.log(`Workspace created at: ${result.workspacePath}`);
 * console.log(`Settings at: ${result.settingsPath}`);
 * ```
 */
export function generateWorkspace(config?: WorkspaceConfig): WorkspaceResult {
  const workspacePath = resolveWorkspacePath(config);
  const geminiDir = ensureGeminiDir(workspacePath);
  const settingsPath = join(geminiDir, 'settings.json');
  
  // Check if settings already exist (idempotent)
  const existingSettings = readSettingsFile(workspacePath);
  if (existingSettings) {
    log('Workspace settings already exist, skipping generation');
    return {
      workspacePath,
      settingsPath,
      created: false,
    };
  }
  
  // Generate new settings
  writeSettingsFile(geminiDir, config);
  
  log(`Provider workspace generated at ${workspacePath}`);
  
  return {
    workspacePath,
    settingsPath,
    created: true,
  };
}

/**
 * Validates that the provider workspace has the required configuration.
 * 
 * Checks:
 * - Settings file exists
 * - excludeTools list is present
 * - MCP server configuration is present (if enabled)
 * 
 * @param workspacePath - Path to the workspace directory
 * @param config - Expected configuration to validate against
 * @returns Validation result with success status and any errors
 */
export function validateWorkspace(workspacePath: string, config?: WorkspaceConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  try {
    const settings = readSettingsFile(workspacePath);
    
    if (!settings) {
      errors.push('Settings file not found');
      return { valid: false, errors };
    }
    
    // Check excludeTools
    if (!Array.isArray(settings.excludeTools)) {
      errors.push('Missing or invalid excludeTools list');
    }
    
    // Check folderTrust
    if (settings.folderTrust !== true) {
      errors.push('folderTrust should be enabled');
    }
    
    // Check MCP server config (if expected)
    const enableMcp = config?.enableMcpServer ?? true;
    if (enableMcp) {
      if (!settings.mcpServers || typeof settings.mcpServers !== 'object') {
        errors.push('Missing mcpServers configuration');
      } else if (!settings.mcpServers.tools) {
        errors.push('Missing tools MCP server configuration');
      }
    }
    
  } catch (error: any) {
    errors.push(`Validation error: ${error.message || String(error)}`);
  }
  
  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Exports for testing.
 */
export const __testing__ = {
  PROVIDER_WORKSPACE_SETTINGS,
  generateSettingsContent,
  resolveWorkspacePath,
};
