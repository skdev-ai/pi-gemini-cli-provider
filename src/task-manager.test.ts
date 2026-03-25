/**
 * Task Manager Tests
 * 
 * Tests for src/task-manager.ts covering:
 * - Multi-event state transitions
 * - Pending tool call updates
 * - Awaiting approval detection
 * - Failure/terminal state handling
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTask,
  createTaskWithIds,
  updateTaskState,
  clearPendingToolCalls,
  markTaskFailed,
  getTaskState,
  hasTask,
  getPendingToolCalls,
  isAwaitingApproval,
  isTaskTerminal,
  getTaskStateString,
  deleteTask,
  clearAllTasks,
  __testing__,
} from './task-manager.js';
import type { ParsedA2AEvent, A2AResult } from './types.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a parsed A2A event fixture
 */
function createParsedEvent(
  kind: ParsedA2AEvent['kind'],
  state: A2AResult['status']['state'],
  final?: boolean,
  isAwaitingApproval?: boolean,
  text?: string
): ParsedA2AEvent {
  return {
    kind,
    result: {
      metadata: {
        coderAgent: { kind },
      },
      status: {
        state,
        message: { parts: text ? [{ kind: 'text', text }] : [] },
      },
      final,
    },
    text,
    isAwaitingApproval,
  } as ParsedA2AEvent;
}

/**
 * Creates a parsed event with tool call data
 */
function createToolCallEvent(
  callId: string,
  name: string,
  status: 'validating' | 'scheduled' | 'executing' | 'success',
  args: unknown = {}
): ParsedA2AEvent {
  return {
    kind: 'tool-call-update',
    result: {
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
                request: { callId, name, args },
                status,
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
      status,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('createTask', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should create a task with generated IDs and initial submitted state', () => {
    const task = createTask();
    
    expect(task.taskId).toMatch(/^task_\d+_[a-z0-9]+$/);
    expect(task.contextId).toMatch(/^ctx_\d+_[a-z0-9]+$/);
    expect(task.state).toBe('submitted');
    expect(task.awaitingApproval).toBe(false);
    expect(task.pendingToolCalls).toEqual([]);
    expect(task.isTerminal).toBe(false);
    expect(task.errorMessage).toBeUndefined();
  });

  it('should store the task in the task store', () => {
    const task = createTask();
    expect(hasTask(task.taskId)).toBe(true);
  });
});

describe('createTaskWithIds', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should create a task with explicit IDs', () => {
    const task = createTaskWithIds('task-123', 'ctx-456');
    
    expect(task.taskId).toBe('task-123');
    expect(task.contextId).toBe('ctx-456');
    expect(task.state).toBe('submitted');
    expect(task.awaitingApproval).toBe(false);
    expect(task.pendingToolCalls).toEqual([]);
  });
});

describe('updateTaskState - state transitions', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should transition from submitted to working', () => {
    const task = createTask();
    
    const event = createParsedEvent('state-change', 'working');
    const updated = updateTaskState(task.taskId, event);
    
    expect(updated?.state).toBe('working');
    expect(updated?.isTerminal).toBe(false);
  });

  it('should transition to input-required and detect awaiting approval', () => {
    const task = createTask();
    
    // First transition to working
    updateTaskState(task.taskId, createParsedEvent('state-change', 'working'));
    
    // Then to input-required with final=true
    const event = createParsedEvent(
      'state-change',
      'input-required',
      true, // final
      true  // isAwaitingApproval
    );
    const updated = updateTaskState(task.taskId, event);
    
    expect(updated?.state).toBe('input-required');
    expect(updated?.awaitingApproval).toBe(true);
    expect(updated?.isTerminal).toBe(false);
  });

  it('should transition to completed and mark as terminal', () => {
    const task = createTask();
    
    const event = createParsedEvent(
      'text-content',
      'completed',
      true, // final
      undefined,
      'Task completed successfully'
    );
    const updated = updateTaskState(task.taskId, event);
    
    expect(updated?.state).toBe('completed');
    expect(updated?.isTerminal).toBe(true);
    expect(updated?.awaitingApproval).toBe(false);
  });

  it('should handle multi-event state transition sequence', () => {
    const task = createTask();
    
    // submitted -> working
    updateTaskState(task.taskId, createParsedEvent('state-change', 'working'));
    expect(getTaskStateString(task.taskId)).toBe('working');
    
    // working -> input-required (awaiting approval)
    updateTaskState(
      task.taskId,
      createParsedEvent('state-change', 'input-required', true, true)
    );
    expect(getTaskStateString(task.taskId)).toBe('input-required');
    expect(isAwaitingApproval(task.taskId)).toBe(true);
    
    // Still awaiting approval (not terminal)
    expect(isTaskTerminal(task.taskId)).toBe(false);
  });
});

