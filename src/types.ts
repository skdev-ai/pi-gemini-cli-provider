/**
 * Shared types for the gemini-cli-search extension.
 * These types define the contract for search results, URL resolution, and error handling.
 */

/**
 * Represents a resolved URL from Google grounding search.
 * The original URL is the opaque vertexaisearch redirect,
 * and resolved is the actual destination URL.
 */
export interface GroundingUrl {
  /** Display title extracted from the link text (e.g., "kraken.com") */
  title: string;
  /** The original URL from Gemini's response (may be a grounding redirect or direct URL) */
  original: string;
  /** The resolved actual URL after following any redirect */
  resolved: string;
  /** Whether the URL was successfully resolved */
  resolvedSuccessfully: boolean;
}

/**
 * Warning types for search results.
 * Used to indicate when Gemini answered from memory without searching.
 */
export interface SearchWarning {
  /** Warning type identifier */
  type: 'NO_SEARCH';
  /** Human-readable warning message */
  message: string;
}

/**
 * Structured error types for search operations.
 * Machine-distinguishable categories for error handling.
 */
export interface SearchError {
  /** Error type for programmatic handling */
  type:
    | 'CLI_NOT_FOUND'
    | 'NOT_AUTHENTICATED'
    | 'TIMEOUT'
    | 'PARSE_ERROR'
    | 'SEARCH_FAILED'
    // A2A server lifecycle errors
    /** Detected when gemini-cli-a2a package is not installed via npm list */
    | 'A2A_NOT_INSTALLED'
    /** Detected when a2a.ts patch is missing from gemini-cli-core */
    | 'A2A_NOT_PATCHED'
    /** Detected when server doesn't emit ready marker within 30s timeout (12s boot + margin) */
    | 'A2A_STARTUP_TIMEOUT'
    /** Detected when stderr contains 'FatalAuthenticationError' or 'OAuth token expired' */
    | 'A2A_AUTH_EXPIRED'
    /** Detected when headless mode flag is missing from startup command */
    | 'A2A_HEADLESS_MISSING'
    /** Detected when child process exits with non-zero code during runtime */
    | 'A2A_CRASHED'
    /** Detected when server is intentionally stopped via stopServer() */
    | 'A2A_STOPPED'
    /** Detected when A2A server accepts connection but no response within 45s (hung server) - S05 */
    | 'A2A_HUNG'
    /** Detected when A2A server cannot be reached (connection refused/timeout) - S05 */
    | 'A2A_CONNECTION_REFUSED'
    /** Detected when port 41242 is already in use by another process - Fix 10 */
    | 'A2A_PORT_CONFLICT'
    /** Detected when ACP warm subprocess fails to boot within timeout - S01 */
    | 'ACP_BOOT_FAILED'
    /** Detected when server respawn after health check failure fails - Bugfix 260320-1 */
    | 'A2A_RESPAWN_FAILED'
    /** Detected when inject_result patch is missing from A2A bundle - S02 */
    | 'A2A_INJECT_RESULT_NOT_PATCHED'
    /** Detected when pending tools are cancelled on abort instead of preserved during input-required state - Bugfix 260324-10 */
    | 'A2A_PENDING_TOOL_ABORT_NOT_PATCHED';
  /** Human-readable error message */
  message: string;
}

/**
 * Complete search result returned by the extension.
 * Contains either a successful result with answer and sources,
 * or error information if the search failed.
 */
export interface SearchResult {
  /** The AI-synthesized answer to the query */
  answer: string;
  /** List of source URLs used to ground the answer */
  sources: GroundingUrl[];
  /** Optional warning if Gemini answered from memory */
  warning?: SearchWarning;
  /** Optional error if the search failed */
  error?: SearchError;
  /**
   * Transport used for this search result.
   * Set to 'a2a', 'acp', or 'cold' for searches performed after S05.
   * Undefined for cached results from before S05 (pre-S05 results lack this field).
   * Used to track which transport successfully answered the query for cascade optimization.
   */
  transport?: 'a2a' | 'acp' | 'cold';
}

/**
 * Configuration options for search operations.
 */
export interface SearchOptions {
  /** Optional model to use for the search */
  model?: string;
  /** Optional timeout in milliseconds */
  timeout?: number;
  /** Optional abort signal for cancellation */
  signal?: AbortSignal;
  /** Optional callback for progress updates during search */
  onUpdate?: (message: string) => void;
}

/**
 * A2A server lifecycle state returned by getServerState().
 * Provides complete diagnostic visibility into server health and history.
 */
