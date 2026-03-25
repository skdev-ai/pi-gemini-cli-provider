/**
 * SSE Parser Tests
 * 
 * Tests for src/sse-parser.ts with real-looking SSE payload fixtures.
 * Covers text-content, thought, tool-call-update, tool-call-confirmation,
 * state-change events, and failure/edge transitions.
 */

import { describe, it, expect } from 'vitest';
import {
  parseA2AResult,
  extractTextContent,
  extractToolCall,
  isAwaitingApproval,
  isTerminalState,
  extractErrorMessage,
  isInvalidModelError,
} from './sse-parser.js';
import type { A2AResult } from './types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/** Text content event fixture */
const textContentEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'text-content' },
  },
  status: {
    state: 'working',
    message: {
      parts: [
        { kind: 'text', text: 'Searching for information about...' },
        { kind: 'text', text: ' I found several relevant sources.' },
      ],
    },
  },
};

/** Thought event fixture */
const thoughtEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'thought' },
  },
  status: {
    state: 'working',
    message: {
      parts: [
        {
          kind: 'text',
          text: 'Let me think about this step by step...',
        },
      ],
    },
  },
  final: false,
};

/** Tool call update event (validating state) */
const toolCallValidatingEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'tool-call-update' },
  },
  status: {
    state: 'working',
    message: {
      parts: [
        {
          kind: 'data',
          data: {
            request: {
              callId: 'mcp_gsd-test_test_echo_1774176890004_0',
              name: 'mcp_gsd-test_test_echo',
              args: { message: 'SSE format test' },
            },
            status: 'validating',
          },
        },
      ],
    },
  },
};

/** Tool call update event (success state) */
const toolCallSuccessEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'tool-call-update' },
  },
  status: {
    state: 'working',
    message: {
      parts: [
        {
          kind: 'data',
          data: {
            request: {
              callId: 'mcp_gsd-test_test_echo_1774176890004_0',
              name: 'mcp_gsd-test_test_echo',
              args: { message: 'SSE format test' },
            },
            status: 'success',
          },
        },
      ],
    },
  },
};

/** Tool call confirmation event (awaiting approval) */
const toolCallConfirmationEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'tool-call-confirmation' },
  },
  status: {
    state: 'input-required',
    message: {
      parts: [
        {
          kind: 'data',
          data: {
            request: {
              callId: 'mcp_gsd-test_test_echo_1774176890004_0',
              name: 'mcp_gsd-test_test_echo',
              args: { message: 'SSE format test' },
            },
          },
        },
      ],
    },
  },
  final: true,
};

/** State change event (submitted → working) */
const stateChangeWorkingEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'state-change' },
  },
  status: {
    state: 'working',
    message: {
      parts: [],
    },
  },
};

/** State change event (input-required + final = awaiting approval) */
const stateChangeAwaitingApprovalEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'state-change' },
  },
  status: {
    state: 'input-required',
    message: {
      parts: [
        {
          kind: 'data',
          data: {
            request: {
              callId: 'mcp_tools_read_123',
              name: 'mcp_tools_read',
              args: { path: 'test.md' },
            },
            status: 'scheduled',
          },
        },
      ],
    },
  },
  final: true,
};

/** Completed event */
const completedEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'text-content' },
  },
  status: {
    state: 'completed',
    message: {
      parts: [
        { kind: 'text', text: 'Task completed successfully.' },
      ],
    },
  },
  final: true,
};

/** Failed event */
const failedEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'text-content' },
  },
  status: {
    state: 'failed',
    message: {
      parts: [
        { kind: 'text', text: 'Error: Tool execution failed' },
      ],
    },
  },
  final: true,
};

/** Event without metadata (edge case) */
const noMetadataEvent: A2AResult = {
  status: {
    state: 'working',
    message: {
      parts: [{ kind: 'text', text: 'No metadata' }],
    },
  },
};

/** Event with empty parts */
const emptyPartsEvent: A2AResult = {
  metadata: {
    coderAgent: { kind: 'text-content' },
  },
  status: {
    state: 'working',
    message: {
      parts: [],
    },
  },
};

// ============================================================================
// Tests
// ============================================================================

