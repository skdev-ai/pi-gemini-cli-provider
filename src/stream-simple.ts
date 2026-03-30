/**
 * Stream Simple Module
 *
 * Implements the streamSimple orchestration for the Gemini A2A provider.
 * Returns a pi-compatible AssistantMessageEventStream that is populated
 * asynchronously from A2A SSE events, with approval interception and result
 * reinjection.
 */

import type { Context } from './pi-types.js';
import { sendMessageStream, injectResult, approveToolCall } from './a2a-client.js';
import { parseSSEStream } from './sse-parser.js';
import { errorLog } from './logger.js';
import { resolveVertexUrls } from './url-resolver.js';
import {
  createTaskWithIds,
  updateTaskState,
  getTaskState,
  getPendingToolCalls,
  clearPendingToolCalls,
  markTaskFailed,
} from './task-manager.js';
import { detectReCall, extractAllToolResults } from './result-extractor.js';
import {
  classifyToolRouting,
  buildReinjectionWorkList,
  validateReinjectionCompleteness,
  isNativeTool,
  isMcpTool,
} from './approval-flow.js';
import {
  createPartialMessage,
  updatePartialMessage,
  translateEvents,
} from './event-bridge.js';
import { incrementProviderTaskCount } from './a2a-lifecycle.js';
import type { PiToolCallContent } from './types.js';

// =============================================================================
// Pi stream contract types
// =============================================================================

export interface AssistantMessageTextContent {
  type: 'text';
  text: string;
}

export interface AssistantMessageThinkingContent {
  type: 'thinking';
  thinking: string;
}

export interface AssistantMessageToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, any>;
}

export type AssistantMessageContent =
  | AssistantMessageTextContent
  | AssistantMessageThinkingContent
  | AssistantMessageToolCallContent;

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantMessageContent[];
  api: string;
  provider: string;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';
  errorMessage?: string;
  timestamp: number;
}

export type AssistantMessageEvent =
  | { type: 'start'; partial: AssistantMessage }
  | { type: 'text_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'text_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'text_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'thinking_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'thinking_delta'; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: 'thinking_end'; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: 'toolcall_start'; contentIndex: number; partial: AssistantMessage }
  | { type: 'done'; reason: 'stop' | 'toolUse' | 'length'; message: AssistantMessage }
  | { type: 'error'; reason: 'error' | 'aborted'; error: AssistantMessage };

export interface AssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  push(event: AssistantMessageEvent): void;
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
}

class LocalAssistantMessageEventStream implements AssistantMessageEventStream {
  private queue: AssistantMessageEvent[] = [];
  private waiters: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private isEnded = false;
  private resultValue: AssistantMessage | undefined;
  private resultPromise: Promise<AssistantMessage>;
  private resolveResult!: (value: AssistantMessage) => void;
  private rejectResult!: (reason?: unknown) => void;

  constructor() {
    this.resultPromise = new Promise<AssistantMessage>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.isEnded) {
      return;
    }

    if (event.type === 'done') {
      this.resultValue = event.message;
      this.deliver(event);
      this.end(event.message);
      return;
    }

    if (event.type === 'error') {
      this.resultValue = event.error;
      this.deliver(event);
      this.isEnded = true;
      this.resolvePendingDone();
      this.resolveResult(event.error);
      return;
    }

    this.deliver(event);
  }

  end(result?: AssistantMessage): void {
    if (this.isEnded) {
      return;
    }

    this.isEnded = true;
    if (result) {
      this.resultValue = result;
      this.resolveResult(result);
    } else if (this.resultValue) {
      this.resolveResult(this.resultValue);
    } else {
      this.rejectResult(new Error('Stream ended without a terminal assistant message'));
    }
    this.resolvePendingDone();
  }

  result(): Promise<AssistantMessage> {
    return this.resultPromise;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }

      if (this.isEnded) {
        return;
      }

      const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
        this.waiters.push(resolve);
      });

      if (next.done) {
        return;
      }

      yield next.value;
    }
  }

  private deliver(event: AssistantMessageEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  private resolvePendingDone(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter({ value: undefined as never, done: true });
    }
  }
}

