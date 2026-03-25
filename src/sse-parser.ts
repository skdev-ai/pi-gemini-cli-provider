/**
 * A2A SSE Parser Module
 * 
 * Parses Server-Sent Events from A2A message/stream responses using eventsource-parser.
 * Emits typed ParsedA2AEvent objects with extracted text, tool calls, and state transitions.
 * 
 * Reuses the proven pattern from gemini-cli-search/src/a2a-transport.ts.
 */

import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { A2AResult, ParsedA2AEvent, ToolCallMetadata } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Default timeout for SSE response in milliseconds */
const RESPONSE_TIMEOUT_MS = 45000;

// ============================================================================
// SSE Parser
// ============================================================================

/**
 * Parses an A2A SSE stream and emits typed events.
 * 
 * @param stream - ReadableStream of Uint8Array from fetch response body
 * @param options - Optional configuration with abort signal
 * @returns AsyncIterable of ParsedA2AEvent objects
 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  options?: { signal?: AbortSignal }
): AsyncIterable<ParsedA2AEvent> {
  const { signal } = options ?? {};
  
  // Create event queue for producer-consumer pattern
  const eventQueue: ParsedA2AEvent[] = [];
  const eventListeners: Array<(event: ParsedA2AEvent) => void> = [];
  let done = false;
  let parseError: Error | null = null;

  // Create parser using eventsource-parser
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      if (!event.data) return;
      
      try {
        const parsed = JSON.parse(event.data) as { result?: A2AResult };
        const result = parsed.result;
        if (!result) return;
        
        const parsedEvent = parseA2AResult(result);
        if (parsedEvent) {
          eventQueue.push(parsedEvent);
          // Notify waiting consumers
          eventListeners.forEach(listener => listener(parsedEvent));
        }
      } catch (err) {
        // Parse errors are captured but don't stop the stream
        // Invalid JSON events are skipped silently
        parseError = err instanceof Error ? err : new Error(String(err));
      }
    },
  });

  // Set up timeout for response
  const timeoutId = signal
    ? null
    : setTimeout(() => {
        if (!done) {
          parseError = new Error(`Response timeout after ${RESPONSE_TIMEOUT_MS}ms`);
          done = true;
        }
      }, RESPONSE_TIMEOUT_MS);

  // Read the stream
  const reader = stream.getReader();
  try {
    while (!done && !signal?.aborted) {
      const { value, done: streamDone } = await reader.read();
      
      if (streamDone) {
        done = true;
        break;
      }
      
      if (value) {
        const decoder = new TextDecoder();
        parser.feed(decoder.decode(value));
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      // Aborted is not an error - just stop parsing
      done = true;
    } else {
      parseError = err instanceof Error ? err : new Error(String(err));
      done = true;
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    reader.releaseLock();
  }

  // Yield all queued events
  for (const event of eventQueue) {
    yield event;
  }

  // Throw if there was a parse error
  if (parseError) {
    throw parseError;
  }
}

/**
 * Parses an A2AResult into a typed ParsedA2AEvent.
 * 
 * @param result - A2AResult from JSON-RPC response
 * @returns ParsedA2AEvent or null if event type is unrecognized
 */
export function parseA2AResult(result: A2AResult): ParsedA2AEvent | null {
  const kind = result.metadata?.coderAgent?.kind;
  if (!kind) return null;

  // Only accept known event kinds
  const knownKinds: ParsedA2AEvent['kind'][] = [
    'state-change',
    'thought',
    'tool-call-update',
    'tool-call-confirmation',
    'text-content',
  ];
  if (!knownKinds.includes(kind)) return null;

  const baseEvent: ParsedA2AEvent = {
    kind,
    result,
  };

  // Extract text content for text-content and thought events
  if (kind === 'text-content' || kind === 'thought') {
    baseEvent.text = extractTextContent(result);
  }

  // Extract tool call metadata for tool-call-update events
  if (kind === 'tool-call-update') {
    const toolCall = extractToolCall(result);
    if (toolCall) {
      baseEvent.toolCall = toolCall;
    }
  }

  // Detect awaiting approval state
  if (kind === 'state-change') {
    baseEvent.isAwaitingApproval = isAwaitingApproval(result);
  }

  return baseEvent;
}

// ============================================================================
// Extraction Helpers
// ============================================================================

/**
 * Extracts text content from an A2AResult.
 * 
 * Traverses result.status.message.parts[] and concatenates text parts.
 * 
 * @param result - A2AResult to extract text from
 * @returns Concatenated text content or empty string
 */
export function extractTextContent(result: A2AResult): string {
  const parts = result.status?.message?.parts ?? [];
  const textParts = parts.filter(part => part.kind === 'text' && part.text);
  return textParts.map(part => part.text!).join('');
}

/**
 * Extracts tool call metadata from an A2AResult.
 * 
 * Traverses result.status.message.parts[] and finds data parts with tool call requests.
 * 
 * @param result - A2AResult to extract tool call from
 * @returns ToolCallMetadata or null if no tool call found
 */
export function extractToolCall(result: A2AResult): ToolCallMetadata | null {
  const parts = result.status?.message?.parts ?? [];
  
  for (const part of parts) {
    if (part.kind === 'data' && part.data?.request) {
      const { request, status } = part.data;
      if (!status) continue; // Skip if no status (incomplete event)
      
      return {
        callId: request.callId,
        name: request.name,
        args: request.args,
        status: status as ToolCallMetadata['status'],
      };
    }
  }
  
  return null;
}

/**
 * Detects if a task is awaiting user approval.
 * 
 * A2A spec: awaiting_approval = state === 'input-required' && final === true
 * 
 * @param result - A2AResult to check
 * @returns True if task is awaiting approval
 */
export function isAwaitingApproval(result: A2AResult): boolean {
  return result.status?.state === 'input-required' && result.final === true;
}

/**
 * Checks if a task has reached a terminal state.
 * 
 * Terminal states: completed, failed, canceled, rejected
 * 
 * @param result - A2AResult to check
 * @returns True if task is in terminal state
 */
export function isTerminalState(result: A2AResult): boolean {
  const state = result.status?.state;
  return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected';
}

/**
 * Extracts error message from a failed/canceled/rejected result.
 * 
 * @param result - A2AResult with terminal state
 * @returns Error message or undefined
 */
export function extractErrorMessage(result: A2AResult): string | undefined {
  if (!isTerminalState(result)) return undefined;
  
  // Try to extract from message parts
  const text = extractTextContent(result);
  if (text) return text;
  
  // Fall back to state description
  return `Task ${result.status?.state}`;
}

/**
 * Detects if an SSE result contains an invalid-model error.
 * 
 * Checks metadata.error field for "not found" errors that indicate
 * an invalid model ID was requested. This allows the provider to
 * surface model validation errors explicitly rather than treating
 * them as normal assistant text.
 * 
 * @param result - A2AResult to check
 * @returns True if the error indicates an invalid model
 */
export function isInvalidModelError(result: A2AResult): boolean {
  const metadata = result.metadata;
  if (!metadata || typeof metadata !== 'object') {
    return false;
  }

  const metadataObj = metadata as Record<string, unknown>;
  const error = metadataObj.error;

  if (typeof error !== 'string') {
    return false;
  }

  // Detect "not found" errors that indicate invalid model
  return error.toLowerCase().includes('not found');
}
