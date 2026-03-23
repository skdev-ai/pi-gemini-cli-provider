/**
 * Stream Simple Module
 * 
 * Implements the streamSimple orchestration for the Gemini A2A provider.
 * Returns a pi AssistantMessageEventStream that is populated asynchronously
 * from A2A SSE events, with approval interception and result reinjection.
 * 
 * Key behaviors:
 * - Fresh prompts: Stream A2A output until terminal completion or approval interception
 * - MCP approvals: Emit prefix-stripped toolCall blocks, end with stopReason: 'toolUse'
 * - Native approvals: Continue inline without returning control to GSD
 * - Re-calls: Detect toolResult messages, inject results, continue streaming
 */

import type { Context } from './pi-types.js';
import { sendMessageStream, injectResult } from './a2a-client.js';
import { parseSSEStream } from './sse-parser.js';
import {
  createTask,
  createTaskWithIds,
  updateTaskState,
  getTaskState,
  getPendingToolCalls,
  clearPendingToolCalls,
  markTaskFailed,
} from './task-manager.js';
import {
  detectReCall,
  extractAllToolResults,
} from './result-extractor.js';
import {
  classifyToolRouting,
  buildReinjectionWorkList,
  validateReinjectionCompleteness,
} from './approval-flow.js';
import {
  createPartialMessage,
  updatePartialMessage,
  translateEvents,
} from './event-bridge.js';
import type {} from './types.js';

// ============================================================================
// Pi Stream Type (local definition since 'pi' module not available at build time)
// ============================================================================

/**
 * Pi AssistantMessageEventStream interface.
 * Used for streaming assistant messages with text, thinking, and tool call events.
 */