function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new LocalAssistantMessageEventStream();
}

// =============================================================================
// Result types
// =============================================================================

export interface StreamSimpleParams {
  prompt: string;
  context: Context;
  taskId?: string;
  contextId?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface StreamSimpleResult {
  taskId: string;
  contextId: string;
  stopReason?: string;
  message: {
    text: string;
    thinking: string;
    nativeToolText: string;
    toolCalls: Array<{ callId: string; name: string; args: unknown }>;
  };
}

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

interface StreamEventState {
  emittedStart: boolean;
  textIndex: number | null;
  textEmitted: string;
  thinkingIndex: number | null;
  thinkingEmitted: string;
  nativeToolTextIndex: number | null;
  nativeToolTextEmitted: string;
  toolCallIndices: Map<string, number>;
}

interface MessageMetadata {
  api: string;
  provider: string;
  model: string;
}

const DEFAULT_MESSAGE_METADATA: MessageMetadata = {
  api: 'gemini-a2a',
  provider: 'gemini-a2a',
  model: 'unknown',
};

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

let lastTaskId: string | undefined;
let lastContextId: string | undefined;

// =============================================================================
// Public entrypoints
// =============================================================================

export function streamSimple(params: StreamSimpleParams): {
  stream: AssistantMessageEventStream;
  result: Promise<StreamSimpleResult>;
} {
  const { prompt, context, taskId, contextId, model, signal } = params;
  const stream = createAssistantMessageEventStream();

  let resolveResult!: (value: StreamSimpleResult) => void;
  let rejectResult!: (reason: Error) => void;
  const resultPromise = new Promise<StreamSimpleResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  (async () => {
    try {
      await incrementProviderTaskCount();

      const isReCall = Boolean(taskId) && detectReCall(context.messages);
      errorLog('stream', `streamSimple called: taskId=${taskId ?? 'none'} isReCall=${isReCall} prompt=${prompt?.slice(0, 50)}`);
      const result = isReCall
        ? await handleReCall(stream, {
            context,
            taskId: taskId!,
            contextId: contextId!,
            model,
            signal,
          })
        : await handleFreshPrompt(stream, {
            prompt,
            context,
            taskId,
            contextId,
            model,
            signal,
          });

      // Always update — server may assign new IDs on any call
      {
        lastTaskId = result.taskId;
        lastContextId = result.contextId;
        errorLog('stream', `streamSimple completed: resultTaskId=${result.taskId} stopReason=${result.stopReason}`);
      }

      const messageMetadata = createMessageMetadata(model);
      const finalAssistantMessage = buildAssistantMessage(
        result.message,
        messageMetadata,
        mapStopReason(result.stopReason),
      );
      emitDone(stream, finalAssistantMessage);
      resolveResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      errorLog('stream', `streamSimpleGsd failed: ${errorMessage}`, error);
      emitError(stream, createMessageMetadata(model), errorMessage, signal?.aborted === true ? 'aborted' : 'error');
      rejectResult(new Error(errorMessage));
    }
  })();

  return { stream, result: resultPromise };
}

function extractPromptFromContext(context: Context): string {
  if (!context || !Array.isArray(context.messages)) {
    return '';
  }

  for (let i = context.messages.length - 1; i >= 0; i -= 1) {
    const message = context.messages[i];

    if (typeof message !== 'object' || message === null || !('role' in message)) {
      continue;
    }

    if ((message as { role?: unknown }).role !== 'user' || !('content' in message)) {
      continue;
    }

    const content = (message as { content?: unknown }).content;

    if (typeof content === 'string') {
      return content;
    }

    if (!Array.isArray(content)) {
      return '';
    }

    return content
      .filter(
        (block): block is { type: 'text'; text?: unknown } =>
          typeof block === 'object' && block !== null && 'type' in block && (block as { type?: unknown }).type === 'text',
      )
      .map((block) => (typeof block.text === 'string' ? block.text : ''))
      .join('');
  }

  return '';
}

export function streamSimpleGsd(
  model: Model,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const prompt = extractPromptFromContext(context);

  // Always pass lastTaskId when available
  errorLog('stream', `streamSimpleGsd: lastTaskId=${lastTaskId ?? 'none'}`);
  const { stream } = streamSimple({
    prompt,
    context,
    model: model.id,
    signal: options?.signal,
    taskId: lastTaskId,
    contextId: lastContextId,
  });

  return stream;
}

/**
 * Resets multi-turn task context. Called on session_switch to ensure
 * each GSD session gets a fresh A2A task.
 */
export function resetTaskContext(): void {
  lastTaskId = undefined;
  lastContextId = undefined;
}

// =============================================================================
// Fresh prompt flow
// =============================================================================

async function handleFreshPrompt(
  stream: AssistantMessageEventStream,
  params: {
    prompt: string;
    context: Context;
    taskId?: string;
    contextId?: string;
    model?: string;
    signal?: AbortSignal;
  },
): Promise<StreamSimpleResult> {
  const { prompt, taskId, contextId, model, signal } = params;

  // Only send taskId/contextId to A2A server when they came from the server
  // (multi-turn). On first call, let the server create its own task.
  // Local task state is created after we get the server's IDs.
  const { taskId: a2aTaskId, contextId: a2aContextId, sseStream } = await sendMessageStream({
    prompt,
    taskId,
    contextId,
    model,
    signal,
  });

  // Create local task state with the IDs returned by sendMessageStream
  createTaskWithIds(a2aTaskId, a2aContextId);

  const partialMessage = createPartialMessage();
  const eventState = createStreamEventState();
  let stopReason: string | undefined;
  // Track server-assigned task ID (differs from our local a2aTaskId)
  let serverTaskId: string | undefined;
  let serverContextId: string | undefined;

  for await (const event of parseSSEStream(sseStream, { signal })) {
    // Capture server's real task/context IDs from first event.
    // Re-register the task under the server's ID so re-calls can find pending tools.
    if (!serverTaskId && event.serverTaskId) {
      serverTaskId = event.serverTaskId;
      serverContextId = event.serverContextId;
      // Migrate local task state from our generated ID to server's ID
      const existingState = getTaskState(a2aTaskId);
      if (existingState) {
        createTaskWithIds(serverTaskId, serverContextId ?? existingState.contextId);
      }
    }

    errorLog('stream', `SSE event: kind=${event.kind} state=${event.result?.status?.state} final=${event.result?.final} isAwait=${event.isAwaitingApproval} hasToolCall=${!!event.toolCall}`);
    const stateAfter = updateTaskState(serverTaskId ?? a2aTaskId, event);
    if (stateAfter) {
      errorLog('stream', `  taskState: awaiting=${stateAfter.awaitingApproval} pending=${stateAfter.pendingToolCalls.length} state=${stateAfter.state}`);
    }
    const nextPartial = updatePartialMessage(partialMessage, event);
    copyPartialMessage(partialMessage, nextPartial);
    emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]), createMessageMetadata(model));

    const effectiveTaskId = serverTaskId ?? a2aTaskId;
    const updatedState = getTaskState(effectiveTaskId);
    if (updatedState?.awaitingApproval) {
      const _pending = getPendingToolCalls(effectiveTaskId);
      errorLog('stream', `awaitingApproval detected! pendingToolCalls=${_pending.length} tools=${_pending.map(t => t.name).join(',')}`);
      const pendingToolCalls = getPendingToolCalls(effectiveTaskId);

      if (pendingToolCalls.length > 0) {
        const routingDecisions = pendingToolCalls.map(classifyToolRouting);
        const hasMcpCalls = routingDecisions.some((r) => r.routing === 'mcp');
        const hasNativeCalls = routingDecisions.some((r) => r.routing === 'native');

        if (hasMcpCalls) {
          stopReason = 'toolUse';
          break;
        }

        if (hasNativeCalls && !hasMcpCalls) {
          for (const toolCall of pendingToolCalls) {
            try {
              const { sseStream: approveStream } = await approveToolCall({
                taskId: serverTaskId ?? a2aTaskId,
                callId: toolCall.callId,
                outcome: 'proceed_once',
                signal,
              });

              for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
                updateTaskState(effectiveTaskId, approveEvent);
                const approvePartial = updatePartialMessage(partialMessage, approveEvent);
                copyPartialMessage(partialMessage, approvePartial);
                emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([approveEvent]), createMessageMetadata(model));

                const approvedState = getTaskState(effectiveTaskId);
                if (approvedState?.isTerminal) {
                  break;
                }
                // Check if native tool response triggered new MCP tool calls
                if (approvedState?.awaitingApproval) {
                  const newPending = getPendingToolCalls(effectiveTaskId);
                  if (newPending.some((tc) => isMcpTool(tc.name))) {
                    stopReason = 'toolUse';
                    break;
                  }
                }
              }
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Auto-approval failed';
              markTaskFailed(effectiveTaskId, errorMessage);
              throw new Error(`Failed to auto-approve native tool ${toolCall.callId}: ${errorMessage}`);
            }
            if (stopReason === 'toolUse') break;
          }

          clearPendingToolCalls(effectiveTaskId, pendingToolCalls.map((tc) => tc.callId));
        }
      }
    }

    if (updatedState?.isTerminal) {
      break;
    }
  }

  // Post-loop: handle native tool approval after SSE stream closed.
  // The server sends input-required + final=true when tools need approval,
  // which closes the SSE stream. We detect awaitingApproval here and send
  // the approval on a new connection. The approval SSE response carries
  // the tool execution results AND the model's text continuation.
  const effectiveTaskId = serverTaskId ?? a2aTaskId;
  const postLoopState = getTaskState(effectiveTaskId);
  if (postLoopState?.awaitingApproval) {
    const pendingToolCalls = getPendingToolCalls(effectiveTaskId);
    const routingDecisions = pendingToolCalls.map(classifyToolRouting);
    const hasMcpCalls = routingDecisions.some((r) => r.routing === 'mcp');
    const hasNativeCalls = routingDecisions.some((r) => r.routing === 'native');

    if (hasMcpCalls) {
      stopReason = 'toolUse';
    } else if (hasNativeCalls) {
      errorLog('stream', `Post-loop native approval: ${pendingToolCalls.length} native tools`);
      for (const toolCall of pendingToolCalls.filter((tc) => isNativeTool(tc.name))) {
        try {
          const { sseStream: approveStream } = await approveToolCall({
            taskId: effectiveTaskId,
            callId: toolCall.callId,
            outcome: 'proceed_once',
            signal,
          });

          for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
            errorLog('stream', `Approval SSE: kind=${approveEvent.kind} state=${approveEvent.result?.status?.state} final=${approveEvent.result?.final}`);
            updateTaskState(effectiveTaskId, approveEvent);
            const approvePartial = updatePartialMessage(partialMessage, approveEvent);
            copyPartialMessage(partialMessage, approvePartial);
            emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([approveEvent]), createMessageMetadata(model));

            const approvedState = getTaskState(effectiveTaskId);
            if (approvedState?.isTerminal) break;
            // Check if approval response triggered new MCP tool calls
            if (approvedState?.awaitingApproval) {
              const newPending = getPendingToolCalls(effectiveTaskId);
              if (newPending.some((tc) => isMcpTool(tc.name))) {
                stopReason = 'toolUse';
                break;
              }
            }
          }
        } catch (error) {
          errorLog('stream', `Native approval failed for ${toolCall.callId}`, error);
        }
        if (stopReason === 'toolUse') break;
      }
      clearPendingToolCalls(effectiveTaskId, pendingToolCalls.filter((tc) => isNativeTool(tc.name)).map((tc) => tc.callId));
    }
  }

  // Filter out native tool calls from the FINAL message — they are rendered
  // via nativeToolText (fenced code blocks), not as executable toolCall content.
  // Check both original name and native_ prefixed name.
  const mcpToolCalls = partialMessage.toolCalls.filter(
    (call) => !isNativeTool(call.name) && !call.name.startsWith('native_')
  );

  // Resolve vertex grounding redirect URLs in native tool text
  const resolvedNativeToolText = await resolveVertexUrls(partialMessage.nativeToolText);

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    nativeToolText: resolvedNativeToolText,
    toolCalls: mcpToolCalls.map((call) => ({
      callId: call.id,
      name: call.name,
      args: call.arguments,
    })),
  };

  finalizeOpenContent(stream, eventState, finalMessage, createMessageMetadata(model));

  return {
    // Use server-assigned IDs for multi-turn continuity
    taskId: serverTaskId ?? a2aTaskId,
    contextId: serverContextId ?? a2aContextId,
    stopReason,
    message: finalMessage,
  };
}

