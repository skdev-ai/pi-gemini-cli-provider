/**
 * Approval Flow Tests
 * 
 * Tests for src/approval-flow.ts covering:
 * - Tool routing classification (MCP vs native)
 * - Prefix stripping for user-facing names
 * - Reinjection work list building
 * - Stop reason determination
 * - Multi-tool ordering and edge cases
 */

import { describe, it, expect } from 'vitest';
import {
  classifyToolRouting,
  isNativeTool,
  isMcpTool,
  stripMcpPrefix,
  addMcpPrefix,
  buildReinjectionWorkList,
  filterWorkItemsByRouting,
  getMcpWorkItems,
  getNativeWorkItems,
  determineStopReason,
  hasApprovalRequired,
  allAutoApproved,
  validateReinjectionCompleteness,
  validateToolResultPayload,
} from './approval-flow.js';
import type { ToolCallMetadata, ExtractedToolResult } from './types.js';

// ============================================================================
// Test Fixtures
// ============================================================================

/** MCP tool call fixture */
const mcpToolCall: ToolCallMetadata = {
  callId: 'mcp_tools_read_123',
  name: 'mcp_tools_read',
  args: { path: 'README.md' },
  status: 'success',
};

/** Native tool call fixture (google_web_search) */
const nativeToolCallSearch: ToolCallMetadata = {
  callId: 'google_web_search_456',
  name: 'google_web_search',
  args: { query: 'test query' },
  status: 'success',
};

/** Native tool call fixture (web_fetch) */
const nativeToolCallFetch: ToolCallMetadata = {
  callId: 'web_fetch_789',
  name: 'web_fetch',
  args: { url: 'https://example.com' },
  status: 'success',
};

/** Extracted result fixture for MCP tool */
const mcpResult: ExtractedToolResult = {
  toolCallId: 'mcp_tools_read_123',
  toolName: 'read',
  isError: false,
  payload: {
    name: 'read',
    response: { content: 'file contents' },
  },
};

/** Extracted result fixture for native tool */
const nativeResultSearch: ExtractedToolResult = {
  toolCallId: 'google_web_search_456',
  toolName: 'google_web_search',
  isError: false,
  payload: {
    name: 'google_web_search',
    response: { output: 'Search results here' },
  },
};

/** Extracted result fixture for web_fetch */
const nativeResultFetch: ExtractedToolResult = {
  toolCallId: 'web_fetch_789',
  toolName: 'web_fetch',
  isError: false,
  payload: {
    name: 'web_fetch',
    response: { output: 'Fetched content here' },
  },
};

// ============================================================================
// Tool Routing Classification
// ============================================================================

describe('classifyToolRouting', () => {
  it('should classify MCP tool with prefix stripping', () => {
    const decision = classifyToolRouting(mcpToolCall);

    expect(decision.routing).toBe('mcp');
    expect(decision.displayName).toBe('read');
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toContain('MCP tool');
    expect(decision.reason).toContain('read');
  });

  it('should classify native tool (google_web_search) as auto-approved', () => {
    const decision = classifyToolRouting(nativeToolCallSearch);

    expect(decision.routing).toBe('native');
    expect(decision.displayName).toBe('google_web_search');
    expect(decision.autoApprove).toBe(true);
    expect(decision.reason).toContain('auto-approved');
  });

  it('should classify native tool (web_fetch) as auto-approved', () => {
    const decision = classifyToolRouting(nativeToolCallFetch);

    expect(decision.routing).toBe('native');
    expect(decision.displayName).toBe('web_fetch');
    expect(decision.autoApprove).toBe(true);
  });

  it('should default unknown tools to MCP routing', () => {
    const unknownTool: ToolCallMetadata = {
      callId: 'unknown_tool_123',
      name: 'custom_tool',
      args: {},
      status: 'success',
    };
    const decision = classifyToolRouting(unknownTool);

    expect(decision.routing).toBe('mcp');
    expect(decision.displayName).toBe('custom_tool');
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toContain('defaulted to MCP routing');
  });

  it('should default non-provider-prefixed MCP-like tools to unknown MCP routing without stripping', () => {
    const nestedMcpTool: ToolCallMetadata = {
      callId: 'mcp_gsd-test_test_echo_123',
      name: 'mcp_gsd-test_test_echo',
      args: { message: 'test' },
      status: 'success',
    };
    const decision = classifyToolRouting(nestedMcpTool);

    expect(decision.routing).toBe('mcp');
    expect(decision.displayName).toBe('mcp_gsd-test_test_echo');
    expect(decision.autoApprove).toBe(false);
    expect(decision.reason).toContain('defaulted to MCP routing');
  });
});

