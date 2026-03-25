import { readFileSync, writeFileSync, renameSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Marker string that identifies the inject_result patch has been applied.
 * This string is searched for to detect if the patch is present.
 */
export const INJECT_RESULT_MARKER = 'PATCH: inject_result support (pi-gemini-cli-provider)';

/**
 * The exact patch string to insert into the A2A server bundle.
 * This adds a new outcome handler for 'inject_result' in the _handleToolConfirmationPart function.
 */
export const INJECT_RESULT_CASE = `} else if (outcomeString === "inject_result") {
  // PATCH: inject_result support (pi-gemini-cli-provider)
  const functionResponse = part.data['functionResponse'];
  if (!functionResponse || typeof functionResponse !== 'object') {
    logger.warn('[Task] inject_result missing functionResponse for callId: ' + callId);
    return false;
  }

  const isError = functionResponse.isError === true;
  const responsePayload = functionResponse.response;
  const resultDisplay = responsePayload?.output || JSON.stringify(responsePayload) || '';
  const errorMessage = isError
    ? (typeof responsePayload?.output === 'string' ? responsePayload.output : resultDisplay || 'Tool execution failed')
    : undefined;
  
  const completedToolCall = {
    status: isError ? 'error' : 'success',
    request: {
      callId: callId,
      name: functionResponse.name,
      args: {},
      originalRequestName: functionResponse.name,
      isClientInitiated: false,
      prompt_id: this.currentPromptId || '',
    },
    response: {
      callId: callId,
      responseParts: [
        {
          functionResponse: {
            id: functionResponse.id,
            name: functionResponse.name,
            response: responsePayload,
          },
        },
      ],
      resultDisplay: resultDisplay,
      error: errorMessage,
      errorType: isError ? 'tool_execution_error' : undefined,
      contentLength: JSON.stringify(responsePayload).length,
    },
  };
  
  this.completedToolCalls.push(completedToolCall);
  this._resolveToolCall(callId);
  
  // Cleanup pending state
  if (this.pendingToolConfirmationDetails) {
    this.pendingToolConfirmationDetails.delete(callId);
  }
  if (this.pendingCorrelationIds) {
    this.pendingCorrelationIds.delete(callId);
  }
  if (this.toolsAlreadyConfirmed) {
    this.toolsAlreadyConfirmed.add(callId);
  }
  
  logger.info('[Task] Injected result for callId: ' + callId);
  return true;
}`;

/**
 * Default fallback else block target.
 * The inject_result case must be inserted immediately before this block.
 */
const DEFAULT_ELSE_TARGET = '    } else {\n      logger.warn(\n        `[Task] Unknown tool confirmation outcome:';

/**
 * Checks if the A2A server bundle has been patched with inject_result support.
 * 
 * @param bundlePath - Path to the a2a-server.mjs bundle file
 * @returns true if patch is present, false otherwise
 */
export function checkInjectResultPatched(bundlePath: string): boolean {
  try {
    if (!existsSync(bundlePath)) {
      return false;
    }
    
    const content = readFileSync(bundlePath, 'utf-8');
    return content.includes(INJECT_RESULT_MARKER);
  } catch (error) {
    // Handle file read errors gracefully
    return false;
  }
}

/**
 * Applies the inject_result patch to the A2A server bundle.
 * 
 * This function is idempotent - calling it multiple times will not corrupt the file.
 * Uses atomic write (temp file + rename) to prevent file corruption on interruption.
 * 
 * @param bundlePath - Path to the a2a-server.mjs bundle file
 * @returns true if patch was applied successfully (or already present)
 * @throws Error if insertion point is not found in the bundle
 */
export function applyInjectResultPatch(bundlePath: string): boolean {
  // Check if already patched (idempotent)
  if (checkInjectResultPatched(bundlePath)) {
    return true;
  }
  
  // Read bundle content
  const content = readFileSync(bundlePath, 'utf-8');

  // Insert immediately before the default fallback else block.
  const insertionIndex = content.indexOf(DEFAULT_ELSE_TARGET);

  if (insertionIndex === -1) {
    throw new Error('Could not find default else block for inject_result insertion');
  }

  // Construct the patched content
  const patchedContent =
    content.slice(0, insertionIndex) +
    INJECT_RESULT_CASE +
    '\n' +
    content.slice(insertionIndex);
  
  // Atomic write: write to temp file first, then rename
  const tempDir = mkdtempSync(join(tmpdir(), 'a2a-patch-'));
  const tempFilePath = join(tempDir, 'a2a-server.mjs');
  
  try {
    writeFileSync(tempFilePath, patchedContent, 'utf-8');
    renameSync(tempFilePath, bundlePath);
  } finally {
    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (cleanupError) {
      // Ignore cleanup errors - temp files will be cleaned up by OS
    }
  }
  
  return true;
}
