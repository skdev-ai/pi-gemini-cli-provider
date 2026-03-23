/**
 * A2A HTTP Client Tests
 * 
 * Tests the transport layer for A2A message/stream and inject_result methods.
 * Uses mocked fetch to verify request construction, headers, body shape,
 * task reuse behavior, and typed error handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendMessageStream, injectResult } from './a2a-client.js';
import type { A2ATransportError } from './types.js';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ReadableStream for SSE responses.
 */
function createMockSSEStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Creates a mock fetch response with SSE stream.
 */
function createMockResponse(options?: { status?: number; body?: ReadableStream | undefined }): Response {
  return {
    ok: options?.status === undefined || options.status === 200,
    status: options?.status ?? 200,
    body: options?.body ?? createMockSSEStream(),
  } as Response;
}

// ============================================================================
// Tests
// ============================================================================

describe('sendMessageStream', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('posts to root endpoint with correct JSON-RPC body', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const prompt = 'Test prompt';
    await sendMessageStream({ prompt });

    // Verify URL is root endpoint, NOT /message/stream
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:41242/',
      expect.objectContaining({
        method: 'POST',
      })
    );

    // Verify request body shape
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    
    expect(body).toEqual({
      id: expect.stringMatching(/^req_/),
      jsonrpc: '2.0',
      method: 'message/stream',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: 'Test prompt' }],
          messageId: expect.stringMatching(/^req_/),
        },
      },
    });
  });

  it('sets correct headers for SSE', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await sendMessageStream({ prompt: 'Test' });

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('text/event-stream');
  });

  it('includes model override in metadata when provided', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await sendMessageStream({
      prompt: 'Test',
      model: 'gemini-3-flash-preview',
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    
    expect(body.params.message.metadata).toEqual({
      _model: 'gemini-3-flash-preview',
    });
  });

  it('omits metadata when model is not provided', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await sendMessageStream({ prompt: 'Test' });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    
    expect(body.params.message.metadata).toBeUndefined();
  });

  it('reuses existing taskId for multi-turn continuity', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const existingTaskId = 'task_existing_123';
    const existingContextId = 'ctx_existing_456';
    
    await sendMessageStream({
      prompt: 'Follow-up',
      taskId: existingTaskId,
      contextId: existingContextId,
    });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    
    // Verify taskId and contextId are included in request
    expect(body.params.taskId).toBe(existingTaskId);
    expect(body.params.contextId).toBe(existingContextId);
  });

  it('generates new taskId and contextId when not provided', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const result = await sendMessageStream({ prompt: 'New conversation' });

    expect(result.taskId).toMatch(/^task_/);
    expect(result.contextId).toMatch(/^ctx_/);
  });

  it('returns SSE stream from response', async () => {
    const mockStream = createMockSSEStream();
    mockFetch.mockResolvedValueOnce(createMockResponse({ body: mockStream }));

    const result = await sendMessageStream({ prompt: 'Test' });

    expect(result.sseStream).toBeInstanceOf(ReadableStream);
  });

  it('includes request metadata for debugging', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const result = await sendMessageStream({ prompt: 'Test' });

    expect(result.metadata).toEqual({
      url: 'http://localhost:41242/',
      requestId: expect.stringMatching(/^req_/),
    });
  });

  it('throws CONNECTION_REFUSED error when fetch fails with ECONNREFUSED', async () => {
    const connectionError = new TypeError('fetch failed: ECONNREFUSED');
    mockFetch.mockRejectedValueOnce(connectionError);

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'CONNECTION_REFUSED',
        message: expect.stringContaining('Cannot connect to A2A server'),
      } as A2ATransportError);
  });

  it('throws CONNECTION_TIMEOUT error on connection timeout', async () => {
    const abortError = new Error('Connection timeout');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'CONNECTION_TIMEOUT',
        message: expect.stringContaining('timed out'),
      } as A2ATransportError);
  });

  it('throws RESPONSE_TIMEOUT error on response timeout', async () => {
    const abortError = new Error('Response timeout');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'RESPONSE_TIMEOUT',
        message: expect.stringContaining('did not respond'),
      } as A2ATransportError);
  });

  it('throws ABORTED error when user aborts request', async () => {
    const abortError = new Error('Request aborted by user');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'ABORTED',
        message: 'Request aborted by user',
      } as A2ATransportError);
  });

  it('throws HTTP_ERROR on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({ status: 500 }));

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'HTTP_ERROR',
        message: expect.stringContaining('status 500'),
      } as A2ATransportError);
  });

  it('throws PARSE_ERROR when response has no body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: undefined,
    } as unknown as Response);

    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toMatchObject({
        type: 'PARSE_ERROR',
        message: expect.stringContaining('no body'),
      } as A2ATransportError);
  });
});