// =============================================================================
// Re-call flow
// =============================================================================

async function handleReCall(
  stream: AssistantMessageEventStream,
  params: {
    context: Context;
    taskId: string;
    contextId: string;
    model?: string;
    signal?: AbortSignal;
  },
): Promise<StreamSimpleResult> {
  const { context, taskId, contextId, model, signal } = params;

  const extractedResults = extractAllToolResults(context.messages);
  if (extractedResults.length === 0) {
    throw new Error('Re-call detected but no tool results found in context');
  }

  const pendingToolCalls = getPendingToolCalls(taskId);
  const taskState = getTaskState(taskId);
  errorLog('stream', `handleReCall: taskId=${taskId} taskExists=${!!taskState} pending=${pendingToolCalls.length} tools=${pendingToolCalls.map(t => t.name).join(',')} extractedResults=${extractedResults.length}`);
  if (pendingToolCalls.length === 0) {
    throw new Error('Re-call detected but task has no pending tool calls');
  }

  const validation = validateReinjectionCompleteness(pendingToolCalls, extractedResults);
  if (!validation.isValid) {
    throw new Error(`Missing results for tool calls: ${validation.missingCallIds.join(', ')}`);
  }

  const workItems = buildReinjectionWorkList(pendingToolCalls, extractedResults);
  const partialMessage = createPartialMessage();
  const eventState = createStreamEventState();
  let stopReason: string | undefined;
  const injectedCallIds: string[] = [];

  for (const item of workItems) {
    try {
      const { sseStream: injectStream } = await injectResult({
        taskId,
        callId: item.callId,
        toolName: item.toolName,
        functionResponse: item.result.response,
        isError: item.result.isError,
        signal,
      });
      injectedCallIds.push(item.callId);

      for await (const event of parseSSEStream(injectStream, { signal })) {
        updateTaskState(taskId, event);
        const nextPartial = updatePartialMessage(partialMessage, event);
        copyPartialMessage(partialMessage, nextPartial);
        emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]), createMessageMetadata(model));

        const injectState = getTaskState(taskId);
        if (injectState?.awaitingApproval) {
          const newPending = getPendingToolCalls(taskId).filter(
            (tc) => !injectedCallIds.includes(tc.callId)
          );

          const routingDecisions = newPending.map(classifyToolRouting);
          const hasMcpCalls = routingDecisions.some((r) => r.routing === 'mcp');
          const hasNativeCalls = routingDecisions.some((r) => r.routing === 'native');

          if (hasMcpCalls) {
            stopReason = 'toolUse';
            break;
          }

          // Auto-approve native tools (same as handleFreshPrompt)
          if (hasNativeCalls && !hasMcpCalls) {
            for (const tc of newPending.filter((t) => isNativeTool(t.name))) {
              try {
                const { sseStream: approveStream } = await approveToolCall({
                  taskId,
                  callId: tc.callId,
                  outcome: 'proceed_once',
                  signal,
                });
                for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
                  updateTaskState(taskId, approveEvent);
                  const approvePartial = updatePartialMessage(partialMessage, approveEvent);
                  copyPartialMessage(partialMessage, approvePartial);
                  emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([approveEvent]), createMessageMetadata(model));
                  const approvedState = getTaskState(taskId);
                  if (approvedState?.isTerminal) break;
                }
              } catch {
                // Native approval failed — continue, don't block
              }
            }
            clearPendingToolCalls(taskId, newPending.filter((t) => isNativeTool(t.name)).map((t) => t.callId));
          }
        }
        if (injectState?.isTerminal) {
          break;
        }
      }
      if (stopReason === 'toolUse') break;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Result injection failed';
      markTaskFailed(taskId, errorMessage);
      throw new Error(`Failed to inject result for ${item.callId}: ${errorMessage}`);
    }
  }

  // Clear injected calls BEFORE checking for new pending calls.
  clearPendingToolCalls(taskId, injectedCallIds);

  // Check for new tool calls in local task state
  const updatedState = getTaskState(taskId);
  if (updatedState?.awaitingApproval) {
    const morePendingCalls = getPendingToolCalls(taskId);
    if (morePendingCalls.length > 0) {
      const moreRouting = morePendingCalls.map(classifyToolRouting);
      if (moreRouting.some((r) => r.routing === 'mcp')) {
        stopReason = 'toolUse';
      }
    }
  }

  // Resolve vertex grounding redirect URLs in native tool text
  const resolvedNativeToolText = await resolveVertexUrls(partialMessage.nativeToolText);

  // Filter native tools from toolCalls (rendered via nativeToolText instead)
  const mcpToolCalls = partialMessage.toolCalls.filter(
    (call) => !isNativeTool(call.name) && !call.name.startsWith('native_')
  );

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    nativeToolText: resolvedNativeToolText,
    toolCalls: mcpToolCalls.map((call) => ({
      callId: call.id,
      name: call.name,
      args: call.arguments,
    })),
  };

  finalizeOpenContent(stream, eventState, finalMessage, createMessageMetadata(model));

  return {
    taskId,
    contextId,
    stopReason,
    message: finalMessage,
  };
}

