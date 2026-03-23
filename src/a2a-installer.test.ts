/**
 * Unit tests for A2A installer
 * 
 * Tests cover:
 * - Pre-check phase (prerequisites, idempotency)
 * - Approval phase (user confirmation)
 * - Installation phase (npm install, workspace creation)
 * - Patch application (Patch 2 and Patch 3)
 * - Verification phase (patch validation)
 * - Error handling (permission denied, network errors, patch failures)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { installA2AServer, type InstallerContext, A2AInstallationError } from './a2a-installer.js';
import { getA2APath, getA2APackageRoot } from './a2a-path.js';
import { checkA2AInstalled, checkA2APatched, checkA2AInjectResultPatched } from './availability.js';
import { applyInjectResultPatch, checkInjectResultPatched } from './inject-result-patch.js';

// Mock dependencies
vi.mock('./availability.js', () => ({
  checkA2AInstalled: vi.fn(),
  checkA2APatched: vi.fn(),
  checkA2AInjectResultPatched: vi.fn(),
}));

vi.mock('./a2a-path.js', () => ({
  getA2APath: vi.fn(),
  getA2APackageRoot: vi.fn(),
}));

vi.mock('./inject-result-patch.js', () => ({
  checkInjectResultPatched: vi.fn(),
  applyInjectResultPatch: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('a2a-installer', () => {
  const mockInstallerContext: InstallerContext = {
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(),
    },
  };

  const mockPackageRoot = '/mock/a2a';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Default mocks
    vi.mocked(getA2APath).mockReturnValue(null);
    vi.mocked(getA2APackageRoot).mockReturnValue(null);
    vi.mocked(checkA2AInstalled).mockReturnValue(false);
    vi.mocked(checkA2APatched).mockReturnValue(false);
    vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
    vi.mocked(checkInjectResultPatched).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('preCheck phase', () => {
    it('throws when Gemini CLI binary is not installed', async () => {
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command not found: gemini');
      });

      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow(A2AInstallationError);
      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow('Gemini CLI not installed');
      
      const notifyCalls = vi.mocked(mockInstallerContext.ui.notify).mock.calls;
      expect(notifyCalls[0][0]).toContain('Checking prerequisites');
    });

    it('throws when OAuth credentials are missing', async () => {
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      vi.mocked(existsSync).mockReturnValue(false);

      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow(A2AInstallationError);
      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow('Not authenticated');
    });

    it('returns false when already installed and patched (idempotent)', async () => {
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(getA2APath).mockReturnValue('/usr/bin/gemini-cli-a2a-server');
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(checkA2AInstalled).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);

      const result = await installA2AServer(mockInstallerContext);

      expect(result).toBe(true);
      expect(mockInstallerContext.ui.notify).toHaveBeenCalledWith('A2A already installed and patched with Patch 2 and Patch 3');
    });

    it('returns true when Patch 2 is present but Patch 3 is missing', async () => {
      const { execSync } = await import('node:child_process');
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(getA2APath).mockReturnValue('/usr/bin/gemini-cli-a2a-server');
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(checkA2AInstalled).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);

      // Mock approval
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockReturnValueOnce('/usr/bin/gemini'); // Re-mock for preCheck

      const result = await installA2AServer(mockInstallerContext);

      expect(result).toBe(true);
    });
  });

  describe('installation flow', () => {
    const setupPrerequisites = () => {
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(getA2APath).mockReturnValue(null); // Not installed yet
      vi.mocked(checkA2AInstalled).mockReturnValue(false);
    };

    it('installs A2A binary, creates workspace, and applies patches', async () => {
      setupPrerequisites();
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('npm install')) {
          return ''; // Success
        }
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);

      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(writeFileSync).mockReturnValue(undefined);
      vi.mocked(applyInjectResultPatch).mockReturnValue(true);

      // Mock readFileSync for patch application
      let mockFileContent = 'const currentTask = wrapper.task;';
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr.includes('a2a-server.mjs')) {
          return mockFileContent;
        }
        return '';
      });

      // Mock writeFileSync to capture patched content
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().includes('a2a-server.mjs') && !path.toString().includes('.bak')) {
          mockFileContent = content.toString();
        }
      });

      const result = await installA2AServer(mockInstallerContext);

      expect(result).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('npm install -g @google/gemini-cli-a2a-server@0.34.0', { stdio: 'pipe' });
      expect(mockInstallerContext.ui.notify).toHaveBeenCalledWith('A2A server installation complete!');
    });

    it('throws A2AInstallationError on permission denied', async () => {
      setupPrerequisites();
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementationOnce((cmd: string) => {
        if (cmd.includes('npm install')) {
          const error = new Error('EACCES: permission denied');
          (error as any).code = 'EACCES';
          throw error;
        }
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);

      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow(A2AInstallationError);
      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow('Permission denied');
    });

    it('throws A2AInstallationError on network error', async () => {
      setupPrerequisites();
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementationOnce((cmd: string) => {
        if (cmd.includes('npm install')) {
          const error = new Error('ENOTFOUND: network error');
          (error as any).code = 'ENOTFOUND';
          throw error;
        }
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);

      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow(A2AInstallationError);
      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow('Network error');
    });

    it('returns false when user cancels approval', async () => {
      setupPrerequisites();
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(false);

      const result = await installA2AServer(mockInstallerContext);

      expect(result).toBe(false);
      expect(mockInstallerContext.ui.notify).toHaveBeenCalledWith('Installation cancelled by user');
    });
  });

  describe('patch application', () => {
    const setupPrerequisites = () => {
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(getA2APath).mockReturnValue(null);
      vi.mocked(checkA2AInstalled).mockReturnValue(false);
    };

    it('applies Patch 2 (_requestedModel) and Patch 3 (inject_result)', async () => {
      setupPrerequisites();
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('npm install')) return '';
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);

      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(writeFileSync).mockReturnValue(undefined);
      
      const mockApplyPatch = vi.fn().mockReturnValue(true);
      vi.mocked(applyInjectResultPatch).mockImplementation(mockApplyPatch);

      // Mock file content - return patched content after write
      let mockFileContent = 'const currentTask = wrapper.task;';
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr.includes('a2a-server.mjs') && !pathStr.includes('.bak')) {
          return mockFileContent;
        }
        return '';
      });
      
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().includes('a2a-server.mjs') && !path.toString().includes('.bak')) {
          mockFileContent = content.toString();
        }
      });

      await installA2AServer(mockInstallerContext);

      // Verify writeFileSync was called for patches
      expect(writeFileSync).toHaveBeenCalled();

      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      
      // Mock already patched content
      const patchedContent = 'const currentTask = wrapper.task; const _requestedModel = userMessage.metadata?._model; PATCH: inject_result support';
      vi.mocked(readFileSync).mockReturnValue(patchedContent);

      await installA2AServer(mockInstallerContext);

      expect(mockInstallerContext.ui.notify).toHaveBeenCalledWith('Already patched with Patch 2 and Patch 3, skipping patch application');
    });
  });

  describe('verification phase', () => {
    it('verifies both patches are present', async () => {
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('npm install')) return '';
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);
      
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(writeFileSync).mockReturnValue(undefined);
      
      const mockApplyPatch = vi.fn().mockReturnValue(true);
      vi.mocked(applyInjectResultPatch).mockImplementation(mockApplyPatch);

      // Mock patched content
      const patchedContent = 'const currentTask = wrapper.task; const _requestedModel = userMessage.metadata?._model; PATCH: inject_result support';
      vi.mocked(readFileSync).mockReturnValue(patchedContent);

      await installA2AServer(mockInstallerContext);

      expect(mockInstallerContext.ui.notify).toHaveBeenCalledWith('Patches applied and verified successfully');
    });

    it('restores backup when verification fails', async () => {
      vi.mocked(existsSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        return pathStr.includes('oauth_creds.json') || pathStr.includes('.bak');
      });
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('npm install')) return '';
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);
      
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      
      const mockApplyPatch = vi.fn().mockReturnValue(true);
      vi.mocked(applyInjectResultPatch).mockImplementation(mockApplyPatch);

      // Mock content missing Patch 3
      const incompleteContent = 'const currentTask = wrapper.task; const _requestedModel = userMessage.metadata?._model;';
      vi.mocked(readFileSync).mockReturnValue(incompleteContent);

      await expect(installA2AServer(mockInstallerContext)).rejects.toThrow('inject_result support not applied');
      
      // Verify backup was restored
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.bak'),
        expect.any(String),
        'utf-8'
      );
    });
  });

  describe('workspace creation', () => {
    it('creates provider workspace with MCP server config', async () => {
      vi.mocked(existsSync).mockImplementation((path: any) => {
        return path.toString().includes('oauth_creds.json');
      });
      vi.mocked(mockInstallerContext.ui.confirm).mockResolvedValue(true);
      
      const mockExecSync = vi.fn().mockImplementation((cmd: string) => {
        if (cmd.includes('npm install')) return '';
        return '/usr/bin/gemini';
      });
      vi.mocked(execSync).mockImplementation(mockExecSync);
      
      vi.mocked(getA2APackageRoot).mockReturnValue(mockPackageRoot);
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(writeFileSync).mockReturnValue(undefined);
      
      const mockApplyPatch = vi.fn().mockReturnValue(true);
      vi.mocked(applyInjectResultPatch).mockImplementation(mockApplyPatch);
      
      // Mock file content that gets patched
      let mockFileContent = 'const currentTask = wrapper.task;';
      vi.mocked(readFileSync).mockImplementation((path: any) => {
        const pathStr = path.toString();
        if (pathStr.includes('a2a-server.mjs') && !pathStr.includes('.bak')) {
          return mockFileContent;
        }
        return '';
      });
      
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().includes('a2a-server.mjs') && !path.toString().includes('.bak')) {
          mockFileContent = content.toString();
        }
      });

      await installA2AServer(mockInstallerContext);

      // Verify workspace was created
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('a2a-workspace/.gemini'),
        { recursive: true }
      );
      
      // Verify settings were written
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('settings.json'),
        expect.stringContaining('pi-gemini-cli-provider'),
        'utf-8'
      );
    });
  });
});