export interface A2AServerState {
  /** Current server status in lifecycle state machine */
  status: 'idle' | 'starting' | 'running' | 'stopped' | 'error';
  /** Port number the server is listening on (41242 default) */
  port: number;
  /** Uptime in milliseconds since server started, null if not running */
  uptime: number | null;
  /** Total number of searches processed since session start (search extension traffic) */
  searchCount: number;
  /** Total number of provider tasks processed since session start (provider extension traffic) */
  providerTaskCount: number;
  /** Most recent error encountered, null if no errors */
  lastError: SearchError | null;
  /** Exit code from child process, null if still running or not started */
  exitCode: number | null;
  /** Ring buffer of last 50 stdout lines for debugging */
  stdoutBuffer: string[];
  /** Ring buffer of last 50 stderr lines for debugging */
  stderrBuffer: string[];
}

/**
 * A2A SSE Event parsed by eventsource-parser.
 * Represents a single server-sent event from the A2A server stream.
 * The SSE data field contains a JSON-RPC 2.0 envelope.
 */
export interface A2AEvent {
  /** JSON-RPC envelope wrapping the result */
  id?: string;
  jsonrpc: '2.0';
  result: A2AResult;
}

/**
 * A2A result structure within a JSON-RPC response.
 * Contains metadata, status, and optional task completion markers.
 */
export interface A2AResult {
  /** Optional metadata about the coder agent and event type */
  metadata?: {
    coderAgent: {
      kind: 'text-content' | 'tool-call-update' | 'tool-call-confirmation' | 'thought' | 'state-change';
    };
  };
  /** Current task status with state and message parts */
  status: {
    /** Task state per A2A spec */
    state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';
    message: {
      parts: A2AMessagePart[];
    };
  };
  /** True when task is complete and this is the final event */
  final?: boolean;
}

/**
 * A2A message part - represents text or data content within a message.
 * CRITICAL: Use `kind` field (not `type`) to identify content type.
 */
export interface A2AMessagePart {
  /** Content type discriminator - must be 'kind', not 'type' */
  kind: 'text' | 'data';
  /** Text content when kind === 'text' */
  text?: string;
  /** Structured data when kind === 'data' */
  data?: {
    /** Tool call request details */
    request?: { callId: string; name: string; args: unknown };
    /** Tool execution status (sibling to request, not nested) */
    status?: 'validating' | 'scheduled' | 'executing' | 'success';
  };
}

/**
 * A2A task representation.
 * Contains task metadata, current status, and optional artifacts.
 */
export interface A2ATask {
  /** Unique task identifier */
  id: string;
  /** Context ID for multi-turn conversations */
  contextId: string;
  /** Current task status */
  status: {
    state: string;
    message: { parts: A2AMessagePart[] };
  };
  /** Optional artifacts produced by the task */
  artifacts?: A2AArtifact[];
}

/**
 * A2A artifact - output produced by a task.
 * Currently supports text artifacts.
 */
export interface A2AArtifact {
  /** Artifact type - currently only 'text' is supported */
  type: 'text';
  /** Text content of the artifact */
  text: string;
}

/**
 * A2A SSE Stream Parsing Guide
 * 
 * Key parsing rules for S05 transport implementation:
 * 
 * 1. SSE events contain JSON-RPC 2.0 envelopes
 *    - Parse using eventsource-parser@3.0.6
 *    - Each event: { id?, jsonrpc: "2.0", result: A2AResult }
 *    - Access result via JSON.parse(sseData).result
 * 
 * 2. Text content extraction path:
 *    event → result.status.message.parts[] → filter where kind === 'text' → extract .text
 * 
 * 3. Task completion detection:
 *    result.status.state === 'input-required' && result.final === true
 * 
 * 4. Tool call tracking:
 *    - kind === 'tool-call-update' indicates tool execution
 *    - data.request contains { callId, name, args }
 *    - data.status contains execution status (validating/scheduled/executing/success)
 * 
 * 5. CRITICAL: Always use `kind` field (not `type`)
 *    - Using `type` causes silent failure - A2A uses `kind` as discriminator
 *    - This applies to both A2AMessagePart and metadata.coderAgent
 * 
 * 6. Task state machine (A2A spec):
 *    submitted → working → (input-required | completed | failed | canceled | rejected)
 *    - 'submitted': Task accepted, not yet started
 *    - 'working': Task in progress
 *    - 'input-required': User input needed (check result.final for completion)
 *    - 'completed': Task finished successfully
 *    - 'failed' | 'canceled' | 'rejected': Terminal error states
 * 
 * Example SSE event structure:
 * ```json
 * {
 *   "id": "abc123",
 *   "jsonrpc": "2.0",
 *   "result": {
 *     "metadata": { "coderAgent": { "kind": "text-content" } },
 *     "status": {
 *       "state": "working",
 *       "message": {
 *         "parts": [
 *           { "kind": "text", "text": "Searching for..." }
 *         ]
 *       }
 *     }
 *   }
 * }
 * ```
 */