export interface AssistantMessageEventStream {
  sendText(text: string): void;
  sendThinking(thinking: string): void;
  sendToolCall(callId: string, name: string, args: unknown): void;
  error(err: Error): void;
  complete(): void;
  onText(listener: (text: string) => void): () => void;
  onThinking(listener: (thinking: string) => void): () => void;
  onToolCall(listener: (callId: string, name: string, args: unknown) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onComplete(listener: () => void): () => void;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for streamSimple operation.
 */
export interface StreamSimpleParams {
  /** User prompt text */
  prompt: string;
  /** Pi context with message history */
  context: Context;
  /** Optional existing task ID for multi-turn */
  taskId?: string;
  /** Optional context ID for conversation continuity */
  contextId?: string;
  /** Optional model override */
  model?: string;
  /** Optional abort signal */
  signal?: AbortSignal;
}

/**
 * Result from streamSimple operation.
 */
export interface StreamSimpleResult {
  /** Task ID for this conversation */
  taskId: string;
  /** Context ID for multi-turn continuity */
  contextId: string;
  /** Stop reason (toolUse for MCP approvals, undefined otherwise) */
  stopReason?: string;
  /** Final assistant message content */
  message: {
    text: string;
    thinking: string;
    toolCalls: Array<{ callId: string; name: string; args: unknown }>;
  };
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Implements the streamSimple orchestration for Gemini A2A provider.
 * 
 * Returns a pi AssistantMessageEventStream immediately, then populates it
 * asynchronously from A2A SSE events. Handles:
 * 
 * - Fresh prompts: Stream A2A output until completion or approval
 * - MCP approvals: Emit toolCall blocks, return stopReason: 'toolUse'
 * - Native approvals: Auto-approve and continue inline
 * - Re-calls: Detect toolResult messages, inject results, resume streaming
 * 
 * @param params - Stream parameters
 * @returns AssistantMessageEventStream populated with pi events
 */
export async function streamSimple(params: StreamSimpleParams): Promise<{
  stream: AssistantMessageEventStream;
  result: Promise<StreamSimpleResult>;
}> {
  const { prompt, context, taskId, contextId, model, signal } = params;
  
  // Create the stream that will be returned immediately
  const stream = createAssistantMessageEventStream();
  
  // Create a promise that resolves when streaming completes
  const resultPromise = (async (): Promise<StreamSimpleResult> => {
    try {
      // Check if this is a re-call (tool results present)
      const isReCall = detectReCall(context.messages);
      
      if (isReCall) {
        // Handle re-call: inject results and resume streaming
        return await handleReCall(stream, {
          context,
          taskId: taskId!,
          contextId: contextId!,
          model,
          signal,
        });
      } else {
        // Handle fresh prompt: start new task and stream
        return await handleFreshPrompt(stream, {
          prompt,
          context,
          taskId,
          contextId,
          model,
          signal,
        });
      }
    } catch (error) {
      // Handle errors: emit error event and reject
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      stream.error(new Error(errorMessage));
      throw error;
    }
  })();
  
  return {
    stream,
    result: resultPromise,
  };
}

// ============================================================================
// Fresh Prompt Handler
// ============================================================================

/**
 * Handles a fresh prompt (no tool results in context).
 * 
 * @param stream - AssistantMessageEventStream to populate
 * @param params - Handler parameters
 * @returns StreamSimpleResult with task metadata
 */
async function handleFreshPrompt(
  stream: AssistantMessageEventStream,
  params: {
    prompt: string;
    context: Context;
    taskId?: string;
    contextId?: string;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<StreamSimpleResult> {
  const { prompt, taskId, contextId, model, signal } = params;
  
  // Create or resume task
  let taskState;
  if (taskId && contextId) {
    taskState = createTaskWithIds(taskId, contextId);
  } else {
    taskState = createTask();
  }
  
  // Send message to A2A server
  const { taskId: a2aTaskId, contextId: a2aContextId, sseStream } = await sendMessageStream({
    prompt,
    taskId: taskState.taskId,
    contextId: taskState.contextId,
    model,
    signal,
  });
  
  // Consume SSE stream and populate pi stream
  const partialMessage = createPartialMessage();
  let stopReason: string | undefined;
  
  for await (const event of parseSSEStream(sseStream, { signal })) {
    // Update task state
    updateTaskState(a2aTaskId, event);
    
    // Update partial message accumulator
    updatePartialMessage(partialMessage, event);
    
    // Translate and emit pi events (wrap single event in array)
    const piEvents = translateEvents([event]);
    for (const piEvent of piEvents) {
      if (piEvent.type === 'text' && piEvent.content) {
        stream.sendText(piEvent.content as string);
      } else if (piEvent.type === 'thinking' && piEvent.content) {
        stream.sendThinking(piEvent.content as string);
      } else if (piEvent.type === 'toolCall') {
        const toolCall = piEvent.content as any;
        stream.sendToolCall(toolCall.callId, toolCall.name, toolCall.args);
      }
    }
    
    // Check for approval state
    const updatedState = getTaskState(a2aTaskId);
    if (updatedState?.awaitingApproval) {
      // Get pending tool calls
      const pendingToolCalls = getPendingToolCalls(a2aTaskId);
      
      if (pendingToolCalls.length > 0) {
        // Classify routing
        const routingDecisions = pendingToolCalls.map(classifyToolRouting);
        const hasMcpCalls = routingDecisions.some(r => r.routing === 'mcp');
        const hasNativeCalls = routingDecisions.some(r => r.routing === 'native');
        
        if (hasMcpCalls) {
          // MCP calls present - return control to GSD
          stopReason = 'toolUse';
          break;
        }
        
        if (hasNativeCalls && !hasMcpCalls) {
          // Only native calls - auto-approve and continue
          // For S04, we'll return toolUse for all approvals to keep scope manageable
          stopReason = 'toolUse';
          break;
        }
      }
    }
    
    // Check for terminal state
    if (updatedState?.isTerminal) {
      break;
    }
  }
  
  // Build final message (remove unused finalState)
  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map(call => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
    })),
  };
  
  return {
    taskId: a2aTaskId,
    contextId: a2aContextId,
    stopReason,
    message: finalMessage,
  };
}

// ============================================================================
// Re-call Handler
// ============================================================================

/**
 * Handles a re-call (tool results present in context).
 * 
 * Detects toolResult messages, builds reinjection work list,
 * calls injectResult() for each completed tool, and resumes streaming.
 * 
 * @param stream - AssistantMessageEventStream to populate
 * @param params - Handler parameters
 * @returns StreamSimpleResult with task metadata
 */
async function handleReCall(
  stream: AssistantMessageEventStream,
  params: {
    context: Context;
    taskId: string;
    contextId: string;
    model?: string;
    signal?: AbortSignal;
  }
): Promise<StreamSimpleResult> {
  const { context, taskId, contextId, model, signal } = params;
  
  // Extract tool results from context.messages
  const extractedResults = extractAllToolResults(context.messages);
  
  if (extractedResults.length === 0) {
    throw new Error('Re-call detected but no tool results found in context');
  }
  
  // Get pending tool calls from task state
  const pendingToolCalls = getPendingToolCalls(taskId);
  
  if (pendingToolCalls.length === 0) {
    throw new Error('Re-call detected but task has no pending tool calls');
  }
  
  // Validate reinjection completeness
  const validation = validateReinjectionCompleteness(pendingToolCalls, extractedResults);
  if (!validation.isValid) {
    throw new Error(
      `Missing results for tool calls: ${validation.missingCallIds.join(', ')}`
    );
  }
  
  // Build reinjection work list
  const workItems = buildReinjectionWorkList(pendingToolCalls, extractedResults);
  
  // Inject results in order (preserving original tool call order)
  for (const item of workItems) {
    try {
      const { sseStream } = await injectResult({
        taskId,
        callId: item.callId,
        toolName: item.toolName,
        functionResponse: item.result.response,
        signal,
      });
      
      // Consume the injection response stream
      // This may contain acknowledgments or immediate follow-up events
      for await (const event of parseSSEStream(sseStream, { signal })) {
        updateTaskState(taskId, event);
        
        // Translate and emit any events from injection response (wrap single event in array)
        const piEvents = translateEvents([event]);
        for (const piEvent of piEvents) {
          if (piEvent.type === 'text' && piEvent.content) {
            stream.sendText(piEvent.content as string);
          } else if (piEvent.type === 'thinking' && piEvent.content) {
            stream.sendThinking(piEvent.content as string);
          } else if (piEvent.type === 'toolCall') {
            const toolCall = piEvent.content as any;
            stream.sendToolCall(toolCall.callId, toolCall.name, toolCall.args);
          }
        }
      }
    } catch (error) {
      // Injection failed - mark task as failed
      const errorMessage = error instanceof Error ? error.message : 'Result injection failed';
      markTaskFailed(taskId, errorMessage);
      throw new Error(`Failed to inject result for ${item.callId}: ${errorMessage}`);
    }
  }
  
  // Clear satisfied pending calls from task state
  const injectedCallIds = workItems.map(item => item.callId);
  clearPendingToolCalls(taskId, injectedCallIds);
  
  // Resume streaming the model's response
  // The A2A server will continue from where it left off after receiving results
  const { sseStream } = await sendMessageStream({
    prompt: '', // Empty prompt - we're resuming existing task
    taskId,
    contextId,
    model,
    signal,
  });
  
  // Consume resumed SSE stream
  const partialMessage = createPartialMessage();
  let stopReason: string | undefined;
  
  for await (const event of parseSSEStream(sseStream, { signal })) {
    updateTaskState(taskId, event);
    updatePartialMessage(partialMessage, event);
    
    // Translate and emit pi events (wrap single event in array)
    const piEvents = translateEvents([event]);
    for (const piEvent of piEvents) {
      if (piEvent.type === 'text' && piEvent.content) {
        stream.sendText(piEvent.content as string);
      } else if (piEvent.type === 'thinking' && piEvent.content) {
        stream.sendThinking(piEvent.content as string);
      } else if (piEvent.type === 'toolCall') {
        const toolCall = piEvent.content as any;
        stream.sendToolCall(toolCall.callId, toolCall.name, toolCall.args);
      }
    }
    
    // Check for approval state (may have more tool calls)
    const updatedState = getTaskState(taskId);
    if (updatedState?.awaitingApproval) {
      const morePendingCalls = getPendingToolCalls(taskId);
      if (morePendingCalls.length > 0) {
        // More tool calls - return control to GSD
        stopReason = 'toolUse';
        break;
      }
    }
    
    // Check for terminal state
    if (updatedState?.isTerminal) {
      break;
    }
  }
  
  // Build final message
  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map(call => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
    })),
  };
  
  return {
    taskId,
    contextId,
    stopReason,
    message: finalMessage,
  };
}

