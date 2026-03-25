/**
 * Result Extractor Module
 * 
 * Detects re-calls from pi's ToolResultMessage objects in context.messages,
 * extracts tool results in order, and normalizes payloads for inject_result().
 * 
 * Critical: Uses pi's actual ToolResultMessage shape (role: 'toolResult'),
 * not the older 'role: tool' assumption from research notes.
 */

import type { ExtractedToolResult, PiToolResultMessage } from './types.js';

// ============================================================================
// Re-call Detection
// ============================================================================

/**
 * Detects if this is a re-call turn by checking the last message only.
 * 
 * A re-call occurs when pi sends back tool results after a toolUse stop reason.
 * GSD accumulates prior-turn history, so scanning the full message list can match
 * stale tool results from earlier turns and misclassify a fresh user prompt as a
 * re-call. We only treat the turn as a re-call when the latest message is a
 * ToolResultMessage.
 * 
 * @param messages - pi Context.messages array
 * @returns True if the last message is a ToolResultMessage
 */
export function detectReCall(messages: unknown[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;

  const lastMessage = messages[messages.length - 1];
  if (typeof lastMessage !== 'object' || lastMessage === null) return false;
  if (!('role' in lastMessage)) return false;

  return (lastMessage as PiToolResultMessage).role === 'toolResult';
}

/**
 * Extracts ToolResultMessage objects from the current tool-use turn only.
 *
 * Searches backward for the most recent assistant message with
 * `stopReason === 'toolUse'` and only returns `toolResult` messages that
 * appear after that boundary. This avoids scanning stale historical tool
 * results from prior completed turns.
 *
 * @param messages - pi Context.messages array
 * @returns Array of ToolResultMessage objects in order for the current turn
 */
export function extractToolResultMessages(messages: unknown[]): PiToolResultMessage[] {
  if (!Array.isArray(messages)) return [];

  const startIndex = findCurrentTurnToolResultStart(messages);
  const currentTurnMessages = messages.slice(startIndex);
  
  return currentTurnMessages.filter((msg): msg is PiToolResultMessage => {
    if (typeof msg !== 'object' || msg === null) return false;
    if (!('role' in msg)) return false;
    return (msg as PiToolResultMessage).role === 'toolResult';
  });
}

// ============================================================================
// Result Normalization
// ============================================================================

/**
 * Normalizes a pi ToolResultMessage into an ExtractedToolResult.
 * 
 * Converts pi's content format (array of text/image parts) into the
 * payload shape expected by inject_result().
 * 
 * For text results: extracts the first text part or concatenates all.
 * For image results: preserves the image data as base64.
 * For mixed results: creates a structured response with both text and images.
 * 
 * @param message - ToolResultMessage to normalize
 * @returns ExtractedToolResult ready for injection
 */
export function normalizeToolResult(message: PiToolResultMessage): ExtractedToolResult {
  const { toolCallId, toolName, isError = false, content } = message;
  
  // Normalize content into response payload
  const response = normalizeContent(content);
  
  return {
    toolCallId,
    toolName,
    isError,
    payload: {
      name: toolName,
      response,
      ...(isError ? { isError: true } : {}),
    },
  };
}

/**
 * Normalizes pi's content array into a response payload.
 * 
 * @param content - pi ToolResultMessage.content array
 * @param isError - Whether the tool execution failed
 * @returns Normalized response object
 */
function normalizeContent(
  content: PiToolResultMessage['content'],
): unknown {
  if (!content || content.length === 0) {
    return { output: '' };
  }
  
  // Single text part - return simple string
  if (content.length === 1 && content[0]?.type === 'text') {
    return { output: content[0].text ?? '' };
  }
  
  // Single image part - return image data
  if (content.length === 1 && content[0]?.type === 'image') {
    return {
      image: {
        data: content[0].data ?? null,
        mimeType: content[0].mimeType ?? null,
      },
    };
  }
  
  // Multiple parts or mixed - return structured object
  const textParts: string[] = [];
  const imageParts: Array<{ data: string; mimeType?: string }> = [];
  
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      textParts.push(part.text);
    } else if (part.type === 'image' && part.data) {
      imageParts.push({ data: part.data, mimeType: part.mimeType });
    }
  }
  
  // Return structured response
  const response: Record<string, unknown> = {};
  
  if (textParts.length > 0) {
    response.output = textParts.join('\n');
  }
  
  if (imageParts.length > 0) {
    response.images = imageParts;
  }
  
  return response;
}

function findCurrentTurnToolResultStart(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (typeof message !== 'object' || message === null) continue;

    const role = 'role' in message ? (message as { role?: unknown }).role : undefined;
    if (role !== 'assistant') continue;

    const stopReason = 'stopReason' in message ? (message as { stopReason?: unknown }).stopReason : undefined;
    if (stopReason === 'toolUse') {
      return i + 1;
    }
  }

  return 0;
}

/**
 * Extracts and normalizes all tool results from context.messages.
 * 
 * Combines re-call detection, extraction, and normalization into one operation.
 * Returns results in the order they appear in the message history.
 * 
 * @param messages - pi Context.messages array
 * @returns Array of ExtractedToolResult objects in order
 */
export function extractAllToolResults(messages: unknown[]): ExtractedToolResult[] {
  const toolResultMessages = extractToolResultMessages(messages);
  return toolResultMessages.map(normalizeToolResult);
}

// ============================================================================
// ToolCallId Linkage
// ============================================================================

/**
 * Groups extracted results by toolCallId for multi-tool turn handling.
 * 
 * Returns a map where keys are toolCallIds and values are the corresponding results.
 * This allows T02 to call inject_result() once per completed tool call.
 * 
 * @param results - Array of ExtractedToolResult objects
 * @returns Map of toolCallId → ExtractedToolResult
 */
export function groupResultsByCallId(
  results: ExtractedToolResult[]
): Map<string, ExtractedToolResult> {
  const result = new Map<string, ExtractedToolResult>();
  
  for (const res of results) {
    result.set(res.toolCallId, res);
  }
  
  return result;
}

/**
 * Checks if a result exists for a specific toolCallId.
 * 
 * @param results - Array of ExtractedToolResult objects
 * @param callId - Tool call ID to check
 * @returns True if result exists for this callId
 */
export function hasResultForCallId(results: ExtractedToolResult[], callId: string): boolean {
  return results.some(res => res.toolCallId === callId);
}

/**
 * Gets the result for a specific toolCallId.
 * 
 * @param results - Array of ExtractedToolResult objects
 * @param callId - Tool call ID to find
 * @returns ExtractedToolResult or undefined if not found
 */
export function getResultForCallId(
  results: ExtractedToolResult[],
  callId: string
): ExtractedToolResult | undefined {
  return results.find(res => res.toolCallId === callId);
}
