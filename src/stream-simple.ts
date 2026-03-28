/**
 * Stream Simple Module
 *
 * Implements the streamSimple orchestration for the Gemini A2A provider.
 * Returns a pi-compatible AssistantMessageEventStream that is populated
 * asynchronously from A2A SSE events, with approval interception and result
 * reinjection.
 */

import type { Context } from './pi-types.js';
import { sendMessageStream, injectResult, approveToolCall, resubscribeTask } from './a2a-client.js';
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

      const isReCall = Boolean(taskId);
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

      if (!isReCall) {
        lastTaskId = result.taskId;
        lastContextId = result.contextId;
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
  const isReCall = detectReCall(context.messages);

  const { stream } = streamSimple({
    prompt,
    context,
    model: model.id,
    signal: options?.signal,
    taskId: isReCall ? lastTaskId : undefined,
    contextId: isReCall ? lastContextId : undefined,
  });

  return stream;
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

  const taskState = taskId && contextId ? createTaskWithIds(taskId, contextId) : createTask();

  const { taskId: a2aTaskId, contextId: a2aContextId, sseStream, metadata: a2aMetadata } = await sendMessageStream({
    prompt,
    taskId: taskState.taskId,
    contextId: taskState.contextId,
    model,
    signal,
  });

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

    updateTaskState(serverTaskId ?? a2aTaskId, event);
    const nextPartial = updatePartialMessage(partialMessage, event);
    copyPartialMessage(partialMessage, nextPartial);
    emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]), createMessageMetadata(model));

    const effectiveTaskId = serverTaskId ?? a2aTaskId;
    const updatedState = getTaskState(effectiveTaskId);
    if (updatedState?.awaitingApproval) {
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
              const fs = await import('node:fs');
              fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] APPROVE: a2aMetadata.requestId=${a2aMetadata.requestId} serverTaskId=${serverTaskId} a2aTaskId=${a2aTaskId}\n`);
              const { sseStream: approveStream } = await approveToolCall({
                // Use server's real task UUID — the InMemoryTaskStore is keyed by this
                taskId: serverTaskId ?? a2aTaskId,
                callId: toolCall.callId,
                outcome: 'proceed_once',
                signal,
              });

              let approveEventCount = 0;
              for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
                approveEventCount++;
                fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] approve-event #${approveEventCount}: kind=${approveEvent.kind} state=${approveEvent.result?.status?.state} final=${approveEvent.result?.final} text=${(approveEvent.text ?? '').slice(0, 80)}\n`);
                updateTaskState(effectiveTaskId, approveEvent);
                const approvePartial = updatePartialMessage(partialMessage, approveEvent);
                copyPartialMessage(partialMessage, approvePartial);
                emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([approveEvent]), createMessageMetadata(model));

                const approvedState = getTaskState(effectiveTaskId);
                if (approvedState?.isTerminal) {
                  fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] approve-loop: TERMINAL after ${approveEventCount} events\n`);
                  break;
                }
              }
              fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] approve-loop: exited after ${approveEventCount} events, text=${partialMessage.text.length}chars\n`);
            } catch (error) {
              const errorMessage = error instanceof Error ? error.message : 'Auto-approval failed';
              markTaskFailed(effectiveTaskId, errorMessage);
              throw new Error(`Failed to auto-approve native tool ${toolCall.callId}: ${errorMessage}`);
            }
          }

          clearPendingToolCalls(effectiveTaskId, pendingToolCalls.map((tc) => tc.callId));
        }
      }
    }

    if (updatedState?.isTerminal) {
      break;
    }
  }

  // Filter out native tool calls — they were auto-approved within A2A
  // and should not appear in the GSD-facing message.
  const mcpToolCalls = partialMessage.toolCalls.filter((call) => !isNativeTool(call.name));

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
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
      const _fs = await import('node:fs');

      // Send inject first, then resubscribe. The inject's secondary executor
      // swaps the event bus — resubscribing after ensures we connect to the
      // bus that the primary executor will publish tool events to.
      await injectResult({
        taskId,
        callId: item.callId,
        toolName: item.toolName,
        functionResponse: item.result.response,
        isError: item.result.isError,
        signal,
      });
      injectedCallIds.push(item.callId);
      _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] inject sent for ${item.callId}, resubscribing\n`);

      const { sseStream: resubStream } = await resubscribeTask({ taskId, signal });
      let _evtCount = 0;
      for await (const event of parseSSEStream(resubStream, { signal, idleTimeoutMs: 2000 })) {
        _evtCount++;
        _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub evt #${_evtCount}: kind=${event.kind} state=${event.result?.status?.state} final=${event.result?.final} awaiting=${event.isAwaitingApproval} toolCall=${event.toolCall?.callId ?? 'none'}\n`);
        updateTaskState(taskId, event);

        // Skip already-injected tool calls — don't re-emit or re-process them
        const isOldToolCall = event.toolCall && injectedCallIds.includes(event.toolCall.callId);
        if (!isOldToolCall) {
          const nextPartial = updatePartialMessage(partialMessage, event);
          copyPartialMessage(partialMessage, nextPartial);
          emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]), createMessageMetadata(model));
        }

        // Check for NEW awaiting tool calls (from synthetic task snapshot events)
        if (event.isAwaitingApproval && event.toolCall && !injectedCallIds.includes(event.toolCall.callId)) {
          if (isMcpTool(event.toolCall.name)) {
            _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub BREAK: new MCP tool ${event.toolCall.name}\n`);
            stopReason = 'toolUse';
            break;
          }
        }
        // Also check via task state (for events that update awaitingApproval indirectly)
        const resubState = getTaskState(taskId);
        if (resubState?.awaitingApproval) {
          const newPending = getPendingToolCalls(taskId).filter(
            (tc) => !injectedCallIds.includes(tc.callId)
          );
          if (newPending.some((tc) => isMcpTool(tc.name))) {
            _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub BREAK: new MCP tool (state) ${newPending.map(t=>t.name).join(',')}\n`);
            stopReason = 'toolUse';
            break;
          }
        }
        if (resubState?.isTerminal) {
          _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub BREAK: terminal\n`);
          break;
        }
      }
      _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub loop exited after ${_evtCount} events, stopReason=${stopReason}\n`);

      // If no toolUse detected from live events, check the task snapshot
      // one more time — the tool-call-update may have been registered after
      // the resubscribe stream delivered events but before it closed.
      if (!stopReason) {
        try {
          const { sseStream: checkStream } = await resubscribeTask({ taskId, signal });
          for await (const checkEvt of parseSSEStream(checkStream, { signal, idleTimeoutMs: 5000 })) {
            _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub-check evt: kind=${checkEvt.kind} awaiting=${checkEvt.isAwaitingApproval} toolCall=${checkEvt.toolCall?.callId ?? 'none'}\n`);
            updateTaskState(taskId, checkEvt);
            // Check for NEW tool calls not in injectedCallIds
            if (checkEvt.isAwaitingApproval && checkEvt.toolCall && !injectedCallIds.includes(checkEvt.toolCall.callId)) {
              if (isMcpTool(checkEvt.toolCall.name)) {
                stopReason = 'toolUse';
                // Add to partial message and emit to GSD
                const nextP = updatePartialMessage(partialMessage, checkEvt);
                copyPartialMessage(partialMessage, nextP);
                emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([checkEvt]), createMessageMetadata(model));
                _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub-check BREAK: new MCP tool ${checkEvt.toolCall.name}\n`);
                break;
              }
            }
          }
          _fs.appendFileSync('/tmp/gemini-debug.log', `[${new Date().toISOString()}] resub-check done, stopReason=${stopReason}\n`);
        } catch { /* ignore check failure */ }
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
      stopReason = 'toolUse';
    }
  }

  // No separate resubscribe fallback needed — resubscribe is the primary
  // event source after each inject (see inject loop above).

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map((call) => ({
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
    toolCallIndices: new Map<string, number>(),
  };
}

function emitTranslatedEvents(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  piEvents: Array<{ type: 'text' | 'thinking' | 'toolCall'; content: string | PiToolCallContent }>,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  for (const piEvent of piEvents) {
    if (piEvent.type === 'text') {
      emitTextDelta(stream, state, partialMessage, deltaToString(piEvent.content), metadata);
    } else if (piEvent.type === 'thinking') {
      emitThinkingDelta(stream, state, partialMessage, deltaToString(piEvent.content), metadata);
    } else if (piEvent.type === 'toolCall') {
      const tc = piEvent.content as PiToolCallContent;
      // Don't emit native tool calls (google_web_search, web_fetch) to GSD —
      // they are auto-approved and handled within A2A.
      if (!isNativeTool(tc.name)) {
        emitToolCall(stream, state, partialMessage, tc, metadata);
      }
    }
  }
}

function ensureStartEvent(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
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
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
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
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  delta: string,
  metadata: MessageMetadata,
): void {
  ensureStartEvent(stream, state, partialMessage, metadata);

  if (state.thinkingIndex === null) {
    state.thinkingIndex = getOrCreateThinkingIndex(partialMessage);
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
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
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
  finalMessage: { text: string; thinking: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> },
  metadata: MessageMetadata,
): void {
  const finalAssistantMessage = buildAssistantMessage(finalMessage, metadata, 'stop');
  ensureStartEvent(stream, state, {
    text: finalMessage.text,
    thinking: finalMessage.thinking,
    toolCalls: finalMessage.toolCalls.map((call) => ({
      id: call.callId,
      name: call.name,
      arguments: normalizeToolArguments(call.args),
    })),
  }, metadata);

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
      { text: '', thinking: '', toolCalls: [] },
      metadata,
      reason,
      errorMessage,
    ),
  });
}

