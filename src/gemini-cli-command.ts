/**
 * Gemini CLI Provider Command Surface
 * 
 * Provides a user-facing command (`/gemini-cli`) for managing the provider's
 * A2A lifecycle, inspecting status, and viewing discovered models.
 * 
 * Subcommands:
 * - status: Reports A2A server state, patch status, workspace path, and model info
 * - install-a2a: Installs and patches the A2A server with provider workspace
 * - server start|stop|restart: Controls the A2A server lifecycle
 * - models: Lists discovered Gemini CLI models available to the provider
 */

import { installA2AServer, type InstallerContext } from './a2a-installer.js';
import { startServer, stopServer, getServerState } from './a2a-lifecycle.js';
import { getAvailableModelIds } from './provider-registration.js';
import { resolveWorkspacePath } from './workspace-generator.js';
import { getA2APackageRoot } from './a2a-path.js';
import { checkA2APatched, checkA2AInjectResultPatched, checkA2APendingToolAbortPatched } from './availability.js';

// ============================================================================
// Command Handler
// ============================================================================

/**
 * Handles the /gemini-cli command with subcommands.
 * 
 * @param args - Command arguments (subcommand and optional parameters)
 * @param ctx - GSD command context with ui.notify and ui.confirm
 */
export async function handleGeminiCliCommand(
  args: string,
  ctx: {
    ui: {
      notify: (message: string, level?: string) => void;
      confirm: (title: string, detail: string) => Promise<boolean>;
    };
  }
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0];

  try {
    if (subcommand === 'status') {
      await handleStatus(ctx);
    } else if (subcommand === 'install-a2a') {
      await handleInstallA2A(ctx);
    } else if (subcommand === 'server') {
      await handleServerCommand(parts[1], ctx);
    } else if (subcommand === 'models') {
      await handleModels(ctx);
    } else if (!subcommand) {
      // No subcommand - show help
      showHelp(ctx);
    } else {
      ctx.ui.notify(`Unknown subcommand: ${subcommand}\nRun /gemini-cli for available subcommands`, 'error');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Command failed: ${message}`, 'error');
  }
}

// ============================================================================
// Subcommand: status
// ============================================================================

/**
 * Reports comprehensive provider status including:
 * - A2A server state (status, port, uptime, search count)
 * - Patch status (Patch 1, 2, 3)
 * - Workspace path
 * - Discovered model count
 */
async function handleStatus(
  ctx: { ui: { notify: (message: string, level?: string) => void } }
): Promise<void> {
  const lines: string[] = [];

  // A2A Server State
  const serverState = getServerState();
  lines.push('**A2A Server Status:**');
  lines.push(`- Status: \`${serverState.status}\``);
  lines.push(`- Port: \`${serverState.port}\``);

  if (serverState.uptime && serverState.uptime > 0) {
    lines.push(`- Uptime: \`${Math.round(serverState.uptime / 1000)}s\``);
  }

  lines.push(`- Search Count: \`${serverState.searchCount}\``);
  lines.push(`- Provider Task Count: \`${serverState.providerTaskCount}\``);

  if (serverState.exitCode !== null) {
    lines.push(`- Exit Code: \`${serverState.exitCode}\``);
  }

  if (serverState.lastError) {
    lines.push(`- Last Error: \`${serverState.lastError.type}: ${serverState.lastError.message}\``);
  }

  // Patch Status
  const packageRoot = getA2APackageRoot();
  if (packageRoot) {
    const serverPath = packageRoot + '/dist/a2a-server.mjs';
    
    // Check Patch 1 by reading the bundle file (not hardcoded)
    let hasPatch1 = false;
    try {
      const { readFileSync } = await import('node:fs');
      const content = readFileSync(serverPath, 'utf-8');
      hasPatch1 = content.includes('isHeadlessMode(options) { return false;');
    } catch {
      // If we can't read the file, assume not patched
      hasPatch1 = false;
    }
    
    const hasPatch2 = checkA2APatched(serverPath);
    const hasPatch3 = checkA2AInjectResultPatched();
    const hasPatch4 = checkA2APendingToolAbortPatched(serverPath);

    lines.push('');
    lines.push('**Patch Status:**');
    lines.push(`- Patch 1 (headless): ${hasPatch1 ? '✓' : '✗'}`);
    lines.push(`- Patch 2 (_model): ${hasPatch2 ? '✓' : '✗'}`);
    lines.push(`- Patch 3 (inject_result): ${hasPatch3 ? '✓' : '✗'}`);
    lines.push(`- Patch 4 (preserve pending tools on input-required abort): ${hasPatch4 ? '✓' : '✗'}`);

    if (!hasPatch1 || !hasPatch2 || !hasPatch3 || !hasPatch4) {
      lines.push('');
      lines.push('⚠️ Missing patches detected. Run `/gemini-cli install-a2a` to apply.');
    }
  } else {
    lines.push('');
    lines.push('**Patch Status:** A2A server not installed');
  }

  // Workspace Path
  const workspacePath = resolveWorkspacePath({});
  lines.push('');
  lines.push('**Workspace:**');
  lines.push(`- Path: \`${workspacePath}\``);

  // Model Discovery
  const modelIds = await getAvailableModelIds();
  lines.push('');
  lines.push('**Models:**');
  lines.push(`- Discovered: \`${modelIds.length}\` models`);

  if (modelIds.length > 0) {
    lines.push(`- Sample: \`${modelIds.slice(0, 3).join(', ')}...\``);
  }

  ctx.ui.notify(lines.join('\n'), 'info');
}