describe('parseA2AResult', () => {
  it('should parse text-content event with extracted text', () => {
    const event = parseA2AResult(textContentEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('text-content');
    expect(event?.text).toBe('Searching for information about... I found several relevant sources.');
    expect(event?.result).toBe(textContentEvent);
  });

  it('should parse thought event', () => {
    const event = parseA2AResult(thoughtEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('thought');
    expect(event?.text).toBe('Let me think about this step by step...');
  });

  it('should parse tool-call-update event with tool call metadata', () => {
    const event = parseA2AResult(toolCallValidatingEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('tool-call-update');
    expect(event?.toolCall).toEqual({
      callId: 'mcp_gsd-test_test_echo_1774176890004_0',
      name: 'mcp_gsd-test_test_echo',
      args: { message: 'SSE format test' },
      status: 'validating',
    });
  });

  it('should parse tool-call-confirmation event', () => {
    const event = parseA2AResult(toolCallConfirmationEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('tool-call-confirmation');
    expect(event?.isAwaitingApproval).toBeUndefined(); // Only state-change sets this
  });

  it('should parse state-change event with awaitingApproval detection', () => {
    const event = parseA2AResult(stateChangeAwaitingApprovalEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('state-change');
    expect(event?.isAwaitingApproval).toBe(true);
  });

  it('should parse state-change event without awaitingApproval when not final', () => {
    const event = parseA2AResult(stateChangeWorkingEvent);
    
    expect(event).not.toBeNull();
    expect(event?.kind).toBe('state-change');
    expect(event?.isAwaitingApproval).toBe(false);
  });

  it('should return null for event without metadata', () => {
    const event = parseA2AResult(noMetadataEvent);
    expect(event).toBeNull();
  });

  it('should return null for event with unrecognized kind', () => {
    const invalidEvent: A2AResult = {
      metadata: {
        coderAgent: { kind: 'unknown-event' as any },
      },
      status: {
        state: 'working',
        message: { parts: [] },
      },
    };
    const event = parseA2AResult(invalidEvent);
    expect(event).toBeNull();
  });
});

describe('extractTextContent', () => {
  it('should extract and concatenate multiple text parts', () => {
    const text = extractTextContent(textContentEvent);
    expect(text).toBe('Searching for information about... I found several relevant sources.');
  });

  it('should return empty string for event with no text parts', () => {
    const text = extractTextContent(toolCallValidatingEvent);
    expect(text).toBe('');
  });

  it('should return empty string for event with empty parts', () => {
    const text = extractTextContent(emptyPartsEvent);
    expect(text).toBe('');
  });

  it('should handle missing status gracefully', () => {
    const invalidResult = { metadata: { coderAgent: { kind: 'text-content' } } } as A2AResult;
    const text = extractTextContent(invalidResult);
    expect(text).toBe('');
  });
});

describe('extractToolCall', () => {
  it('should extract tool call from tool-call-update event (validating)', () => {
    const toolCall = extractToolCall(toolCallValidatingEvent);
    
    expect(toolCall).not.toBeNull();
    expect(toolCall).toEqual({
      callId: 'mcp_gsd-test_test_echo_1774176890004_0',
      name: 'mcp_gsd-test_test_echo',
      args: { message: 'SSE format test' },
      status: 'validating',
    });
  });

  it('should extract tool call with success status', () => {
    const toolCall = extractToolCall(toolCallSuccessEvent);
    
    expect(toolCall).not.toBeNull();
    expect(toolCall?.status).toBe('success');
  });

  it('should return null for event without tool call data', () => {
    const toolCall = extractToolCall(textContentEvent);
    expect(toolCall).toBeNull();
  });

  it('should return null for tool call without status (incomplete)', () => {
    const incompleteEvent: A2AResult = {
      metadata: {
        coderAgent: { kind: 'tool-call-update' },
      },
      status: {
        state: 'working',
        message: {
          parts: [
            {
              kind: 'data',
              data: {
                request: {
                  callId: 'test_123',
                  name: 'test_tool',
                  args: {},
                },
                // No status field
              },
            },
          ],
        },
      },
    };
    const toolCall = extractToolCall(incompleteEvent);
    expect(toolCall).toBeNull();
  });
});

describe('isAwaitingApproval', () => {
  it('should return true for input-required + final', () => {
    expect(isAwaitingApproval(stateChangeAwaitingApprovalEvent)).toBe(true);
  });

  it('should return false for input-required without final', () => {
    const event: A2AResult = {
      metadata: { coderAgent: { kind: 'state-change' } },
      status: { state: 'input-required', message: { parts: [] } },
    };
    expect(isAwaitingApproval(event)).toBe(false);
  });

  it('should return false for final without input-required', () => {
    expect(isAwaitingApproval(completedEvent)).toBe(false);
  });

  it('should return false for working state', () => {
    expect(isAwaitingApproval(stateChangeWorkingEvent)).toBe(false);
  });

  it('should handle missing status gracefully', () => {
    const invalidResult = { metadata: { coderAgent: { kind: 'state-change' } } } as A2AResult;
    expect(isAwaitingApproval(invalidResult)).toBe(false);
  });
});

describe('isTerminalState', () => {
  it('should return true for completed state', () => {
    expect(isTerminalState(completedEvent)).toBe(true);
  });

  it('should return true for failed state', () => {
    expect(isTerminalState(failedEvent)).toBe(true);
  });

  it('should return true for canceled state', () => {
    const canceledEvent: A2AResult = {
      metadata: { coderAgent: { kind: 'state-change' } },
      status: { state: 'canceled', message: { parts: [] } },
      final: true,
    };
    expect(isTerminalState(canceledEvent)).toBe(true);
  });

  it('should return true for rejected state', () => {
    const rejectedEvent: A2AResult = {
      metadata: { coderAgent: { kind: 'state-change' } },
      status: { state: 'rejected', message: { parts: [] } },
      final: true,
    };
    expect(isTerminalState(rejectedEvent)).toBe(true);
  });

  it('should return false for working state', () => {
    expect(isTerminalState(stateChangeWorkingEvent)).toBe(false);
  });

  it('should return false for input-required state', () => {
    expect(isTerminalState(stateChangeAwaitingApprovalEvent)).toBe(false);
  });
});

describe('extractErrorMessage', () => {
  it('should extract error message from failed event', () => {
    const error = extractErrorMessage(failedEvent);
    expect(error).toBe('Error: Tool execution failed');
  });

  it('should return undefined for non-terminal state', () => {
    const error = extractErrorMessage(stateChangeWorkingEvent);
    expect(error).toBeUndefined();
  });

  it('should fall back to state description when no text', () => {
    const failedNoMessage: A2AResult = {
      metadata: { coderAgent: { kind: 'state-change' } },
      status: { state: 'failed', message: { parts: [] } },
      final: true,
    };
    const error = extractErrorMessage(failedNoMessage);
    expect(error).toBe('Task failed');
  });
});

describe('isInvalidModelError', () => {
  it('should return true for "not found" error in metadata', () => {
    const invalidModelEvent = {
      metadata: {
        coderAgent: { kind: 'text-content' as const },
        error: 'Model gemini-invalid-model not found',
      },
      status: {
        state: 'failed',
        message: {
          parts: [{ kind: 'text', text: 'Invalid model' }],
        },
      },
      final: true,
    } as A2AResult;

    expect(isInvalidModelError(invalidModelEvent)).toBe(true);
  });

  it('should return true for case-insensitive "not found" error', () => {
    const invalidModelEvent = {
      metadata: {
        coderAgent: { kind: 'text-content' as const },
        error: 'MODEL NOT FOUND',
      },
      status: {
        state: 'failed',
        message: { parts: [] },
      },
      final: true,
    } as A2AResult;

    expect(isInvalidModelError(invalidModelEvent)).toBe(true);
  });

  it('should return false for other error types', () => {
    const authErrorEvent = {
      metadata: {
        coderAgent: { kind: 'text-content' as const },
        error: 'Authentication failed',
      },
      status: {
        state: 'failed',
        message: { parts: [] },
      },
      final: true,
    } as A2AResult;

    expect(isInvalidModelError(authErrorEvent)).toBe(false);
  });

  it('should return false if metadata has no error field', () => {
    expect(isInvalidModelError(textContentEvent)).toBe(false);
  });

  it('should return false if metadata is missing', () => {
    const noMetadataEvent: A2AResult = {
      status: {
        state: 'failed',
        message: { parts: [] },
      },
      final: true,
    };

    expect(isInvalidModelError(noMetadataEvent)).toBe(false);
  });

  it('should return false if error is not a string', () => {
    const invalidErrorEvent = {
      metadata: {
        coderAgent: { kind: 'text-content' as const },
        error: 123,
      },
      status: {
        state: 'failed',
        message: { parts: [] },
      },
      final: true,
    } as A2AResult;

    expect(isInvalidModelError(invalidErrorEvent)).toBe(false);
  });

  it('should return false for empty metadata', () => {
    const emptyMetadataEvent: A2AResult = {
      metadata: {
        coderAgent: { kind: 'text-content' },
      },
      status: {
        state: 'working',
        message: { parts: [] },
      },
    };

    expect(isInvalidModelError(emptyMetadataEvent)).toBe(false);
  });
});
