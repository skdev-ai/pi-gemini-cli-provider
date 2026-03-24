# Gemini CLI Provider for GSD/Pi

A GSD extension that registers `gemini-a2a` as a selectable LLM provider, routing requests through Gemini CLI's A2A server with full model discovery and lifecycle management.

## Features

- **Provider Registration**: Automatically registers `gemini-a2a` as a selectable provider on extension load
- **Exact Model Discovery**: Discovers models directly from Gemini CLI's installed `models.js` file
- **A2A Server Management**: Built-in installer, patcher, and lifecycle controls
- **Command Surface**: Full `/gemini-cli` command for status, installation, server control, and model inspection

## Installation

```bash
# Install the extension (via GSD extension mechanism)
```

## Quick Start

### Prerequisites

1. **Install Gemini CLI** (if not already installed):
   ```bash
   npm install -g @google/gemini-cli
   ```

2. **Authenticate with Google**:
   ```bash
   gemini auth login
   ```

### Enablement Flow

1. **Load the Extension**:
   - The extension automatically registers the `gemini-a2a` provider on load
   - Provider workspace is prepared at `~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/`
   - The `/gemini-cli` command surface becomes available

2. **Install A2A Server and Patches**:
   ```
   /gemini-cli install-a2a
   ```
   
   This will:
   - Install `@google/gemini-cli-a2a-server@0.34.0` globally
   - Create provider workspace with restrictive tool denylist
   - Apply 3 patches:
     - Patch 1: Headless mode fix (run without interactive terminal)
     - Patch 2: `_model` per-request model override
     - Patch 3: `inject_result` support for tool result reinjection
   - Auto-start the A2A server