// =============================================================================
// Event helpers
// =============================================================================

function createStreamEventState(): StreamEventState {
  return {
    emittedStart: false,
    textIndex: null,
    textEmitted: '',
    thinkingIndex: null,
    thinkingEmitted: '',
    nativeToolTextIndex: null,
    nativeToolTextEmitted: '',
    toolCallIndices: new Map<string, number>(),
  };
}

function emitTranslatedEvents(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  piEvents: Array<{ type: 'text' | 'thinking' | 'toolCall'; content: string | PiToolCallContent }>,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  // Check for native tool text deltas
  if (partialMessage.nativeToolText && partialMessage.nativeToolText.length > state.nativeToolTextEmitted.length) {
    const delta = partialMessage.nativeToolText.slice(state.nativeToolTextEmitted.length);
    emitNativeToolDelta(stream, state, partialMessage, delta, metadata);
  }

  for (const piEvent of piEvents) {
    if (piEvent.type === 'text') {
      emitTextDelta(stream, state, partialMessage, deltaToString(piEvent.content), metadata);
    } else if (piEvent.type === 'thinking') {
      emitThinkingDelta(stream, state, partialMessage, deltaToString(piEvent.content), metadata);
    } else if (piEvent.type === 'toolCall') {
      const tc = piEvent.content as PiToolCallContent;
      // Don't emit native tool calls (google_web_search, web_fetch) as toolUse content blocks —
      // they are auto-approved within A2A and rendered as text blocks above.
      if (!isNativeTool(tc.name)) {
        emitToolCall(stream, state, partialMessage, tc, metadata);
      }
    }
  }
}

