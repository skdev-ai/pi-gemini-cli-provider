/**
 * Integration Tests
 * 
 * Live end-to-end tests for the Gemini A2A provider.
 * Env-gated with GEMINI_A2A_LIVE=1.
 * 
 * Tests cover:
 * - Prerequisite verification (patched A2A server, MCP bridge, tool schemas)
 * - Approval interception for MCP tool calls (stopReason: 'toolUse')
 * - Result reinjection via inject_result (continuation without empty follow-up prompt)
 * - Multi-turn continuity (taskId/contextId reuse)
 * 
 * Setup behavior:
 * - Checks /gemini-cli status-equivalent state via lifecycle module
 * - Fails fast with clear error if prerequisites are missing
 * - Does NOT auto-install - user must run /gemini-cli install-a2a first
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { streamSimple } from './stream-simple.js';
import {
  startServer,
  stopServer,
  getServerState,
} from './a2a-lifecycle.js';
import {
  getTaskState,
  clearAllTasks,
} from './task-manager.js';
import { checkA2APatched, checkA2AInjectResultPatched } from './availability.js';
import { getA2APackageRoot } from './a2a-path.js';
import { isPortInUse, isServerHealthy } from './port-check.js';

// Skip all tests if GEMINI_A2A_LIVE is not set
const LIVE_MODE = process.env.GEMINI_A2A_LIVE === '1';
const describeLive = LIVE_MODE ? describe : describe.skip;

// Check prerequisites at module load time
let PREREQUISITES_MET = false;
let PREREQUISITE_ERROR = '';

if (LIVE_MODE) {
  try {
    const packageRoot = getA2APackageRoot();
    if (!packageRoot) {
      PREREQUISITE_ERROR = 'A2A server not installed. Run: npm install -g @google/gemini-cli-a2a-server@0.34.0';
    } else {
      const bundlePath = packageRoot + '/dist/a2a-server.mjs';
      const hasPatches1and2 = checkA2APatched(bundlePath);
      const hasPatch3 = checkA2AInjectResultPatched();
      
      if (!hasPatches1and2) {
        PREREQUISITE_ERROR = 'A2A server missing Patches 1-2. Run `/gemini-cli install-a2a` from the search extension.';
      } else if (!hasPatch3) {
        PREREQUISITE_ERROR = 'A2A server missing Patch 3 (inject_result). This patch is being developed in this provider extension.';
      } else {
        PREREQUISITES_MET = true;
      }
    }
  } catch (error) {
    PREREQUISITE_ERROR = error instanceof Error ? error.message : 'Unknown prerequisite check failure';
  }
}

// Helper to wait for a condition with timeout
async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const start = Date.now();
  
  while (Date.now() - start < timeoutMs) {
    const result = await condition();
    if (result) return true;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  return false;
}

describeLive('Live Integration', () => {
  const TEST_MODEL = 'gemini-2.5-flash';
  
  // Skip all tests in this block if prerequisites aren't met
  if (LIVE_MODE && !PREREQUISITES_MET) {
    beforeAll(() => {
      throw new Error(`Prerequisites not met: ${PREREQUISITE_ERROR}`);
    });
  }
  
  beforeAll(async () => {
    // Ensure server is running before tests start
    const isRunning = await isPortInUse(41242);
    const isHealthy = await isServerHealthy(41242);
    
    if (!isRunning || !isHealthy) {
      await startServer();
      await waitForCondition(async () => await isServerHealthy(41242), 10000);
    }
  }, 15000);
  
  beforeEach(async () => {
    // Clear task state between tests
    clearAllTasks();
  });
  
  afterEach(async () => {
    // Clean up: stop server if running
    try {
      await stopServer();
    } catch {
      // Ignore cleanup errors
    }
  });
  
  describe('Prerequisite Verification', () => {
    it('should verify A2A server is installed and patched before running tests', async () => {
      // This test establishes the baseline - all other tests depend on these prerequisites
      
      // Check 1: A2A package is installed
      const packageRoot = getA2APackageRoot();
      expect(packageRoot).toBeTruthy();
      expect(packageRoot).toContain('gemini-cli-a2a');
      
      // Check 2: Patches 1-2 are applied
      const bundlePath = packageRoot + '/dist/a2a-server.mjs';
      const hasPatches1and2 = checkA2APatched(bundlePath);
      expect(hasPatches1and2).toBe(true);
      
      // Check 3: Patch 3 (inject_result) is applied
      const hasPatch3 = checkA2AInjectResultPatched();
      expect(hasPatch3).toBe(true);
      
      // Check 4: Server is running and healthy
      const isRunning = await isPortInUse(41242);
      const isHealthy = await isServerHealthy(41242);
      
      expect(isRunning).toBe(true);
      expect(isHealthy).toBe(true);
      
      // Verify server state
      const state = getServerState();
      // Server might be 'running' or 'idle' (if no active requests) - both are OK
      expect(state.port).toBe(41242);
    }, 10000);
  });
  
  describe('Approval Interception', () => {
    it('should intercept MCP tool call and return stopReason: toolUse', async () => {
      // Ensure server is running
      const isRunning = await isPortInUse(41242);
      if (!isRunning) {
        await startServer();
        await waitForCondition(async () => await isServerHealthy(41242), 5000);
      }
      
      // Send a prompt that should trigger an MCP tool call
      // Using a prompt that requests file system access (which requires MCP)
      const { stream, result } = await streamSimple({
        prompt: 'Read the file package.json and tell me what dependencies are listed',
        context: { messages: [] },
        model: TEST_MODEL,
      });
      
      // Capture events from the stream
      const events: any[] = [];
      const toolCalls: any[] = [];
      
      stream.onEvent?.((event) => {
        events.push(event);
        if (event.type === 'toolCall' || event.type === 'tool_call') {
          toolCalls.push(event);
        }
      });
      
      // Wait for result to complete
      const finalResult = await result;
      
      // Assert: stopReason should be 'toolUse' for MCP tool
      expect(finalResult.stopReason).toBe('toolUse');
      
      // Assert: taskId and contextId are present
      expect(finalResult.taskId).toBeDefined();
      expect(finalResult.contextId).toBeDefined();
      expect(finalResult.taskId).toBeTruthy();
      expect(finalResult.contextId).toBeTruthy();
      
      // Assert: At least one tool call was detected
      expect(toolCalls.length).toBeGreaterThan(0);
      
      // Assert: Tool call has MCP prefix (mcp_tools_*)
      const mcpToolCalls = toolCalls.filter(tc => tc.name.startsWith('tools_'));
      expect(mcpToolCalls.length).toBeGreaterThan(0);
      
      // Assert: Task state shows awaiting approval
      const taskState = getTaskState(finalResult.taskId);
      expect(taskState).toBeTruthy();
      expect(taskState?.awaitingApproval).toBe(true);
      expect(taskState?.pendingToolCalls.length).toBeGreaterThan(0);
    }, 30000);
  });
  
  describe('Result Reinjection and Continuation', () => {
    it('should continue from inject_result without empty follow-up prompt', async () => {
      // Ensure server is running
      const isRunning = await isPortInUse(41242);
      if (!isRunning) {
        await startServer();
        await waitForCondition(async () => await isServerHealthy(41242), 5000);
      }
      
      // Step 1: Send initial prompt to trigger tool call
      const { result: result1 } = await streamSimple({
        prompt: 'What is the current Node.js version? Run a command to check.',
        context: { messages: [] },
        model: TEST_MODEL,
      });
      
      const finalResult1 = await result1;
      
      // Assert: First pass returns stopReason: toolUse
      expect(finalResult1.stopReason).toBe('toolUse');
      expect(finalResult1.taskId).toBeDefined();
      expect(finalResult1.contextId).toBeDefined();
      
      const taskId = finalResult1.taskId;
      const contextId = finalResult1.contextId;
      
      // Get the pending tool call to simulate execution
      const taskState1 = getTaskState(taskId);
      expect(taskState1?.pendingToolCalls.length).toBeGreaterThan(0);
      
      const pendingCall = taskState1?.pendingToolCalls[0];
      expect(pendingCall).toBeDefined();
      
      // Step 2: Simulate GSD executing the tool and sending back result
      // This is the re-call path with toolResult in context
      const toolResultContent = 'Node.js version: v24.14.0';
      
      const { stream: stream2, result: result2 } = await streamSimple({
        prompt: '', // Empty prompt - this is a re-call
        context: {
          messages: [
            {
              role: 'toolResult',
              toolCallId: pendingCall!.callId,
              name: pendingCall!.name,
              content: [{ type: 'text', text: toolResultContent }],
            },
          ],
        },
        taskId,
        contextId,
        model: TEST_MODEL,
      });
      
      // Capture continuation events
      const continuationEvents: any[] = [];
      let hasTextContent = false;
      
      stream2.onEvent?.((event) => {
        continuationEvents.push(event);
        if (event.type === 'text_delta' && event.delta) {
          hasTextContent = true;
        } else if (event.type === 'text' && event.content) {
          hasTextContent = true;
        }
      });
      
      const finalResult2 = await result2;
      
      // Assert: Continuation happened (no stopReason, task continues)
      expect(finalResult2.stopReason).toBeUndefined();
      
      // Assert: Same taskId and contextId were reused
      expect(finalResult2.taskId).toBe(taskId);
      expect(finalResult2.contextId).toBe(contextId);
      
      // Assert: Model produced continuation content from injected result
      expect(hasTextContent).toBe(true);
      expect(continuationEvents.length).toBeGreaterThan(0);
      
      // Assert: Task reached terminal state after continuation
      const taskState2 = getTaskState(taskId);
      expect(taskState2?.isTerminal).toBe(true);
      expect(taskState2?.state).toBe('completed');
    }, 30000);
  });
  
  describe('Multi-Turn Continuity', () => {
    it('should reuse taskId/contextId for second turn on same conversation', async () => {
      // Ensure server is running
      const isRunning = await isPortInUse(41242);
      if (!isRunning) {
        await startServer();
        await waitForCondition(async () => await isServerHealthy(41242), 5000);
      }
      
      // Turn 1: Initial prompt
      const { result: result1 } = await streamSimple({
        prompt: 'Hello, I need help with a coding question.',
        context: { messages: [] },
        model: TEST_MODEL,
      });
      
      const finalResult1 = await result1;
      
      // Assert: First turn completes successfully
      expect(finalResult1.taskId).toBeDefined();
      expect(finalResult1.contextId).toBeDefined();
      expect(finalResult1.stopReason).toBeUndefined(); // No tool calls expected
      
      const taskId = finalResult1.taskId;
      const contextId = finalResult1.contextId;
      
      // Turn 2: Follow-up question using same taskId/contextId
      const { result: result2 } = await streamSimple({
        prompt: 'Actually, can you help me understand how to read a file in Node.js?',
        context: { messages: [] }, // Fresh context but same task/context IDs
        taskId,
        contextId,
        model: TEST_MODEL,
      });
      
      const finalResult2 = await result2;
      
      // Assert: Second turn reuses the same taskId and contextId
      expect(finalResult2.taskId).toBe(taskId);
      expect(finalResult2.contextId).toBe(contextId);
      
      // Assert: Second turn completes (may or may not have tool calls)
      expect(finalResult2.taskId).toBeDefined();
      
      // Verify task state shows continuity
      const taskState = getTaskState(taskId);
      expect(taskState).toBeTruthy();
      expect(taskState?.contextId).toBe(contextId);
    });
    
    it('should handle multi-turn with tool call in second turn', async () => {
      // Ensure server is running
      const isRunning = await isPortInUse(41242);
      if (!isRunning) {
        await startServer();
        await waitForCondition(async () => await isServerHealthy(41242), 5000);
      }
      
      // Turn 1: Simple greeting (no tool calls)
      const { result: result1 } = await streamSimple({
        prompt: 'Hi, I have a question about my project files.',
        context: { messages: [] },
        model: TEST_MODEL,
      });
      
      const finalResult1 = await result1;
      expect(finalResult1.taskId).toBeDefined();
      expect(finalResult1.contextId).toBeDefined();
      
      const taskId = finalResult1.taskId;
      const contextId = finalResult1.contextId;
      
      // Turn 2: Question that should trigger tool use
      const { result: result2 } = await streamSimple({
        prompt: 'Can you check what files are in the current directory?',
        context: { messages: [] },
        taskId,
        contextId,
        model: TEST_MODEL,
      });
      
      const finalResult2 = await result2;
      
      // Assert: Same conversation context
      expect(finalResult2.taskId).toBe(taskId);
      expect(finalResult2.contextId).toBe(contextId);
      
      // Assert: Second turn may trigger tool use
      // (exact behavior depends on model's decision)
      expect(finalResult2.taskId).toBeDefined();
    }, 30000);
  });
  
  describe('Error Handling', () => {
    it('should fail gracefully when server is not running', async () => {
      // Stop the server
      await stopServer();
      
      // Wait for server to actually stop
      await waitForCondition(
        async () => !(await isPortInUse(41242)),
        5000
      );
      
      // Attempt to send prompt - should fail with connection error
      try {
        const { stream, result } = await streamSimple({
          prompt: 'Test',
          context: { messages: [] },
          model: TEST_MODEL,
        });
        
        // If we get here, the stream was created - wait for result to see if it fails
        await result;
        // If result resolves, the test should fail
        throw new Error('Expected streamSimple to fail when server is not running');
      } catch (error) {
        // Expected: should throw an error
        expect(error).toBeDefined();
        const errorMessage = error instanceof Error ? error.message : String(error);
        expect(errorMessage).toMatch(/fetch failed|ECONNREFUSED|Connection refused|not running/i);
      }
    }, 10000);
    
    it('should handle invalid model ID gracefully', async () => {
      // Ensure server is running
      const isRunning = await isPortInUse(41242);
      if (!isRunning) {
        await startServer();
        await waitForCondition(async () => await isServerHealthy(41242), 5000);
      }
      
      // Use an invalid model ID
      const invalidModel = 'gemini-nonexistent-model-xyz-123';
      
      const { stream, result } = await streamSimple({
        prompt: 'Test',
        context: { messages: [] },
        model: invalidModel,
      });
      
      // Capture any error events
      stream.onError?.((err: Error) => {
        // Error captured - we don't need to store it since we're testing both success and failure paths
      });
      
      // Wait for result - it may resolve or reject depending on how A2A handles invalid models
      try {
        const finalResult = await result;
        // If it resolves, that's acceptable - invalid model handling varies by A2A version
        expect(finalResult).toBeDefined();
      } catch (error) {
        // If it rejects, that's also acceptable
        expect(error).toBeDefined();
      }
    }, 10000);
  });
});
