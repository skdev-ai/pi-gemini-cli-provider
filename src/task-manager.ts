/**
 * A2A Task Manager Module
 * 
 * Tracks per-task state across multi-turn conversations and tool approval flows.
 * Persists taskId, contextId, pending tool calls, and terminal state transitions.
 */

import type { TaskState, ParsedA2AEvent, ToolCallMetadata } from './types.js';

// ============================================================================
// State
// ============================================================================

/** In-memory task state store */
const taskStore = new Map<string, TaskState>();

// ============================================================================
// Task Creation
// ============================================================================

/**
 * Creates a new task with generated IDs.
 * 
 * @returns Initial task state with submitted state
 */
export function createTask(): TaskState {
  const taskId = generateTaskId();
  const contextId = generateContextId();
  
  const initialState: TaskState = {
    taskId,
    contextId,
    state: 'submitted',
    awaitingApproval: false,
    pendingToolCalls: [],
    isTerminal: false,
  };
  
  taskStore.set(taskId, initialState);
  return initialState;
}

/**
 * Creates a task with explicit IDs (for resuming existing tasks).
 * 
 * @param taskId - Existing task ID to resume
 * @param contextId - Existing context ID for continuity
 * @returns Initial task state
 */
export function createTaskWithIds(taskId: string, contextId: string): TaskState {
  const initialState: TaskState = {
    taskId,
    contextId,
    state: 'submitted',
    awaitingApproval: false,
    pendingToolCalls: [],
    isTerminal: false,
  };
  
  taskStore.set(taskId, initialState);
  return initialState;
}

// ============================================================================
// Task State Updates
// ============================================================================

/**
 * Updates task state based on a parsed A2A event.
 * 
 * Handles:
 * - State transitions from state-change events
 * - Pending tool call tracking from tool-call-update events
 * - Awaiting approval detection
 * - Terminal state marking
 * - Error message extraction
 * 
 * @param taskId - Task ID to update
 * @param event - Parsed A2A event
 * @returns Updated task state or null if task not found
 */
export function updateTaskState(taskId: string, event: ParsedA2AEvent): TaskState | null {
  const state = taskStore.get(taskId);
  if (!state) return null;
  
  // Update state from result
  const resultState = event.result.status?.state;
  if (resultState) {
    state.state = resultState;
  }
  
  // Handle state-change events
  if (event.kind === 'state-change') {
    // Update awaiting approval flag
    if (event.isAwaitingApproval !== undefined) {
      state.awaitingApproval = event.isAwaitingApproval;
    }
  }
  
  // Handle tool-call-update events
  if (event.kind === 'tool-call-update' && event.toolCall) {
    updatePendingToolCall(state, event.toolCall);
  }
  
  // Handle terminal states
  if (event.result.final === true) {
    const terminalStates: TaskState['state'][] = ['completed', 'failed', 'canceled', 'rejected'];
    if (terminalStates.includes(state.state)) {
      state.isTerminal = true;
    }
    
    // Extract error message for failed/canceled/rejected states
    if (state.state === 'failed' || state.state === 'canceled' || state.state === 'rejected') {
      const errorMessage = event.text || `Task ${state.state}`;
      state.errorMessage = errorMessage;
    }
  }
  
  // Update awaiting approval from input-required + final pattern
  // Only set awaitingApproval when there are actual pending tool calls.
  // input-required + final is ALSO the normal completion state (no tools),
  // so we must check pendingToolCalls to distinguish.
  if (state.state === 'input-required' && event.result.final === true) {
    state.awaitingApproval = state.pendingToolCalls.length > 0;
  }
  
  taskStore.set(taskId, state);
  return state;
}

/**
 * Updates or adds a pending tool call in task state.
 * 
 * @param state - Task state to update
 * @param toolCall - Tool call metadata to add/update
 */