// ============================================================================
// Stream Creation Helper
// ============================================================================

/**
 * Creates a pi AssistantMessageEventStream with proper error handling.
 * 
 * Implements the async-population pattern: return stream immediately,
 * populate it from an async worker, and guard against double completion.
 * 
 * @returns AssistantMessageEventStream ready for population
 */
function createAssistantMessageEventStream(): AssistantMessageEventStream {
  // This is a mock implementation for S04
  // In real pi integration, this would use pi's actual stream API
  
  const textListeners: ((text: string) => void)[] = [];
  const thinkingListeners: ((thinking: string) => void)[] = [];
  const toolCallListeners: ((callId: string, name: string, args: unknown) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const completeListeners: (() => void)[] = [];
  
  let completed = false;
  let errored = false;
  
  const stream: AssistantMessageEventStream = {
    sendText(text: string) {
      if (completed || errored) return;
      textListeners.forEach(listener => listener(text));
    },
    
    sendThinking(thinking: string) {
      if (completed || errored) return;
      thinkingListeners.forEach(listener => listener(thinking));
    },
    
    sendToolCall(callId: string, name: string, args: unknown) {
      if (completed || errored) return;
      toolCallListeners.forEach(listener => listener(callId, name, args));
    },
    
    error(err: Error) {
      if (completed || errored) return;
      errored = true;
      errorListeners.forEach(listener => listener(err));
    },
    
    complete() {
      if (completed || errored) return;
      completed = true;
      completeListeners.forEach(listener => listener());
    },
    
    onText(listener: (text: string) => void) {
      textListeners.push(listener);
      return () => {
        const index = textListeners.indexOf(listener);
        if (index > -1) textListeners.splice(index, 1);
      };
    },
    
    onThinking(listener: (thinking: string) => void) {
      thinkingListeners.push(listener);
      return () => {
        const index = thinkingListeners.indexOf(listener);
        if (index > -1) thinkingListeners.splice(index, 1);
      };
    },
    
    onToolCall(listener: (callId: string, name: string, args: unknown) => void) {
      toolCallListeners.push(listener);
      return () => {
        const index = toolCallListeners.indexOf(listener);
        if (index > -1) toolCallListeners.splice(index, 1);
      };
    },
    
    onError(listener: (error: Error) => void) {
      errorListeners.push(listener);
      return () => {
        const index = errorListeners.indexOf(listener);
        if (index > -1) errorListeners.splice(index, 1);
      };
    },
    
    onComplete(listener: () => void) {
      completeListeners.push(listener);
      return () => {
        const index = completeListeners.indexOf(listener);
        if (index > -1) completeListeners.splice(index, 1);
      };
    },
  };
  
  return stream;
}