// ============================================================================
// Subcommand: install-a2a
// ============================================================================

/**
 * Installs the A2A server with provider workspace and patches.
 * Uses the provider-owned installer from a2a-installer.ts.
 */
async function handleInstallA2A(
  ctx: {
    ui: {
      notify: (message: string, level?: string) => void;
      confirm: (title: string, detail: string) => Promise<boolean>;
    };
  }
): Promise<void> {
  const installerCtx: InstallerContext = {
    ui: {
      notify: (message) => ctx.ui.notify(message),
      confirm: async (message, options) => {
        const title = options?.title || 'Confirm Installation';
        const detail = options?.detail || message;
        return await ctx.ui.confirm(title, detail);
      },
    },
  };

  await installA2AServer(installerCtx);

  // Auto-start A2A server after successful installation
  ctx.ui.notify('A2A installation complete! Starting server...', 'success');
  try {
    await startServer();
    ctx.ui.notify('A2A server started successfully. Ready to use!', 'success');
  } catch (startErr) {
    const startMessage = startErr instanceof Error ? startErr.message : String(startErr);
    ctx.ui.notify(`Installation succeeded but server failed to start: ${startMessage}`, 'warning');
  }
}

// ============================================================================
// Subcommand: server start|stop|restart
// ============================================================================

/**
 * Controls the A2A server lifecycle.
 * 
 * @param action - Server action: 'start', 'stop', or 'restart'
 * @param ctx - GSD command context
 */
async function handleServerCommand(
  action: string,
  ctx: { ui: { notify: (message: string, level?: string) => void } }
): Promise<void> {
  const serverState = getServerState();

  if (action === 'start') {
    if (serverState.status === 'running') {
      ctx.ui.notify(`A2A server already running on port ${serverState.port}`, 'info');
    } else {
      await startServer();
      ctx.ui.notify('A2A server started successfully', 'success');
    }
  } else if (action === 'stop') {
    if (serverState.status === 'stopped' || serverState.status === 'idle') {
      ctx.ui.notify('A2A server is not running', 'info');
    } else {
      await stopServer();
      ctx.ui.notify('A2A server stopped', 'info');
    }
  } else if (action === 'restart') {
    await stopServer();
    await startServer();
    ctx.ui.notify('A2A server restarted', 'success');
  } else if (!action) {
    ctx.ui.notify('Usage: /gemini-cli server [start|stop|restart]', 'warning');
  } else {
    ctx.ui.notify(`Unknown server action: ${action}\nUsage: /gemini-cli server [start|stop|restart]`, 'error');
  }
}

// ============================================================================
// Subcommand: models
// ============================================================================

/**
 * Lists all discovered Gemini CLI models available to the provider.
 * Shows model IDs and total count.
 */
async function handleModels(
  ctx: { ui: { notify: (message: string, level?: string) => void } }
): Promise<void> {
  const modelIds = await getAvailableModelIds();

  if (modelIds.length === 0) {
    ctx.ui.notify(
      'No models discovered.\n\n' +
      'Ensure @google/gemini-cli is installed globally:\n' +
      '  npm install -g @google/gemini-cli',
      'warning'
    );
    return;
  }

  const lines: string[] = [
    `**Discovered Models:** (${modelIds.length} total)`,
    '',
    ...modelIds.map((id, i) => `${i + 1}. \`${id}\``),
  ];

  ctx.ui.notify(lines.join('\n'), 'info');
}

// ============================================================================
// Help
// ============================================================================

/**
 * Shows command help with available subcommands.
 */
function showHelp(
  ctx: { ui: { notify: (message: string, level?: string) => void } }
): void {
  ctx.ui.notify(
    'Usage: /gemini-cli <subcommand>\n\n' +
    'Subcommands:\n' +
    '  status          — Show A2A server state, patch status, workspace, and models\n' +
    '  install-a2a     — Install and patch A2A server with provider workspace\n' +
    '  server start    — Start A2A server\n' +
    '  server stop     — Stop A2A server\n' +
    '  server restart  — Restart A2A server\n' +
    '  models          — List discovered Gemini CLI models',
    'info'
  );
}