/**
 * Default search model used by all transports (A2A, ACP, cold).
 * Ensures consistent AI responses across transport types.
 * gemini-3-flash-preview selected for fastest response time (7.7s avg) and cleanest direct URL output.
 */
export const SEARCH_MODEL = 'gemini-3-flash-preview';

// ============================================================================
// A2A Transport Types (S03)
// ============================================================================

/**
 * Parsed A2A SSE event with typed discriminator.
 * Emitted by the SSE parser for each state-change/tool-call/text event.
 */
export interface ParsedA2AEvent {
  /** Event kind discriminator from result.metadata.coderAgent.kind */
  kind: 'state-change' | 'thought' | 'tool-call-update' | 'tool-call-confirmation' | 'text-content';
  /** Full A2A result object */
  result: A2AResult;
  /** Extracted text content (for text-content events) */
  text?: string;
  /** Extracted tool call metadata (for tool-call-update events) */
  toolCall?: ToolCallMetadata;
  /** True when task is complete with input-required + final flag */
  isAwaitingApproval?: boolean;
}

/**
 * Tool call metadata extracted from a tool-call-update event.
 */
export interface ToolCallMetadata {
  /** Unique call identifier for result injection */
  callId: string;
  /** Fully qualified tool name (e.g., mcp_server_tool) */
  name: string;
  /** Tool arguments as passed to the tool */
  args: unknown;
  /** Current execution status */
  status: 'validating' | 'scheduled' | 'executing' | 'success';
}

/**
 * Task state tracked by the task manager.
 * Persists across multi-turn conversations and tool approval flows.
 */
export interface TaskState {
  /** Unique task identifier */
  taskId: string;
  /** Context ID for multi-turn conversation continuity */
  contextId: string;
  /** Current lifecycle state from A2A spec */
  state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected';
  /** True when task is awaiting user approval (input-required + final) */
  awaitingApproval: boolean;
  /** Tool calls pending approval/execution */
  pendingToolCalls: ToolCallMetadata[];
  /** True when task has reached a terminal state */
  isTerminal: boolean;
  /** Last error message if state is failed/canceled/rejected */
  errorMessage?: string;
}

/**
 * A2A request parameters for message/stream method.
 */
export interface A2AStreamRequest {
  /** JSON-RPC request ID */
  id: string;
  /** JSON-RPC version */
  jsonrpc: '2.0';
  /** Always "message/stream" for A2A prompt submission */
  method: 'message/stream';
  /** Request parameters */
  params: {
    /** User message to send */
    message: {
      /** Always "user" for user messages */
      role: 'user';
      /** Message parts (text content) */
      parts: Array<{ kind: 'text'; text: string }>;
      /** Optional message ID for tracking */
      messageId?: string;
      /** Optional metadata for per-request model override */
      metadata?: {
        /** Model name override (Patch 2 from search extension) */
        _model?: string;
      };
    };
    /** Optional task ID for multi-turn (reuse existing task) */
    taskId?: string;
    /** Optional context ID for conversation continuity */
    contextId?: string;
  };
}

/**
 * A2A inject_result request parameters.
 *
 * Although this represents tool result reinjection, the live A2A server
 * expects it to be sent through `message/stream` as a data part with
 * `outcome: 'inject_result'`, matching the approval flow transport shape.
 */
export interface A2AInjectResultRequest {
  /** JSON-RPC request ID */
  id: string;
  /** JSON-RPC version */
  jsonrpc: '2.0';
  /** Always "message/stream" for tool result injection */
  method: 'message/stream';
  /** Request parameters */
  params: {
    /** Task ID to inject result into */
    taskId: string;
    /** User message carrying tool confirmation data */
    message: {
      /** Always "user" for user messages */
      role: 'user';
      /** Message parts containing the inject_result payload */
      parts: Array<{
        /** Structured data part */
        kind: 'data';
        /** Inject result payload */
        data: {
          /** Tool call ID this result is for */
          callId: string;
          /** Outcome discriminator consumed by the A2A patch */
          outcome: 'inject_result';
          /** Function response object */
          functionResponse: {
            /** Response name (usually matches tool name) */
            name: string;
            /** Response content (structured data) */
            response: unknown;
            /** Whether the tool execution failed */
            isError?: boolean;
          };
        };
      }>;
      /** Message ID for tracking */
      messageId: string;
    };
  };
}

