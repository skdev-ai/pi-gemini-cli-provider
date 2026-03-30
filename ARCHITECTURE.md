# Architecture

Technical details on how the Gemini CLI provider extension works.

## Overview

```
GSD Session(s)
    |
    +- Extension (pi-gemini-cli-provider)
    |     |
    |     +- stream-simple.ts      Orchestration: prompt -> SSE -> tool loop -> response
    |     +- a2a-client.ts         HTTP transport (JSON-RPC 2.0)
    |     +- a2a-lifecycle.ts      Server spawn, health check, detached process management
    |     +- event-bridge.ts       A2A events -> GSD AssistantMessage format
    |     +- approval-flow.ts      Tool routing (MCP vs native), prefix stripping
    |     +- sse-parser.ts         SSE stream parsing, tool call extraction
    |     +- task-manager.ts       Local task state, pending tool tracking
    |     +- url-resolver.ts       Vertex grounding redirect URL resolution
    |     +- tool-schema-writer.ts GSD active tools -> MCP JSON schemas
    |
    +- A2A Server (detached process, shared)
          |
          +- @google/gemini-cli-a2a-server (patched)
          +- MCP Bridge (reads tool-schemas.json)
          +- Gemini API (Google Cloud)
```

## A2A Protocol

Communication uses JSON-RPC 2.0 over HTTP with SSE responses:

- **`message/stream`** — Send prompt, receive streamed response events
- **`message/stream` with tool confirmation** — Approve native tool execution
- **`inject_result`** — Custom method for returning MCP tool results to an in-progress task

All requests go to `POST http://localhost:41242/` with the method specified in the JSON-RPC body.

## Tool Bridge

GSD's tools are exposed to Gemini through a two-stage bridge:

1. **Schema export** — `tool-schema-writer.ts` reads GSD's active tool list via `pi.getActiveTools()` and writes MCP-compatible JSON schemas to `tool-schemas.json` in the workspace directory
2. **MCP server** — The A2A server's built-in MCP bridge reads these schemas and registers them as available functions for the Gemini model
3. **Invocation** — When Gemini calls a tool (e.g., `mcp_tools_read`), the A2A server enters `awaiting_approval` state. The extension detects this, classifies the tool as MCP, and returns `stopReason: toolUse` to GSD
4. **Execution** — GSD executes the tool natively and re-calls the extension with the result
5. **Reinjection** — The extension sends the result back via `inject_result`, the A2A server resumes Gemini's generation

Tool names are prefixed with `mcp_tools_` by the A2A server's MCP bridge. The extension strips this prefix for GSD compatibility.

## Native Tool Handling

Gemini's built-in tools (`google_web_search`, `web_fetch`) execute server-side — they don't need GSD execution:

- Extension detects native tools via `isNativeTool()` check
- Auto-approves with `proceed_once` outcome
- Results rendered as `nativeToolText` (heading + blockquote) in the text stream, positioned before model response text
- Vertex AI grounding redirect URLs resolved to actual website URLs via HEAD requests

Native tools are NOT added to `partial.toolCalls` — this prevents GSD from attempting to execute them or displaying them in the tool execution UI.

## Server Lifecycle

The A2A server is spawned as a fully detached process:

- **Spawn**: `stdio: ['ignore', fd, fd]` with file descriptors (log files when `GCS_DEBUG=1`, `/dev/null` otherwise), `detached: true`, `child.unref()`. No pipes to parent — prevents SIGHUP on parent exit.
- **Readiness**: Health check polling (500ms intervals) instead of stdout marker parsing
- **Reuse**: On startup, checks port health before spawning. If healthy server found, captures PID and reuses
- **Persistence**: Survives GSD exit. Multiple concurrent GSD sessions share one server
- **Logs**: When `GCS_DEBUG=1`, stdout/stderr written to `/tmp/a2a-server-stdout.log` and `/tmp/a2a-server-stderr.log`

## A2A Server Patches

The extension applies four patches to the A2A server bundle (`a2a-server.mjs`). These patches are version-specific to `@google/gemini-cli-a2a-server@0.34.0`.

### Patch 1 — Non-YOLO Approval Flow

Enables `awaiting_approval` task state for tool calls instead of auto-executing. Required for the MCP tool bridge to work — without this, the A2A server would execute tools directly and GSD would never see them.

### Patch 2 — Per-Request Model Override

Reads `metadata._model` from the JSON-RPC message and overrides the model for that request. Allows GSD's model picker to control which Gemini model is used per-request.

### Patch 3 — inject_result Handler

Adds a custom JSON-RPC method for returning tool execution results to an in-progress task. Publishes `TOOL_CONFIRMATION_RESPONSE` to the message bus to unblock the scheduler's `resolveConfirmation()` wait. Without this patch, the scheduler deadlocks after the first tool call — `isProcessing` stays true and all subsequent tool calls are enqueued forever.

### Patch 4 — Socket Close Preservation

Prevents the server from aborting tasks with pending tool calls when the HTTP socket closes. When a task is in `input-required` state (awaiting tool results), socket close is ignored instead of triggering abort. This is critical for the reinjection flow where the original SSE connection may close between tool execution and result delivery.

## Error Handling

- **Stream errors**: Logged unconditionally to `.debug/debug.log` (not gated by `GCS_DEBUG`)
- **HTTP errors**: Response body captured and logged
- **Tool failures**: `rejectResult()` used instead of `resolveResult()` — crashes GSD cleanly rather than leaving it stuck waiting
- **Server crashes**: Health monitor (30s interval) detects failures; respawns unless manually stopped
