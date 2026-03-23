/**
 * Approval Flow Module
 * 
 * Classifies pending tool calls as MCP-routed vs native auto-approved,
 * strips mcp_tools_ prefix for user-facing names, and builds the
 * per-call reinjection work list for inject_result().
 * 
 * Pure helpers - no side effects, fixture-driven for testability.
 */

import type {
  ToolCallMetadata,
  ToolRoutingDecision,
  ReinjectionWorkItem,
  ToolResultPayload,
  NativeToolName,
  ExtractedToolResult,
} from './types.js';
import { NATIVE_TOOL_ALLOWLIST } from './types.js';

// ============================================================================
// Tool Routing
// ============================================================================

/**
 * Classifies a tool call as MCP-routed or native auto-approved.
 * 
 * Routing rules:
 * - Native tools: Explicitly allowlisted (google_web_search, web_fetch)
 * - MCP tools: Any tool with mcp_tools_ prefix or not in native allowlist
 * 
 * @param toolCall - Pending tool call metadata
 * @returns ToolRoutingDecision with classification and metadata
 */
export function classifyToolRouting(toolCall: ToolCallMetadata): ToolRoutingDecision {
  const { name } = toolCall;
  
  // Check if native tool (explicit allowlist)
  if (isNativeTool(name)) {
    return {
      toolCall,
      routing: 'native',
      displayName: name,
      autoApprove: true,
      reason: `Native tool '${name}' is auto-approved`,
    };
  }
  
  // Check if MCP tool (mcp_ prefix)
  if (isMcpTool(name)) {
    const displayName = stripMcpPrefix(name);
    return {
      toolCall,
      routing: 'mcp',
      displayName,
      autoApprove: false,
      reason: `MCP tool '${name}' routed for approval (display: '${displayName}')`,
    };
  }
  
  // Unknown tool - default to MCP routing with warning
  const displayName = stripMcpPrefix(name);
  return {
    toolCall,
    routing: 'mcp',
    displayName,
    autoApprove: false,
    reason: `Unknown tool '${name}' defaulted to MCP routing`,
  };
}

/**
 * Checks if a tool name is in the native allowlist.
 * 
 * @param toolName - Tool name to check
 * @returns True if tool is native (auto-approved)
 */
export function isNativeTool(toolName: string): toolName is NativeToolName {
  return NATIVE_TOOL_ALLOWLIST.includes(toolName as NativeToolName);
}

/**
 * Checks if a tool name has the MCP prefix.
 * 
 * @param toolName - Tool name to check
 * @returns True if tool has mcp_ prefix
 */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp_');
}

/**
 * Strips the mcp_ prefix from a tool name for user-facing display.
 * 
 * Examples:
 * - mcp_tools_read → tools_read
 * - mcp_gsd-test_test_echo → gsd-test_test_echo
 * - google_web_search → google_web_search (no change)
 * 
 * @param toolName - Fully qualified tool name
 * @returns User-facing display name
 */
export function stripMcpPrefix(toolName: string): string {
  if (toolName.startsWith('mcp_')) {
    return toolName.slice('mcp_'.length);
  }
  return toolName;
}

/**
 * Adds the mcp_ prefix to a user-facing tool name.
 * 
 * Used when converting user-facing names back to fully qualified names.
 * 
 * @param displayName - User-facing tool name
 * @returns Fully qualified tool name with mcp_ prefix
 */
export function addMcpPrefix(displayName: string): string {
  // Only add prefix if not already present
  if (displayName.startsWith('mcp_')) {
    return displayName;
  }
  return `mcp_${displayName}`;
}

// ============================================================================
// Reinjection Work List
// ============================================================================

/**
 * Builds the reinjection work list from pending tool calls and extracted results.
 * 
 * For each pending tool call:
 * 1. Classify routing (MCP vs native)
 * 2. Find corresponding result from extracted results
 * 3. Build ReinjectionWorkItem with normalized payload
 * 
 * Results are returned in the order of pending tool calls.
 * 
 * @param pendingToolCalls - Tool calls pending injection
 * @param extractedResults - Results extracted from ToolResultMessages
 * @returns Array of ReinjectionWorkItem objects
 */