function emitNativeToolDelta(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  delta: string,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  if (state.nativeToolTextIndex === null) {
    state.nativeToolTextIndex = getOrCreateNativeToolTextIndex(partialMessage);
    stream.push({
      type: 'text_start',
      contentIndex: state.nativeToolTextIndex,
      partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
    });
  }

  state.nativeToolTextEmitted += delta;
  stream.push({
    type: 'text_delta',
    contentIndex: state.nativeToolTextIndex,
    delta,
    partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
  });
}

function ensureStartEvent(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  metadata: MessageMetadata,
): void {
  if (state.emittedStart) {
    return;
  }

  stream.push({
    type: 'start',
    partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
  });
  state.emittedStart = true;
}

function emitTextDelta(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  delta: string,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  if (state.textIndex === null) {
    state.textIndex = getOrCreateTextIndex(partialMessage);
    stream.push({
      type: 'text_start',
      contentIndex: state.textIndex,
      partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
    });
  }

  state.textEmitted += delta;
  stream.push({
    type: 'text_delta',
    contentIndex: state.textIndex,
    delta,
    partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
  });
}

function emitThinkingDelta(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  delta: string,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  if (state.thinkingIndex === null) {
    state.thinkingIndex = getOrCreateThinkingIndex();
    stream.push({
      type: 'thinking_start',
      contentIndex: state.thinkingIndex,
      partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
    });
  }

  state.thinkingEmitted += delta;
  stream.push({
    type: 'thinking_delta',
    contentIndex: state.thinkingIndex,
    delta,
    partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
  });
}

