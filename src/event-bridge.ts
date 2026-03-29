/**
 * Event Bridge Module
 * 
 * Accumulates partial pi AssistantMessage objects from A2A stream events,
 * translates A2A text/thought/tool-call updates into pi AssistantMessageEventStream events,
 * and ensures both native and MCP activity render through the same pi event format.
 * 
 * Pure helpers - no side effects, fixture-driven for testability.
 */

import type {
  ParsedA2AEvent,
  PiAssistantMessageEvent,
  PiToolCallContent,
  PartialAssistantMessage,
  ToolCallMetadata,
} from './types.js';
import { stripMcpPrefix, isNativeTool } from './approval-flow.js';

// ============================================================================
// Partial Message Accumulation
// ============================================================================

/**
 * Creates a new empty partial assistant message accumulator.
 * 
 * @returns Fresh PartialAssistantMessage with empty text/thinking and no tool calls
 */
export function createPartialMessage(): PartialAssistantMessage {
  return {
    text: '',
    thinking: '',
    nativeToolText: '',
    nativeToolBlocks: {},
    toolCalls: [],
  };
}

/**
 * Updates a partial assistant message with an A2A stream event.
 * 
 * Handles:
 * - text-content events: append to text
 * - thought events: append to thinking
 * - tool-call-update events: add/update tool call in toolCalls array
 * - state-change events: no direct content impact (ignored for accumulation)
 * 
 * @param partial - Current partial message to update
 * @param event - A2A stream event
 * @returns Updated PartialAssistantMessage (new object, immutable)
 */
export function updatePartialMessage(
  partial: PartialAssistantMessage,
  event: ParsedA2AEvent
): PartialAssistantMessage {
  switch (event.kind) {
    case 'text-content':
      return {
        ...partial,
        text: partial.text + (event.text ?? ''),
      };
      
    case 'thought':
      return {
        ...partial,
        thinking: partial.thinking + (event.text ?? ''),
      };
      
    case 'tool-call-update': {
      if (!event.toolCall) {
        return partial;
      }
      
      const { callId, name, args, status, responseOutput } = event.toolCall;

      if (isNativeTool(name)) {
        // Native tools: add to toolCalls with native_ prefix and formatted args
        // so GSD renders them as grey tool blocks during streaming.
        // They are filtered from the FINAL message to prevent execution.
        const formattedArgs: Record<string, any> = {};
        if (args && typeof args === 'object') {
          for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
            formattedArgs[k] = v;
          }
        }

        const piToolCall: PiToolCallContent = {
          id: callId,
          name: 'native_' + name,
          arguments: formattedArgs,
        };

        const newToolCalls = [...partial.toolCalls];
        const existingIndex = newToolCalls.findIndex(c => c.id === callId);
        if (existingIndex >= 0) {
          newToolCalls[existingIndex] = piToolCall;
        } else {
          newToolCalls.push(piToolCall);
        }

        // Store response output (search results/sources) when tool completes
        let nativeToolText = partial.nativeToolText;
        if (status === 'success' && responseOutput) {
          nativeToolText = (nativeToolText ? nativeToolText + '\n' : '') + responseOutput;
        }

        return {
          ...partial,
          toolCalls: newToolCalls,
          nativeToolText,
        };
      }

      // MCP tools: convert with prefix stripping
      const piToolCall = convertToolCallToPi(event.toolCall);

      const existingIndex = partial.toolCalls.findIndex(
        call => call.id === piToolCall.id
      );

      const newToolCalls = [...partial.toolCalls];

      if (existingIndex >= 0) {
        newToolCalls[existingIndex] = piToolCall;
      } else {
        newToolCalls.push(piToolCall);
      }
      
      return {
        ...partial,
        toolCalls: newToolCalls,
      };
    }
      
    case 'tool-call-confirmation':
    case 'state-change':
      // No direct content impact for these event types
      return partial;
      
    default:
      // Unknown event type - ignore
      return partial;
  }
}

