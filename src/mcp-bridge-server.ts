#!/usr/bin/env node
/**
 * MCP Bridge Server
 * 
 * Hand-rolled stdio JSON-RPC server exposing GSD tools via MCP protocol.
 * Discovery-only: tools/list returns schemas, tools/call returns error (never invoked).
 * Uses only Node.js built-ins - no @modelcontextprotocol/sdk dependency.
 */

import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';

/**
 * Schema file path - matches tool-schema-writer.ts
 */
const SCHEMA_FILE_PATH = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'tool-schemas.json');

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
 * Returns MCP capabilities with tools support
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
 * No response needed for notifications
 */
function handleInitializedNotification(): null {
  return null;
}

/**
 * Handle tools/list request
 * Reads schema file and returns tools array
 */
function handleToolsList(request: JsonRpcRequest): JsonRpcResponse {
  if (!existsSync(SCHEMA_FILE_PATH)) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      error: {
        code: -32603,
        message: `Schema file not found: ${SCHEMA_FILE_PATH}`,
      },
    };
  }

  try {
    const content = readFileSync(SCHEMA_FILE_PATH, 'utf-8');
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
 * Discovery-only server - always returns error
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
function dispatchRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  switch (request.method) {
    case 'initialize':
      return handleInitialize(request);
    case 'notifications/initialized':
      return handleInitializedNotification();
    case 'tools/list':
      return handleToolsList(request);
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

/**
 * Process a single line from stdin
 */
function processLine(line: string): void {
  if (!line.trim()) {
    return;
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown parse error';
    process.stderr.write(`JSON parse error: ${errorMessage}\n`);
    return;
  }

  const response = dispatchRequest(request);
  
  // Notifications don't return responses
  if (response !== null) {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
}

/**
 * Main entry point
 * Process stdin line-by-line
 */
function main(): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  process.stderr.write('MCP bridge server started on stdio\n');

  rl.on('line', processLine);

  rl.on('close', () => {
    process.stderr.write('MCP bridge server shutting down\n');
  });
}

main();
