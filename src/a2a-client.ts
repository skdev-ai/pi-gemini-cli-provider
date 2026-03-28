/**
 * A2A HTTP Client Module
 * 
 * Transport layer for communicating with the A2A server over HTTP JSON-RPC.
 * Implements message/stream and inject_result methods with proper timeout,
 * connection, and abort handling.
 * 
 * Critical: POST to root endpoint (http://localhost:41242/), NOT /message/stream path.
 * The method field in the JSON-RPC body specifies the operation.
 */

import type {
  A2AStreamRequest,
  A2AInjectResultRequest,
  A2ATransportError,
} from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default A2A server port */
const DEFAULT_A2A_PORT = 41242;

/** Connection timeout in milliseconds (time to establish TCP connection) */
const CONNECTION_TIMEOUT_MS = 500;

/** Response timeout in milliseconds (time to receive first byte) */
const RESPONSE_TIMEOUT_MS = 45000;

// ============================================================================
// Types
// ============================================================================

/**
 * Parameters for sendMessageStream operation.
 */
export interface SendMessageStreamParams {
  /** Prompt text to send */
  prompt: string;
  /** Optional existing task ID for multi-turn continuity */
  taskId?: string;
  /** Optional context ID for conversation history */
  contextId?: string;
  /** Optional model override (Patch 2: per-request model selection) */
  model?: string;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Result from sendMessageStream operation.
 */
export interface SendMessageStreamResult {
  /** Task ID for this conversation (new or reused) */
  taskId: string;
  /** Context ID for multi-turn continuity */
  contextId: string;
  /** SSE response stream for parsing */
  sseStream: ReadableStream<Uint8Array>;
  /** Response metadata for debugging */
  metadata: {
    url: string;
    requestId: string;
  };
}

/**
 * Parameters for injectResult operation.
 */
export interface InjectResultParams {
  /** Task ID to inject result into */
  taskId: string;
  /** Tool call ID this result is for */
  callId: string;
  /** Tool name (e.g., mcp_server_tool) */
  toolName: string;
  /** Function response content */
  functionResponse: unknown;
  /** Whether the tool execution failed */
  isError?: boolean;
  /** Optional abort signal */
  signal?: AbortSignal;
}

/**
 * Result from injectResult operation.
 */
export interface InjectResultResult {
  /** Task ID */
  taskId: string;
  /** SSE response stream for parsing */
  sseStream: ReadableStream<Uint8Array>;
  /** Response metadata */
  metadata: {
    url: string;
    requestId: string;
  };
}

/**
 * Parameters for approveToolCall operation.
 * 
 * Used to approve a tool call that is awaiting user approval.
 * Sends an outcome (proceed_once, modify, cancel) to the A2A server.
 */
export interface ApproveToolCallParams {
  /** Task ID containing the pending tool call */
  taskId: string;
  /** Tool call ID to approve */
  callId: string;
  /** Approval outcome */
  outcome: 'proceed_once' | 'modify' | 'cancel';
  /** Optional abort signal */
  signal?: AbortSignal;
}

/**
 * Result from approveToolCall operation.
 */
export interface ApproveToolCallResult {
  /** Task ID */
  taskId: string;
  /** SSE response stream for parsing */
  sseStream: ReadableStream<Uint8Array>;
  /** Response metadata */
  metadata: {
    url: string;
    requestId: string;
  };
}

// ============================================================================
// A2A Client Functions
// ============================================================================

/**
 * Sends a message to the A2A server using message/stream method.
 * 
 * Posts JSON-RPC request to root endpoint (http://localhost:41242/) with:
 * - method: "message/stream" in body (NOT in URL path)
 * - Accept: text/event-stream header for SSE response
 * - Optional metadata._model for per-request model override (Patch 2)
 * - Optional taskId/contextId for multi-turn continuity
 * 
 * @param params - Request parameters
 * @returns SendMessageStreamResult with task IDs and SSE stream
 * @throws A2ATransportError with typed failure mode
 */
export async function sendMessageStream(
  params: SendMessageStreamParams
): Promise<SendMessageStreamResult> {
  const { prompt, taskId, contextId, model, signal } = params;
  
  const url = `http://localhost:${DEFAULT_A2A_PORT}/`;
  const requestId = generateRequestId();
  
  // Construct JSON-RPC request body
  const requestBody: A2AStreamRequest = {
    id: requestId,
    jsonrpc: '2.0',
    method: 'message/stream',
    params: {
      message: {
        role: 'user',
        parts: [{ kind: 'text', text: prompt }],
        messageId: requestId,
        ...(model && {
          metadata: {
            _model: model,
          },
        }),
      },
      ...(taskId && { taskId }),
      ...(contextId && { contextId }),
    },
  };

  try {
    const response = await fetchWithTimeouts(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw createTransportError(
        'HTTP_ERROR',
        `A2A server responded with status ${response.status}`,
        { url }
      );
    }

    if (!response.body) {
      throw createTransportError('PARSE_ERROR', 'A2A response has no body');
    }

    return {
      taskId: taskId ?? generateTaskId(),
      contextId: contextId ?? generateContextId(),
      sseStream: response.body,
      metadata: {
        url,
        requestId,
      },
    };
  } catch (error) {
    throw mapFetchErrorToTransportError(error, url);
  }
}

/**
 * Injects a tool result into an existing A2A task.
 * 
 * Posts JSON-RPC request to root endpoint with:
 * - method: "message/stream" in body
 * - taskId and a data-part message containing:
 *   - callId
 *   - outcome: "inject_result"
 *   - functionResponse
 * 
 * Used after tool execution to provide results back to the A2A task.
 * This matches the live A2A tool-confirmation path used by approveToolCall().
 * 
 * @param params - Injection parameters
 * @returns InjectResultResult with SSE stream
 * @throws A2ATransportError with typed failure mode
 */
export async function injectResult(
  params: InjectResultParams
): Promise<InjectResultResult> {
  const { taskId, callId, toolName, functionResponse, isError, signal } = params;
  
  const url = `http://localhost:${DEFAULT_A2A_PORT}/`;
  const requestId = generateRequestId();

  // Construct JSON-RPC request body for inject_result via message/stream
  const requestBody: A2AInjectResultRequest = {
    id: requestId,
    jsonrpc: '2.0',
    method: 'message/stream',
    params: {
      taskId,
      message: {
        role: 'user',
        parts: [
          {
            kind: 'data',
            data: {
              callId,
              outcome: 'inject_result',
              functionResponse: {
                name: toolName,
                response: functionResponse,
                ...(isError !== undefined ? { isError } : {}),
              },
            },
          },
        ],
        messageId: requestId,
        // taskId in message body required — DefaultRequestHandler uses
        // incomingMessage.taskId to look up the existing task
        taskId,
      },
    },
  };

  try {
    const response = await fetchWithTimeouts(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw createTransportError(
        'HTTP_ERROR',
        `A2A server responded with status ${response.status}`,
        { url }
      );
    }

    if (!response.body) {
      throw createTransportError('PARSE_ERROR', 'A2A response has no body');
    }

    return {
      taskId,
      sseStream: response.body,
      metadata: {
        url,
        requestId,
      },
    };
  } catch (error) {
    throw mapFetchErrorToTransportError(error, url);
  }
}

/**
 * Approves a tool call that is awaiting user approval.
 * 
 * Posts JSON-RPC request to root endpoint with:
 * - method: "tasks/approve" in body
 * - taskId, callId, and outcome in params
 * 
 * Used to approve native tool calls (google_web_search, web_fetch)
 * by sending proceed_once outcome, allowing the A2A server to
 * execute the tool and continue streaming.
 * 
 * @param params - Approval parameters
 * @returns ApproveToolCallResult with SSE stream
 * @throws A2ATransportError with typed failure mode
 */
export async function approveToolCall(
  params: ApproveToolCallParams
): Promise<ApproveToolCallResult> {
  const { taskId, callId, outcome, signal } = params;

  const url = `http://localhost:${DEFAULT_A2A_PORT}/`;
  const approvalMessageId = generateRequestId();

  // Construct JSON-RPC request body for approve
  // `params.taskId` must be the server's internal task UUID (from SSE events).
  // The InMemoryTaskStore is keyed by this UUID.
  const requestBody = {
    id: approvalMessageId,
    jsonrpc: '2.0' as const,
    method: 'message/stream',
    params: {
      taskId,
      message: {
        role: 'user' as const,
        parts: [
          {
            kind: 'data' as const,
            data: {
              callId,
              outcome,
            },
          },
        ],
        messageId: approvalMessageId,
        // taskId/contextId in message body are required — DefaultRequestHandler
        // uses incomingMessage.taskId (not params.taskId) to look up the task
        taskId,
      },
    },
  };

  try {
    const response = await fetchWithTimeouts(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw createTransportError(
        'HTTP_ERROR',
        `A2A server responded with status ${response.status}`,
        { url }
      );
    }

    if (!response.body) {
      throw createTransportError('PARSE_ERROR', 'A2A response has no body');
    }

    return {
      taskId,
      sseStream: response.body,
      metadata: {
        url,
        requestId: approvalMessageId,
      },
    };
  } catch (error) {
    throw mapFetchErrorToTransportError(error, url);
  }
}

// ============================================================================
// Task Resubscribe
// ============================================================================

/**
 * Resubscribes to a task's event stream to receive pending events.
 *
 * Used after inject_result when the inject SSE stream closes before
 * tool-call-update events arrive. The resubscribe stream connects to
 * the task's event bus and delivers any pending/new events.
 */
export interface ResubscribeTaskParams {
  taskId: string;
  signal?: AbortSignal;
}

export interface ResubscribeTaskResult {
  sseStream: ReadableStream<Uint8Array>;
}

export async function resubscribeTask(
  params: ResubscribeTaskParams
): Promise<ResubscribeTaskResult> {
  const { taskId, signal } = params;
  const url = `http://localhost:${DEFAULT_A2A_PORT}/`;
  const requestId = generateRequestId();

  const requestBody = {
    id: requestId,
    jsonrpc: '2.0' as const,
    method: 'tasks/resubscribe',
    params: {
      id: taskId,
    },
  };

  try {
    const response = await fetchWithTimeouts(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      throw createTransportError('HTTP_ERROR', `Resubscribe failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw createTransportError('PARSE_ERROR', 'Resubscribe response has no body');
    }

    return { sseStream: response.body };
  } catch (error) {
    throw mapFetchErrorToTransportError(error, url);
  }
}

// ============================================================================
// Fetch with Timeout Handling
// ============================================================================

/**
 * Performs fetch with connection and response timeouts.
 * 
 * - Connection timeout: 500ms (time to establish TCP connection)
 * - Response timeout: 45s (time to receive first byte)
 * 
 * @param url - URL to fetch
 * @param options - Fetch options
 * @returns Fetch Response
 * @throws Typed transport errors
 */
async function fetchWithTimeouts(
  url: string,
  options: RequestInit
): Promise<Response> {
  const { signal: userSignal } = options;
  
  // Create abort controller for timeout management
  const timeoutController = new AbortController();
  
  // Set up connection timeout (500ms)
  const connectionTimeoutId = setTimeout(() => {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort('Connection timeout');
    }
  }, CONNECTION_TIMEOUT_MS);

  // Set up response timeout (45s) - will be cleared when response arrives
  const responseTimeoutId = setTimeout(() => {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort('Response timeout');
    }
  }, RESPONSE_TIMEOUT_MS);

  // Combine user signal with timeout signal
  const combinedSignal = combineAbortSignals(userSignal ?? undefined, timeoutController.signal);

  try {
    const response = await fetch(url, {
      ...options,
      signal: combinedSignal,
    });
    
    // Response received - clear timeouts
    clearTimeout(connectionTimeoutId);
    clearTimeout(responseTimeoutId);
    
    return response;
  } catch (error) {
    // Clear timeouts on error
    clearTimeout(connectionTimeoutId);
    clearTimeout(responseTimeoutId);
    throw error;
  }
}

/**
 * Combines multiple AbortSignals into one.
 * 
 * @param signals - Signals to combine
 * @returns Combined AbortSignal
 */
function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  
  for (const signal of signals) {
    if (signal?.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal?.addEventListener('abort', () => {
      controller.abort(signal.reason);
    }, { once: true });
  }
  
  return controller.signal;
}

// ============================================================================
// Error Handling
// ============================================================================

/**
 * Maps fetch errors to typed A2ATransportError objects.
 * 
 * @param error - Caught error from fetch
 * @param url - URL that was fetched (for error context)
 * @returns A2ATransportError with categorized failure mode
 */
function mapFetchErrorToTransportError(error: unknown, url: string): A2ATransportError {
  // Check if it's an abort error
  if (error instanceof Error && error.name === 'AbortError') {
    const message = error.message || 'Request was aborted';
    if (message.includes('Connection timeout')) {
      return createTransportError(
        'CONNECTION_TIMEOUT',
        `Connection to A2A server timed out after ${CONNECTION_TIMEOUT_MS}ms`,
        { url }
      );
    }
    if (message.includes('Response timeout')) {
      return createTransportError(
        'RESPONSE_TIMEOUT',
        `A2A server did not respond within ${RESPONSE_TIMEOUT_MS}ms`,
        { url }
      );
    }
    return createTransportError('ABORTED', message, { url });
  }

  // Check for connection refused (TypeError with specific message)
  if (error instanceof TypeError) {
    if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
      return createTransportError(
        'CONNECTION_REFUSED',
        `Cannot connect to A2A server at ${url}. Is the server running?`,
        { url, cause: error }
      );
    }
  }

  // Check if already a transport error
  if (isA2ATransportError(error)) {
    return error;
  }

  // Default: parse error
  return createTransportError(
    'PARSE_ERROR',
    error instanceof Error ? error.message : 'Unknown fetch error',
    { url, cause: error }
  );
}

/**
 * Creates a typed A2ATransportError object.
 * 
 * @param type - Error category
 * @param message - Human-readable message
 * @param context - Optional context (cause, url, etc.)
 * @returns A2ATransportError
 */
function createTransportError(
  type: A2ATransportError['type'],
  message: string,
  context?: { cause?: unknown; url?: string }
): A2ATransportError {
  const error: A2ATransportError = {
    type,
    message,
  };
  
  if (context?.cause !== undefined) {
    error.cause = context.cause;
  }
  
  return error;
}

/**
 * Type guard for A2ATransportError.
 * 
 * @param error - Error to check
 * @returns True if error is A2ATransportError
 */
function isA2ATransportError(error: unknown): error is A2ATransportError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    'message' in error
  );
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generates a unique request ID for JSON-RPC requests.
 * 
 * @returns Request ID string
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generates a unique task ID for new conversations.
 * 
 * @returns Task ID string
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Generates a unique context ID for multi-turn conversations.
 * 
 * @returns Context ID string
 */
function generateContextId(): string {
  return `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