describe('updateTaskState - tool call tracking', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should add pending tool call from tool-call-update event', () => {
    const task = createTask();
    
    const event = createToolCallEvent(
      'call_123',
      'mcp_gsd-test_test_echo',
      'validating',
      { message: 'test' }
    );
    updateTaskState(task.taskId, event);
    
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0]).toEqual({
      callId: 'call_123',
      name: 'mcp_gsd-test_test_echo',
      args: { message: 'test' },
      status: 'validating',
    });
  });

  it('should update tool call status from validating to scheduled', () => {
    const task = createTask();
    
    // First: validating
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_123', 'test_tool', 'validating')
    );
    
    // Then: scheduled
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_123', 'test_tool', 'scheduled')
    );
    
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0].status).toBe('scheduled');
  });

  it('should track multiple pending tool calls', () => {
    const task = createTask();
    
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_1', 'tool_a', 'validating')
    );
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_2', 'tool_b', 'validating')
    );
    
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(2);
    expect(pendingCalls.map(c => c.callId)).toEqual(['call_1', 'call_2']);
  });

  it('should preserve tool calls across state transitions', () => {
    const task = createTask();
    
    // Add tool call
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_123', 'test_tool', 'validating')
    );
    
    // Transition state
    updateTaskState(task.taskId, createParsedEvent('state-change', 'working'));
    
    // Tool calls should still be there
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0].callId).toBe('call_123');
  });
});

describe('clearPendingToolCalls', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should clear all pending tool calls', () => {
    const task = createTask();
    
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_1', 'tool_a', 'success')
    );
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_2', 'tool_b', 'success')
    );
    
    clearPendingToolCalls(task.taskId);
    
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(0);
  });

  it('should clear specific pending tool calls by callId', () => {
    const task = createTask();
    
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_1', 'tool_a', 'success')
    );
    updateTaskState(
      task.taskId,
      createToolCallEvent('call_2', 'tool_b', 'success')
    );
    
    clearPendingToolCalls(task.taskId, ['call_1']);
    
    const pendingCalls = getPendingToolCalls(task.taskId);
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0].callId).toBe('call_2');
  });

  it('should return null for non-existent task', () => {
    const result = clearPendingToolCalls('non-existent-task');
    expect(result).toBeNull();
  });
});

describe('markTaskFailed', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should mark task as failed with error message', () => {
    const task = createTask();
    
    const result = markTaskFailed(task.taskId, 'Connection timeout');
    
    expect(result?.state).toBe('failed');
    expect(result?.isTerminal).toBe(true);
    expect(result?.errorMessage).toBe('Connection timeout');
    expect(result?.awaitingApproval).toBe(false);
  });

  it('should return null for non-existent task', () => {
    const result = markTaskFailed('non-existent-task', 'error');
    expect(result).toBeNull();
  });
});

describe('isAwaitingApproval', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should return true when task is awaiting approval', () => {
    const task = createTask();
    updateTaskState(
      task.taskId,
      createParsedEvent('state-change', 'input-required', true, true)
    );
    
    expect(isAwaitingApproval(task.taskId)).toBe(true);
  });

  it('should return false when task is not awaiting approval', () => {
    const task = createTask();
    updateTaskState(task.taskId, createParsedEvent('state-change', 'working'));
    
    expect(isAwaitingApproval(task.taskId)).toBe(false);
  });

  it('should return false for non-existent task', () => {
    expect(isAwaitingApproval('non-existent-task')).toBe(false);
  });
});

