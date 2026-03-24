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
  callId: string;
  toolName: string;
  args: unknown;
}

export type AssistantMessageContent =
  | AssistantMessageTextContent
  | AssistantMessageThinkingContent
  | AssistantMessageToolCallContent;

export interface AssistantMessage {
  role: 'assistant';
  content: AssistantMessageContent[];
  stopReason?: 'stop' | 'toolUse' | 'length' | 'error' | 'aborted';
  errorMessage?: string;
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

      const isReCall = detectReCall(context.messages);
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

      const finalAssistantMessage = buildAssistantMessage(result.message, mapStopReason(result.stopReason));
      emitDone(stream, finalAssistantMessage);
      resolveResult(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      emitError(stream, errorMessage, signal?.aborted === true ? 'aborted' : 'error');
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

  const { stream } = streamSimple({
    prompt,
    context,
    model: model.id,
    signal: options?.signal,
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

  const { taskId: a2aTaskId, contextId: a2aContextId, sseStream } = await sendMessageStream({
    prompt,
    taskId: taskState.taskId,
    contextId: taskState.contextId,
    model,
    signal,
  });

  const partialMessage = createPartialMessage();
  const eventState = createStreamEventState();
  let stopReason: string | undefined;

  for await (const event of parseSSEStream(sseStream, { signal })) {
    updateTaskState(a2aTaskId, event);
    const nextPartial = updatePartialMessage(partialMessage, event);
    copyPartialMessage(partialMessage, nextPartial);
    emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]));

    const updatedState = getTaskState(a2aTaskId);
    if (updatedState?.awaitingApproval) {
      const pendingToolCalls = getPendingToolCalls(a2aTaskId);

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
                taskId: a2aTaskId,
                callId: toolCall.callId,
                outcome: 'proceed_once',
                signal,
              });

              for await (const approveEvent of parseSSEStream(approveStream, { signal })) {
                updateTaskState(a2aTaskId, approveEvent);
                const approvePartial = updatePartialMessage(partialMessage, approveEvent);
                copyPartialMessage(partialMessage, approvePartial);
                emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([approveEvent]));

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