describe('isNativeTool', () => {
  it('should return true for google_web_search', () => {
    expect(isNativeTool('google_web_search')).toBe(true);
  });

  it('should return true for web_fetch', () => {
    expect(isNativeTool('web_fetch')).toBe(true);
  });

  it('should return false for MCP tools', () => {
    expect(isNativeTool('mcp_tools_read')).toBe(false);
    expect(isNativeTool('mcp_gsd-test_test_echo')).toBe(false);
  });

  it('should return false for unknown tools', () => {
    expect(isNativeTool('custom_tool')).toBe(false);
  });
});

describe('isMcpTool', () => {
  it('should return true only for mcp_tools_ prefix', () => {
    expect(isMcpTool('mcp_tools_read')).toBe(true);
    expect(isMcpTool('mcp_tools_write')).toBe(true);
  });

  it('should return false for native tools', () => {
    expect(isMcpTool('google_web_search')).toBe(false);
    expect(isMcpTool('web_fetch')).toBe(false);
  });

  it('should return false for tools without provider MCP prefix', () => {
    expect(isMcpTool('custom_tool')).toBe(false);
    expect(isMcpTool('mcp_gsd-test_test_echo')).toBe(false);
  });
});

describe('stripMcpPrefix', () => {
  it('should strip mcp_tools_ prefix', () => {
    expect(stripMcpPrefix('mcp_tools_read')).toBe('read');
    expect(stripMcpPrefix('mcp_tools_write')).toBe('write');
  });

  it('should not strip non-provider MCP-like names', () => {
    expect(stripMcpPrefix('mcp_gsd-test_test_echo')).toBe('mcp_gsd-test_test_echo');
  });

  it('should not modify native tool names', () => {
    expect(stripMcpPrefix('google_web_search')).toBe('google_web_search');
    expect(stripMcpPrefix('web_fetch')).toBe('web_fetch');
  });

  it('should not modify unknown tool names', () => {
    expect(stripMcpPrefix('custom_tool')).toBe('custom_tool');
  });
});

describe('addMcpPrefix', () => {
  it('should add mcp_tools_ prefix to plain name', () => {
    expect(addMcpPrefix('read')).toBe('mcp_tools_read');
    expect(addMcpPrefix('write')).toBe('mcp_tools_write');
  });

  it('should not double-prefix already prefixed names', () => {
    expect(addMcpPrefix('mcp_tools_read')).toBe('mcp_tools_read');
  });

  it('should prefix other display names with provider MCP prefix', () => {
    expect(addMcpPrefix('gsd-test_test_echo')).toBe('mcp_tools_gsd-test_test_echo');
  });
});

// ============================================================================
// Reinjection Work List
// ============================================================================

describe('buildReinjectionWorkList', () => {
  it('should build work list for single MCP tool using full protocol name', () => {
    const workItems = buildReinjectionWorkList([mcpToolCall], [mcpResult]);

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toEqual({
      callId: 'mcp_tools_read_123',
      toolName: 'mcp_tools_read',
      args: { path: 'README.md' },
      result: mcpResult.payload,
      routing: 'mcp',
    });
  });

  it('should preserve full MCP protocol name even when display name is stripped for UI', () => {
    const workItems = buildReinjectionWorkList([mcpToolCall], [mcpResult]);
    const routing = classifyToolRouting(mcpToolCall);

    expect(routing.displayName).toBe('read');
    expect(workItems[0]?.toolName).toBe('mcp_tools_read');
  });

  it('should build work list for single native tool', () => {
    const workItems = buildReinjectionWorkList(
      [nativeToolCallSearch],
      [nativeResultSearch]
    );

    expect(workItems).toHaveLength(1);
    expect(workItems[0]).toEqual({
      callId: 'google_web_search_456',
      toolName: 'google_web_search',
      args: { query: 'test query' },
      result: nativeResultSearch.payload,
      routing: 'native',
    });
  });

  it('should build work list for mixed MCP and native tools', () => {
    const toolCalls = [mcpToolCall, nativeToolCallSearch];
    const results = [mcpResult, nativeResultSearch];

    const workItems = buildReinjectionWorkList(toolCalls, results);

    expect(workItems).toHaveLength(2);
    expect(workItems[0].routing).toBe('mcp');
    expect(workItems[1].routing).toBe('native');
  });

  it('should preserve order of pending tool calls', () => {
    const toolCalls = [nativeToolCallFetch, mcpToolCall, nativeToolCallSearch];
    const results = [nativeResultFetch, mcpResult, nativeResultSearch];

    const workItems = buildReinjectionWorkList(toolCalls, results);

    expect(workItems.map(w => w.callId)).toEqual([
      'web_fetch_789',
      'mcp_tools_read_123',
      'google_web_search_456',
    ]);
  });

  it('should skip tool calls without corresponding results', () => {
    const toolCalls = [mcpToolCall, nativeToolCallSearch];
    const results = [mcpResult];

    const workItems = buildReinjectionWorkList(toolCalls, results);

    expect(workItems).toHaveLength(1);
    expect(workItems[0].callId).toBe('mcp_tools_read_123');
  });

  it('should handle empty tool calls', () => {
    const workItems = buildReinjectionWorkList([], []);
    expect(workItems).toHaveLength(0);
  });
});