/**
 * Accumulates multiple A2A events into a partial assistant message.
 * 
 * Processes events in order, updating the accumulator with each event.
 * 
 * @param events - Array of A2A stream events
 * @returns Accumulated PartialAssistantMessage
 */
export function accumulateEvents(events: ParsedA2AEvent[]): PartialAssistantMessage {
  let partial = createPartialMessage();
  
  for (const event of events) {
    partial = updatePartialMessage(partial, event);
  }
  
  return partial;
}

// ============================================================================
// Tool Call Conversion
// ============================================================================

/**
 * Converts an A2A ToolCallMetadata to pi's PiToolCallContent format.
 * 
 * Strips mcp_tools_ prefix for user-facing display name.
 * 
 * @param toolCall - A2A tool call metadata
 * @returns pi-compatible tool call content
 */
export function convertToolCallToPi(toolCall: ToolCallMetadata): PiToolCallContent {
  return {
    id: toolCall.callId,
    name: stripMcpPrefix(toolCall.name),
    arguments: (toolCall.args ?? {}) as Record<string, any>,
  };
}

/**
 * Converts an array of A2A tool calls to pi format.
 * 
 * @param toolCalls - Array of A2A tool call metadata
 * @returns Array of pi-compatible tool call content
 */
export function convertToolCallsToPi(toolCalls: ToolCallMetadata[]): PiToolCallContent[] {
  return toolCalls.map(convertToolCallToPi);
}

// ============================================================================
// Event Translation
// ============================================================================

/**
 * Translates an A2A text-content event to a pi AssistantMessageEvent.
 * 
 * @param event - A2A text-content event
 * @returns pi AssistantMessageEvent with type 'text'
 */
export function translateTextEvent(event: ParsedA2AEvent): PiAssistantMessageEvent {
  if (event.kind !== 'text-content') {
    throw new Error(
      `Expected text-content event, got ${event.kind}`
    );
  }
  
  return {
    type: 'text',
    content: event.text ?? '',
  };
}

/**
 * Translates an A2A thought event to a pi AssistantMessageEvent.
 * 
 * @param event - A2A thought event
 * @returns pi AssistantMessageEvent with type 'thinking'
 */
export function translateThoughtEvent(event: ParsedA2AEvent): PiAssistantMessageEvent {
  if (event.kind !== 'thought') {
    throw new Error(
      `Expected thought event, got ${event.kind}`
    );
  }
  
  return {
    type: 'thinking',
    content: event.text ?? '',
  };
}

/**
 * Translates an A2A tool-call-update event to a pi AssistantMessageEvent.
 * 
 * @param event - A2A tool-call-update event
 * @returns pi AssistantMessageEvent with type 'toolCall'
 */
export function translateToolCallEvent(event: ParsedA2AEvent): PiAssistantMessageEvent {
  if (event.kind !== 'tool-call-update') {
    throw new Error(
      `Expected tool-call-update event, got ${event.kind}`
    );
  }
  
  if (!event.toolCall) {
    throw new Error('tool-call-update event missing toolCall metadata');
  }
  
  return {
    type: 'toolCall',
    content: convertToolCallToPi(event.toolCall),
  };
}

/**
 * Translates any A2A event to pi AssistantMessageEvent(s).
 * 
 * Returns an array because some A2A events might map to multiple pi events
 * (currently not the case, but future-proof).
 * 
 * @param event - A2A stream event
 * @returns Array of pi AssistantMessageEvent objects (0-1 events)
 */
export function translateEvent(event: ParsedA2AEvent): PiAssistantMessageEvent[] {
  try {
    switch (event.kind) {
      case 'text-content':
        return [translateTextEvent(event)];
        
      case 'thought':
        return [translateThoughtEvent(event)];
        
      case 'tool-call-update':
        return [translateToolCallEvent(event)];
        
      case 'tool-call-confirmation':
      case 'state-change':
        // No pi event equivalent - these are state markers
        return [];
        
      default:
        // Unknown event type - skip
        return [];
    }
  } catch {
    // Translation failed - return empty array (skip malformed event)
    return [];
  }
}