          clearPendingToolCalls(a2aTaskId, pendingToolCalls.map((tc) => tc.callId));
        }
      }
    }

    if (updatedState?.isTerminal) {
      break;
    }
  }

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
    })),
  };

  finalizeOpenContent(stream, eventState, finalMessage);

  return {
    taskId: a2aTaskId,
    contextId: a2aContextId,
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
  const { context, taskId, contextId, signal } = params;

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

  for (const item of workItems) {
    try {
      const { sseStream } = await injectResult({
        taskId,
        callId: item.callId,
        toolName: item.toolName,
        functionResponse: item.result.response,
        signal,
      });

      for await (const event of parseSSEStream(sseStream, { signal })) {
        updateTaskState(taskId, event);
        const nextPartial = updatePartialMessage(partialMessage, event);
        copyPartialMessage(partialMessage, nextPartial);
        emitTranslatedEvents(stream, eventState, partialMessage, translateEvents([event]));

        const updatedState = getTaskState(taskId);
        if (updatedState?.awaitingApproval) {
          const morePendingCalls = getPendingToolCalls(taskId);
          if (morePendingCalls.length > 0) {
            stopReason = 'toolUse';
            break;
          }
        }

        if (updatedState?.isTerminal) {
          break;
        }
      }

      if (stopReason || getTaskState(taskId)?.isTerminal) {
        break;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Result injection failed';
      markTaskFailed(taskId, errorMessage);
      throw new Error(`Failed to inject result for ${item.callId}: ${errorMessage}`);
    }
  }

  clearPendingToolCalls(taskId, workItems.map((item) => item.callId));

  const finalMessage = {
    text: partialMessage.text,
    thinking: partialMessage.thinking,
    toolCalls: partialMessage.toolCalls.map((call) => ({
      callId: call.callId,
      name: call.name,
      args: call.args,
    })),
  };

  finalizeOpenContent(stream, eventState, finalMessage);

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
): void {
  ensureStartEvent(stream, state, partialMessage);

  for (const piEvent of piEvents) {
    if (piEvent.type === 'text') {
      emitTextDelta(stream, state, partialMessage, piEvent.content as string);
    } else if (piEvent.type === 'thinking') {
      emitThinkingDelta(stream, state, partialMessage, piEvent.content as string);
    } else if (piEvent.type === 'toolCall') {
      emitToolCall(stream, state, partialMessage, piEvent.content as PiToolCallContent);
    }
  }
}

function ensureStartEvent(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
): void {
  if (state.emittedStart) {
    return;
  }

  stream.push({
    type: 'start',
    partial: buildAssistantMessage(snapshotMessage(partialMessage)),
  });
  state.emittedStart = true;
}

function emitTextDelta(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  delta: string,
): void {
  ensureStartEvent(stream, state, partialMessage);

  if (state.textIndex === null) {
    state.textIndex = getOrCreateTextIndex(partialMessage);
    stream.push({
      type: 'text_start',
      contentIndex: state.textIndex,
      partial: buildAssistantMessage(snapshotMessage(partialMessage)),
    });
  }

  state.textEmitted += delta;
  stream.push({
    type: 'text_delta',
    contentIndex: state.textIndex,
    delta,
    partial: buildAssistantMessage(snapshotMessage(partialMessage)),
  });
}

function emitThinkingDelta(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  delta: string,
): void {
  ensureStartEvent(stream, state, partialMessage);

  if (state.thinkingIndex === null) {
    state.thinkingIndex = getOrCreateThinkingIndex(partialMessage);
    stream.push({
      type: 'thinking_start',
      contentIndex: state.thinkingIndex,
      partial: buildAssistantMessage(snapshotMessage(partialMessage)),
    });
  }

  state.thinkingEmitted += delta;
  stream.push({
    type: 'thinking_delta',
    contentIndex: state.thinkingIndex,
    delta,
    partial: buildAssistantMessage(snapshotMessage(partialMessage)),
  });
}

function emitToolCall(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  partialMessage: { text: string; thinking: string; toolCalls: PiToolCallContent[] },
  toolCall: PiToolCallContent,
): void {
  ensureStartEvent(stream, state, partialMessage);

  if (state.toolCallIndices.has(toolCall.callId)) {
    return;
  }

  const contentIndex = partialMessage.toolCalls.findIndex((call) => call.callId === toolCall.callId);
  if (contentIndex === -1) {
    return;
  }

  state.toolCallIndices.set(toolCall.callId, contentIndex);
  stream.push({
    type: 'toolcall_start',
    contentIndex,
    partial: buildAssistantMessage(snapshotMessage(partialMessage)),
  });
}

function finalizeOpenContent(
  stream: AssistantMessageEventStream,
  state: StreamEventState,
  finalMessage: { text: string; thinking: string; toolCalls: Array<{ callId: string; name: string; args: unknown }> },
): void {
  const finalAssistantMessage = buildAssistantMessage(finalMessage);
  ensureStartEvent(stream, state, {
    text: finalMessage.text,
    thinking: finalMessage.thinking,
    toolCalls: finalMessage.toolCalls.map((call) => ({ callId: call.callId, name: call.name, args: call.args })),
  });

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
  errorMessage: string,
  reason: 'error' | 'aborted',
): void {
  stream.push({
    type: 'error',
    reason,
    error: {
      role: 'assistant',
      content: [],
      stopReason: reason,
      errorMessage,
    },
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

  if (partialMessage.text.length > 0) {
    content.push({ type: 'text', text: partialMessage.text });
  }

  if (partialMessage.thinking.length > 0) {
    content.push({ type: 'thinking', thinking: partialMessage.thinking });
  }

  for (const toolCall of partialMessage.toolCalls) {
    content.push({
      type: 'toolCall',
      callId: toolCall.callId,
      toolName: toolCall.name,
      args: toolCall.args,
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
  stopReason?: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  const toolCalls: PiToolCallContent[] = message.toolCalls.map((call) => ({
    callId: call.callId,
    name: call.name,
    args: call.args,
  }));

  return {
    role: 'assistant',
    content: partialMessageToContent({
      text: message.text,
      thinking: message.thinking,
      toolCalls,
    }),
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage ? { errorMessage } : {}),
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
      callId: call.callId,
      name: call.name,
      args: call.args,
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

function mapStopReason(stopReason?: string): AssistantMessage['stopReason'] {
  if (stopReason === 'toolUse') {
    return 'toolUse';
  }
  if (stopReason === 'length') {
    return 'length';
  }
  return 'stop';
}