export function buildReinjectionWorkList(
  pendingToolCalls: ToolCallMetadata[],
  extractedResults: ExtractedToolResult[]
): ReinjectionWorkItem[] {
  const workItems: ReinjectionWorkItem[] = [];
  
  for (const toolCall of pendingToolCalls) {
    // Classify routing
    const routing = classifyToolRouting(toolCall);
    
    // Find corresponding result
    const result = extractedResults.find(r => r.toolCallId === toolCall.callId);
    
    if (!result) {
      // Skip if no result available (should not happen in normal flow)
      continue;
    }
    
    // Build work item
    workItems.push({
      callId: toolCall.callId,
      toolName: routing.displayName,
      args: toolCall.args,
      result: result.payload,
      routing: routing.routing,
    });
  }
  
  return workItems;
}

/**
 * Filters reinjection work items by routing type.
 * 
 * @param workItems - All work items
 * @param routing - Routing type to filter by ('mcp' | 'native')
 * @returns Filtered work items
 */
export function filterWorkItemsByRouting(
  workItems: ReinjectionWorkItem[],
  routing: 'mcp' | 'native'
): ReinjectionWorkItem[] {
  return workItems.filter(item => item.routing === routing);
}

/**
 * Gets all MCP-routed work items.
 * 
 * @param workItems - All work items
 * @returns MCP-routed work items
 */
export function getMcpWorkItems(workItems: ReinjectionWorkItem[]): ReinjectionWorkItem[] {
  return filterWorkItemsByRouting(workItems, 'mcp');
}

/**
 * Gets all native work items.
 * 
 * @param workItems - All work items
 * @returns Native work items
 */
export function getNativeWorkItems(workItems: ReinjectionWorkItem[]): ReinjectionWorkItem[] {
  return filterWorkItemsByRouting(workItems, 'native');
}

// ============================================================================
// Stop Reason Determination
// ============================================================================

/**
 * Determines the appropriate stop reason based on routing decisions.
 * 
 * - If any MCP tool calls are present: return 'toolUse' (requires approval)
 * - If only native tool calls: return undefined (continue streaming)
 * - If no tool calls: return undefined
 * 
 * @param workItems - Reinjection work items
 * @returns Stop reason for pi stream ('toolUse' or undefined)
 */
export function determineStopReason(workItems: ReinjectionWorkItem[]): string | undefined {
  const mcpItems = getMcpWorkItems(workItems);
  
  if (mcpItems.length > 0) {
    return 'toolUse';
  }
  
  return undefined;
}

/**
 * Checks if any tool calls require approval (MCP-routed).
 * 
 * @param workItems - Reinjection work items
 * @returns True if any MCP tool calls are present
 */
export function hasApprovalRequired(workItems: ReinjectionWorkItem[]): boolean {
  return getMcpWorkItems(workItems).length > 0;
}

/**
 * Checks if all tool calls are auto-approved (native only).
 * 
 * @param workItems - Reinjection work items
 * @returns True if all tool calls are native
 */
export function allAutoApproved(workItems: ReinjectionWorkItem[]): boolean {
  if (workItems.length === 0) return false;
  return getNativeWorkItems(workItems).length === workItems.length;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validates that all pending tool calls have corresponding results.
 * 
 * @param pendingToolCalls - Tool calls pending injection
 * @param extractedResults - Results extracted from ToolResultMessages
 * @returns Object with isValid flag and missing callIds
 */
export function validateReinjectionCompleteness(
  pendingToolCalls: ToolCallMetadata[],
  extractedResults: ExtractedToolResult[]
): { isValid: boolean; missingCallIds: string[] } {
  const missingCallIds: string[] = [];
  
  for (const toolCall of pendingToolCalls) {
    const hasResult = extractedResults.some(r => r.toolCallId === toolCall.callId);
    if (!hasResult) {
      missingCallIds.push(toolCall.callId);
    }
  }
  
  return {
    isValid: missingCallIds.length === 0,
    missingCallIds,
  };
}

/**
 * Validates a tool result payload for injection.
 * 
 * Checks:
 * - Payload has required 'name' field
 * - Payload has 'response' field (can be any type)
 * - Response is not undefined
 * 
 * @param payload - Tool result payload to validate
 * @returns Object with isValid flag and error message if invalid
 */
export function validateToolResultPayload(payload: ToolResultPayload): {
  isValid: boolean;
  error?: string;
} {
  if (!payload || typeof payload !== 'object') {
    return { isValid: false, error: 'Payload is not an object' };
  }
  
  if (!('name' in payload) || typeof payload.name !== 'string') {
    return { isValid: false, error: 'Payload missing required "name" field' };
  }
  
  if (!('response' in payload) || payload.response === undefined) {
    return { isValid: false, error: 'Payload missing required "response" field' };
  }
  
  return { isValid: true };
}
