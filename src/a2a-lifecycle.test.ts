/**
 * Unit tests for A2A lifecycle inject_result patch verification
 * 
 * Tests cover:
 * - startServer() throws A2A_INJECT_RESULT_NOT_PATCHED when patch missing
 * - startServer() proceeds when patch is present
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChildProcess } from 'node:child_process';

import {
  startServer,
  stopServer,
  __testing__,
} from './a2a-lifecycle.js';
import { checkA2AInjectResultPatched, checkA2APendingToolAbortPatched } from './availability.js';
import { getA2APackageRoot } from './a2a-path.js';
import { isPortInUse, isServerHealthy } from './port-check.js';

// Mock dependencies
vi.mock('./availability.js', () => ({
  checkA2APatched: vi.fn(),
  checkA2AInjectResultPatched: vi.fn(),
  checkA2APendingToolAbortPatched: vi.fn(),
}));

vi.mock('./a2a-path.js', () => ({
  getA2APackageRoot: vi.fn(),
}));

vi.mock('./port-check.js', () => ({
  isPortInUse: vi.fn(),
  isServerHealthy: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
}));

describe('a2a-lifecycle inject_result patch verification', () => {
  const mockPackageRoot = '/mock/a2a';
  const mockServerPath = '/mock/a2a/dist/a2a-server.mjs';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Reset internal state
    __testing__.setState({
      status: 'idle',
      port: 42,
      uptime: null,
      searchCount: 0,
      providerTaskCount: 0,
      lastError: null,
      exitCode: null,
      stdoutBuffer: [],
      stderrBuffer: [],
    });
    __testing__.setChildProcess(null);
    __testing__.setStartTime(null);
    __testing__.setStartupPromise(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    
    // Clean up any running server
    try {
      await stopServer();
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('startServer() patch verification', () => {
    it('throws A2A_INJECT_RESULT_NOT_PATCHED when inject_result patch is missing', async () => {
      // Mock port check to indicate no existing server
      vi.mocked(isPortInUse).mockResolvedValue(false);
      vi.mocked(isServerHealthy).mockResolvedValue(false);
      
      // Mock package root
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      
      // Mock _requestedModel patch as present
      const { checkA2APatched } = await import('./availability.js');
      vi.mocked(checkA2APatched).mockReturnValue(true);
      
      // Mock inject_result patch as missing
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
      vi.mocked(checkA2APendingToolAbortPatched).mockReturnValue(true);
      
      // Attempt to start server - should throw
      await expect(startServer()).rejects.toThrowError('inject_result patch not found in A2A bundle');
      
      const error = await startServer().catch((e) => e);
      expect(error).toBeDefined();
      expect(error.type).toBe('A2A_INJECT_RESULT_NOT_PATCHED');
      expect(error.message).toBe('inject_result patch not found in A2A bundle');
    });

    it('throws A2A_NOT_PATCHED when _requestedModel patch is missing', async () => {
      // Mock port check to indicate no existing server
      vi.mocked(isPortInUse).mockResolvedValue(false);
      vi.mocked(isServerHealthy).mockResolvedValue(false);
      
      // Mock package root
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      
      // Mock _requestedModel patch as missing
      const { checkA2APatched } = await import('./availability.js');
      vi.mocked(checkA2APatched).mockReturnValue(false);
      
      // Mock inject_result patch (shouldn't be called due to short-circuit)
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
      vi.mocked(checkA2APendingToolAbortPatched).mockReturnValue(false);
      
      // Attempt to start server - should throw
      await expect(startServer()).rejects.toThrowError('A2A patch not found');
      
      const error = await startServer().catch((e) => e);
      expect(error).toBeDefined();
      expect(error.type).toBe('A2A_NOT_PATCHED');
    });

    it('proceeds with startup when all required patches are present', async () => {
      // Mock port check to indicate no existing server
      vi.mocked(isPortInUse).mockResolvedValue(false);
      vi.mocked(isServerHealthy).mockResolvedValue(false);
      
      // Mock package root
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      
      // Mock all required patches as present
      const { checkA2APatched } = await import('./availability.js');
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(checkA2APendingToolAbortPatched).mockReturnValue(true);
      
      // Mock spawn to create a fake child process
      const mockStdout = {
        on: vi.fn(),
      };
      
      const mockChildProcess = {
        stdout: mockStdout,
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
        pid: 12345,
      } as unknown as ChildProcess;
      
      const { spawn } = await import('node:child_process');
      vi.mocked(spawn).mockReturnValue(mockChildProcess);
      
      // Simulate ready marker being emitted
      setTimeout(() => {
        const dataCall = mockStdout.on.mock.calls.find((call) => call[0] === 'data');
        if (dataCall && dataCall[1]) {
          dataCall[1](Buffer.from('Agent Server started\n'));
        }
      }, 10);
      
      // Should resolve without throwing
      await expect(startServer()).resolves.toBeUndefined();
      
      // Verify spawn was called
      expect(spawn).toHaveBeenCalledWith(
        'node',
        [mockServerPath],
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      );
    });

    it('checks inject_result patch after _requestedModel patch', async () => {
      // Mock port check to indicate no existing server
      vi.mocked(isPortInUse).mockResolvedValue(false);
      vi.mocked(isServerHealthy).mockResolvedValue(false);
      
      // Mock package root
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      
      // Import and mock _requestedModel patch as present
      const availability = await import('./availability.js');
      const checkA2APatchedMock = vi.mocked(availability.checkA2APatched);
      const checkA2AInjectResultPatchedMock = vi.mocked(availability.checkA2AInjectResultPatched);
      checkA2APatchedMock.mockReturnValue(true);
      checkA2AInjectResultPatchedMock.mockReturnValue(false);
      
      // Attempt to start server
      await startServer().catch(() => {});
      
      // Verify both checks were called
      expect(checkA2APatchedMock).toHaveBeenCalled();
      expect(checkA2AInjectResultPatchedMock).toHaveBeenCalled();
      
      // Verify order by checking call indices
      const patchCallIndex = checkA2APatchedMock.mock.invocationCallOrder[0];
      const injectCallIndex = checkA2AInjectResultPatchedMock.mock.invocationCallOrder[0];
      expect(patchCallIndex).toBeLessThan(injectCallIndex);
    });
  });

  describe('checkA2AInjectResultPatched integration', () => {
    it('is imported from availability module', async () => {
      // Verify the function is exported and callable
      expect(typeof checkA2AInjectResultPatched).toBe('function');
    });

    it('returns boolean value', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      
      const result = checkA2AInjectResultPatched();
      
      expect(typeof result).toBe('boolean');
    });
  });
});
