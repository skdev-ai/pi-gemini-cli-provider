# pi-gemini-cli-provider

A [GSD-2](https://github.com/gsd-build/gsd-2) extension that adds Google Gemini as an LLM provider, routing model calls through Google's Gemini CLI via the A2A (Agent-to-Agent) protocol.

Use Gemini models (Flash, Pro) inside GSD with full tool support — the same tools available in GSD-2 work with Gemini, plus Gemini's native `google_web_search` and `web_fetch` capabilities.

## Why This Approach

Google's Gemini CLI includes an A2A server that exposes Gemini models over HTTP with tool calling support. This extension bridges that server into GSD's provider system, giving you:

- **No API key needed** — uses your existing Google AI Pro subscription via Gemini CLI OAuth
- **Full tool support** — GSD's tools (Read, Edit, Bash, Grep, etc.) are exposed to the model via MCP
- **Native search and fetch** — Gemini's built-in `google_web_search` and `web_fetch` run server-side with no extra setup
- **Multi-turn context** — conversation history maintained per A2A task; GSD session resets (`/clear`, `/new`, workflow steps) start fresh tasks
- **Shared server** — one A2A server process shared across all GSD sessions, survives GSD exit

**Approach to ToS:** The extension spawns official Google binaries (`@google/gemini-cli-a2a-server`) using the same OAuth credentials as regular Gemini CLI usage. All communication uses Google's own A2A protocol. See the [search extension's ToS discussion](https://github.com/skdev-ai/pi-gemini-cli-search#why-this-approach) for details.

> **DISCLAIMER:** Google's [ToS](https://geminicli.com/docs/resources/tos-privacy/) regarding third-party access to Gemini CLI services is ambiguous. A Google maintainer has [indicated](https://github.com/google-gemini/gemini-cli/discussions/22970#discussioncomment-16198982) that ACP-based integration "sounds like a legitimate use," but this is not a policy commitment. **Use at your own risk.**

## Prerequisites

- **Gemini CLI** installed globally: `npm install -g @google/gemini-cli`
- **Google OAuth** authenticated: run `gemini` once to complete browser auth flow
- **[GSD-2](https://github.com/gsd-build/gsd-2)** (v2.30.0+)

## Installation

```bash
curl -fsSL https://raw.githubusercontent.com/skdev-ai/pi-gemini-cli-provider/main/install.sh | bash
```

Or manually:

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/skdev-ai/pi-gemini-cli-provider.git
cd pi-gemini-cli-provider
npm install
```

### Setup

1. Start GSD
2. Run `/gemini-cli install-a2a` to install and patch the A2A server
3. Select a Gemini model from the model picker (e.g., `gemini-2.5-flash`, `gemini-2.5-pro`)

## How It Works

The extension registers Gemini models as GSD LLM providers. When you select a Gemini model:

1. **Server startup** — The A2A server is spawned (or reused if already running from another session)
2. **Prompt routing** — Your prompt is sent to the A2A server via HTTP SSE
3. **Tool calling** — GSD's active tools are exported as MCP schemas to the A2A server. When Gemini calls a tool, the extension hands it back to GSD for execution, then reinjects the result
4. **Native tools** — Gemini's `google_web_search` and `web_fetch` run server-side automatically. Results are displayed inline with resolved source URLs

### Tool Flow

```
You type a prompt
  -> Extension sends to A2A server (HTTP SSE)
  -> Gemini processes, may call tools:
      MCP tools (Read, Edit, Bash, etc.)
        -> Extension returns to GSD -> GSD executes -> result reinjected
      Native tools (google_web_search, web_fetch)
        -> Gemini executes server-side -> results displayed inline
  -> Final response streamed back to GSD
```

### A2A Server

The A2A server runs as a detached process shared across all GSD sessions. First session spawns it, subsequent sessions detect and reuse it via health check. The server persists after GSD exits.

The `/gemini-cli install-a2a` command installs `@google/gemini-cli-a2a-server` globally and applies required patches for tool approval flow, result reinjection, and model override support.

**Version pinning:** The extension requires `@google/gemini-cli-a2a-server@0.34.0` specifically. The `/gemini-cli install-a2a` command pins this version and applies required patches to the bundle. Do not update the A2A server package independently — newer versions will break patch compatibility and may change internal APIs. Wait for an extension update that supports the new version.

### Commands

| Command | Description |
|---|---|
| `/gemini-cli install-a2a` | Install and patch the A2A server |
| `/gemini-cli server start` | Start the A2A server |
| `/gemini-cli server stop` | Stop the A2A server |
| `/gemini-cli server restart` | Restart the A2A server |
| `/gemini-cli server status` | Show server status and uptime |

## Models

Any model available through the Gemini API can be selected from GSD's model picker.

**Rate limiting:** Starting March 25, 2026, Google has implemented [aggressive rate limiting](https://github.com/google-gemini/gemini-cli/discussions/22970) for Pro models, even for paying accounts.

## Known Limitations

- **Context window overflow**: The A2A server accumulates conversation history per task with no compaction. Gemini models have 1M token context windows. Very long sessions may eventually hit this limit, resulting in an API error. Start a new session (`/clear`) to reset.
- **No token usage reporting**: The A2A protocol does not expose token usage metadata. GSD's auto-compaction cannot trigger based on context fullness.
- **Gemini rate limiting**: Google has implemented aggressive rate limiting for Pro models. Flash models are less affected. When rate-limited, the model response may take 60-120 seconds.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for technical details on the A2A protocol integration, MCP tool bridge, native tool handling, and server patches.

## License

MIT
