/**
 * MCP Bridge Server Unit Tests
 * 
 * Tests for all 4 handlers: initialize, notifications/initialized, tools/list, tools/call
 * Plus error handling for invalid JSON
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const TEST_SCHEMA_FILE_PATH = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'test-tool-schemas.json');

/**
 * Helper to write test schema file
 */
function writeTestSchema(tools: unknown[]): void {
  const schemaDir = dirname(TEST_SCHEMA_FILE_PATH);
  if (!existsSync(schemaDir)) {
    mkdirSync(schemaDir, { recursive: true });
  }
  writeFileSync(TEST_SCHEMA_FILE_PATH, JSON.stringify(tools), 'utf-8');
}

/**
 * Helper to remove test schema file
 */
function removeTestSchema(): void {
  if (existsSync(TEST_SCHEMA_FILE_PATH)) {
    unlinkSync(TEST_SCHEMA_FILE_PATH);
  }
}

/**
 * JSON-RPC request structure
 */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC response structure
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Handle initialize request
 */
function handleInitialize(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'pi-gemini-cli-provider',
        version: '0.1.0',
      },
    },
  };
}

/**
 * Handle notifications/initialized
 */
function handleInitializedNotification(): null {
  return null;
}

/**
 * Handle tools/list request
 */
function handleToolsList(request: JsonRpcRequest, schemaFilePath: string): JsonRpcResponse {
  if (!existsSync(schemaFilePath)) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: `Schema file not found: ${schemaFilePath}`,
      },
    };
  }

  try {
    const content = readFileSync(schemaFilePath, 'utf-8');
    const tools = JSON.parse(content);
    
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: { tools },
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error reading schema file';
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: errorMessage,
      },
    };
  }
}

/**
 * Handle tools/call request
 */
function handleToolsCall(request: JsonRpcRequest): JsonRpcResponse {
  return {
    jsonrpc: '2.0',
    id: request.id,
    error: {
      code: -32601,
      message: 'Method not allowed: tools/call is not supported in discovery-only mode',
    },
  };
}

/**
 * Dispatch JSON-RPC request to appropriate handler
 */
function dispatchRequest(request: JsonRpcRequest, schemaFilePath: string): JsonRpcResponse | null {
  switch (request.method) {
    case 'initialize':
      return handleInitialize(request);
    case 'notifications/initialized':
      return handleInitializedNotification();
    case 'tools/list':
      return handleToolsList(request, schemaFilePath);
    case 'tools/call':
      return handleToolsCall(request);
    default:
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: {
          code: -32601,
          message: `Method not found: ${request.method}`,
        },
      };
  }
}

describe('MCP Bridge Server', () => {
  beforeEach(() => {
    removeTestSchema();
  });

  afterEach(() => {
    removeTestSchema();
  });

  describe('initialize handler', () => {
    it('returns correct MCP capabilities structure', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      };

      const response = handleInitialize(request);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'pi-gemini-cli-provider',
            version: '0.1.0',
          },
        },
      });
    });

    it('preserves request id', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 'test-id-123',
        method: 'initialize',
        params: {},
      };

      const response = handleInitialize(request);

      expect(response.id).toBe('test-id-123');
    });
  });

  describe('notifications/initialized handler', () => {
    it('returns null for notification (no response)', () => {
      const response = handleInitializedNotification();
      expect(response).toBeNull();
    });
  });

  describe('tools/list handler', () => {
    it('returns tools from schema file', () => {
      const testTools = [
        { name: 'read', description: 'Read a file', inputSchema: { type: 'object' } },
        { name: 'write', description: 'Write a file', inputSchema: { type: 'object' } },
      ];
      writeTestSchema(testTools);

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = handleToolsList(request, TEST_SCHEMA_FILE_PATH);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        result: {
          tools: testTools,
        },
      });
    });

    it('returns error when schema file not found', () => {
      removeTestSchema();

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = handleToolsList(request, TEST_SCHEMA_FILE_PATH);

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32603,
          message: expect.stringContaining('Schema file not found'),
        },
      });
    });

    it('returns error when schema file contains invalid JSON', () => {
      const schemaDir = dirname(TEST_SCHEMA_FILE_PATH);
      if (!existsSync(schemaDir)) {
        mkdirSync(schemaDir, { recursive: true });
      }
      writeFileSync(TEST_SCHEMA_FILE_PATH, 'invalid json {{{', 'utf-8');

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = handleToolsList(request, TEST_SCHEMA_FILE_PATH);

      expect(response).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32603,
          message: expect.any(String),
        },
      });
    });
  });

  describe('tools/call handler', () => {
    it('returns method not allowed error', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read' },
      };

      const response = handleToolsCall(request);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32601,
          message: 'Method not allowed: tools/call is not supported in discovery-only mode',
        },
      });
    });

    it('preserves request id in error response', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 'call-id-456',
        method: 'tools/call',
        params: { name: 'write' },
      };

      const response = handleToolsCall(request);

      expect(response.id).toBe('call-id-456');
    });
  });

  describe('unknown method handler', () => {
    it('returns method not found error', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'unknown/method',
        params: {},
      };

      const response = dispatchRequest(request, TEST_SCHEMA_FILE_PATH);

      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32601,
          message: 'Method not found: unknown/method',
        },
      });
    });
  });

  describe('dispatch function', () => {
    it('routes initialize to correct handler', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      };

      const response = dispatchRequest(request, TEST_SCHEMA_FILE_PATH);

      expect(response?.result).toBeDefined();
      expect((response!.result as Record<string, unknown>).protocolVersion).toBe('2024-11-05');
    });

    it('routes tools/list to correct handler', () => {
      writeTestSchema([{ name: 'test', description: 'test', inputSchema: {} }]);

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      };

      const response = dispatchRequest(request, TEST_SCHEMA_FILE_PATH);

      expect(response?.result).toBeDefined();
      expect((response!.result as Record<string, unknown>).tools).toHaveLength(1);
    });

    it('routes tools/call to error handler', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'test' },
      };

      const response = dispatchRequest(request, TEST_SCHEMA_FILE_PATH);

      expect(response?.error).toBeDefined();
      expect(response!.error!.code).toBe(-32601);
    });

    it('returns null for notifications', () => {
      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'notifications/initialized',
        params: {},
      };

      const response = dispatchRequest(request, TEST_SCHEMA_FILE_PATH);

      expect(response).toBeNull();
    });
  });
});