function emitToolCall(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  toolCall: PiToolCallContent,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  if (state.toolCallIndices.has(toolCall.id)) {
    return;
  }

  const contentIndex = partialMessage.toolCalls.findIndex((call) => call.id === toolCall.id);
  if (contentIndex === -1) {
    return;
  }

  state.toolCallIndices.set(toolCall.id, contentIndex);
  stream.push({
    type: 'toolcall_start',
    contentIndex,
    partial: buildAssistantMessage(snapshotMessage(partialMessage), metadata, 'stop'),
  });
}

function finalizeOpenContent(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  finalMessage: { text: string; thinking: string; nativeToolText: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> },
  metadata: MessageMetadata,
): void {
  const finalAssistantMessage = buildAssistantMessage(finalMessage, metadata, 'stop');
  ensureStartEvent(stream, state, {
    text: finalMessage.text,
    thinking: finalMessage.thinking,
    nativeToolText: finalMessage.nativeToolText,
    toolCalls: finalMessage.toolCalls.map((call) => ({
      id: call.callId,
      name: call.name,
      arguments: normalizeToolArguments(call.args),
    })),
  }, metadata);

  if (state.nativeToolTextIndex !== null) {
    stream.push({
      type: 'text_end',
      contentIndex: state.nativeToolTextIndex,
      content: finalMessage.nativeToolText,
      partial: finalAssistantMessage,
    });
    state.nativeToolTextIndex = null;
  }

  if (state.textIndex !== null) {
    stream.push({
      type: 'text_end',
      contentIndex: state.textIndex,
      content: finalMessage.text,
      partial: finalAssistantMessage,
    });
    state.textIndex = null;
  }

  if (state.thinkingIndex !== null) {
    stream.push({
      type: 'thinking_end',
      contentIndex: state.thinkingIndex,
      content: finalMessage.thinking,
      partial: finalAssistantMessage,
    });
    state.thinkingIndex = null;
  }
}