describe('filterWorkItemsByRouting', () => {
  const mixedWorkItems = [
    {
      callId: 'call_1',
      toolName: 'read',
      args: {},
      result: { name: 'read', response: {} },
      routing: 'mcp' as const,
    },
    {
      callId: 'call_2',
      toolName: 'google_web_search',
      args: {},
      result: { name: 'google_web_search', response: {} },
      routing: 'native' as const,
    },
  ];

  it('should filter to MCP items only', () => {
    const mcpItems = filterWorkItemsByRouting(mixedWorkItems, 'mcp');
    expect(mcpItems).toHaveLength(1);
    expect(mcpItems[0].callId).toBe('call_1');
  });

  it('should filter to native items only', () => {
    const nativeItems = filterWorkItemsByRouting(mixedWorkItems, 'native');
    expect(nativeItems).toHaveLength(1);
    expect(nativeItems[0].callId).toBe('call_2');
  });
});

describe('getMcpWorkItems', () => {
  it('should return only MCP-routed items', () => {
    const mixedWorkItems: Array<{
      callId: string;
      toolName: string;
      args: unknown;
      result: { name: string; response: unknown };
      routing: 'mcp' | 'native';
    }> = [
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp',
      },
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native',
      },
    ];

    const mcpItems = getMcpWorkItems(mixedWorkItems);
    expect(mcpItems).toHaveLength(1);
    expect(mcpItems[0].routing).toBe('mcp');
  });
});

describe('getNativeWorkItems', () => {
  it('should return only native-routed items', () => {
    const mixedWorkItems: Array<{
      callId: string;
      toolName: string;
      args: unknown;
      result: { name: string; response: unknown };
      routing: 'mcp' | 'native';
    }> = [
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp',
      },
      {
        callId: 'native_1',
        toolName: 'web_fetch',
        args: {},
        result: { name: 'web_fetch', response: {} },
        routing: 'native',
      },
    ];

    const nativeItems = getNativeWorkItems(mixedWorkItems);
    expect(nativeItems).toHaveLength(1);
    expect(nativeItems[0].routing).toBe('native');
  });
});

// ============================================================================
// Stop Reason Determination
// ============================================================================

describe('determineStopReason', () => {
  it('should return toolUse for MCP tools', () => {
    const mcpWorkItems = [
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp' as const,
      },
    ];

    expect(determineStopReason(mcpWorkItems)).toBe('toolUse');
  });

  it('should return undefined for native-only tools', () => {
    const nativeWorkItems = [
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native' as const,
      },
    ];

    expect(determineStopReason(nativeWorkItems)).toBeUndefined();
  });

  it('should return undefined for empty work items', () => {
    expect(determineStopReason([])).toBeUndefined();
  });

  it('should return toolUse for mixed MCP and native tools', () => {
    const mixedWorkItems = [
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native' as const,
      },
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp' as const,
      },
    ];

    expect(determineStopReason(mixedWorkItems)).toBe('toolUse');
  });
});

describe('hasApprovalRequired', () => {
  it('should return true when MCP tools are present', () => {
    const workItems = [
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp' as const,
      },
    ];

    expect(hasApprovalRequired(workItems)).toBe(true);
  });

  it('should return false when only native tools are present', () => {
    const workItems = [
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native' as const,
      },
    ];

    expect(hasApprovalRequired(workItems)).toBe(false);
  });

  it('should return false for empty work items', () => {
    expect(hasApprovalRequired([])).toBe(false);
  });
});