describe('injectResult', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('posts to root endpoint with inject_result method', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const params = {
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'mcp_gsd-test_test_echo',
      functionResponse: { result: 'success' },
    };
    
    await injectResult(params);

    // Verify URL is root endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:41242/',
      expect.objectContaining({
        method: 'POST',
      })
    );

    // Verify request body shape
    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1]?.body as string);
    
    expect(body).toEqual({
      id: expect.stringMatching(/^req_/),
      jsonrpc: '2.0',
      method: 'tasks/inject_result',
      params: {
        taskId: 'task_123',
        callId: 'call_456',
        functionResponse: {
          name: 'mcp_gsd-test_test_echo',
          response: { result: 'success' },
        },
      },
    });
  });

  it('sets correct headers for SSE', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    await injectResult({
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'test_tool',
      functionResponse: {},
    });

    const callArgs = mockFetch.mock.calls[0];
    const headers = callArgs[1]?.headers as Record<string, string>;
    
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Accept']).toBe('text/event-stream');
  });

  it('returns taskId and SSE stream', async () => {
    const mockStream = createMockSSEStream();
    mockFetch.mockResolvedValueOnce(createMockResponse({ body: mockStream }));

    const result = await injectResult({
      taskId: 'task_existing',
      callId: 'call_123',
      toolName: 'test',
      functionResponse: {},
    });

    expect(result.taskId).toBe('task_existing');
    expect(result.sseStream).toBeInstanceOf(ReadableStream);
  });

  it('includes request metadata', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse());

    const result = await injectResult({
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'test',
      functionResponse: {},
    });

    expect(result.metadata).toEqual({
      url: 'http://localhost:41242/',
      requestId: expect.stringMatching(/^req_/),
    });
  });

  it('throws CONNECTION_REFUSED error on connection failure', async () => {
    const connectionError = new TypeError('fetch failed: ECONNREFUSED');
    mockFetch.mockRejectedValueOnce(connectionError);

    await expect(injectResult({
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'test',
      functionResponse: {},
    }))
      .rejects
      .toMatchObject({
        type: 'CONNECTION_REFUSED',
        message: expect.stringContaining('Cannot connect'),
      } as A2ATransportError);
  });

  it('throws HTTP_ERROR on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({ status: 404 }));

    await expect(injectResult({
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'test',
      functionResponse: {},
    }))
      .rejects
      .toMatchObject({
        type: 'HTTP_ERROR',
        message: expect.stringContaining('status 404'),
      } as A2ATransportError);
  });

  it('propagates abort signal correctly', async () => {
    const abortController = new AbortController();
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    
    // Simulate abort after a delay
    mockFetch.mockImplementationOnce(() => {
      abortController.abort('Aborted');
      return Promise.reject(abortError);
    });

    await expect(injectResult({
      taskId: 'task_123',
      callId: 'call_456',
      toolName: 'test',
      functionResponse: {},
      signal: abortController.signal,
    }))
      .rejects
      .toMatchObject({
        type: 'ABORTED',
      } as A2ATransportError);
  });
});

describe('Error type coverage', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('distinguishes all transport error types', async () => {
    // Test CONNECTION_REFUSED
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed: ECONNREFUSED'));
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'CONNECTION_REFUSED');

    // Test CONNECTION_TIMEOUT
    const connTimeoutError = new Error('Connection timeout');
    connTimeoutError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(connTimeoutError);
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'CONNECTION_TIMEOUT');

    // Test RESPONSE_TIMEOUT
    const respTimeoutError = new Error('Response timeout');
    respTimeoutError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(respTimeoutError);
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'RESPONSE_TIMEOUT');

    // Test ABORTED
    const abortError = new Error('User aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'ABORTED');

    // Test HTTP_ERROR
    mockFetch.mockResolvedValueOnce(createMockResponse({ status: 503 }));
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'HTTP_ERROR');

    // Test PARSE_ERROR
    mockFetch.mockRejectedValueOnce(new Error('Invalid JSON'));
    await expect(sendMessageStream({ prompt: 'Test' }))
      .rejects
      .toHaveProperty('type', 'PARSE_ERROR');
  });
});
