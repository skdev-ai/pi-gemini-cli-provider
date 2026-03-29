/**
 * Event Bridge Tests
 * 
 * Tests for src/event-bridge.ts covering:
 * - Partial message accumulation from A2A events
 * - A2A-to-pi event translation
 * - Tool call conversion with prefix stripping
 * - Unified rendering for MCP and native tools
 * - Malformed/unsupported event edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  createPartialMessage,
  updatePartialMessage,
  accumulateEvents,
  convertToolCallToPi,
  convertToolCallsToPi,
  translateTextEvent,
  translateThoughtEvent,
  translateToolCallEvent,
  translateEvent,
  translateEvents,
  extractCompleteMessage,
  hasContent,
  hasToolCalls,
  validateA2AEvent,
  validatePartialMessage,
} from './event-bridge.js';
import type { ParsedA2AEvent, ToolCallMetadata } from './types.js';

function createTextEvent(text: string): ParsedA2AEvent {
  return {
    kind: 'text-content',
    result: {
      metadata: { coderAgent: { kind: 'text-content' } },
      status: { state: 'working', message: { parts: [] } },
    },
    text,
  };
}

function createThoughtEvent(text: string): ParsedA2AEvent {
  return {
    kind: 'thought',
    result: {
      metadata: { coderAgent: { kind: 'thought' } },
      status: { state: 'working', message: { parts: [] } },
    },
    text,
  };
}

function createToolCallEvent(toolCall: ToolCallMetadata): ParsedA2AEvent {
  return {
    kind: 'tool-call-update',
    result: {
      metadata: { coderAgent: { kind: 'tool-call-update' } },
      status: {
        state: 'working',
        message: {
          parts: [
            {
              kind: 'data',
              data: {
                request: {
                  callId: toolCall.callId,
                  name: toolCall.name,
                  args: toolCall.args,
                },
                status: toolCall.status,
              },
            },
          ],
        },
      },
    },
    toolCall,
  };
}

function createStateChangeEvent(state: 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' | 'rejected'): ParsedA2AEvent {
  return {
    kind: 'state-change',
    result: {
      metadata: { coderAgent: { kind: 'state-change' } },
      status: { state, message: { parts: [] } },
    },
  };
}

function createToolCallConfirmationEvent(): ParsedA2AEvent {
  return {
    kind: 'tool-call-confirmation',
    result: {
      metadata: { coderAgent: { kind: 'tool-call-confirmation' } },
      status: { state: 'input-required', message: { parts: [] } },
    },
  };
}

describe('createPartialMessage', () => {
  it('should create empty partial message', () => {
    const partial = createPartialMessage();

    expect(partial.text).toBe('');
    expect(partial.thinking).toBe('');
    expect(partial.nativeToolText).toBe('');
    expect(partial.nativeToolBlocks).toEqual({});
    expect(partial.toolCalls).toEqual([]);
  });
});

describe('updatePartialMessage', () => {
  it('should accumulate text from text-content events', () => {
    let partial = createPartialMessage();

    partial = updatePartialMessage(partial, createTextEvent('Hello '));
    expect(partial.text).toBe('Hello ');

    partial = updatePartialMessage(partial, createTextEvent('World'));
    expect(partial.text).toBe('Hello World');
  });

  it('should accumulate thinking from thought events', () => {
    let partial = createPartialMessage();

    partial = updatePartialMessage(partial, createThoughtEvent('Step 1: '));
    expect(partial.thinking).toBe('Step 1: ');

    partial = updatePartialMessage(partial, createThoughtEvent('Step 2: analyze'));
    expect(partial.thinking).toBe('Step 1: Step 2: analyze');
  });

  it('should add tool calls from tool-call-update events', () => {
    let partial = createPartialMessage();

    const toolCall1: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };

    partial = updatePartialMessage(partial, createToolCallEvent(toolCall1));
    expect(partial.toolCalls).toHaveLength(1);
    expect(partial.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'read',
      arguments: { path: 'test.md' },
    });
  });

  it('should update existing tool calls with same callId', () => {
    let partial = createPartialMessage();

    const toolCall1: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'validating',
    };

    partial = updatePartialMessage(partial, createToolCallEvent(toolCall1));

    const toolCall2: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };

    partial = updatePartialMessage(partial, createToolCallEvent(toolCall2));

    expect(partial.toolCalls).toHaveLength(1);
  });

  it('should handle multiple different tool calls', () => {
    let partial = createPartialMessage();

    const toolCall1: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };

    const toolCall2: ToolCallMetadata = {
      callId: 'call_2',
      name: 'mcp_tools_write',
      args: { path: 'test.md', content: 'test' },
      status: 'success',
    };

    partial = updatePartialMessage(partial, createToolCallEvent(toolCall1));
    partial = updatePartialMessage(partial, createToolCallEvent(toolCall2));

    expect(partial.toolCalls).toHaveLength(2);
    expect(partial.toolCalls.map((c) => c.id)).toEqual(['call_1', 'call_2']);
  });

  it('should ignore state-change events', () => {
    let partial = createPartialMessage();
    partial = updatePartialMessage(partial, createTextEvent('Text'));

    const beforeState = { ...partial };
    partial = updatePartialMessage(partial, createStateChangeEvent('working'));

    expect(partial).toEqual(beforeState);
  });

  it('should ignore tool-call-confirmation events', () => {
    let partial = createPartialMessage();
    partial = updatePartialMessage(partial, createTextEvent('Text'));

    const beforeConfirm = { ...partial };
    partial = updatePartialMessage(partial, createToolCallConfirmationEvent());

    expect(partial).toEqual(beforeConfirm);
  });

  it('should handle event with missing text gracefully', () => {
    let partial = createPartialMessage();

    const eventWithoutText: ParsedA2AEvent = {
      kind: 'text-content',
      result: {
        metadata: { coderAgent: { kind: 'text-content' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };

    partial = updatePartialMessage(partial, eventWithoutText);
    expect(partial.text).toBe('');
  });

  it('should handle tool-call-update event without toolCall metadata', () => {
    let partial = createPartialMessage();

    const eventWithoutToolCall: ParsedA2AEvent = {
      kind: 'tool-call-update',
      result: {
        metadata: { coderAgent: { kind: 'tool-call-update' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };

    partial = updatePartialMessage(partial, eventWithoutToolCall);
    expect(partial.toolCalls).toHaveLength(0);
  });
});

describe('accumulateEvents', () => {
  it('should accumulate multiple events in order', () => {
    const events: ParsedA2AEvent[] = [
      createThoughtEvent('Thinking...'),
      createTextEvent('Answer: '),
      createTextEvent('42'),
    ];

    const partial = accumulateEvents(events);

    expect(partial.thinking).toBe('Thinking...');
    expect(partial.text).toBe('Answer: 42');
    expect(partial.toolCalls).toHaveLength(0);
  });

  it('should accumulate mixed event types', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: {},
      status: 'success',
    };

    const events: ParsedA2AEvent[] = [
      createThoughtEvent('Let me search...'),
      createToolCallEvent(toolCall),
      createTextEvent('Found the information.'),
    ];

    const partial = accumulateEvents(events);

    expect(partial.thinking).toBe('Let me search...');
    expect(partial.text).toBe('Found the information.');
    expect(partial.toolCalls).toHaveLength(1);
    expect(partial.toolCalls[0].name).toBe('read');
  });

  it('should handle empty event array', () => {
    const partial = accumulateEvents([]);
    expect(partial.text).toBe('');
    expect(partial.thinking).toBe('');
    expect(partial.toolCalls).toHaveLength(0);
  });
});

describe('convertToolCallToPi', () => {
  it('should convert MCP tool call with prefix stripping', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };

    const piCall = convertToolCallToPi(toolCall);

    expect(piCall).toEqual({
      id: 'call_1',
      name: 'read',
      arguments: { path: 'test.md' },
    });
  });

  it('should convert native tool call without modification', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'google_web_search',
      args: { query: 'test' },
      status: 'success',
    };

    const piCall = convertToolCallToPi(toolCall);

    expect(piCall).toEqual({
      id: 'call_1',
      name: 'google_web_search',
      arguments: { query: 'test' },
    });
  });

  it('should handle nested provider MCP prefix (mcp_tools_gsd-test_test_echo)', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_gsd-test_test_echo',
      args: { message: 'test' },
      status: 'success',
    };

    const piCall = convertToolCallToPi(toolCall);

    expect(piCall.name).toBe('gsd-test_test_echo');
  });
});

describe('convertToolCallsToPi', () => {
  it('should convert array of tool calls', () => {
    const toolCalls: ToolCallMetadata[] = [
      {
        callId: 'call_1',
        name: 'mcp_tools_read',
        args: {},
        status: 'success',
      },
      {
        callId: 'call_2',
        name: 'google_web_search',
        args: {},
        status: 'success',
      },
    ];

    const piCalls = convertToolCallsToPi(toolCalls);

    expect(piCalls).toHaveLength(2);
    expect(piCalls[0].name).toBe('read');
    expect(piCalls[1].name).toBe('google_web_search');
  });

  it('should handle empty array', () => {
    const piCalls = convertToolCallsToPi([]);
    expect(piCalls).toHaveLength(0);
  });
});

describe('translateTextEvent', () => {
  it('should translate text-content event to pi event', () => {
    const a2aEvent = createTextEvent('Hello World');
    const piEvent = translateTextEvent(a2aEvent);

    expect(piEvent.type).toBe('text');
    expect(piEvent.content).toBe('Hello World');
  });

  it('should throw for non-text event', () => {
    const thoughtEvent = createThoughtEvent('Thinking');
    expect(() => translateTextEvent(thoughtEvent)).toThrow();
  });
});

describe('translateThoughtEvent', () => {
  it('should translate thought event to pi event', () => {
    const a2aEvent = createThoughtEvent('Let me think...');
    const piEvent = translateThoughtEvent(a2aEvent);

    expect(piEvent.type).toBe('thinking');
    expect(piEvent.content).toBe('Let me think...');
  });

  it('should throw for non-thought event', () => {
    const textEvent = createTextEvent('Text');
    expect(() => translateThoughtEvent(textEvent)).toThrow();
  });
});

describe('translateToolCallEvent', () => {
  it('should translate tool-call-update event to pi event', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };
    const a2aEvent = createToolCallEvent(toolCall);
    const piEvent = translateToolCallEvent(a2aEvent);

    expect(piEvent.type).toBe('toolCall');
    expect(piEvent.content).toEqual({
      id: 'call_1',
      name: 'read',
      arguments: { path: 'test.md' },
    });
  });

  it('should throw for non-tool-call event', () => {
    const textEvent = createTextEvent('Text');
    expect(() => translateToolCallEvent(textEvent)).toThrow();
  });

  it('should throw for tool-call-update without toolCall metadata', () => {
    const eventWithoutToolCall: ParsedA2AEvent = {
      kind: 'tool-call-update',
      result: {
        metadata: { coderAgent: { kind: 'tool-call-update' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    expect(() => translateToolCallEvent(eventWithoutToolCall)).toThrow();
  });
});

describe('translateEvent', () => {
  it('should translate text-content event', () => {
    const a2aEvent = createTextEvent('Hello');
    const piEvents = translateEvent(a2aEvent);

    expect(piEvents).toHaveLength(1);
    expect(piEvents[0].type).toBe('text');
  });

  it('should translate thought event', () => {
    const a2aEvent = createThoughtEvent('Thinking');
    const piEvents = translateEvent(a2aEvent);

    expect(piEvents).toHaveLength(1);
    expect(piEvents[0].type).toBe('thinking');
  });

  it('should translate tool-call-update event', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: {},
      status: 'success',
    };
    const a2aEvent = createToolCallEvent(toolCall);
    const piEvents = translateEvent(a2aEvent);

    expect(piEvents).toHaveLength(1);
    expect(piEvents[0].type).toBe('toolCall');
  });

  it('should return empty array for state-change event', () => {
    const a2aEvent = createStateChangeEvent('working');
    const piEvents = translateEvent(a2aEvent);

    expect(piEvents).toHaveLength(0);
  });

  it('should return empty array for tool-call-confirmation event', () => {
    const a2aEvent = createToolCallConfirmationEvent();
    const piEvents = translateEvent(a2aEvent);

    expect(piEvents).toHaveLength(0);
  });

  it('should return empty array for unknown event kind', () => {
    const unknownEvent: ParsedA2AEvent = {
      kind: 'unknown-kind' as any,
      result: {
        metadata: { coderAgent: { kind: 'unknown-kind' as any } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const piEvents = translateEvent(unknownEvent);

    expect(piEvents).toHaveLength(0);
  });

  it('should handle malformed event gracefully', () => {
    const malformedEvent: ParsedA2AEvent = {
      kind: 'tool-call-update',
      result: {
        metadata: { coderAgent: { kind: 'tool-call-update' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const piEvents = translateEvent(malformedEvent);

    expect(piEvents).toHaveLength(0);
  });
});

describe('translateEvents', () => {
  it('should translate multiple events', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'mcp_tools_read',
      args: {},
      status: 'success',
    };

    const events: ParsedA2AEvent[] = [
      createThoughtEvent('Thinking'),
      createTextEvent('Answer'),
      createToolCallEvent(toolCall),
    ];

    const piEvents = translateEvents(events);

    expect(piEvents).toHaveLength(3);
    expect(piEvents.map((e) => e.type)).toEqual(['thinking', 'text', 'toolCall']);
  });

  it('should skip non-translatable events', () => {
    const events: ParsedA2AEvent[] = [
      createThoughtEvent('Thinking'),
      createStateChangeEvent('working'),
      createTextEvent('Answer'),
    ];

    const piEvents = translateEvents(events);

    expect(piEvents).toHaveLength(2);
  });

  it('should handle empty array', () => {
    const piEvents = translateEvents([]);
    expect(piEvents).toHaveLength(0);
  });
});

describe('extractCompleteMessage', () => {
  it('should extract complete message from partial', () => {
    const partial = {
      text: 'Hello World',
      thinking: 'Let me think...',
      nativeToolText: '',
      toolCalls: [{ id: 'call_1', name: 'read', arguments: {} }],
    };

    const complete = extractCompleteMessage(partial);

    expect(complete.text).toBe('Hello World');
    expect(complete.thinking).toBe('Let me think...');
    expect(complete.toolCalls).toEqual([{ id: 'call_1', name: 'read', arguments: {} }]);
  });
});

describe('hasContent', () => {
  it('should return true for message with text', () => {
    const partial = { text: 'Hello', thinking: '', nativeToolText: '', toolCalls: [] };
    expect(hasContent(partial)).toBe(true);
  });

  it('should return true for message with thinking', () => {
    const partial = { text: '', thinking: 'Thinking...', nativeToolText: '', toolCalls: [] };
    expect(hasContent(partial)).toBe(true);
  });

  it('should return true for message with tool calls', () => {
    const partial = { text: '', thinking: '', nativeToolText: '', toolCalls: [{ id: '1', name: 'read', arguments: {} }] };
    expect(hasContent(partial)).toBe(true);
  });

  it('should return false for empty message', () => {
    const partial = { text: '', thinking: '', nativeToolText: '', toolCalls: [] };
    expect(hasContent(partial)).toBe(false);
  });
});

describe('hasToolCalls', () => {
  it('should return true when tool calls present', () => {
    const partial = { text: '', thinking: '', nativeToolText: '', toolCalls: [{ id: '1', name: 'read', arguments: {} }] };
    expect(hasToolCalls(partial)).toBe(true);
  });

  it('should return false when no tool calls', () => {
    const partial = { text: 'Hello', thinking: '', nativeToolText: '', toolCalls: [] };
    expect(hasToolCalls(partial)).toBe(false);
  });
});

describe('validateA2AEvent', () => {
  it('should return valid for text-content event with text', () => {
    const event = createTextEvent('Hello');
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(true);
    expect(validation.error).toBeUndefined();
  });

  it('should return invalid for text-content event without text', () => {
    const event: ParsedA2AEvent = {
      kind: 'text-content',
      result: {
        metadata: { coderAgent: { kind: 'text-content' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('text');
  });

  it('should return valid for thought event with text', () => {
    const event = createThoughtEvent('Thinking');
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(true);
  });

  it('should return invalid for thought event without text', () => {
    const event: ParsedA2AEvent = {
      kind: 'thought',
      result: {
        metadata: { coderAgent: { kind: 'thought' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('text');
  });

  it('should return valid for tool-call-update event with toolCall', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'call_1',
      name: 'read',
      args: {},
      status: 'success',
    };
    const event = createToolCallEvent(toolCall);
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(true);
  });

  it('should return invalid for tool-call-update event without toolCall', () => {
    const event: ParsedA2AEvent = {
      kind: 'tool-call-update',
      result: {
        metadata: { coderAgent: { kind: 'tool-call-update' } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('toolCall');
  });

  it('should return invalid for unknown event kind', () => {
    const event: ParsedA2AEvent = {
      kind: 'unknown-kind' as any,
      result: {
        metadata: { coderAgent: { kind: 'unknown-kind' as any } },
        status: { state: 'working', message: { parts: [] } },
      },
    };
    const validation = validateA2AEvent(event);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('Unknown event kind');
  });
});

describe('validatePartialMessage', () => {
  it('should return valid for message with text', () => {
    const partial = { text: 'Hello', thinking: '', nativeToolText: '', toolCalls: [] };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });

  it('should return invalid for empty message', () => {
    const partial = { text: '', thinking: '', nativeToolText: '', toolCalls: [] };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContainEqual(expect.stringContaining('no content'));
  });

  it('should return invalid for tool call missing callId', () => {
    const partial = {
      text: 'Hello',
      thinking: '',
      nativeToolText: '',
      toolCalls: [{ name: 'read', arguments: {} } as any],
    };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContainEqual(expect.stringContaining('missing callId'));
  });

  it('should return invalid for tool call missing name', () => {
    const partial = {
      text: 'Hello',
      thinking: '',
      nativeToolText: '',
      toolCalls: [{ id: '1', arguments: {} } as any],
    };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContainEqual(expect.stringContaining('missing name'));
  });

  it('should return invalid for tool call missing args', () => {
    const partial = {
      text: 'Hello',
      thinking: '',
      nativeToolText: '',
      toolCalls: [{ id: '1', name: 'read' } as any],
    };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(false);
    expect(validation.errors).toContainEqual(expect.stringContaining('missing args'));
  });

  it('should return valid for message with valid tool calls', () => {
    const partial = {
      text: '',
      thinking: '',
      nativeToolText: '',
      toolCalls: [{ id: '1', name: 'read', arguments: { path: 'test.md' } }],
    };
    const validation = validatePartialMessage(partial);

    expect(validation.isValid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});

describe('unified rendering', () => {
  it('should render MCP and native tool calls through same format', () => {
    const mcpToolCall: ToolCallMetadata = {
      callId: 'mcp_1',
      name: 'mcp_tools_read',
      args: { path: 'test.md' },
      status: 'success',
    };

    const nativeToolCall: ToolCallMetadata = {
      callId: 'native_1',
      name: 'google_web_search',
      args: { query: 'test' },
      status: 'success',
    };

    const mcpPiCall = convertToolCallToPi(mcpToolCall);
    const nativePiCall = convertToolCallToPi(nativeToolCall);

    expect(mcpPiCall).toHaveProperty('id');
    expect(mcpPiCall).toHaveProperty('name');
    expect(mcpPiCall).toHaveProperty('arguments');

    expect(nativePiCall).toHaveProperty('id');
    expect(nativePiCall).toHaveProperty('name');
    expect(nativePiCall).toHaveProperty('arguments');

    expect(mcpPiCall.name).toBe('read');
    expect(nativePiCall.name).toBe('google_web_search');
  });

  it('should accumulate mixed MCP and native tool calls', () => {
    const mcpToolCall: ToolCallMetadata = {
      callId: 'mcp_1',
      name: 'mcp_tools_read',
      args: {},
      status: 'success',
    };

    const nativeToolCall: ToolCallMetadata = {
      callId: 'native_1',
      name: 'web_fetch',
      args: { prompt: 'test' },
      status: 'success',
      responseOutput: 'Result text',
    };

    const events: ParsedA2AEvent[] = [
      createToolCallEvent(mcpToolCall),
      createToolCallEvent(nativeToolCall),
    ];

    const partial = accumulateEvents(events);

    expect(partial.toolCalls).toHaveLength(1);
    expect(partial.toolCalls[0].name).toBe('read');
    expect(partial.nativeToolText).toContain('native_web_fetch');
    expect(partial.nativeToolText).toContain('prompt: test');
    expect(partial.nativeToolText).toContain('Result text');
  });
});