describe('isTaskTerminal', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should return true for completed task', () => {
    const task = createTask();
    updateTaskState(
      task.taskId,
      createParsedEvent('text-content', 'completed', true)
    );
    
    expect(isTaskTerminal(task.taskId)).toBe(true);
  });

  it('should return true for failed task', () => {
    const task = createTask();
    markTaskFailed(task.taskId, 'error');
    
    expect(isTaskTerminal(task.taskId)).toBe(true);
  });

  it('should return false for awaiting approval task', () => {
    const task = createTask();
    updateTaskState(
      task.taskId,
      createParsedEvent('state-change', 'input-required', true, true)
    );
    
    expect(isTaskTerminal(task.taskId)).toBe(false);
  });

  it('should return false for non-existent task', () => {
    expect(isTaskTerminal('non-existent-task')).toBe(false);
  });
});

describe('getTaskState', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should return task state for existing task', () => {
    const task = createTask();
    const state = getTaskState(task.taskId);
    
    expect(state).not.toBeNull();
    expect(state?.taskId).toBe(task.taskId);
    expect(state?.contextId).toBe(task.contextId);
  });

  it('should return null for non-existent task', () => {
    const state = getTaskState('non-existent-task');
    expect(state).toBeNull();
  });
});

describe('hasTask', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should return true for existing task', () => {
    const task = createTask();
    expect(hasTask(task.taskId)).toBe(true);
  });

  it('should return false for non-existent task', () => {
    expect(hasTask('non-existent-task')).toBe(false);
  });
});

describe('deleteTask', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should delete existing task', () => {
    const task = createTask();
    const deleted = deleteTask(task.taskId);
    
    expect(deleted).toBe(true);
    expect(hasTask(task.taskId)).toBe(false);
  });

  it('should return false for non-existent task', () => {
    const deleted = deleteTask('non-existent-task');
    expect(deleted).toBe(false);
  });
});

describe('getTaskStateString', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should return state string for existing task', () => {
    const task = createTask();
    updateTaskState(task.taskId, createParsedEvent('state-change', 'working'));
    
    expect(getTaskStateString(task.taskId)).toBe('working');
  });

  it('should return null for non-existent task', () => {
    expect(getTaskStateString('non-existent-task')).toBeNull();
  });
});

describe('failure and edge cases', () => {
  beforeEach(() => {
    clearAllTasks();
  });

  it('should handle updateTaskState for non-existent task', () => {
    const event = createParsedEvent('state-change', 'working');
    const result = updateTaskState('non-existent-task', event);
    expect(result).toBeNull();
  });

  it('should extract error message from failed event text', () => {
    const task = createTask();
    const event = createParsedEvent(
      'text-content',
      'failed',
      true,
      undefined,
      'Error: Tool execution failed'
    );
    updateTaskState(task.taskId, event);
    
    const state = getTaskState(task.taskId);
    expect(state?.errorMessage).toBe('Error: Tool execution failed');
    expect(state?.isTerminal).toBe(true);
  });

  it('should handle input-required without final flag (not awaiting approval)', () => {
    const task = createTask();
    const event = createParsedEvent(
      'state-change',
      'input-required',
      false, // not final
      false
    );
    updateTaskState(task.taskId, event);
    
    const state = getTaskState(task.taskId);
    expect(state?.awaitingApproval).toBe(false);
  });

  it('should detect awaiting approval from input-required + final pattern', () => {
    const task = createTask();
    // Event without isAwaitingApproval flag but with input-required + final
    const event: ParsedA2AEvent = {
      kind: 'state-change',
      result: {
        metadata: { coderAgent: { kind: 'state-change' } },
        status: { state: 'input-required', message: { parts: [] } },
        final: true,
      },
      isAwaitingApproval: false, // Explicitly false
    };
    updateTaskState(task.taskId, event);
    
    const state = getTaskState(task.taskId);
    // Should be true because of input-required + final pattern
    expect(state?.awaitingApproval).toBe(true);
  });
});
