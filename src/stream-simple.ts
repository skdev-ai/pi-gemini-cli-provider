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
import { sendMessageStream, injectResult, approveToolCall } from './a2a-client.js';
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
import { incrementProviderTaskCount } from './a2a-lifecycle.js';

// =============================================================================
// Pi Stream Type (local definition since 'pi' module not available at build time)
// =============================================================================

/**
 * Pi AssistantMessageEventStream interface.
 * Matches GSD's actual AssistantMessageEventStream contract.
 * Uses push() with event objects instead of sendText/sendThinking/etc.
 */
export interface AssistantMessageEventStream {
  /** Push an event to the stream */
  push(event: AssistantMessageEvent): void;
  /** Signal an error */
  error(err: Error): void;
  /** Signal completion */
  complete(): void;
  /** End the stream */
  end?(): void;
  /** Register event listener (for testing) */
  onEvent?(listener: (event: AssistantMessageEvent) => void): () => void;
  /** Register error listener (for testing) */
  onError?(listener: (error: Error) => void): () => void;
  /** Register complete listener (for testing) */
  onComplete?(listener: () => void): () => void;
}

/**
 * Assistant message event types compatible with GSD's contract.
 */
export type AssistantMessageEvent =
  | { type: 'text_delta'; delta: string; partial?: boolean }
  | { type: 'thinking_delta'; delta: string; partial?: boolean }
  | { type: 'tool_call'; callId: string; name: string; args: unknown }
  | { type: 'tool_call_delta'; callId: string; nameDelta?: string; argsDelta?: unknown }
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'toolCall'; callId: string; name: string; args: unknown };

// =============================================================================
// Types
// =============================================================================

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

// =============================================================================
// Main Entry Point - SYNCHRONOUS (GSD-compatible)
// =============================================================================

/**
 * Implements the streamSimple orchestration for Gemini A2A provider.
 * 
 * CRITICAL: This function is SYNCHRONOUS and returns the stream immediately.
 * Async work happens in a fire-and-forget IIFE that populates the stream.
 * 
 * Pattern matches custom-provider-anthropic:
 * 1. Create stream
 * 2. Start async IIFE that populates stream via push()
 * 3. Return stream immediately (don't await, don't wrap in Promise)
 * 
 * @param params - Stream parameters
 * @returns AssistantMessageEventStream (synchronous return)
 */
export function streamSimple(params: StreamSimpleParams): {
  stream: AssistantMessageEventStream;
  result: Promise<StreamSimpleResult>;
} {
  const { prompt, context, taskId, contextId, model, signal } = params;
  
  // Step 1: Create the stream that will be returned immediately
  const stream = createAssistantMessageEventStream();
  
  // Step 2: Create a promise for the result (tracked separately)
  let resolveResult!: (value: StreamSimpleResult) => void;
  let rejectResult!: (reason: Error) => void;
  const resultPromise = new Promise<StreamSimpleResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  
  // Step 3: Fire-and-forget async work that populates the stream
  (async () => {
    try {
      // Increment provider task count for tracking and restart mitigation
      await incrementProviderTaskCount();
      
      // Check if this is a re-call (tool results present)
      const isReCall = detectReCall(context.messages);
      
      let result: StreamSimpleResult;
      
      if (isReCall) {
        // Handle re-call: inject results and resume streaming
        result = await handleReCall(stream, {
          context,
          taskId: taskId!,
          contextId: contextId!,
          model,
          signal,
        });
      } else {
        // Handle fresh prompt: start new task and stream
        result = await handleFreshPrompt(stream, {
          prompt,
          context,
          taskId,
          contextId,
          model,
          signal,
        });
      }
      
      // Resolve the result promise
      resolveResult(result);
    } catch (error) {
      // Handle errors: emit error event and reject result promise
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      stream.error(new Error(errorMessage));
      rejectResult(new Error(errorMessage));
    }
  })();
  
  // Step 4: Return immediately with stream and result promise
  return {
    stream,
    result: resultPromise,
  };
}

// =============================================================================
// GSD-Compatible Export (correct signature)
// =============================================================================

/**
 * Minimal type definitions for GSD compatibility.
 * These match what GSD actually passes to streamSimple.
 */
interface Model {
  id: string;
  provider?: string;
  api?: string;
  baseUrl?: string;
}

interface SimpleStreamOptions {
  signal?: AbortSignal;
  reasoning?: string;
  thinkingBudgets?: Record<string, number>;
  maxTokens?: number;
  apiKey?: string;
}

/**
 * GSD-compatible streamSimple wrapper.
 * 
 * Signature matches GSD's contract:
 *   streamSimple(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream
 * 
 * Returns the stream synchronously (fire-and-forget pattern).
 * The async work happens in the background, populating the stream.
 * 
 * @param model - Model configuration (includes model.id for _model metadata)
 * @param context - Pi context with message history and tools
 * @param options - Optional stream options (signal, reasoning, etc.)
 * @returns AssistantMessageEventStream populated with pi events
 */