function updatePendingToolCall(state: TaskState, toolCall: ToolCallMetadata): void {
  const existingIndex = state.pendingToolCalls.findIndex(
    call => call.callId === toolCall.callId
  );
  
  if (existingIndex >= 0) {
    // Update existing call (e.g., status changed from validating to scheduled)
    state.pendingToolCalls[existingIndex] = toolCall;
  } else {
    // Add new pending call
    state.pendingToolCalls.push(toolCall);
  }
}

/**
 * Clears pending tool calls after approval/execution.
 * 
 * @param taskId - Task ID to clear calls for
 * @param callIds - Specific call IDs to remove (removes all if not provided)
 * @returns Updated task state or null if task not found
 */
export function clearPendingToolCalls(taskId: string, callIds?: string[]): TaskState | null {
  const state = taskStore.get(taskId);
  if (!state) return null;
  
  if (callIds && callIds.length > 0) {
    // Remove specific calls
    state.pendingToolCalls = state.pendingToolCalls.filter(
      call => !callIds.includes(call.callId)
    );
  } else {
    // Clear all
    state.pendingToolCalls = [];
  }
  
  taskStore.set(taskId, state);
  return state;
}

/**
 * Marks a task as failed with an error message.
 * 
 * @param taskId - Task ID to mark as failed
 * @param errorMessage - Error message
 * @returns Updated task state or null if task not found
 */
export function markTaskFailed(taskId: string, errorMessage: string): TaskState | null {
  const state = taskStore.get(taskId);
  if (!state) return null;
  
  state.state = 'failed';
  state.isTerminal = true;
  state.errorMessage = errorMessage;
  state.awaitingApproval = false;
  
  taskStore.set(taskId, state);
  return state;
}

// ============================================================================
// Task State Queries
// ============================================================================

/**
 * Gets the current state of a task.
 * 
 * @param taskId - Task ID to query
 * @returns Task state or null if not found
 */
export function getTaskState(taskId: string): TaskState | null {
  return taskStore.get(taskId) ?? null;
}

/**
 * Checks if a task exists.
 * 
 * @param taskId - Task ID to check
 * @returns True if task exists
 */
export function hasTask(taskId: string): boolean {
  return taskStore.has(taskId);
}

/**
 * Gets all pending tool calls for a task.
 * 
 * @param taskId - Task ID to query
 * @returns Array of pending tool call metadata
 */
export function getPendingToolCalls(taskId: string): ToolCallMetadata[] {
  const state = taskStore.get(taskId);
  return state?.pendingToolCalls ?? [];
}

/**
 * Checks if a task is awaiting approval.
 * 
 * @param taskId - Task ID to check
 * @returns True if task is awaiting approval
 */
export function isAwaitingApproval(taskId: string): boolean {
  const state = taskStore.get(taskId);
  return state?.awaitingApproval === true;
}

/**
 * Checks if a task has reached a terminal state.
 * 
 * @param taskId - Task ID to check
 * @returns True if task is terminal
 */
export function isTaskTerminal(taskId: string): boolean {
  const state = taskStore.get(taskId);
  return state?.isTerminal === true;
}

/**
 * Gets the current state string for a task.
 * 
 * @param taskId - Task ID to query
 * @returns State string or null if task not found
 */
export function getTaskStateString(taskId: string): string | null {
  const state = taskStore.get(taskId);
  return state?.state ?? null;
}

// ============================================================================
// Task Cleanup
// ============================================================================

/**
 * Removes a task from the store.
 * 
 * @param taskId - Task ID to delete
 * @returns True if task was deleted
 */
export function deleteTask(taskId: string): boolean {
  return taskStore.delete(taskId);
}

/**
 * Clears all tasks from the store.
 * 
 * Useful for testing or session cleanup.
 */
export function clearAllTasks(): void {
  taskStore.clear();
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generates a unique task ID.
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

// ============================================================================
// Testing Exports
// ============================================================================

/**
 * Testing utilities for internal state inspection.
 */
export const __testing__ = {
  getTaskStore: () => taskStore,
  setTaskStore: (store: Map<string, TaskState>) => {
    // Clear and repopulate
    taskStore.clear();
    store.forEach((value, key) => taskStore.set(key, value));
  },
};