function emitDone(stream: AssistantMessageEventStream, message: AssistantMessage): void {
  const reason = message.stopReason === 'toolUse' ? 'toolUse' : message.stopReason === 'length' ? 'length' : 'stop';
  stream.push({
    type: 'done',
    reason,
    message,
  });
}

function emitError(
  stream: AssistantMessageEventStream,
  metadata: MessageMetadata,
  errorMessage: string,
  reason: 'error' | 'aborted',
): void {
  stream.push({
    type: 'error',
    reason,
    error: buildAssistantMessage(
      { text: '', thinking: '', nativeToolText: '', toolCalls: [] },
      metadata,
      reason,
      errorMessage,
    ),
  });
}

function getOrCreateNativeToolTextIndex(partialMessage: { thinking: string }): number {
  return partialMessage.thinking.length > 0 ? 1 : 0;
}

function getOrCreateTextIndex(partialMessage: { thinking: string; nativeToolText?: string }): number {
  let index = 0;
  if (partialMessage.thinking.length > 0) index++;
  if (partialMessage.nativeToolText && partialMessage.nativeToolText.length > 0) index++;
  return index;
}

function getOrCreateThinkingIndex(): number {
  return 0;
}

function partialMessageToContent(partialMessage: {
  text: string;
  thinking: string;
  nativeToolText?: string;
  toolCalls: PiToolCallContent[];
}): AssistantMessageContent[] {
  const content: AssistantMessageContent[] = [];

  if (partialMessage.thinking.length > 0) {
    content.push({ type: 'thinking', thinking: partialMessage.thinking });
  }

  // Native tool text (fenced code block) before model answer text.
  // This is the text-path rendering for native tools — ordering is correct
  // because assistant-message.ts renders text blocks in content-array order.
  if (partialMessage.nativeToolText && partialMessage.nativeToolText.length > 0) {
    content.push({ type: 'text', text: partialMessage.nativeToolText });
  }

  if (partialMessage.text.length > 0) {
    content.push({ type: 'text', text: partialMessage.text });
  }

  // MCP tool calls (only — native tools use nativeToolText above)
  for (const toolCall of partialMessage.toolCalls) {
    content.push({
      type: 'toolCall',
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    });
  }

  return content;
}

