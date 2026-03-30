/**
 * Stream Simple Tests
 *
 * Tests for the streamSimple orchestration handler.
 * Covers fresh prompts, MCP intercept, native auto-continue,
 * re-call reinjection, and transport/injection failure paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamSimple, streamSimpleGsd, resetTaskContext, type AssistantMessageEvent } from './stream-simple.js';
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
    // First call: no taskId/contextId sent — server creates its own
    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Test prompt',
      taskId: undefined,
      contextId: undefined,
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
            name: 'search',
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
      // Uses server's task UUID (falls back to a2aTaskId when serverTaskId not in mock events)
      taskId: 'task_native',
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

  it('re-call injects all available results before surfacing the next toolUse stop', async () => {
    const mockTaskId = 'task_multi';
    const mockContextId = 'ctx_multi';

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_1',
        name: 'mcp_tools_read',
        args: { path: 'a.txt' },
        status: 'scheduled',
      },
      {
        callId: 'call_2',
        name: 'mcp_tools_bash',
        args: { command: 'pwd' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult
      .mockResolvedValueOnce({
        taskId: mockTaskId,
        sseStream: new ReadableStream(),
        metadata: { url: 'http://localhost:41242/', requestId: 'req_inject_1' },
      })
      .mockResolvedValueOnce({
        taskId: mockTaskId,
        sseStream: new ReadableStream(),
        metadata: { url: 'http://localhost:41242/', requestId: 'req_inject_2' },
      });

    // parseSSEStream is called for each inject's SSE response.
    // First inject: text events only (model processes first result).
    // Second inject: model calls a new tool (call_3).
    mockParseSSEStream
      .mockImplementationOnce(async function* () {
        yield createTextEvent('First result received');
      })
      .mockImplementationOnce(async function* () {
        yield createToolCallEvent('call_3', 'mcp_tools_write', { path: 'out.txt' });
        yield createStateChangeEvent('input-required', true, true);
      });

    // First inject SSE: no new tools. Second inject SSE: call_3 appears.
    mockGetTaskState
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
        state: 'input-required',
        awaitingApproval: true,
        pendingToolCalls: [
          {
            callId: 'call_3',
            name: 'mcp_tools_write',
            args: { path: 'out.txt' },
            status: 'scheduled',
          },
        ],
        isTerminal: false,
      });

    const { stream, result } = streamSimple({
      prompt: '',
      context: {
        messages: [
          { role: 'assistant', stopReason: 'toolUse', content: [] },
          {
            role: 'toolResult',
            toolCallId: 'call_1',
            toolName: 'mcp_tools_read',
            isError: false,
            content: [{ type: 'text', text: 'file text' }],
          },
          {
            role: 'toolResult',
            toolCallId: 'call_2',
            toolName: 'mcp_tools_bash',
            isError: false,
            content: [{ type: 'text', text: '/tmp' }],
          },
        ],
      } as any,
      taskId: mockTaskId,
      contextId: mockContextId,
    });

    const events = await collectEvents(stream);
    const finalResult = await result;

    expect(mockInjectResult).toHaveBeenCalledTimes(2);
    expect(mockInjectResult).toHaveBeenNthCalledWith(1, {
      taskId: mockTaskId,
      callId: 'call_1',
      toolName: 'mcp_tools_read',
      functionResponse: { output: 'file text' },
      isError: undefined,
      signal: undefined,
    });
    expect(mockInjectResult).toHaveBeenNthCalledWith(2, {
      taskId: mockTaskId,
      callId: 'call_2',
      toolName: 'mcp_tools_bash',
      functionResponse: { output: '/tmp' },
      isError: undefined,
      signal: undefined,
    });
    expect(mockClearPendingToolCalls).toHaveBeenCalledWith(mockTaskId, ['call_1', 'call_2']);
    expect(finalResult.stopReason).toBe('toolUse');
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'toolUse' });
  });

  it('re-call injects error results with explicit error metadata', async () => {
    const mockTaskId = 'task_error_result';
    const mockContextId = 'ctx_error_result';

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_err',
        name: 'mcp_tools_bash',
        args: { command: 'false' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockResolvedValue({
      taskId: mockTaskId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_inject_err' },
    });


    mockParseSSEStream.mockImplementation(async function* () {
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
          { role: 'assistant', stopReason: 'toolUse', content: [] },
          {
            role: 'toolResult',
            toolCallId: 'call_err',
            toolName: 'mcp_tools_bash',
            isError: true,
            content: [{ type: 'text', text: 'command failed' }],
          },
        ],
      } as any,
      taskId: mockTaskId,
      contextId: mockContextId,
    });

    await collectEvents(stream);
    await result;

    expect(mockInjectResult).toHaveBeenCalledWith({
      taskId: mockTaskId,
      callId: 'call_err',
      toolName: 'mcp_tools_bash',
      functionResponse: { output: 'command failed' },
      isError: true,
      signal: undefined,
    });
  });

  it('treats provided taskId/contextId as re-call when toolResult is last message', async () => {
    const mockTaskId = 'task_direct_recall';
    const mockContextId = 'ctx_direct_recall';

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_direct',
        name: 'mcp_tools_read',
        args: { path: 'x' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockResolvedValue({
      taskId: mockTaskId,
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_direct_recall' },
    });


    mockParseSSEStream.mockImplementation(async function* () {
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

    // toolResult must be the LAST message for detectReCall to trigger
    const { stream, result } = streamSimple({
      prompt: 'ignored for recall routing',
      context: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'fresh-looking prompt' }] },
          {
            role: 'toolResult',
            toolCallId: 'call_direct',
            toolName: 'mcp_tools_read',
            isError: false,
            content: [{ type: 'text', text: 'value' }],
          },
        ],
      } as any,
      taskId: mockTaskId,
      contextId: mockContextId,
    });

    await collectEvents(stream);
    await result;

    expect(mockInjectResult).toHaveBeenCalledTimes(1);
    expect(mockSendMessageStream).not.toHaveBeenCalled();
  });

  it('treats stale historical toolResult messages as a fresh prompt', async () => {
    const mockTaskId = 'task_fresh_after_history';
    const mockContextId = 'ctx_fresh_after_history';

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
      metadata: { url: 'http://localhost:41242/', requestId: 'req_fresh_after_history' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createTextEvent('Fresh turn response');
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
      prompt: 'Second prompt',
      context: {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'First prompt' }] },
          { role: 'assistant', content: [] },
          {
            role: 'toolResult',
            toolCallId: 'call_old',
            toolName: 'mcp_tools_read',
            isError: false,
            content: [{ type: 'text', text: 'Old result' }],
          },
          { role: 'assistant', content: [] },
          { role: 'user', content: [{ type: 'text', text: 'Second prompt' }] },
        ],
      } as any,
    });

    const events = await collectEvents(stream);
    await result;

    expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
    // No taskId passed as param → fresh prompt, no IDs sent to server
    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Second prompt',
      taskId: undefined,
      contextId: undefined,
      model: undefined,
      signal: undefined,
    });
    expect(mockInjectResult).not.toHaveBeenCalled();
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

    await expect(result).rejects.toThrow();
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
            toolName: 'mcp_tools_search',
            isError: false,
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
    resetTaskContext();
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

    // First call in session: no taskId sent (server creates task)
    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Hello. What model are you?',
      taskId: undefined,
      contextId: undefined,
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

    // First call in session: no taskId sent (server creates task)
    expect(mockSendMessageStream).toHaveBeenCalledWith({
      prompt: 'Latest user prompt',
      taskId: undefined,
      contextId: undefined,
      model: 'gemini-a2a',
      signal: undefined,
    });
  });

  it('stores fresh task IDs before emitting done so immediate re-calls reuse them', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_race',
      contextId: 'ctx_race',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: 'task_race',
      contextId: 'ctx_race',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_race' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createToolCallEvent('call_race', 'mcp_tools_search', { query: 'race' });
      yield createStateChangeEvent('input-required', true, false);
    });

    mockGetTaskState
      .mockReturnValueOnce({
        taskId: 'task_race',
        contextId: 'ctx_race',
        state: 'working',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      })
      .mockReturnValueOnce({
        taskId: 'task_race',
        contextId: 'ctx_race',
        state: 'input-required',
        awaitingApproval: true,
        pendingToolCalls: [],
        isTerminal: false,
      });

    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_race',
        name: 'mcp_tools_search',
        args: { query: 'race' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockResolvedValue({
      taskId: 'task_race',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_race_recall' },
    });

    const recallState = {
      taskId: 'task_race',
      contextId: 'ctx_race',
      state: 'completed' as const,
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    };

    let recallTriggered = false;

    const initialStream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Trigger tool call' }],
            timestamp: Date.now(),
          },
        ],
      },
    );

    for await (const event of initialStream) {
      if (event.type === 'done') {
        recallTriggered = true;
        mockGetTaskState.mockReturnValue(recallState);

        const recallStream = streamSimpleGsd(
          { id: 'gemini-a2a' } as any,
          {
            messages: [
              {
                role: 'toolResult',
                toolCallId: 'call_race',
                toolName: 'mcp_tools_search',
                isError: false,
                content: [{ type: 'text', text: 'Search results' }],
                timestamp: Date.now(),
              },
            ],
          } as any,
        );

        await collectEvents(recallStream);
      }
    }

    expect(recallTriggered).toBe(true);
    expect(mockInjectResult).toHaveBeenCalledWith({
      taskId: 'task_race',
      callId: 'call_race',
      toolName: 'mcp_tools_search',
      functionResponse: { output: 'Search results' },
      isError: undefined,
      signal: undefined,
    });
    expect(mockSendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('uses the last fresh task IDs for re-calls', async () => {
    mockCreateTask.mockReturnValue({
      taskId: 'task_initial',
      contextId: 'ctx_initial',
      state: 'submitted',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: false,
    });

    mockSendMessageStream.mockResolvedValue({
      taskId: 'task_initial',
      contextId: 'ctx_initial',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_initial' },
    });

    mockParseSSEStream.mockImplementation(async function* () {
      yield createStateChangeEvent('completed', false, true);
    });

    mockGetTaskState.mockReturnValue({
      taskId: 'task_initial',
      contextId: 'ctx_initial',
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const initialStream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Initial prompt' }],
            timestamp: Date.now(),
          },
        ],
      },
    );

    await collectEvents(initialStream);

    mockSendMessageStream.mockClear();
    mockGetPendingToolCalls.mockReturnValue([
      {
        callId: 'call_recall',
        name: 'mcp_tools_search',
        args: { query: 'test' },
        status: 'scheduled',
      },
    ]);

    mockInjectResult.mockResolvedValue({
      taskId: 'task_initial',
      sseStream: new ReadableStream(),
      metadata: { url: 'http://localhost:41242/', requestId: 'req_recall' },
    });

    mockGetTaskState.mockReturnValue({
      taskId: 'task_initial',
      contextId: 'ctx_initial',
      state: 'completed',
      awaitingApproval: false,
      pendingToolCalls: [],
      isTerminal: true,
    });

    const recallStream = streamSimpleGsd(
      { id: 'gemini-a2a' } as any,
      {
        messages: [
          {
            role: 'toolResult',
            toolCallId: 'call_recall',
            toolName: 'mcp_tools_search',
            isError: false,
            content: [{ type: 'text', text: 'Search results' }],
            timestamp: Date.now(),
          },
        ],
      } as any,
    );

    await collectEvents(recallStream);

    expect(mockSendMessageStream).not.toHaveBeenCalled();
    expect(mockInjectResult).toHaveBeenCalledWith({
      taskId: 'task_initial',
      callId: 'call_recall',
      toolName: 'mcp_tools_search',
      functionResponse: { output: 'Search results' },
      isError: undefined,
      signal: undefined,
    });
  });
});