3. **Select the Provider**:
   - Run `/model` command in GSD to see available models
   - Select any `gemini-*` model (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`)
   - The `gemini-a2a` provider will be used automatically for LLM requests

4. **Verify Setup**:
   ```
   /gemini-cli status
   ```
   
   Shows:
   - A2A server state (status, port, uptime)
   - Patch status (all 3 patches should show ✓)
   - Workspace path
   - Discovered model count

## Command Reference

### `/gemini-cli`

Provider lifecycle management and diagnostics.

#### Subcommands

**`status`** — Show comprehensive provider status
```
/gemini-cli status
```
Reports:
- A2A server state (status, port, uptime, search count, provider task count)
- Patch status (Patch 1, 2, 3)
- Workspace path
- Discovered model count
- Last error and exit code (if applicable)

**`install-a2a`** — Install and patch A2A server
```
/gemini-cli install-a2a
```
- Installs `@google/gemini-cli-a2a-server@0.34.0`
- Creates provider workspace with restrictive tool denylist
- Applies all 3 patches
- Auto-starts the server after installation

**`server start`** — Start A2A server
```
/gemini-cli server start
```

**`server stop`** — Stop A2A server
```
/gemini-cli server stop
```

**`server restart`** — Restart A2A server
```
/gemini-cli server restart
```

**`models`** — List discovered models
```
/gemini-cli models
```
Shows all model IDs discovered from Gemini CLI's installation.

## Architecture

### Provider Registration

On extension load, the provider:
1. Discovers models from Gemini CLI's `models.js` file
2. Maps each model to GSD's custom provider format:
   ```typescript
   {
     id: 'gemini-2.5-pro',
     name: 'Gemini 2.5 Pro',
     reasoning: true,
     input: ['text', 'image'],
     contextWindow: 1048576,  // 1M tokens
     maxTokens: 65536         // 64K output tokens
   }
   ```
3. Registers with GSD via `pi.registerProvider('gemini-a2a', { models, streamSimple })`

### A2A Server Lifecycle

- **Startup**: Auto-started on `session_start` if installed and patched
- **Health Monitoring**: Periodic health checks with auto-respawn
- **Search Count Limit**: Auto-restarts at 1000 searches to prevent memory leaks
- **Provider Task Count**: Auto-restarts at 1000 provider tasks to prevent memory leaks
- **Patch Verification**: Verifies required patches before reuse
- **Shared Server**: Both search and provider extensions share the same A2A server instance on port 41242

### Workspace

Provider workspace location:
```
~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
```

Configuration includes:
- Restrictive `excludeTools` denylist (blocks native file/shell tools like `read_file`, `write_file`, `run_shell_command` to force usage through MCP; `google_web_search` is not excluded and remains auto-approved)
- MCP discovery server configuration
- Warning comment about denylist risks

## Model Discovery

Models are discovered from:
```
{geminiCliRoot}/node_modules/@google/gemini-cli-core/dist/src/config/models.js
```

The `VALID_GEMINI_MODELS` set is imported directly, ensuring exact alignment with the installed Gemini CLI version.

## Troubleshooting

### Provider Not Showing in `/model`

1. Check if Gemini CLI is installed:
   ```bash
   which gemini
   ```

2. Check authentication:
   ```bash
   ls ~/.gemini/oauth_creds.json
   ```

3. Run status command:
   ```
   /gemini-cli status
   ```

4. Check model discovery:
   ```
   /gemini-cli models
   ```
   
   If no models are listed, the provider cannot register. Ensure Gemini CLI is properly installed.

### A2A Server Won't Start

1. Check patch status:
   ```
   /gemini-cli status
   ```

2. Reinstall if patches missing:
   ```
   /gemini-cli install-a2a
   ```

3. Check for port conflicts (default port: 41242):
   ```bash
   lsof -i :41242
   ```

4. Manual server restart:
   ```
   /gemini-cli server restart
   ```

### Invalid Model Errors

If you see "model not found" errors:
1. Run `/gemini-cli models` to see available models
2. Ensure you're using an exact model ID from the list
3. Model IDs are case-sensitive

### Tool List Changed but A2A Still Using Old Tools

When GSD adds or removes tools, the schema file is updated automatically on `session_start`, but the A2A server needs to be restarted to pick up changes:

1. Check if tool list changed:
   - You should see a notification: "Tool list updated. Restart A2A server to pick up changes."

2. Restart the A2A server:
   ```
   /gemini-cli server restart
   ```

3. Verify the server is running with new tools:
   ```
   /gemini-cli status
   ```

### Workspace or Schema File Locations

**Provider Workspace:**
```
~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
```

**Tool Schemas:**
```
~/.pi/agent/extensions/pi-gemini-cli-provider/tool-schemas.json
```

To inspect these files:
```bash
cat ~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
cat ~/.pi/agent/extensions/pi-gemini-cli-provider/tool-schemas.json
```

### Extension Load Issues

If the extension loads but provider registration fails:
1. Check GSD console/logs for error messages
2. Verify Gemini CLI is installed: `npm ls -g @google/gemini-cli`
3. Try reinstalling Gemini CLI: `npm install -g @google/gemini-cli`
4. Reload GSD to re-trigger extension load

The extension is designed to fail-soft — provider registration errors don't block extension load, but you won't see any models available until the issue is resolved.

## Limitations

### Thinking/Reasoning Toggle

The `reasoning: true` flag in model definitions indicates that Gemini models support reasoning natively. However, GSD's thinking toggle UI does **not** control Gemini's internal reasoning behavior — it's informational only. All Gemini 2.x/3.x models use reasoning by default.

**What this means:**
- The thinking toggle in GSD's UI has no effect on Gemini's reasoning process
- Gemini models will always use their internal reasoning regardless of the toggle state
- The toggle is preserved for UI consistency but should be considered decorative for this provider

### Tool Routing

The provider workspace uses a restrictive denylist (`excludeTools`) that blocks all tools except `google_web_search`. This is intentional for safety but means:
- New tools added by Google in future A2A versions will be auto-approved
- MCP tools are bridged separately via the MCP server
- Native GSD tools are not available through A2A

### Model Selection

Models are discovered from the installed Gemini CLI package. If you don't see expected models:
1. Ensure you have the latest Gemini CLI version
2. Run `/gemini-cli models` to see the discovered list
3. Model IDs are case-sensitive and must match exactly

## Files and Directories

### Extension Files
- `src/index.ts` — Extension entry point, provider registration
- `src/provider-registration.ts` — Model discovery and registration
- `src/gemini-cli-command.ts` — Command surface implementation
- `src/a2a-installer.ts` — A2A server installer and patcher
- `src/a2a-lifecycle.ts` — Server lifecycle management
- `src/workspace-generator.ts` — Provider workspace creation

### Generated Files
- `~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json` — Provider workspace settings
- `~/.pi/agent/extensions/pi-gemini-cli-provider/tool-schemas.json` — Filtered tool schemas (excludes denylist tools)

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- src/gemini-cli-command.test.ts

# Run with coverage
npm run test:coverage
```

### Live Integration Tests

The provider includes live end-to-end tests that verify the full A2A integration with a real server. These tests are env-gated and require:

1. **A2A server installed and patched** (all 3 patches):
   ```bash
   /gemini-cli install-a2a
   ```

2. **OAuth authentication**:
   ```bash
   gemini auth login
   ```

3. **A2A server running**:
   ```bash
   /gemini-cli server start
   ```

Run live tests:
```bash
GEMINI_A2A_LIVE=1 npm test -- src/integration.test.ts
```

**What the live tests verify:**
- Prerequisite checks (patches, server health)
- MCP tool call interception (`stopReason: 'toolUse'`)
- Result reinjection via `inject_result` (continuation without empty follow-up prompt)
- Multi-turn conversation continuity (taskId/contextId reuse)
- Error handling (server down, invalid model)

**Note:** Live tests may take 30-60 seconds to run as they make real API calls to Gemini. Tests will skip if `GEMINI_A2A_LIVE` is not set to `1`.

### Type Checking

```bash
npm run typecheck
```

## License

MIT