function buildAssistantMessage(
  message: {
    text: string;
    thinking: string;
    nativeToolText: string;
    toolCalls: Array<{ callId: string; name: string; args: unknown }>;
  },
  metadata: MessageMetadata,
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  const toolCalls: PiToolCallContent[] = message.toolCalls.map((call) => ({
    id: call.callId,
    name: call.name,
    arguments: normalizeToolArguments(call.args),
  }));

  return {
    role: 'assistant',
    api: metadata.api,
    provider: metadata.provider,
    model: metadata.model,
    content: partialMessageToContent({
      text: message.text,
      thinking: message.thinking,
      nativeToolText: message.nativeToolText,
      toolCalls,
    }),
    usage: createZeroUsage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

function snapshotMessage(partialMessage: {
  text: string;
  thinking: string;
  nativeToolText: string;
  toolCalls: PiToolCallContent[];
}): { text: string; thinking: string; nativeToolText: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> } {
  return {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    nativeToolText: partialMessage.nativeToolText,
    toolCalls: partialMessage.toolCalls.map((call) => ({
      callId: call.id,
      name: call.name,
      args: call.arguments,
    })),
  };
}

function copyPartialMessage(
  target: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
  next: { text: string; thinking: string; nativeToolText: string; toolCalls: PiToolCallContent[] },
): void {
  target.text = next.text;
  target.thinking = next.thinking;
  target.nativeToolText = next.nativeToolText;
  target.toolCalls = next.toolCalls;
}

function createMessageMetadata(model?: string): MessageMetadata {
  return {
    ...DEFAULT_MESSAGE_METADATA,
    model: model ?? DEFAULT_MESSAGE_METADATA.model,
  };
}

function createZeroUsage(): Usage {
  return {
    input: ZERO_USAGE.input,
    output: ZERO_USAGE.output,
    cacheRead: ZERO_USAGE.cacheRead,
    cacheWrite: ZERO_USAGE.cacheWrite,
    totalTokens: ZERO_USAGE.totalTokens,
    cost: {
      input: ZERO_USAGE.cost.input,
      output: ZERO_USAGE.cost.output,
      cacheRead: ZERO_USAGE.cost.cacheRead,
      cacheWrite: ZERO_USAGE.cost.cacheWrite,
      total: ZERO_USAGE.cost.total,
    },
  };
}

function normalizeToolArguments(args: unknown): Record<string, any> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, any>;
  }

  return {};
}

function deltaToString(content: string | PiToolCallContent): string {
  return typeof content === 'string' ? content : '';
}

function mapStopReason(stopReason?: string): AssistantMessage['stopReason'] {
  if (stopReason === 'toolUse') {
    return 'toolUse';
  }
  if (stopReason === 'length') {
    return 'length';
  }
  return 'stop';
}
