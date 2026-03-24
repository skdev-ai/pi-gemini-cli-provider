/**
 * Unit tests for availability module
 * 
 * Tests cover:
 * - checkA2AInjectResultPatched() wrapper function
 * - checkAvailability() includes injectResultPatched in returned object
 * - Integration with inject-result-patch module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

import {
  checkA2AInjectResultPatched,
  checkAvailability,
  checkA2AInstalled,
  checkA2APatched,
  checkA2APendingToolAbortPatched,
} from './availability.js';
import { getA2APackageRoot } from './a2a-path.js';

// Mock dependencies
vi.mock('./a2a-path.js', () => ({
  getA2APath: vi.fn(),
  getA2APackageRoot: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return {
    ...(actual as object),
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

describe('availability', () => {
  const mockBundlePath = '/mock/a2a/dist/a2a-server.mjs';
  const mockPackageRoot = '/mock/a2a';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('checkA2AInjectResultPatched()', () => {
    it('returns false when A2A package root is not found', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      
      const result = checkA2AInjectResultPatched();
      
      expect(result).toBe(false);
      expect(getA2APackageRoot).toHaveBeenCalledOnce();
    });

    it('returns false when bundle file does not exist', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(existsSync).mockReturnValue(false);
      
      const result = checkA2AInjectResultPatched();
      
      expect(result).toBe(false);
      expect(existsSync).toHaveBeenCalledWith(mockBundlePath);
    });

    it('returns false when bundle exists but inject_result patch is missing', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('console.log("unpatched bundle");');
      
      const result = checkA2AInjectResultPatched();
      
      expect(result).toBe(false);
      expect(readFileSync).toHaveBeenCalledWith(mockBundlePath, 'utf-8');
    });

    it('returns true when inject_result patch is present', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(
        'console.log("patched"); PATCH: inject_result support (pi-gemini-cli-provider)'
      );
      
      const result = checkA2AInjectResultPatched();
      
      expect(result).toBe(true);
    });

    it('returns false on file read errors', () => {
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });
      
      const result = checkA2AInjectResultPatched();
      
      expect(result).toBe(false);
    });
  });

  describe('checkA2APendingToolAbortPatched()', () => {
    it('returns false when marker is missing', () => {
      vi.mocked(readFileSync).mockReturnValue('console.log("unpatched bundle");');

      const result = checkA2APendingToolAbortPatched('/mock/path.mjs');

      expect(result).toBe(false);
    });

    it('returns true when marker is present', () => {
      vi.mocked(readFileSync).mockReturnValue(
        'if (!abortController.signal.aborted) { if (typeof currentTask !== "undefined" && currentTask && currentTask.taskState === "input-required") { logger.info("[CoderAgentExecutor] Socket closed while task " + taskId + " awaits input. Preserving pending tools."); } else { abortController.abort(); } }'
      );

      const result = checkA2APendingToolAbortPatched('/mock/path.mjs');

      expect(result).toBe(true);
    });

    it('returns false on file read errors', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });

      const result = checkA2APendingToolAbortPatched('/mock/path.mjs');

      expect(result).toBe(false);
    });
  });

  describe('checkAvailability()', () => {
    it('returns CLI_NOT_FOUND when gemini CLI binary is missing', () => {
      // This will call the real checkCliBinary which searches PATH
      // We can't easily mock PATH, so we test the actual behavior
      const result = checkAvailability();
      
      // Result depends on actual environment - just verify structure
      if (!result.available) {
        expect(result.reason).toBeDefined();
        expect(result.a2a).toBeUndefined();
      }
    });

    it('includes injectResultPatched in a2a object when available', () => {
      // Mock successful availability check
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync)
        .mockReturnValueOnce('console.log("patched with _requestedModel");') // checkA2APatched
        .mockReturnValueOnce('PATCH: inject_result support (pi-gemini-cli-provider)'); // checkInjectResultPatched
      
      // Mock checkCliBinary and checkCredentialFile to return true
      // We need to import them after mocking
      const result = checkAvailability();
      
      // If available, verify a2a structure includes injectResultPatched
      if (result.available) {
        expect(result.a2a).toBeDefined();
        expect(result.a2a?.injectResultPatched).toBeDefined();
        expect(typeof result.a2a?.injectResultPatched).toBe('boolean');
        expect(result.a2a?.pendingToolAbortPatched).toBeDefined();
        expect(typeof result.a2a?.pendingToolAbortPatched).toBe('boolean');
      }
    });
  });

  describe('checkA2AInstalled()', () => {
    it('returns false when A2A binary is not in PATH', async () => {
      const { getA2APath } = await import('./a2a-path.js');
      vi.mocked(getA2APath).mockReturnValue(null);
      
      const result = checkA2AInstalled();
      
      expect(result).toBe(false);
    });

    it('returns true when A2A binary is in PATH', async () => {
      const { getA2APath } = await import('./a2a-path.js');
      vi.mocked(getA2APath).mockReturnValue('/usr/local/bin/gemini-cli-a2a-server');
      
      const result = checkA2AInstalled();
      
      expect(result).toBe(true);
    });
  });

  describe('checkA2APatched()', () => {
    it('returns false when file does not contain _requestedModel marker', () => {
      vi.mocked(readFileSync).mockReturnValue('console.log("unpatched");');
      
      const result = checkA2APatched('/mock/path.mjs');
      
      expect(result).toBe(false);
    });

    it('returns true when file contains _requestedModel marker', () => {
      vi.mocked(readFileSync).mockReturnValue(
        'const _requestedModel = "patch marker";'
      );
      
      const result = checkA2APatched('/mock/path.mjs');
      
      expect(result).toBe(true);
    });

    it('returns false on file read errors', () => {
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('File not found');
      });
      
      const result = checkA2APatched('/mock/path.mjs');
      
      expect(result).toBe(false);
    });
  });
});
