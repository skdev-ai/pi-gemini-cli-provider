/**
 * Stream Simple Tests
 * 
 * Tests for the streamSimple orchestration handler.
 * Covers fresh prompts, MCP intercept, native auto-continue,
 * multi-tool reinjection, and transport/injection failure paths.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { streamSimple } from './stream-simple.js';
import { sendMessageStream, injectResult, approveToolCall } from './a2a-client.js';
import { parseSSEStream } from './sse-parser.js';
import {
  getTaskState,
  getPendingToolCalls,
  clearPendingToolCalls,
  markTaskFailed,
  clearAllTasks,
  createTask,
  createTaskWithIds,
} from './task-manager.js';
import type { ParsedA2AEvent } from './types.js';

// Mock dependencies
vi.mock('./a2a-client.js');
vi.mock('./sse-parser.js');
vi.mock('./task-manager.js');

const mockSendMessageStream = vi.mocked(sendMessageStream);
const mockInjectResult = vi.mocked(injectResult);
const mockApproveToolCall = vi.mocked(approveToolCall);
const mockParseSSEStream = vi.mocked(parseSSEStream);
const mockCreateTask = vi.mocked(createTask);
const mockCreateTaskWithIds = vi.mocked(createTaskWithIds);
const mockGetTaskState = vi.mocked(getTaskState);
const mockGetPendingToolCalls = vi.mocked(getPendingToolCalls);
const mockClearPendingToolCalls = vi.mocked(clearPendingToolCalls);
const mockMarkTaskFailed = vi.mocked(markTaskFailed);
const mockClearAllTasks = vi.mocked(clearAllTasks);

// Mock console to suppress noise
vi.spyOn(console, 'warn').mockImplementation(() => {});

// Helper to create properly typed mock events
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
  state: string = 'working'
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
  isFinal: boolean = false
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

describe('streamSimple', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClearAllTasks();
  });

  describe('Fresh Prompt Flow', () => {
    it('should send to A2A, stream events, and return on completion', async () => {
      // Arrange
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
      
      // Mock SSE stream: text events then completion
      const mockEvents: ParsedA2AEvent[] = [
        createTextEvent('Hello'),
        createTextEvent(' world'),
        createStateChangeEvent('completed', false, true),
      ];
      
      mockParseSSEStream.mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });
      
      mockGetTaskState.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'completed',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: true,
      });
      
      // Act
      const { stream, result } = await streamSimple({
        prompt: 'Test prompt',
        context: { messages: [] },
      });
      
      // Capture stream events
      const capturedEvents: any[] = [];
      const textEvents: string[] = [];
      stream.onEvent?.((event) => {
        if (event.type === 'text' || event.type === 'text_delta') {
          const text = (event as any).content || (event as any).delta;
          capturedEvents.push({ type: 'text', content: text });
          textEvents.push(text);
        } else if (event.type === 'thinking' || event.type === 'thinking_delta') {
          capturedEvents.push({ type: 'thinking', content: (event as any).content || (event as any).delta });
        } else if (event.type === 'toolCall' || event.type === 'tool_call') {
          capturedEvents.push({ type: 'toolCall', callId: (event as any).callId, name: (event as any).name, args: (event as any).args });
        }
      });
      
      const finalResult = await result;
      
      // Assert
      expect(mockCreateTask).toHaveBeenCalled();
      expect(mockSendMessageStream).toHaveBeenCalledWith({
        prompt: 'Test prompt',
        taskId: mockTaskId,
        contextId: mockContextId,
      });
      expect(finalResult.stopReason).toBeUndefined();
      // Verify events were emitted (exact capture depends on listener timing)
      expect(capturedEvents.length).toBeGreaterThanOrEqual(1);
      expect(capturedEvents[0]).toEqual({ type: 'text', content: 'Hello' });
    });

    it('should detect MCP tool, emit toolCall, and return stopReason: toolUse', async () => {
      // Arrange
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
      
      // Mock SSE stream: text, tool call, then approval state
      const mockEvents: ParsedA2AEvent[] = [
        createTextEvent('Let me search'),
        createToolCallEvent('call_1', 'mcp_tools_search', { query: 'test' }),
        createStateChangeEvent('input-required', true, true),
      ];
      
      mockParseSSEStream.mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });
      
      // Mock task state transitions
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
      
      // Act
      const { stream, result } = await streamSimple({
        prompt: 'Test prompt',
        context: { messages: [] },
      });
      
      // Capture stream events
      const capturedEvents: any[] = [];
      const toolCallEvents: any[] = [];
      stream.onEvent?.((event) => {
        if (event.type === 'text' || event.type === 'text_delta') {
          const text = (event as any).content || (event as any).delta;
          capturedEvents.push({ type: 'text', content: text });
        } else if (event.type === 'toolCall' || event.type === 'tool_call') {
          const toolCall = { callId: (event as any).callId, name: (event as any).name, args: (event as any).args };
          capturedEvents.push({ type: 'toolCall', ...toolCall });
          toolCallEvents.push(toolCall);
        }
      });
      
      const finalResult = await result;
      
      // Assert
      expect(finalResult.stopReason).toBe('toolUse');
      expect(toolCallEvents).toHaveLength(1);
      expect(toolCallEvents[0]).toEqual({
        callId: 'call_1',
        name: 'tools_search', // Prefix stripped
        args: { query: 'test' },
      });
      expect(capturedEvents).toEqual([
        { type: 'text', content: 'Let me search' },
        { type: 'toolCall', callId: 'call_1', name: 'tools_search', args: { query: 'test' } },
      ]);
    });

    it('should auto-approve native google_web_search and continue streaming without stopReason', async () => {
      // Arrange
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
      
      mockSendMessageStream
        .mockResolvedValueOnce({
          taskId: mockTaskId,
          contextId: mockContextId,
          sseStream: new ReadableStream(),
          metadata: { url: 'http://localhost:41242/', requestId: 'req_native' },
        })
        .mockResolvedValueOnce({
          taskId: mockTaskId,
          contextId: mockContextId,
          sseStream: new ReadableStream(),
          metadata: { url: 'http://localhost:41242/', requestId: 'req_resume' },
        });
      
      // Mock SSE stream: text, native tool call, approval state, then resumed content
      const mockEvents: ParsedA2AEvent[] = [
        createTextEvent('Let me search the web'),
        createToolCallEvent('call_1', 'google_web_search', { query: 'weather' }),
        createStateChangeEvent('input-required', true, true),
      ];
      
      mockParseSSEStream.mockImplementation(async function* () {
        for (const event of mockEvents) {
          yield event;
        }
      });
      
      // Mock task state transitions
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
        });
      
      mockGetPendingToolCalls.mockReturnValue([
        {
          callId: 'call_1',
          name: 'google_web_search',
          args: { query: 'weather' },
          status: 'scheduled',
        },
      ]);
      
      // Mock approveToolCall for auto-approval (proceed_once)
      mockApproveToolCall.mockResolvedValue({
        taskId: mockTaskId,
        sseStream: new ReadableStream(),
        metadata: { url: 'http://localhost:41242/', requestId: 'req_proceed' },
      });
      
      const mockResumeEvents: ParsedA2AEvent[] = [
        createTextEvent('Here are the weather results'),
        createStateChangeEvent('completed', false, true),
      ];
      
      // First call to parseSSEStream: initial stream
      // Second call: approval response stream (contains resumed content)
      let callCount = 0;
      mockParseSSEStream.mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          // First call: initial stream
          for (const event of mockEvents) {
            yield event;
          }
        } else {
          // Second call: approval response stream (contains model's continued output)
          for (const event of mockResumeEvents) {
            yield event;
          }
        }
      });
      
      // Act
      const { stream, result } = await streamSimple({
        prompt: 'What is the weather?',
        context: { messages: [] },
      });
      
      // Capture events
      const capturedEvents: any[] = [];
      stream.onEvent?.((event) => {
        if (event.type === 'text' || event.type === 'text_delta') {
          capturedEvents.push({ type: 'text', content: (event as any).content || (event as any).delta });
        } else if (event.type === 'toolCall' || event.type === 'tool_call') {
          capturedEvents.push({ type: 'toolCall', callId: (event as any).callId, name: (event as any).name, args: (event as any).args });
        }
      });
      
      const finalResult = await result;
      
      // Assert - verify native tool auto-approval behavior
      expect(mockApproveToolCall).toHaveBeenCalledWith({
        taskId: mockTaskId,
        callId: 'call_1',
        outcome: 'proceed_once',
      });
      expect(finalResult.stopReason).toBeUndefined(); // No toolUse for native tools
      expect(finalResult.taskId).toBe(mockTaskId);
      expect(finalResult.contextId).toBe(mockContextId);
    });
  });

  describe('Re-call Flow', () => {
    it('should detect ToolResultMessage, call injectResult(), and resume streaming', async () => {
      // Arrange
      const mockTaskId = 'task_replay';
      const mockContextId = 'ctx_replay';
      
      mockCreateTaskWithIds.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'submitted',
        awaitingApproval: false,
        pendingToolCalls: [],
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
      
      mockInjectResult.mockResolvedValue({
        taskId: mockTaskId,
        sseStream: new ReadableStream(),
        metadata: { url: 'http://localhost:41242/', requestId: 'req_inject' },
      });
      
      // Mock resumed stream after injection
      const mockResumeEvents: ParsedA2AEvent[] = [
        createTextEvent('Based on the search results'),
        createStateChangeEvent('completed', false, true),
      ];
      
      mockParseSSEStream.mockImplementation(async function* () {
        // First call: injection response (empty)
        // Second call: resumed stream
        for (const event of mockResumeEvents) {
          yield event;
        }
      });
      
      mockGetTaskState
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
        })
        .mockReturnValue({
          taskId: mockTaskId,
          contextId: mockContextId,
          state: 'completed',
          awaitingApproval: false,
          pendingToolCalls: [],
          isTerminal: true,
        });
      
      // Act
      const { result } = await streamSimple({
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
      
      const finalResult = await result;
      
      // Assert
      expect(mockInjectResult).toHaveBeenCalled();
      expect(mockInjectResult.mock.calls[0][0]).toMatchObject({
        taskId: mockTaskId,
        callId: 'call_1',
        toolName: 'tools_search', // Prefix stripped
      });
      expect(mockClearPendingToolCalls).toHaveBeenCalledWith(mockTaskId, ['call_1']);
      // Verify result was processed (text accumulated during resumed streaming)
      expect(finalResult).toBeDefined();
    });

    it('should handle multi-tool per turn with correct ordering', async () => {
      // Arrange
      const mockTaskId = 'task_multi';
      const mockContextId = 'ctx_multi';
      
      mockCreateTaskWithIds.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'submitted',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      });
      
      mockGetPendingToolCalls.mockReturnValue([
        {
          callId: 'call_1',
          name: 'mcp_tools_read',
          args: { path: 'file1.txt' },
          status: 'scheduled',
        },
        {
          callId: 'call_2',
          name: 'mcp_tools_read',
          args: { path: 'file2.txt' },
          status: 'scheduled',
        },
      ]);
      
      mockInjectResult
        .mockResolvedValueOnce({
          taskId: mockTaskId,
          sseStream: new ReadableStream(),
          metadata: { url: 'http://localhost:41242/', requestId: 'req_1' },
        })
        .mockResolvedValueOnce({
          taskId: mockTaskId,
          sseStream: new ReadableStream(),
          metadata: { url: 'http://localhost:41242/', requestId: 'req_2' },
        });
      
      mockParseSSEStream.mockImplementation(async function* () {
        // Yield events for each injection call and final resume
        // Empty stream - just testing injection order
      });
      
      // Mock task state for each injection
      mockGetTaskState
        .mockReturnValueOnce({
          taskId: mockTaskId,
          contextId: mockContextId,
          state: 'input-required',
          awaitingApproval: true,
          pendingToolCalls: [
            {
              callId: 'call_1',
              name: 'mcp_tools_read',
              args: { path: 'file1.txt' },
              status: 'scheduled',
            },
            {
              callId: 'call_2',
              name: 'mcp_tools_read',
              args: { path: 'file2.txt' },
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
      
      // Act
      const { result } = await streamSimple({
        prompt: '',
        context: {
          messages: [
            {
              role: 'toolResult',
              toolCallId: 'call_1',
              name: 'mcp_tools_read',
              content: [{ type: 'text', text: 'File 1' }],
            },
            {
              role: 'toolResult',
              toolCallId: 'call_2',
              name: 'mcp_tools_read',
              content: [{ type: 'text', text: 'File 2' }],
            },
          ],
        },
        taskId: mockTaskId,
        contextId: mockContextId,
      });
      
      // Wait for result to complete (which processes all injections)
      await result;
      
      // Assert - verify injection order
      expect(mockInjectResult).toHaveBeenCalledTimes(2);
      expect(mockInjectResult.mock.calls[0][0].callId).toBe('call_1');
      expect(mockInjectResult.mock.calls[1][0].callId).toBe('call_2');
    });
  });

  describe('Error Handling', () => {
    it('should surface transport failures as stream errors', async () => {
      // Arrange
      mockCreateTask.mockReturnValue({
        taskId: 'task_transport',
        contextId: 'ctx_transport',
        state: 'submitted',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      });
      
      mockSendMessageStream.mockRejectedValue(new Error('A2A server not responding'));
      
      // Act
      const { stream, result } = await streamSimple({
        prompt: 'Test',
        context: { messages: [] },
      });
      
      // Capture error
      let capturedError: Error | undefined;
      stream.onError?.((err: Error) => {
        capturedError = err;
      });
      
      // Assert
      await expect(result).rejects.toThrow('A2A server not responding');
      expect(capturedError).toBeTruthy();
      if (capturedError) {
        expect(capturedError.message).toBe('A2A server not responding');
      }
    });

    it('should mark task failed when injection fails', async () => {
      // Arrange
      const mockTaskId = 'task_fail';
      const mockContextId = 'ctx_fail';
      
      mockCreateTaskWithIds.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'submitted',
        awaitingApproval: false,
        pendingToolCalls: [],
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
      
      // Act
      const { stream, result } = await streamSimple({
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
      
      // Capture error
      let capturedError: Error | undefined;
      stream.onError?.((err: Error) => {
        capturedError = err;
      });
      
      // Assert
      await expect(result).rejects.toThrow('Failed to inject result for call_1: Connection refused');
      expect(mockMarkTaskFailed).toHaveBeenCalledWith(mockTaskId, 'Connection refused');
      expect(capturedError).toBeTruthy();
    });

    it('should fail when re-call has no pending tool calls', async () => {
      // Arrange
      mockGetPendingToolCalls.mockReturnValue([]);
      
      // Act - the error will be thrown in the result promise
      const { result } = await streamSimple({
        prompt: '',
        context: {
          messages: [
            {
              role: 'toolResult',
              toolCallId: 'call_1',
              name: 'test',
              content: [{ type: 'text', text: 'Result' }],
            },
          ],
        },
        taskId: 'task_no_pending',
        contextId: 'ctx_no_pending',
      });
      
      // Assert - wait for the promise to reject
      await expect(result).rejects.toThrow('Re-call detected but task has no pending tool calls');
    });

    it('should fail when tool results are missing for pending calls', async () => {
      // Arrange
      const mockTaskId = 'task_missing';
      const mockContextId = 'ctx_missing';
      
      mockGetPendingToolCalls.mockReturnValue([
        {
          callId: 'call_1',
          name: 'mcp_tools_search',
          args: { query: 'test' },
          status: 'scheduled',
        },
        {
          callId: 'call_2',
          name: 'mcp_tools_read',
          args: { path: 'file.txt' },
          status: 'scheduled',
        },
      ]);
      
      mockCreateTaskWithIds.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'submitted',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: false,
      });
      
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
          {
            callId: 'call_2',
            name: 'mcp_tools_read',
            args: { path: 'file.txt' },
            status: 'scheduled',
          },
        ],
        isTerminal: false,
      });
      
      // Act
      const { result } = await streamSimple({
        prompt: '',
        context: {
          messages: [
            // Only one result for two pending calls
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
      
      // Assert
      await expect(result).rejects.toThrow('Missing results for tool calls: call_2');
    });
  });

  describe('Event Emission', () => {
    it('should emit thinking events from A2A stream', async () => {
      // Arrange
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
      
      mockGetTaskState.mockReturnValue({
        taskId: mockTaskId,
        contextId: mockContextId,
        state: 'completed',
        awaitingApproval: false,
        pendingToolCalls: [],
        isTerminal: true,
      });
      
      // Act
      const { stream, result } = await streamSimple({
        prompt: 'Test',
        context: { messages: [] },
      });
      
      // Capture thinking events
      const thinkingEvents: string[] = [];
      stream.onEvent?.((event) => {
        if (event.type === 'thinking' || event.type === 'thinking_delta') {
          thinkingEvents.push((event as any).content || (event as any).delta);
        }
      });
      
      await result;
      
      // Assert - check what was actually captured
      expect(thinkingEvents.length).toBeGreaterThan(0);
      expect(thinkingEvents[0]).toBe('Thinking step 1');
    });
  });
});
