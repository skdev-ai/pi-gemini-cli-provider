/**
 * Stream Simple Tests
 *
 * Tests for the streamSimple orchestration handler.
 * Covers fresh prompts, MCP intercept, native auto-continue,
 * re-call reinjection, and transport/injection failure paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamSimple, streamSimpleGsd, type AssistantMessageEvent } from './stream-simple.js';
import { sendMessageStream, injectResult, approveToolCall } from './a2a-client.js';
import { parseSSEStream } from './sse-parser.js';
import {
  getTaskState,
  getPendingToolCalls,
  clearPendingToolCalls,
  markTaskFailed,
  clearAllTasks,
  createTask,
} from './task-manager.js';
import { incrementProviderTaskCount } from './a2a-lifecycle.js';
import type { ParsedA2AEvent } from './types.js';

vi.mock('./a2a-client.js');
vi.mock('./sse-parser.js');
vi.mock('./task-manager.js');
vi.mock('./a2a-lifecycle.js');

const mockSendMessageStream = vi.mocked(sendMessageStream);
const mockInjectResult = vi.mocked(injectResult);
const mockApproveToolCall = vi.mocked(approveToolCall);
const mockParseSSEStream = vi.mocked(parseSSEStream);
const mockCreateTask = vi.mocked(createTask);
const mockGetTaskState = vi.mocked(getTaskState);
const mockGetPendingToolCalls = vi.mocked(getPendingToolCalls);
const mockClearPendingToolCalls = vi.mocked(clearPendingToolCalls);
const mockMarkTaskFailed = vi.mocked(markTaskFailed);
const mockClearAllTasks = vi.mocked(clearAllTasks);
const mockIncrementProviderTaskCount = vi.mocked(incrementProviderTaskCount);

vi.spyOn(console, 'warn').mockImplementation(() => {});

function createTextEvent(text: string, state: string = 'working'): ParsedA2AEvent {
  return {
    kind: 'text-content',
    result: {
      status: {
        state: state as any,
        message: { parts: [{ kind: 'text', text }] },
      },
    },
    text,
  };
}

function createThoughtEvent(text: string, state: string = 'working'): ParsedA2AEvent {
  return {
    kind: 'thought',
    result: {
      status: {
        state: state as any,
        message: { parts: [{ kind: 'text', text }] },
      },
    },
    text,
  };
}

function createToolCallEvent(
  callId: string,
  name: string,
  args: unknown,
  state: string = 'working',
): ParsedA2AEvent {
  return {
    kind: 'tool-call-update',
    result: {
      status: {
        state: state as any,
        message: {
          parts: [
            {
              kind: 'data',
              data: {
                request: { callId, name, args },
                status: 'scheduled',
              },
            },
          ],
        },
      },
    },
    toolCall: {
      callId,
      name,
      args,
      status: 'scheduled',
    },
  };
}

function createStateChangeEvent(
  state: string,
  isAwaitingApproval: boolean = false,
  isFinal: boolean = false,
): ParsedA2AEvent {
  return {
    kind: 'state-change',
    result: {
      status: {
        state: state as any,
        message: { parts: [] },
      },
      final: isFinal,
    },
    isAwaitingApproval,
  };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('streamSimple', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockClearAllTasks();
    mockIncrementProviderTaskCount.mockResolvedValue();
  });

  it('returns an async iterable stream and emits contract-shaped text events', async () => {
    const mockTaskId = 'task_123';
    const mockContextId = 'ctx_123';

    mockCreateTask.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_123' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createTextEvent('Hello');
      yield createTextEvent(' world');
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'completed',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: true,
      });

    const { stream, result } = streamSimple({
      prompt: 'Test prompt',
      context: { messages: [] },
    });

    const events = await collectEvents(stream);
    const finalResult = await result;

    expect(typeof (stream as any)[Symbol.asyncIterator]).toBe('function');
    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Test prompt',
      taskId: mockTaskId,
      contextId: mockContextId,
      model: undefined,
      signal: undefined,
    });
    expect(finalResult.stopReason).toBeUndefined();

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'done',
    ]);

    expect(events[2]).toMatchObject({
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Hello',
    });
    expect(events[3]).toMatchObject({
      type: 'text_delta',
      contentIndex: 0,
      delta: ' world',
    });
    expect(events[5]).toMatchObject({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'assistant',
        stopReason: 'stop',
        content: [{ type: 'text', text: 'Hello world' }],
      },
    });
  });

  it('emits toolcall_start and ends with toolUse when MCP approval is required', async () => {
    const mockTaskId = 'task_456';
    const mockContextId = 'ctx_456';

    mockCreateTask.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_456' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createTextEvent('Let me search');
      yield createToolCallEvent('call_1', 'mcp_tools_search', { query: 'test' });
      yield createStateChangeEvent('input-required', true, true);
    });

    mockGetTaskState
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'input-required',
        awaitingApproval: true,
        pendingToolCalls: [
          {
            callId: 'call_1',
            name: 'mcp_tools_search',
            args: { query: 'test' },
            status: 'scheduled',
          },
        ],
        isTerminal: false,
      });

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_1',
        name: 'mcp_tools_search',
            args: { query: 'test' },
        status: 'scheduled',
      },
    ]);

    const { stream, result } = streamSimple({
      prompt: 'Test prompt',
      context: { messages: [] },
    });

    const events = await collectEvents(stream);
    const finalResult = await result;

    expect(finalResult.stopReason).toBe('toolUse');

    const toolEvent = events.find((event) => event.type === 'toolcall_start');
    expect(toolEvent).toBeDefined();
    expect(toolEvent).toMatchObject({
      type: 'toolcall_start',
      contentIndex: 0,
    });

    const doneEvent = events.at(-1);
    expect(doneEvent).toMatchObject({
      type: 'done',
      reason: 'toolUse',
      message: {
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'Let me search' },
          {
            type: 'toolCall',
            id: 'call_1',
            name: 'tools_search',
            arguments: { query: 'test' },
          },
        ],
      },
    });
  });

  it('auto-approves native tools and continues streaming without toolUse', async () => {
    const mockTaskId = 'task_native';
    const mockContextId = 'ctx_native';

    mockCreateTask.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_native' },
    });

    mockApproveToolCall.mockResolvedValue({
      taskId: mockTaskId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_proceed' },
    });

    const initialEvents = [
      createTextEvent('Let me search the web'),
      createToolCallEvent('call_1', 'google_web_search', { query: 'weather' }),
      createStateChangeEvent('input-required', true, true),
    ];
    const approvalEvents = [
      createTextEvent('Here are the weather results'),
      createStateChangeEvent('completed', false, true),
    ];

    let parseCallCount = 0;
    mockParseSSEStream.mockImplementation(async function* () {
      parseCallCount += 1;
      const source = parseCallCount === 1 ? initialEvents : approvalEvents;
      for (const event of source) {
        yield event;
      }
    });

    mockGetTaskState
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'input-required',
        awaitingApproval: true,
        pendingToolCalls: [
          {
            callId: 'call_1',
            name: 'google_web_search',
            args: { query: 'weather' },
            status: 'scheduled',
          },
        ],
        isTerminal: false,
      })
      .mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'completed',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: true,
      });

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_1',
        name: 'google_web_search',
            args: { query: 'weather' },
        status: 'scheduled',
      },
    ]);

    const { stream, result } = streamSimple({
      prompt: 'What is the weather?',
      context: { messages: [] },
    });

    const events = await collectEvents(stream);
    const finalResult = await result;

    expect(mockApproveToolCall).toHaveBeenCalledWith({
      taskId: mockTaskId,
      callId: 'call_1',
      outcome: 'proceed_once',
      signal: undefined,
    });
    expect(finalResult.stopReason).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'stop',
    });
  });

  it('re-call injects results and continues from injectResult stream without empty follow-up prompt', async () => {
    const mockTaskId = 'task_replay';
    const mockContextId = 'ctx_replay';

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_1',
        name: 'mcp_tools_search',
            args: { query: 'test' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockResolvedValue({
      taskId: mockTaskId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_inject' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createTextEvent('Based on the search results');
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const { stream, result } = streamSimple({
      prompt: '',
      context: {
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            name: 'mcp_tools_search',
            content: [{ type: 'text', text: 'Search results' }],
          },
        ],
      },
      taskId: mockTaskId,
      contextId: mockContextId,
    });

    const events = await collectEvents(stream);
    await result;

    expect(mockInjectResult).toHaveBeenCalledWith({
      taskId: mockTaskId,
      callId: 'call_1',
      toolName: 'tools_search',
      functionResponse: expect.anything(),
      signal: undefined,
    });
    expect(mockClearPendingToolCalls).toHaveBeenCalledWith(mockTaskId, ['call_1']);
    expect(mockSendMessageStream).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      reason: 'stop',
    });
  });

  it('surfaces transport failures as error terminal events', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_transport',
      contextId: 'ctx_transport',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockRejectedValue(new Error('A2A server not responding'));

    const { stream, result } = streamSimple({
      prompt: 'Test',
      context: { messages: [] },
    });

    const events = await collectEvents(stream);

    await expect(result).rejects.toThrow('A2A server not responding');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: 'A2A server not responding',
      },
    });
  });

  it('marks task failed when injection fails', async () => {
    const mockTaskId = 'task_fail';
    const mockContextId = 'ctx_fail';

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_1',
        name: 'mcp_tools_search',
            args: { query: 'test' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockRejectedValue(new Error('Connection refused'));

    mockGetTaskState.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'input-required',
      awaitingApproval: true,
      pendingToolCalls: [
        {
          callId: 'call_1',
          name: 'mcp_tools_search',
            args: { query: 'test' },
          status: 'scheduled',
        },
      ],
      isTerminal: false,
    });

    const { stream, result } = streamSimple({
      prompt: '',
      context: {
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            name: 'mcp_tools_search',
            content: [{ type: 'text', text: 'Search results' }],
          },
        ],
      },
      taskId: mockTaskId,
      contextId: mockContextId,
    });

    const events = await collectEvents(stream);

    await expect(result).rejects.toThrow('Failed to inject result for call_1: Connection refused');
    expect(mockMarkTaskFailed).toHaveBeenCalledWith(mockTaskId, 'Connection refused');
    expect(events[0]).toMatchObject({
      type: 'error',
      reason: 'error',
    });
  });

  it('emits thinking_start/thinking_delta/thinking_end for thought events', async () => {
    const mockTaskId = 'task_thinking';
    const mockContextId = 'ctx_thinking';

    mockCreateTask.mockReturnValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: mockTaskId,
      contextId: mockContextId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_thinking' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createThoughtEvent('Thinking step 1');
      yield createThoughtEvent('Thinking step 2');
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValueOnce({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'completed',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: true,
      });

    const { stream, result } = streamSimple({
      prompt: 'Test',
      context: { messages: [] },
    });

    const events = await collectEvents(stream);
    await result;

    expect(events.map((event) => event.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
      'done',
    ]);
    expect(events[2]).toMatchObject({
      type: 'thinking_delta',
      delta: 'Thinking step 1',
    });
  });
});

describe('streamSimpleGsd', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockClearAllTasks();
    mockIncrementProviderTaskCount.mockResolvedValue();
  });

  it('extracts text from block-array user content', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_user_blocks',
      contextId: 'ctx_user_blocks',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: 'task_user_blocks',
      contextId: 'ctx_user_blocks',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_user_blocks' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState.mockReturnValue({
      taskId: 'task_user_blocks',
      contextId: 'ctx_user_blocks',
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const stream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Hello. What model are you?' }],
            timestamp: Date.now(),
          },
        ],
      },
    );

    await collectEvents(stream);

    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Hello. What model are you?',
      taskId: 'task_user_blocks',
      contextId: 'ctx_user_blocks',
      model: 'gemini-a2a',
      signal: undefined,
    });
  });

  it('uses the last user message instead of a trailing assistant message', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_trailing_assistant',
      contextId: 'ctx_trailing_assistant',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: 'task_trailing_assistant',
      contextId: 'ctx_trailing_assistant',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_trailing_assistant' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState.mockReturnValue({
      taskId: 'task_trailing_assistant',
      contextId: 'ctx_trailing_assistant',
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const stream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'First question' }],
            timestamp: Date.now() - 10,
          },
          {
            role: 'assistant',
            content: [],
            timestamp: Date.now() - 5,
          },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Latest user prompt' }],
            timestamp: Date.now() - 3,
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'Prior assistant output' }],
            timestamp: Date.now(),
          },
        ],
      },
    );

    await collectEvents(stream);

    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Latest user prompt',
      taskId: 'task_trailing_assistant',
      contextId: 'ctx_trailing_assistant',
      model: 'gemini-a2a',
      signal: undefined,
    });
  });

  it('preserves legacy string user content', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_string_prompt',
      contextId: 'ctx_string_prompt',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: 'task_string_prompt',
      contextId: 'ctx_string_prompt',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_string_prompt' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState.mockReturnValue({
      taskId: 'task_string_prompt',
      contextId: 'ctx_string_prompt',
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const stream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'user',
            content: 'Legacy string prompt',
            timestamp: Date.now(),
          },
        ],
      },
    );

    await collectEvents(stream);

    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Legacy string prompt',
      taskId: 'task_string_prompt',
      contextId: 'ctx_string_prompt',
      model: 'gemini-a2a',
      signal: undefined,
    });
  });
});
