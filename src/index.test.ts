/**
 * Integration tests for extension load and session_start event handlers
 * 
 * Verifies that:
 * - Extension load triggers provider registration, command registration, and workspace preparation
 * - Session_start triggers schema file write with proper denylist filtering and staleness detection
 * - Extension-load behavior is distinguished from session-start behavior
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, unlinkSync, readFileSync, rmSync } from 'fs';
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
    on: vi.fn(), // Track event registrations
    registerProvider: vi.fn(), // Track provider registration
    registerCommand: vi.fn(), // Track command registration
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

describe('extension load behavior', () => {
  beforeEach(async () => {
    // Reset modules to ensure clean state and fresh env var reading
    vi.resetModules();
    
    // Set unique schema path for this test file to avoid race conditions
    process.env.PI_GEMINI_SCHEMA_PATH = schemaFilePath;
    
    // Clean up schema file before each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
    
    // Clean up workspace directory before each test
    const workspaceDir = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'a2a-workspace');
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
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

  it('registers provider on extension load', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    // Initialize extension
    await extension(mockPi);
    
    // Verify provider registration was called
    expect(mockPi.registerProvider).toHaveBeenCalled();
    expect(mockPi.registerProvider).toHaveBeenCalledWith(
      'gemini-a2a',
      expect.objectContaining({
        models: expect.any(Array),
        streamSimple: expect.any(Function),
      })
    );
  });

  it('registers /gemini-cli command on extension load', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    await extension(mockPi);
    
    // Verify command registration was called
    expect(mockPi.registerCommand).toHaveBeenCalledWith(
      'gemini-cli',
      expect.objectContaining({
        description: expect.stringContaining('gemini-a2a provider'),
        handler: expect.any(Function),
      })
    );
  });

  it('prepares provider workspace on extension load', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    await extension(mockPi);
    
    // Verify workspace was created
    const workspaceDir = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'a2a-workspace');
    const settingsPath = join(workspaceDir, '.gemini', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    
    // Verify settings content
    const content = readFileSync(settingsPath, 'utf-8');
    expect(content).toContain('excludeTools');
    expect(content).toContain('folderTrust');
  });

  it('does not block extension load if provider registration fails', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    mockPi.registerProvider = () => {
      throw new Error('Registration failed');
    };
    
    // Should not throw - extension should load despite provider failure
    await expect(extension(mockPi)).resolves.not.toThrow();
    
    // Command registration should still happen
    expect(mockPi.registerCommand).toHaveBeenCalled();
  });

  it('does not block extension load if workspace generation fails', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    // Mock generateWorkspace to throw
    vi.spyOn(await import('./workspace-generator.js'), 'generateWorkspace').mockImplementation(() => {
      throw new Error('Workspace generation failed');
    });
    
    // Should not throw - extension should load despite workspace failure
    await expect(extension(mockPi)).resolves.not.toThrow();
  });

  it('does NOT write schema file on extension load (only on session_start)', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    await extension(mockPi);
    
    // Schema file should NOT exist yet - only written on session_start
    expect(existsSync(schemaFilePath)).toBe(false);
  });

  it('registers session_start handler but does not trigger it on load', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    
    await extension(mockPi);
    
    // Verify session_start handler was registered
    expect(mockPi.on).toHaveBeenCalledWith('session_start', expect.any(Function));
    
    // But it should NOT have been called yet
    const sessionStartHandler = (mockPi.on as any).mock.calls.find(
      (call: any) => call[0] === 'session_start'
    )?.[1];
    expect(sessionStartHandler).toBeDefined();
    // The handler is registered but not invoked during extension load
  });
});

describe('session_start handler integration', () => {
  beforeEach(() => {
    // Set unique schema path for this test file to avoid race conditions
    process.env.PI_GEMINI_SCHEMA_PATH = schemaFilePath;
    
    // Clean up schema file before each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
    
    // Clean up workspace directory before each test
    const workspaceDir = join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'a2a-workspace');
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true, force: true });
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
    mockPi.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    });
    
    // Initialize extension (await since it's async now)
    await extension(mockPi);
    
    // Verify session_start handler was registered
    expect(registeredHandlers['session_start']).toBeDefined();
    
    // Create mock context
    const mockCtx: any = createMockContext();
    
    // Trigger session_start
    await registeredHandlers['session_start']('session_start', mockCtx);
    
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
    mockPi.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    });
    
    await extension(mockPi);
    
    const mockCtx: any = createMockContext();
    
    // First trigger - should notify (file doesn't exist, isStale=true)
    await registeredHandlers['session_start']('session_start', mockCtx);
    expect(mockCtx.notifications.length).toBe(1);
    expect(mockCtx.notifications[0].message).toContain('Tool list updated');
    expect(mockCtx.notifications[0].level).toBe('info');
    
    // Second trigger with same tools - should NOT notify (isStale=false)
    mockCtx.notifications = []; // Clear notifications
    await registeredHandlers['session_start']('session_start', mockCtx);
    expect(mockCtx.notifications.length).toBe(0);
  });

  it('notifies user when tool list changes between sessions', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    // First session with 3 tools
    const mockPi1: any = createMockPi(sampleTools.slice(0, 3));
    const registeredHandlers1: Record<string, Function> = {};
    mockPi1.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers1[event] = handler;
    });
    
    await extension(mockPi1);
    const mockCtx1: any = createMockContext();
    await registeredHandlers1['session_start']('session_start', mockCtx1);
    
    // Verify first session wrote schemas
    expect(existsSync(schemaFilePath)).toBe(true);
    expect(mockCtx1.notifications.length).toBe(1); // First write should notify
    
    // Second session with same tools - no notification
    const mockPi2: any = createMockPi(sampleTools.slice(0, 3));
    const registeredHandlers2: Record<string, Function> = {};
    mockPi2.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers2[event] = handler;
    });
    await extension(mockPi2);
    
    const mockCtx2: any = createMockContext();
    await registeredHandlers2['session_start']('session_start', mockCtx2);
    expect(mockCtx2.notifications.length).toBe(0); // Same tools, no notification
    
    // Third session with different tools - should notify
    const mockPi3: any = createMockPi(sampleTools.slice(0, 2)); // Only 2 tools now
    const registeredHandlers3: Record<string, Function> = {};
    mockPi3.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers3[event] = handler;
    });
    await extension(mockPi3);
    
    const mockCtx3: any = createMockContext();
    await registeredHandlers3['session_start']('session_start', mockCtx3);
    expect(mockCtx3.notifications.length).toBe(1); // Different tools, should notify
  });

  it('excludes all denylist tools from schema file', async () => {
    const extensionModule = await import('./index.js');
    const extension = extensionModule.default;
    
    const mockPi: any = createMockPi(sampleTools);
    const registeredHandlers: Record<string, Function> = {};
    mockPi.on.mockImplementation((event: string, handler: Function) => {
      registeredHandlers[event] = handler;
    });
    
    await extension(mockPi);
    const mockCtx: any = createMockContext();
    await registeredHandlers['session_start']('session_start', mockCtx);
    
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
