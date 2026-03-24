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

1. **Install Gemini CLI** (if not already installed):
   ```bash
   npm install -g @google/gemini-cli
   ```

2. **Authenticate with Google**:
   ```bash
   gemini auth login
   ```

3. **Install A2A Server and Patches**:
   ```
   /gemini-cli install-a2a
   ```
   
   This will:
   - Install `@google/gemini-cli-a2a-server@0.34.0` globally
   - Create provider workspace at `~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/`
   - Apply 3 patches:
     - Patch 1: Headless mode fix (run without interactive terminal)
     - Patch 2: `_model` per-request model override
     - Patch 3: `inject_result` support for tool result reinjection

4. **Select the Provider**:
   - Use `/model` command in GSD to see available models
   - Select any `gemini-*` model (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`)
   - The `gemini-a2a` provider will be used automatically

## Command Reference

### `/gemini-cli`

Provider lifecycle management and diagnostics.

#### Subcommands

**`status`** — Show comprehensive provider status
```
/gemini-cli status
```
Reports:
- A2A server state (status, port, uptime, search count)
- Patch status (Patch 1, 2, 3)
- Workspace path
- Discovered model count

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
- **Patch Verification**: Verifies required patches before reuse

### Workspace

Provider workspace location:
```
~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/.gemini/settings.json
```

Configuration includes:
- Restrictive `excludeTools` denylist (only `google_web_search` allowed)
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

### A2A Server Won't Start

1. Check patch status:
   ```
   /gemini-cli status
   ```

2. Reinstall if patches missing:
   ```
   /gemini-cli install-a2a
   ```

3. Check for port conflicts (default port: 41242)

### Invalid Model Errors

If you see "model not found" errors:
1. Run `/gemini-cli models` to see available models
2. Ensure you're using an exact model ID from the list
3. Model IDs are case-sensitive

## Limitations

### Thinking/Reasoning Toggle

The `reasoning: true` flag in model definitions indicates that Gemini models support reasoning natively. However, GSD's thinking toggle UI does **not** control Gemini's internal reasoning behavior — it's informational only. All Gemini 2.x/3.x models use reasoning by default.

### Tool Routing

The provider workspace uses a restrictive denylist (`excludeTools`) that blocks all tools except `google_web_search`. This is intentional for safety but means:
- New tools added by Google in future A2A versions will be auto-approved
- MCP tools are bridged separately via the MCP server
- Native GSD tools are not available through A2A

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

### Type Checking

```bash
npm run typecheck
```

## License

MIT
