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

import { writeToolSchemas } from './tool-schema-writer.js';

interface ExtensionAPI {
  getAllTools(): any[];
  on(event: string, handler: Function): void;
}

interface SessionContext {
  ui: {
    notify(message: string, level: string): void;
  };
}

export default function(pi: ExtensionAPI) {
  // Register session_start handler to write tool schemas before A2A server starts
  // Ordering matters per R015 - schemas must exist before MCP server tools/list handler runs
  pi.on('session_start', (_event: any, ctx: SessionContext) => {
    const result = writeToolSchemas(pi);
    
    // Only notify user if tool list actually changed
    if (result.isStale) {
      ctx.ui.notify('Tool list updated. Restart A2A server to pick up changes.', 'info');
    }
  });
  
  // TODO: Implement A2A server startup after spikes validate architecture
  // Spike 1: MCP tool discovery via A2A workspace
  // Spike 2: MCP tool execution callback to GSD
  // Spike 3: A2A SSE → GSD AssistantMessageEventStream
}
