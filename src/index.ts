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
import { registerGeminiProvider } from './provider-registration.js';
import { handleGeminiCliCommand } from './gemini-cli-command.js';
import { startServer, resetManualStopFlag } from './a2a-lifecycle.js';
import { checkA2AInstalled, checkA2APatched, checkA2AInjectResultPatched } from './availability.js';
import { getA2APackageRoot } from './a2a-path.js';
import { join } from 'node:path';

// Export A2A client for use in provider implementation
export { sendMessageStream, injectResult, approveToolCall } from './a2a-client.js';
export type {
  SendMessageStreamParams,
  SendMessageStreamResult,
  InjectResultParams,
  InjectResultResult,
  ApproveToolCallParams,
  ApproveToolCallResult,
} from './a2a-client.js';

// Export SSE parser for stream processing
export { parseSSEStream, parseA2AResult, extractTextContent, extractToolCall, isAwaitingApproval } from './sse-parser.js';
export type { ParsedA2AEvent } from './types.js';

// Export task manager for state tracking
export {
  createTask,
  createTaskWithIds,
  updateTaskState,
  getTaskState,
  getPendingToolCalls,
  clearPendingToolCalls,
  isAwaitingApproval as taskIsAwaitingApproval,
  isTaskTerminal,
  markTaskFailed,
  deleteTask,
  clearAllTasks,
  hasTask,
} from './task-manager.js';
export type { TaskState, ToolCallMetadata } from './types.js';

// Export A2A lifecycle for server management
export { startServer, stopServer, getServerState } from './a2a-lifecycle.js';

// Export inject_result patch verification
export { checkInjectResultPatched, applyInjectResultPatch } from './inject-result-patch.js';

// Export S04 approval flow primitives
export {
  classifyToolRouting,
  isNativeTool,
  isMcpTool,
  stripMcpPrefix,
  addMcpPrefix,
  buildReinjectionWorkList,
  filterWorkItemsByRouting,
  getMcpWorkItems,
  getNativeWorkItems,
  determineStopReason,
  hasApprovalRequired,
  allAutoApproved,
  validateReinjectionCompleteness,
  validateToolResultPayload,
} from './approval-flow.js';
export type {
  ToolRoutingDecision,
  ReinjectionWorkItem,
  ToolResultPayload,
  NativeToolName,
} from './types.js';

// Export S04 result extractor primitives
export {
  detectReCall,
  extractToolResultMessages,
  normalizeToolResult,
  extractAllToolResults,
  groupResultsByCallId,
  hasResultForCallId,
  getResultForCallId,
} from './result-extractor.js';
export type {
  ExtractedToolResult,
  PiToolResultMessage,
} from './types.js';

// Export S04 event bridge primitives
export {
  createPartialMessage,
  updatePartialMessage,
  accumulateEvents,
  convertToolCallToPi,
  convertToolCallsToPi,
  translateTextEvent,
  translateThoughtEvent,
  translateToolCallEvent,
  translateEvent,
  translateEvents,
  extractCompleteMessage,
  hasContent,
  hasToolCalls,
  validateA2AEvent,
  validatePartialMessage,
} from './event-bridge.js';
export type {
  PiAssistantMessageEvent,
  PiToolCallContent,
  PartialAssistantMessage,
} from './types.js';

// Export S04 streamSimple orchestration
export {
  streamSimple,
} from './stream-simple.js';
export type {
  StreamSimpleParams,
  StreamSimpleResult,
} from './stream-simple.js';

interface ExtensionAPI {
  getAllTools(): any[];
  on(event: string, handler: Function): void;
  registerProvider(id: string, config: {
    api: string;
    baseUrl: string;
    apiKey: string;
    models: any[];
    streamSimple: Function;
  }): void;
  registerCommand(name: string, config: {
    description: string;
    handler: (args: string, ctx: any) => Promise<void>;
  }): void;
}

interface SessionContext {
  ui: {
    notify(message: string, level: string): void;
    confirm(title: string, detail: string): Promise<boolean>;
  };
}

export default async function(pi: ExtensionAPI) {
  // ============================================================================
  // Extension Load: Provider Registration, Command Registration, Workspace Prep
  // ============================================================================
  
  // Register provider on extension load (before any LLM requests)
  try {
    await registerGeminiProvider(pi);
  } catch (error) {
    // Provider registration failure is logged but doesn't block extension load
    // User will see no models available when they run /gemini-cli models
  }

  // Register /gemini-cli command for provider lifecycle management
  pi.registerCommand('gemini-cli', {
    description: 'gemini-a2a provider: status | install-a2a | server [start|stop|restart] | models',
    handler: async (args: string, ctx: any) => {
      await handleGeminiCliCommand(args, ctx);
    },
  });

  // Prepare provider workspace on extension load
  // This ensures the workspace exists before A2A server startup
  try {
    const { generateWorkspace } = await import('./workspace-generator.js');
    generateWorkspace();
  } catch (error) {
    // Workspace generation failure doesn't block extension load
    // Will be retried on install-a2a command
  }

  // ============================================================================
  // Session Start: Schema Freshness, Stale Detection, Auto-Startup
  // ============================================================================
  
  // Register session_start handler to write tool schemas before A2A server starts
  // Ordering matters per R015 - schemas must exist before MCP server tools/list handler runs
  pi.on('session_start', async (_event: any, ctx: SessionContext) => {
    const result = writeToolSchemas(pi);
    
    // Only notify user if tool list actually changed
    if (result.isStale) {
      ctx.ui.notify('Tool list updated. Restart A2A server to pick up changes.', 'info');
    }

    // Reset manual stop flag for health monitor
    resetManualStopFlag();

    // Check A2A availability and auto-start if ready
    const isInstalled = checkA2AInstalled();
    const packageRoot = isInstalled ? getA2APackageRoot() : null;
    const bundlePath = packageRoot ? join(packageRoot, 'dist', 'a2a-server.mjs') : null;
    const isPatched = bundlePath ? checkA2APatched(bundlePath) : false;
    const isInjectResultPatched = checkA2AInjectResultPatched();

    if (isInstalled && isPatched && isInjectResultPatched) {
      // Fire-and-forget startup with user notification on failure
      startServer().catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`A2A server failed to start: ${message}`, 'warning');
      });
    }
  });
  
  // TODO: Implement A2A server startup after spikes validate architecture
  // Spike 1: MCP tool discovery via A2A workspace
  // Spike 2: MCP tool execution callback to GSD
  // Spike 3: A2A SSE → GSD AssistantMessageEventStream
}
