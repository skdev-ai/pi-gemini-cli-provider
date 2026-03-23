/**
 * Test fixture: Simplified A2A server bundle for patch testing
 * Contains the _handleToolConfirmationPart function with proceed_always_and_save case
 * This file is copied to temp location for each test to avoid mutating the fixture
 */

class TaskHandler {
  constructor() {
    this.completedToolCalls = [];
    this.currentPromptId = '';
  }

  _resolveToolCall(callId) {
    // Mock resolution
    return true;
  }

  _handleToolConfirmationPart(part, callId) {
    const outcomeString = part.data?.outcome;
    
    if (!outcomeString) {
      return false;
    }

    if (outcomeString === 'proceed_always') {
      // Handle proceed_always case
      return true;
    } else if (outcomeString === 'proceed_always_and_save') {
      // Handle proceed_always_and_save case
      this.completedToolCalls.push({ callId, status: 'saved' });
      this._resolveToolCall(callId);
      return true;
    } else if (outcomeString === 'discard') {
      // Handle discard case
      return true;
    }

    return false;
  }
}

export { TaskHandler };