/**
 * Translates multiple A2A events to pi AssistantMessageEvents.
 * 
 * @param events - Array of A2A stream events
 * @returns Array of pi AssistantMessageEvent objects
 */
export function translateEvents(events: ParsedA2AEvent[]): PiAssistantMessageEvent[] {
  const piEvents: PiAssistantMessageEvent[] = [];
  
  for (const event of events) {
    const translated = translateEvent(event);
    piEvents.push(...translated);
  }
  
  return piEvents;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extracts the complete assistant message from a partial accumulator.
 * 
 * Returns a structured object with all accumulated content.
 * 
 * @param partial - Partial assistant message
 * @returns Object with text, thinking, and toolCalls
 */
export function extractCompleteMessage(partial: PartialAssistantMessage): {
  text: string;
  thinking: string;
  toolCalls: PiToolCallContent[];
} {
  return {
    text: partial.text,
    thinking: partial.thinking,
    toolCalls: partial.toolCalls,
  };
}

/**
 * Checks if a partial message has any content.
 * 
 * @param partial - Partial assistant message
 * @returns True if message has text, thinking, or tool calls
 */
export function hasContent(partial: PartialAssistantMessage): boolean {
  return partial.text.length > 0 || 
         partial.thinking.length > 0 || 
         partial.toolCalls.length > 0;
}

/**
 * Checks if a partial message has any tool calls.
 * 
 * @param partial - Partial assistant message
 * @returns True if message has tool calls
 */
export function hasToolCalls(partial: PartialAssistantMessage): boolean {
  return partial.toolCalls.length > 0;
}

// ============================================================================
// Event Validation
// ============================================================================

/**
 * Validates that an A2A event is well-formed for translation.
 * 
 * Checks:
 * - Event has known kind
 * - Text events have text content
 * - Tool call events have toolCall metadata
 * 
 * @param event - A2A event to validate
 * @returns Object with isValid flag and error message if invalid
 */
export function validateA2AEvent(event: ParsedA2AEvent): {
  isValid: boolean;
  error?: string;
} {
  const knownKinds: ParsedA2AEvent['kind'][] = [
    'text-content',
    'thought',
    'tool-call-update',
    'tool-call-confirmation',
    'state-change',
  ];
  
  if (!knownKinds.includes(event.kind)) {
    return {
      isValid: false,
      error: `Unknown event kind: ${event.kind}`,
    };
  }
  
  // Validate text-content events
  if (event.kind === 'text-content' && !event.text) {
    return {
      isValid: false,
      error: 'text-content event missing text content',
    };
  }
  
  // Validate thought events
  if (event.kind === 'thought' && !event.text) {
    return {
      isValid: false,
      error: 'thought event missing text content',
    };
  }
  
  // Validate tool-call-update events
  if (event.kind === 'tool-call-update' && !event.toolCall) {
    return {
      isValid: false,
      error: 'tool-call-update event missing toolCall metadata',
    };
  }
  
  return { isValid: true };
}

/**
 * Validates a partial assistant message for completeness.
 * 
 * Checks:
 * - Has at least some content (text, thinking, or tool calls)
 * - Tool calls have required fields (callId, name, args)
 * 
 * @param partial - Partial assistant message
 * @returns Object with isValid flag and error messages if invalid
 */
export function validatePartialMessage(partial: PartialAssistantMessage): {
  isValid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  
  // Check for any content
  if (!hasContent(partial)) {
    errors.push('Message has no content (empty text, thinking, and toolCalls)');
  }
  
  // Validate tool calls
  for (let i = 0; i < partial.toolCalls.length; i++) {
    const call = partial.toolCalls[i];
    
    if (!call.id) {
      errors.push(`Tool call at index ${i} missing callId`);
    }
    
    if (!call.name) {
      errors.push(`Tool call at index ${i} missing name`);
    }
    
    if (call.arguments === undefined) {
      errors.push(`Tool call at index ${i} missing args`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
  };
}
