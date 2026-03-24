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

## Shared-Server Coexistence

The provider extension is designed to **share the same non-YOLO A2A server** with the search extension (`gemini-cli-search`) on port 41242. This shared-server model enables:

- **Single Server Instance**: Both provider and search traffic use the same A2A server process
- **No Workspace Switching**: No need for separate workspaces or `/model`-driven restarts
- **Independent Counters**: Separate `searchCount` and `providerTaskCount` diagnostics
- **Coexistence Without Conflict**: Both extensions can operate simultaneously without interference

### Prerequisites for Coexistence

For shared-server operation to work correctly:

1. **Search Extension Installed**: The `gemini-cli-search` extension must be loaded in GSD
2. **A2A Server Patched**: All 3 patches must be applied (Patch 1: headless, Patch 2: _model, Patch 3: inject_result)
3. **Non-YOLO Mode**: Server must run in non-YOLO mode (default for provider safety)

### Detecting Coexistence Issues

Run the coexistence test to verify shared-server behavior:

```bash
GEMINI_A2A_LIVE=1 npm test -- src/coexistence.test.ts
```

**If the search extension is not installed**, the test will skip with a clear prerequisite message:
```
Prerequisites not met: Search extension (gemini-cli-search) not found...
```

**If the test fails**, it indicates a shared-server regression where:
- Provider and search extensions cannot coexist on the same server
- Workspace switching or restart is required (broken boundary)
- Counters are not being tracked independently

### Status Diagnostics

Check `/gemini-cli status` to see both traffic counters:

```
A2A Server Status:
- Status: `running`
- Port: `41242`
- Uptime: `3600s`
- Search Count: `42`
- Provider Task Count: `17`
```

- **Search Count**: Number of search requests processed (from search extension)
- **Provider Task Count**: Number of LLM tasks processed (from provider extension)

Both counters increment independently and trigger automatic restart at 1000 to prevent memory leaks.

### Restart Threshold Behavior

The server automatically restarts when either counter reaches 1000:

- **Search restart**: When `searchCount >= 1000`, server restarts and counter resets to 0
- **Provider restart**: When `providerTaskCount >= 1000`, server restarts and counter resets to 0

Restart is graceful:
1. Server stops cleanly
2. Counter resets to 0
3. Server restarts with same configuration
4. No workspace or model reselection required

## Operational Runbook

This section provides step-by-step guidance for operators managing the provider extension in production or development environments.

### Selecting the Provider

1. **Load the Extension** (automatic on GSD startup):
   - Extension registers `gemini-a2a` provider automatically
   - `/gemini-cli` command becomes available

2. **Install A2A Server** (first-time setup only):
   ```
   /gemini-cli install-a2a
   ```
   
   Wait for confirmation: "A2A installation complete! Starting server..."

3. **Select a Model**:
   ```
   /model
   ```
   
   Choose any `gemini-*` model (e.g., `gemini-2.5-pro`, `gemini-2.5-flash`)

4. **Verify Provider Active**:
   - Selected model shows in GSD status bar
   - Provider will route requests through A2A server

### Checking Health

**Quick Health Check**:
```
/gemini-cli status
```

Look for:
- ✅ Status: `running`
- ✅ Port: `41242`
- ✅ Patch status: All 3 patches show ✓
- ✅ Search Count and Provider Task Count present

**Detailed Diagnostics**:
```
/gemini-cli status
```

Review:
- **Uptime**: Should be increasing (not constantly restarting)
- **Search Count / Provider Task Count**: Track independently
- **Last Error**: Should be null (or recent if recovery occurred)
- **Exit Code**: Should be null (non-null indicates crash)

**Live Test Verification**:
```bash
GEMINI_A2A_LIVE=1 npm test -- src/coexistence.test.ts
```

Expected outcomes:
- ✅ All 13 tests pass
- ✅ Search extension detected
- ✅ Server healthy
- ✅ Independent counters working
- ✅ Restart thresholds trigger correctly

### Understanding Task/Search Counters

**Search Count**:
- Incremented by search extension (`gemini-cli-search`)
- Resets to 0 after reaching 1000 (automatic restart)
- Visible in `/gemini-cli status` output

**Provider Task Count**:
- Incremented by provider extension for each LLM request
- Resets to 0 after reaching 1000 (automatic restart)
- Visible in `/gemini-cli status` output

**Why Two Counters?**:
- Enables independent diagnostics for each traffic type
- Helps identify which extension is driving server load
- Both trigger restart at 1000 to prevent memory leaks