/**
 * A2A transport error with categorized failure mode.
 */
export interface A2ATransportError {
  /** Error category for programmatic handling */
  type:
    | 'CONNECTION_REFUSED'
    | 'CONNECTION_TIMEOUT'
    | 'RESPONSE_TIMEOUT'
    | 'PARSE_ERROR'
    | 'HTTP_ERROR'
    | 'ABORTED';
  /** Human-readable error message */
  message: string;
  /** Optional underlying error for debugging */
  cause?: unknown;
}

// ============================================================================
// S04 Approval Flow Types
// ============================================================================

/**
 * Native tool allowlist for auto-approval.
 * These tools bypass MCP routing and are auto-approved.
 */
export const NATIVE_TOOL_ALLOWLIST = ['google_web_search', 'web_fetch'] as const;

/**
 * Native tool name type (for type-safe routing).
 */
export type NativeToolName = (typeof NATIVE_TOOL_ALLOWLIST)[number];

/**
 * Tool routing decision for a pending tool call.
 * Classifies whether a tool call should be routed to MCP or auto-approved as native.
 */
export interface ToolRoutingDecision {
  /** Original tool call metadata */
  toolCall: ToolCallMetadata;
  /** Routing classification */
  routing: 'mcp' | 'native';
  /** User-facing tool name (prefix-stripped for MCP tools) */
  displayName: string;
  /** Whether this tool is auto-approved (native) or requires approval (MCP) */
  autoApprove: boolean;
  /** Reason for routing decision */
  reason: string;
}

/**
 * Reinjection work item for a completed tool call.
 * Represents one inject_result() call to be made.
 */
export interface ReinjectionWorkItem {
  /** Tool call ID for this result */
  callId: string;
  /** Tool name (full A2A protocol name, e.g. mcp_tools_read — used for inject_result, not the display name) */
  toolName: string;
  /** Tool arguments */
  args: unknown;
  /** Tool result payload for injection */
  result: ToolResultPayload;
  /** Whether this was auto-approved (native) or required approval (MCP) */
  routing: 'mcp' | 'native';
}

/**
 * Tool result payload normalized for inject_result().
 * Compatible with pi's ToolResultMessage response shape, with explicit
 * error metadata preserved for the A2A inject_result patch.
 */
export interface ToolResultPayload {
  /** Response name (matches tool name) */
  name: string;
  /** Response content (structured data) */
  response: unknown;
  /** Whether the underlying tool execution failed */
  isError?: boolean;
}

// ============================================================================
// S04 Result Extractor Types
// ============================================================================

/**
 * Normalized tool result extracted from pi's ToolResultMessage.
 * Ready for injection via inject_result().
 */
export interface ExtractedToolResult {
  /** Tool call ID this result corresponds to */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Whether the tool execution failed */
  isError: boolean;
  /** Result payload for injection */
  payload: ToolResultPayload;
}

/**
 * pi ToolResultMessage shape (from pi's Context.messages).
 * Used for re-call detection and result extraction.
 */
export interface PiToolResultMessage {
  /** Always 'toolResult' for tool result messages */
  role: 'toolResult';
  /** Tool call ID this result is for */
  toolCallId: string;
  /** Tool name */
  toolName: string;
  /** Whether the tool execution failed */
  isError?: boolean;
  /** Result content */
  content: Array<
    | {
        /** Content type */
        type: 'text';
        /** Text content */
        text?: string;
      }
    | {
        /** Content type */
        type: 'image';
        /** Base64 image data */
        data?: string;
        /** Image MIME type */
        mimeType?: string;
      }
  >;
}

// ============================================================================
// S04 Event Bridge Types
// ============================================================================

/**
 * pi AssistantMessageEvent shape for stream emission.
 * Compatible with pi's AssistantMessageEventStream contract.
 */
export interface PiAssistantMessageEvent {
  /** Event type discriminator */
  type: 'text' | 'thinking' | 'toolCall';
  /** Event content (varies by type) */
  content: string | PiToolCallContent;
}

/**
 * pi tool call content for AssistantMessageEvent.
 */
export interface PiToolCallContent {
  /** Tool call ID */
  id: string;
  /** Tool name (user-facing) */
  name: string;
  /** Tool arguments */
  arguments: Record<string, any>;
}

/**
 * Partial assistant message accumulator.
 * Builds up the complete assistant message from A2A stream events.
 */
export interface PartialAssistantMessage {
  /** Accumulated text content */
  text: string;
  /** Accumulated thinking content */
  thinking: string;
  /** Tool calls emitted so far */
  toolCalls: PiToolCallContent[];
}
