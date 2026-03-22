/**
 * Gemini LLM Provider Extension for Pi/GSD
 *
 * Routes LLM calls through Gemini CLI's A2A server.
 * Tool execution is bridged via MCP server back to GSD.
 *
 * Architecture:
 * - A2A server: prompt bridge (conversation channel)
 * - MCP server: tool bridge (execution channel)
 * - GSD callback server: tool execution endpoint
 */

// TODO: Implement after spike tests validate the architecture
// Spike 1: MCP tool discovery via A2A workspace
// Spike 2: MCP tool execution callback to GSD
// Spike 3: A2A SSE → GSD AssistantMessageEventStream

export default function(pi: any) {
  // Placeholder — will register provider after spikes
}