### Recovery Procedures

#### Server Won't Start

1. **Check Patch Status**:
   ```
   /gemini-cli status
   ```
   
   If patches missing (✗), reinstall:
   ```
   /gemini-cli install-a2a
   ```

2. **Check Port Conflict**:
   ```bash
   lsof -i :41242
   ```
   
   If another process is using the port:
   ```bash
   kill -9 <PID>
   ```
   
   Then restart:
   ```
   /gemini-cli server restart
   ```

3. **Check Authentication**:
   ```bash
   gemini auth login
   ```
   
   Verify OAuth token is valid:
   ```bash
   ls ~/.gemini/oauth_creds.json
   ```

#### Server Crashes Repeatedly

1. **Check Last Error**:
   ```
   /gemini-cli status
   ```
   
   Look for `Last Error` field with error type and message.

2. **Check Stderr Buffer**:
   ```
   /gemini-cli status
   ```
   
   Review last 10 lines of stderr for crash details.

3. **Manual Restart**:
   ```
   /gemini-cli server restart
   ```

4. **If Crash Persists**:
   - Stop server: `/gemini-cli server stop`
   - Check logs in workspace: `~/.pi/agent/extensions/pi-gemini-cli-provider/a2a-workspace/`
   - Restart: `/gemini-cli server start`

#### Shared-Server Regression

Symptoms: Provider and search extensions cannot coexist.

1. **Run Coexistence Test**:
   ```bash
   GEMINI_A2A_LIVE=1 npm test -- src/coexistence.test.ts
   ```
   
   Identify failure mode:
   - Search extension not detected → Install search extension
   - Server unhealthy → Check server logs
   - Counters not independent → Check lifecycle code

2. **Verify Single Server Instance**:
   ```bash
   lsof -i :41242
   ```
   
   Should show only ONE A2A server process.

3. **Check Both Extensions Loaded**:
   - Provider: `/gemini-cli status` works
   - Search: `/gcs status` works (if search extension installed)

4. **Restart Server**:
   ```
   /gemini-cli server restart
   ```

#### Memory Leak Suspected

Symptoms: Server slows down or crashes after extended use.

1. **Check Counter Values**:
   ```
   /gemini-cli status
   ```
   
   If either counter is near 1000, restart is imminent (automatic).

2. **Manual Restart** (don't wait for threshold):
   ```
   /gemini-cli server restart
   ```

3. **Monitor Uptime**:
   - Note restart time
   - Check if crashes occur before 1000 tasks
   - If yes, investigate memory profiling

### Manual Verification Steps

To manually verify the slice is working:

1. **Start Server**:
   ```
   /gemini-cli server start
   ```

2. **Check Status**:
   ```
   /gemini-cli status
   ```
   
   Verify:
   - Status: `running`
   - Both counters present
   - Patches all ✓

3. **Run Unit Tests**:
   ```bash
   npm test -- src/a2a-lifecycle.test.ts src/gemini-cli-command.test.ts
   ```

4. **Run Live Coexistence Test**:
   ```bash
   GEMINI_A2A_LIVE=1 npm test -- src/coexistence.test.ts
   ```

5. **Run Live Integration Test**:
   ```bash
   GEMINI_A2A_LIVE=1 npm test -- src/integration.test.ts
   ```

6. **Verify Documentation**:
   ```bash
   rg -n "task count|Search Count|/gemini-cli status|coexist|shared server|search extension" README.md
   ```
   
   Should find multiple matches confirming docs are up to date.

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
- ✅ Prerequisite checks (patches, server health)
- ✅ MCP tool call interception (`stopReason: 'toolUse'`)
- ⚠️ Result reinjection via `inject_result` (patch applied, but scheduler doesn't run in headless mode)
- ⚠️ Multi-turn conversation continuity (depends on scheduler)
- ⚠️ Error handling scenarios

**Known Limitations:**
- The A2A server's scheduler doesn't run in headless mode, so model continuation after `inject_result` doesn't trigger automatically
- The `inject_result` patch correctly marks tools as complete, but the scheduler that would continue model generation isn't active
- This is an architectural limitation of the A2A server in headless configurations

**Note:** Live tests may take 30-60 seconds to run as they make real API calls to Gemini. Tests will skip if `GEMINI_A2A_LIVE` is not set to `1`.

### Type Checking

```bash
npm run typecheck
```

## License

MIT