function getOrCreateTextIndex(partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] }): number {
  const existingIndex = partialMessageToContent(partialMessage).findIndex((item) => item.type === 'text');
  return existingIndex >= 0 ? existingIndex : partialMessageToContent(partialMessage).length;
}

function getOrCreateThinkingIndex(partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] }): number {
  const existingIndex = partialMessageToContent(partialMessage).findIndex((item) => item.type === 'thinking');
  return existingIndex >= 0 ? existingIndex : partialMessageToContent(partialMessage).length;
}

function partialMessageToContent(partialMessage: {
  text: string;
  thinking: string;
  toolCalls: PiToolCallContent[];
}): AssistantMessageContent[] {
  const content: AssistantMessageContent[] = [];

  if (partialMessage.thinking.length > 0) {
    content.push({ type: 'thinking', thinking: partialMessage.thinking });
  }

  if (partialMessage.text.length > 0) {
    content.push({ type: 'text', text: partialMessage.text });
  }

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
  toolCalls: PiToolCallContent[];
}): { text: string; thinking: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> } {
  return {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map((call) => ({
      callId: call.id,
      name: call.name,
      args: call.arguments,
    })),
  };
}

function copyPartialMessage(
  target: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  next: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
): void {
  target.text = next.text;
  target.thinking = next.thinking;
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