describe('allAutoApproved', () => {
  it('should return true when all tools are native', () => {
    const workItems = [
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native' as const,
      },
      {
        callId: 'native_2',
        toolName: 'web_fetch',
        args: {},
        result: { name: 'web_fetch', response: {} },
        routing: 'native' as const,
      },
    ];

    expect(allAutoApproved(workItems)).toBe(true);
  });

  it('should return false when any MCP tools are present', () => {
    const workItems = [
      {
        callId: 'native_1',
        toolName: 'google_web_search',
        args: {},
        result: { name: 'google_web_search', response: {} },
        routing: 'native' as const,
      },
      {
        callId: 'mcp_1',
        toolName: 'read',
        args: {},
        result: { name: 'read', response: {} },
        routing: 'mcp' as const,
      },
    ];

    expect(allAutoApproved(workItems)).toBe(false);
  });

  it('should return false for empty work items', () => {
    expect(allAutoApproved([])).toBe(false);
  });
});

// ============================================================================
// Validation
// ============================================================================

describe('validateReinjectionCompleteness', () => {
  it('should return valid when all tool calls have results', () => {
    const toolCalls = [mcpToolCall, nativeToolCallSearch];
    const results = [mcpResult, nativeResultSearch];

    const validation = validateReinjectionCompleteness(toolCalls, results);

    expect(validation.isValid).toBe(true);
    expect(validation.missingCallIds).toHaveLength(0);
  });

  it('should return invalid with missing callIds', () => {
    const toolCalls = [mcpToolCall, nativeToolCallSearch];
    const results = [mcpResult];

    const validation = validateReinjectionCompleteness(toolCalls, results);

    expect(validation.isValid).toBe(false);
    expect(validation.missingCallIds).toEqual(['google_web_search_456']);
  });

  it('should handle empty tool calls', () => {
    const validation = validateReinjectionCompleteness([], []);
    expect(validation.isValid).toBe(true);
  });
});

describe('validateToolResultPayload', () => {
  it('should return valid for well-formed payload', () => {
    const payload = {
      name: 'read',
      response: { content: 'file contents' },
    };

    const validation = validateToolResultPayload(payload);

    expect(validation.isValid).toBe(true);
    expect(validation.error).toBeUndefined();
  });

  it('should return invalid for missing name field', () => {
    const payload = {
      response: { output: 'echo result' },
    };

    const validation = validateToolResultPayload(payload as any);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('name');
  });

  it('should return invalid for missing response field', () => {
    const payload = {
      name: 'read',
    };

    const validation = validateToolResultPayload(payload as any);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('response');
  });

  it('should return invalid for undefined response', () => {
    const payload = {
      name: 'read',
      response: undefined,
    };

    const validation = validateToolResultPayload(payload as any);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('response');
  });

  it('should return invalid for non-object payload', () => {
    const validation = validateToolResultPayload('string' as any);

    expect(validation.isValid).toBe(false);
    expect(validation.error).toContain('object');
  });
});

// ============================================================================
// Edge Cases and Unsupported Events
// ============================================================================

describe('edge cases', () => {
  it('should handle tool call with empty args', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'mcp_tools_read_123',
      name: 'mcp_tools_read',
      args: {},
      status: 'success',
    };

    const decision = classifyToolRouting(toolCall);
    expect(decision.routing).toBe('mcp');
    expect(decision.displayName).toBe('read');
  });

  it('should handle result with complex response payload', () => {
    const complexResult: ExtractedToolResult = {
      toolCallId: 'test_123',
      toolName: 'read',
      isError: false,
      payload: {
        name: 'read',
        response: {
          output: 'text',
          metadata: { size: 1024, type: 'file' },
          nested: { deep: { value: 42 } },
        },
      },
    };

    const validation = validateToolResultPayload(complexResult.payload);
    expect(validation.isValid).toBe(true);
  });

  it('should leave non-provider MCP-like tool names unchanged', () => {
    const toolCall: ToolCallMetadata = {
      callId: 'test_123',
      name: 'mcp_fake_tool',
      args: {},
      status: 'success',
    };

    const decision = classifyToolRouting(toolCall);
    expect(decision.routing).toBe('mcp');
    expect(decision.displayName).toBe('mcp_fake_tool');
    expect(decision.reason).toContain('defaulted to MCP routing');
  });
});
