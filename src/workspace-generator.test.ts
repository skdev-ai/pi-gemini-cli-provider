/**
 * Unit tests for workspace generator
 * 
 * Tests cover:
 * - Workspace path resolution (default and custom)
 * - Directory creation
 * - Settings file generation
 * - Settings file reading and parsing
 * - Workspace validation
 * - Idempotency (skip if already exists)
 * - Error handling (permission denied, invalid JSON)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  generateWorkspace,
  resolveWorkspacePath,
  readSettingsFile,
  validateWorkspace,
  WorkspaceGenerationError,
  __testing__,
} from './workspace-generator.js';

// Mock dependencies
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(),
}));

describe('workspace-generator', () => {
  const mockHomeDir = '/mock/home';
  const defaultWorkspacePath = join(
    mockHomeDir,
    '.pi',
    'agent',
    'extensions',
    'pi-gemini-cli-provider',
    'a2a-workspace'
  );
  const defaultSettingsPath = join(defaultWorkspacePath, '.gemini', 'settings.json');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(homedir).mockReturnValue(mockHomeDir);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveWorkspacePath', () => {
    it('returns default workspace path when no config provided', () => {
      const result = resolveWorkspacePath();
      
      expect(result).toBe(defaultWorkspacePath);
    });

    it('returns custom workspace path when provided', () => {
      const customPath = '/custom/workspace';
      const result = resolveWorkspacePath({ workspacePath: customPath });
      
      expect(result).toBe(customPath);
    });

    it('uses default when config is empty object', () => {
      const result = resolveWorkspacePath({});
      
      expect(result).toBe(defaultWorkspacePath);
    });
  });

  describe('generateWorkspace', () => {
    it('creates workspace directory and settings file', () => {
      const result = generateWorkspace();
      
      expect(result.workspacePath).toBe(defaultWorkspacePath);
      expect(result.settingsPath).toBe(defaultSettingsPath);
      expect(result.created).toBe(true);
      
      expect(mkdirSync).toHaveBeenCalledWith(
        join(defaultWorkspacePath, '.gemini'),
        { recursive: true }
      );
      
      expect(writeFileSync).toHaveBeenCalledWith(
        defaultSettingsPath,
        expect.any(String),
        'utf-8'
      );
    });

    it('writes correct settings content with excludeTools and MCP server', () => {
      let capturedContent = '';
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().endsWith('settings.json')) {
          capturedContent = content.toString();
        }
      });

      generateWorkspace();

      // Remove comment lines for parsing
      const jsonContent = capturedContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      const settings = JSON.parse(jsonContent);

      expect(settings.excludeTools).toEqual(__testing__.PROVIDER_WORKSPACE_SETTINGS.excludeTools);
      expect(settings.folderTrust).toBe(true);
      expect(settings.mcpServers).toBeDefined();
      expect(settings.mcpServers.tools).toBeDefined();
      expect(settings.mcpServers.tools.command).toBe('node');
      expect(settings.mcpServers.tools.args).toContainEqual(
        expect.stringContaining('mcp-bridge-server.js')
      );
    });

    it('writes valid JSON without a comment header', () => {
      let capturedContent = '';
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().endsWith('settings.json')) {
          capturedContent = content.toString();
        }
      });

      generateWorkspace();

      expect(() => JSON.parse(capturedContent)).not.toThrow();
      expect(capturedContent.trimStart().startsWith('//')).toBe(false);
    });

    it('returns created: false when workspace already exists (idempotent)', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(__testing__.PROVIDER_WORKSPACE_SETTINGS));

      const result = generateWorkspace();

      expect(result.created).toBe(false);
      expect(mkdirSync).not.toHaveBeenCalled();
      expect(writeFileSync).not.toHaveBeenCalled();
    });

    it('creates workspace with custom excludeTools when provided', () => {
      const customExcludeTools = ['tool1', 'tool2'];
      let capturedContent = '';
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().endsWith('settings.json')) {
          capturedContent = content.toString();
        }
      });

      generateWorkspace({ excludeTools: customExcludeTools });

      const jsonContent = capturedContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      const settings = JSON.parse(jsonContent);

      expect(settings.excludeTools).toEqual(customExcludeTools);
    });

    it('disables MCP server when enableMcpServer is false', () => {
      let capturedContent = '';
      vi.mocked(writeFileSync).mockImplementation((path: any, content: any) => {
        if (path.toString().endsWith('settings.json')) {
          capturedContent = content.toString();
        }
      });

      generateWorkspace({ enableMcpServer: false });

      const jsonContent = capturedContent
        .split('\n')
        .filter(line => !line.trim().startsWith('//'))
        .join('\n');
      const settings = JSON.parse(jsonContent);

      expect(settings.mcpServers).toBeUndefined();
    });

    it('throws WorkspaceGenerationError when directory creation fails', () => {
      vi.mocked(mkdirSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      expect(() => generateWorkspace()).toThrow(WorkspaceGenerationError);
      expect(() => generateWorkspace()).toThrow('Failed to create .gemini directory');
    });

    it('throws WorkspaceGenerationError when settings write fails', () => {
      vi.mocked(mkdirSync).mockReturnValue(undefined);
      vi.mocked(writeFileSync).mockImplementation(() => {
        throw new Error('ENOSPC: no space left on device');
      });

      expect(() => generateWorkspace()).toThrow(WorkspaceGenerationError);
      expect(() => generateWorkspace()).toThrow('Failed to write settings.json');
    });
  });

  describe('readSettingsFile', () => {
    it('returns null when settings file does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = readSettingsFile(defaultWorkspacePath);

      expect(result).toBeNull();
    });

    it('returns parsed settings when file exists', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(__testing__.PROVIDER_WORKSPACE_SETTINGS));

      const result = readSettingsFile(defaultWorkspacePath);

      expect(result).toEqual(__testing__.PROVIDER_WORKSPACE_SETTINGS);
    });

    it('throws WorkspaceGenerationError when settings file contains comments', () => {
      const contentWithComments = `// This is a comment
// Another comment
${JSON.stringify(__testing__.PROVIDER_WORKSPACE_SETTINGS)}`;
      
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(contentWithComments);

      expect(() => readSettingsFile(defaultWorkspacePath)).toThrow(WorkspaceGenerationError);
      expect(() => readSettingsFile(defaultWorkspacePath)).toThrow('Failed to parse settings.json');
    });

    it('throws WorkspaceGenerationError when JSON is invalid', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue('invalid json {');

      expect(() => readSettingsFile(defaultWorkspacePath)).toThrow(WorkspaceGenerationError);
      expect(() => readSettingsFile(defaultWorkspacePath)).toThrow('Failed to parse settings.json');
    });
  });

  describe('validateWorkspace', () => {
    it('returns valid: true for correct workspace', () => {
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(__testing__.PROVIDER_WORKSPACE_SETTINGS));

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns valid: false when settings file is missing', () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Settings file not found');
    });

    it('returns valid: false when excludeTools is missing', () => {
      const invalidSettings = { folderTrust: true };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(invalidSettings));

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing or invalid excludeTools list');
    });

    it('returns valid: false when folderTrust is not enabled', () => {
      const invalidSettings = { ...__testing__.PROVIDER_WORKSPACE_SETTINGS, folderTrust: false };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(invalidSettings));

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('folderTrust should be enabled');
    });

    it('returns valid: false when MCP server config is missing', () => {
      const invalidSettings = {
        excludeTools: __testing__.PROVIDER_WORKSPACE_SETTINGS.excludeTools,
        folderTrust: true,
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(invalidSettings));

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing mcpServers configuration');
    });

    it('validates successfully when MCP server is disabled in config', () => {
      const settingsWithoutMcp = {
        excludeTools: __testing__.PROVIDER_WORKSPACE_SETTINGS.excludeTools,
        folderTrust: true,
      };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(settingsWithoutMcp));

      const result = validateWorkspace(defaultWorkspacePath, { enableMcpServer: false });

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns multiple errors when multiple issues exist', () => {
      const invalidSettings = { folderTrust: false };
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(invalidSettings));

      const result = validateWorkspace(defaultWorkspacePath);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(1);
      expect(result.errors).toContain('Missing or invalid excludeTools list');
      expect(result.errors).toContain('folderTrust should be enabled');
    });
  });

  describe('generateSettingsContent', () => {
    it('generates correct JSON structure', () => {
      const content = __testing__.generateSettingsContent();
      const settings = JSON.parse(content);

      expect(settings.excludeTools).toBeDefined();
      expect(settings.folderTrust).toBe(true);
      expect(settings.mcpServers).toBeDefined();
    });

    it('generates pure JSON without comments', () => {
      const content = __testing__.generateSettingsContent();

      expect(() => JSON.parse(content)).not.toThrow();
      expect(content.trimStart().startsWith('//')).toBe(false);
    });

    it('respects enableMcpServer option', () => {
      const content = __testing__.generateSettingsContent({ enableMcpServer: false });

      expect(content).not.toContain('mcpServers');
    });
  });
});
