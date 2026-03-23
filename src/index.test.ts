/**
 * Integration tests for session_start event handler
 * 
 * Verifies that the session_start event triggers schema file write
 * with proper denylist filtering and staleness detection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { Type } from '@sinclair/typebox';
import { join } from 'path';
import { homedir } from 'os';

// Use unique schema path per test file to avoid race conditions
const schemaDir = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider');
const schemaFileName = `test-index-${process.pid}.json`;
const schemaFilePath = join(schemaDir, schemaFileName);

// Mock pi object with getAllTools
function createMockPi(tools: any[] = []) {
  return {
    getAllTools: () => tools,
    on: () => {}, // Will be spied on
  };
}

// Mock context object
function createMockContext() {
  const notifications: { message: string; level: string }[] = [];
  return {
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    },
    notifications,
  };
}

// Sample tools for testing (including denylist tools)
const sampleTools = [
  {
    name: 'read',
    description: 'Read a file',
    parameters: Type.Object({
      path: Type.String(),
    }),
  },
  {
    name: 'write',
    description: 'Write a file',
    parameters: Type.Object({
      path: Type.String(),
      content: Type.String(),
    }),
  },
  {
    name: 'bash',
    description: 'Execute shell command',
    parameters: Type.Object({
      command: Type.String(),
    }),
  },
  // Denylist tools
  {
    name: 'gemini_cli_search',
    description: 'Search the web',
    parameters: Type.Object({
      query: Type.String(),
    }),
  },
  {
    name: 'google_search',
    description: 'Google search',
    parameters: Type.Object({
      query: Type.String(),
    }),
  },
];

describe('session_start handler integration', () => {
  beforeEach(() => {
    // Set unique schema path for this test file to avoid race conditions
    process.env.PI_GEMINI_SCHEMA_PATH = schemaFilePath;
    
    // Clean up schema file before each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
    // Clean up env var
    delete process.env.PI_GEMINI_SCHEMA_PATH;
  });

  it('writes schema file when session_start is triggered', async () => {
    // Import the module to register the handler
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    // Create mock pi with tools
    const mockPi: any = createMockPi(sampleTools);
    
    // Track event registrations
    const registeredHandlers: Record<string, Function> = {};
    mockPi.on = (event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    };
    
    // Initialize extension
    extension(mockPi);
    
    // Verify session_start handler was registered
    expect(registeredHandlers['session_start']).toBeDefined();
    
    // Create mock context
    const mockCtx: any = createMockContext();
    
    // Trigger session_start
    registeredHandlers['session_start']('session_start', mockCtx);
    
    // Verify schema file was created
    expect(existsSync(schemaFilePath)).toBe(true);
    
    // Verify file contains valid JSON
    const content = readFileSync(schemaFilePath, 'utf-8');
    const schemas = JSON.parse(content);
    expect(Array.isArray(schemas)).toBe(true);
    
    // Verify denylist filtering (should have 3 tools: read, write, bash)
    expect(schemas.length).toBe(3);
    const toolNames = schemas.map((s: any) => s.name);
    expect(toolNames).toContain('read');
    expect(toolNames).toContain('write');
    expect(toolNames).toContain('bash');
    expect(toolNames).not.toContain('gemini_cli_search');
    expect(toolNames).not.toContain('google_search');
  });

  it('notifies user only when tool list changes (isStale=true)', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    const registeredHandlers: Record<string, Function> = {};
    mockPi.on = (event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    };
    
    extension(mockPi);
    
    const mockCtx: any = createMockContext();
    
    // First trigger - should notify (file doesn't exist, isStale=true)
    registeredHandlers['session_start']('session_start', mockCtx);
    expect(mockCtx.notifications.length).toBe(1);
    expect(mockCtx.notifications[0].message).toContain('Tool list updated');
    expect(mockCtx.notifications[0].level).toBe('info');
    
    // Second trigger with same tools - should NOT notify (isStale=false)
    mockCtx.notifications = []; // Clear notifications
    registeredHandlers['session_start']('session_start', mockCtx);
    expect(mockCtx.notifications.length).toBe(0);
  });

  it('notifies user when tool list changes between sessions', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    // First session with 3 tools
    const mockPi1: any = createMockPi(sampleTools.slice(0, 3));
    const registeredHandlers1: Record<string, Function> = {};
    mockPi1.on = (event: string, handler: Function) => {
      registeredHandlers1[event] = handler;
    };
    
    extension(mockPi1);
    const mockCtx1: any = createMockContext();
    registeredHandlers1['session_start']('session_start', mockCtx1);
    
    // Verify first session wrote schemas
    expect(existsSync(schemaFilePath)).toBe(true);
    expect(mockCtx1.notifications.length).toBe(1); // First write should notify
    
    // Second session with same tools - no notification
    const mockPi2: any = createMockPi(sampleTools.slice(0, 3));
    const registeredHandlers2: Record<string, Function> = {};
    mockPi2.on = (event: string, handler: Function) => {
      registeredHandlers2[event] = handler;
    };
    extension(mockPi2);
    
    const mockCtx2: any = createMockContext();
    registeredHandlers2['session_start']('session_start', mockCtx2);
    expect(mockCtx2.notifications.length).toBe(0); // Same tools, no notification
    
    // Third session with different tools - should notify
    const mockPi3: any = createMockPi(sampleTools.slice(0, 2)); // Only 2 tools now
    const registeredHandlers3: Record<string, Function> = {};
    mockPi3.on = (event: string, handler: Function) => {
      registeredHandlers3[event] = handler;
    };
    extension(mockPi3);
    
    const mockCtx3: any = createMockContext();
    registeredHandlers3['session_start']('session_start', mockCtx3);
    expect(mockCtx3.notifications.length).toBe(1); // Different tools, should notify
  });

  it('excludes all denylist tools from schema file', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    const registeredHandlers: Record<string, Function> = {};
    mockPi.on = (event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    };
    
    extension(mockPi);
    const mockCtx: any = createMockContext();
    registeredHandlers['session_start']('session_start', mockCtx);
    
    // Read and verify schema file
    const content = readFileSync(schemaFilePath, 'utf-8');
    const schemas = JSON.parse(content);
    
    // Verify no denylist tools present
    const toolNames = schemas.map((s: any) => s.name);
    expect(toolNames).not.toContain('gemini_cli_search');
    expect(toolNames).not.toContain('google_search');
    expect(toolNames).not.toContain('search_the_web');
    expect(toolNames).not.toContain('search-the-web');
    expect(toolNames).not.toContain('search_and_read');
    expect(toolNames).not.toContain('fetch_page');
  });
});