export function streamSimpleGsd(
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  // Extract what we need from model/context/options
  const lastMessage = context.messages[context.messages.length - 1];
  const prompt = typeof lastMessage === 'object' && lastMessage && 'content' in lastMessage ? (lastMessage as any).content : '';
  
  // Call our internal implementation (returns synchronously now!)
  const { stream } = streamSimple({
    prompt,
    context,
    model: model.id,
    signal: options?.signal,
  });
  
  return stream;
}

// =============================================================================
// Fresh Prompt Handler
// =============================================================================

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
        stream.push({ type: "text_delta", delta: piEvent.content as string });
      } else if (piEvent.type === 'thinking' && piEvent.content) {
        stream.push({ type: "thinking_delta", delta: piEvent.content as string });
      } else if (piEvent.type === 'toolCall') {
        const toolCall = piEvent.content as any;
        stream.push({ type: "tool_call", callId: toolCall.callId, name: toolCall.name, args: toolCall.args });
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
          // Only native calls - auto-approve by sending proceed_once outcome
          // This tells the A2A server to execute the native tool and continue
          
          // Approve all native tool calls
          for (const toolCall of pendingToolCalls) {
            try {
              const { sseStream: approveStream } = await approveToolCall({
                taskId: a2aTaskId,
                callId: toolCall.callId,
                outcome: 'proceed_once',
                signal,
              });
              
              // Consume the approval response stream
              // This contains the model's continued output after tool execution
              for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
                updateTaskState(a2aTaskId, approveEvent);
                updatePartialMessage(partialMessage, approveEvent);
                
                const approvePiEvents = translateEvents([approveEvent]);
                for (const piEvent of approvePiEvents) {
                  if (piEvent.type === 'text' && piEvent.content) {
                    stream.push({ type: "text_delta", delta: piEvent.content as string });
                  } else if (piEvent.type === 'thinking' && piEvent.content) {
                    stream.push({ type: "thinking_delta", delta: piEvent.content as string });
                  } else if (piEvent.type === 'toolCall') {
                    const toolCallEvent = piEvent.content as any;
                    stream.push({ type: "tool_call", callId: toolCallEvent.callId, name: toolCallEvent.name, args: toolCallEvent.args });
                  }
                }
                
                // Check for terminal state or more approvals
                const approvedState = getTaskState(a2aTaskId);
                if (approvedState?.isTerminal) {
                  break;
                }
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Auto-approval failed';
              markTaskFailed(a2aTaskId, errorMessage);
              throw new Error(`Failed to auto-approve native tool ${toolCall.callId}: ${errorMessage}`);
            }
          }
          
          // Clear the approved tool calls
          clearPendingToolCalls(a2aTaskId, pendingToolCalls.map(tc => tc.callId));
          
          // Don't break - we've already consumed the resumed stream from approval
          // Just continue to build final message
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

// =============================================================================
// Re-call Handler
// =============================================================================

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
  const { context, taskId, contextId, signal } = params;
  
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
  
  // Accumulator for the final message
  const partialMessage = createPartialMessage();
  let stopReason: string | undefined;
  
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
      // This contains the model's continuation after result injection
      for await (const event of parseSSEStream(sseStream, { signal })) {
        updateTaskState(taskId, event);
        updatePartialMessage(partialMessage, event);
        
        // Translate and emit any events from injection response (wrap single event in array)
        const piEvents = translateEvents([event]);
        for (const piEvent of piEvents) {
          if (piEvent.type === 'text' && piEvent.content) {
            stream.push({ type: "text_delta", delta: piEvent.content as string });
          } else if (piEvent.type === 'thinking' && piEvent.content) {
            stream.push({ type: "thinking_delta", delta: piEvent.content as string });
          } else if (piEvent.type === 'toolCall') {
            const toolCall = piEvent.content as any;
            stream.push({ type: "tool_call", callId: toolCall.callId, name: toolCall.name, args: toolCall.args });
          }
        }
        
        // Check for approval state (may have more tool calls after continuation)
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
      
      // If we hit stopReason or terminal state, break out of injection loop
      if (stopReason || getTaskState(taskId)?.isTerminal) {
        break;
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
  
  // Build final message from accumulated partialMessage
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

// =============================================================================
// Stream Creation Helper
// =============================================================================

/**
 * Creates a pi AssistantMessageEventStream with proper error handling.
 * 
 * Implements the async-population pattern: return stream immediately,
 * populate it from an async worker, and guard against double completion.
 * 
 * @returns AssistantMessageEventStream ready for population
 */
function createAssistantMessageEventStream(): AssistantMessageEventStream {
  const eventListeners: ((event: AssistantMessageEvent) => void)[] = [];
  const errorListeners: ((error: Error) => void)[] = [];
  const completeListeners: (() => void)[] = [];
  
  let completed = false;
  let errored = false;
  
  const stream: AssistantMessageEventStream = {
    push(event: AssistantMessageEvent) {
      if (completed || errored) return;
      eventListeners.forEach(listener => listener(event));
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
    
    end() {
      if (completed || errored) return;
      completed = true;
      completeListeners.forEach(listener => listener());
    },
    
    onEvent(listener: (event: AssistantMessageEvent) => void) {
      eventListeners.push(listener);
      return () => {
        const index = eventListeners.indexOf(listener);
        if (index > -1) eventListeners.splice(index, 1);
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
