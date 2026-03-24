/**
 * Unit tests for Gemini CLI Provider Command Surface
 * 
 * Tests cover:
 * - Subcommand routing (status, install-a2a, server, models, help)
 * - Output shape and content for each subcommand
 * - Install invocation and error handling
 * - Lifecycle control invocation (start/stop/restart)
 * - Model list reporting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGeminiCliCommand } from './gemini-cli-command.js';
import { installA2AServer } from './a2a-installer.js';
import { startServer, stopServer, getServerState } from './a2a-lifecycle.js';
import { getAvailableModelIds } from './provider-registration.js';
import { getA2APackageRoot } from './a2a-path.js';
import { checkA2APatched, checkA2AInjectResultPatched } from './availability.js';

// Mock dependencies
vi.mock('./a2a-installer.js', () => ({
  installA2AServer: vi.fn(),
}));

vi.mock('./a2a-lifecycle.js', () => ({
  startServer: vi.fn(),
  stopServer: vi.fn(),
  getServerState: vi.fn(),
}));

vi.mock('./provider-registration.js', () => ({
  getAvailableModelIds: vi.fn(),
  discoverModels: vi.fn(),
}));

vi.mock('./a2a-path.js', () => ({
  getA2APackageRoot: vi.fn(),
}));

vi.mock('./availability.js', () => ({
  checkA2APatched: vi.fn(),
  checkA2AInjectResultPatched: vi.fn(),
}));

describe('gemini-cli-command', () => {
  const ctx = {
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('subcommand routing', () => {
    it('routes status subcommand', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'idle',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('**A2A Server Status:**'),
        'info'
      );
    });

    it('routes install-a2a subcommand', async () => {
      vi.mocked(installA2AServer).mockResolvedValue(true);
      vi.mocked(startServer).mockResolvedValue();

      await handleGeminiCliCommand('install-a2a', ctx);

      expect(installA2AServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('A2A installation complete'),
        expect.any(String)
      );
    });

    it('routes server start subcommand', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'stopped',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(startServer).mockResolvedValue();

      await handleGeminiCliCommand('server start', ctx);

      expect(startServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'A2A server started successfully',
        'success'
      );
    });

    it('routes server stop subcommand', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'running',
        port: 41242,
        uptime: 1000,
        searchCount: 5,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(stopServer).mockResolvedValue();

      await handleGeminiCliCommand('server stop', ctx);

      expect(stopServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith('A2A server stopped', 'info');
    });

    it('routes server restart subcommand', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'running',
        port: 41242,
        uptime: 1000,
        searchCount: 5,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(stopServer).mockResolvedValue();
      vi.mocked(startServer).mockResolvedValue();

      await handleGeminiCliCommand('server restart', ctx);

      expect(stopServer).toHaveBeenCalled();
      expect(startServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith('A2A server restarted', 'success');
    });

    it('routes models subcommand', async () => {
      vi.mocked(getAvailableModelIds).mockResolvedValue([
        'gemini-2.5-pro',
        'gemini-2.5-flash',
      ]);

      await handleGeminiCliCommand('models', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('**Discovered Models:**'),
        'info'
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('gemini-2.5-pro'),
        'info'
      );
    });

    it('shows help when no subcommand provided', async () => {
      await handleGeminiCliCommand('', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Usage: /gemini-cli'),
        'info'
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('status'),
        'info'
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('install-a2a'),
        'info'
      );
    });

    it('shows error for unknown subcommand', async () => {
      await handleGeminiCliCommand('unknown', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown subcommand'),
        'error'
      );
    });
  });

  describe('status subcommand', () => {
    it('reports server state', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'running',
        port: 41242,
        uptime: 5000,
        searchCount: 10,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue('/mock/a2a');
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(getAvailableModelIds).mockResolvedValue(['gemini-2.5-pro']);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('**A2A Server Status:**');
      expect(output).toContain('Status: `running`');
      expect(output).toContain('Port: `41242`');
      expect(output).toContain('Uptime: `5s`');
      expect(output).toContain('Search Count: `10`');
      expect(output).toContain('Provider Task Count: `0`');
    });

    it('reports provider task count', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'running',
        port: 41242,
        uptime: 10000,
        searchCount: 5,
        providerTaskCount: 25,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue('/mock/a2a');
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('Search Count: `5`');
      expect(output).toContain('Provider Task Count: `25`');
    });

    it('reports patch status', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'idle',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue('/mock/a2a');
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('**Patch Status:**');
      expect(output).toContain('Patch 2 (_model): ✓');
      expect(output).toContain('Patch 3 (inject_result): ✗');
      expect(output).toContain('Missing patches detected');
    });

    it('reports workspace path', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'idle',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('**Workspace:**');
      expect(output).toContain('Path:');
    });

    it('reports model count', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'idle',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      vi.mocked(getAvailableModelIds).mockResolvedValue([
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
      ]);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('**Models:**');
      expect(output).toContain('Discovered: `3` models');
    });

    it('handles missing A2A installation', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'idle',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });
      vi.mocked(getA2APackageRoot).mockReturnValue(null);
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('status', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('A2A server not installed');
    });
  });

  describe('install-a2a subcommand', () => {
    it('calls installer with proper context', async () => {
      vi.mocked(installA2AServer).mockResolvedValue(true);
      vi.mocked(startServer).mockResolvedValue();

      await handleGeminiCliCommand('install-a2a', ctx);

      expect(installA2AServer).toHaveBeenCalledWith(
        expect.objectContaining({
          ui: expect.objectContaining({
            notify: expect.any(Function),
            confirm: expect.any(Function),
          }),
        })
      );
    });

    it('auto-starts server after successful installation', async () => {
      vi.mocked(installA2AServer).mockResolvedValue(true);
      vi.mocked(startServer).mockResolvedValue();

      await handleGeminiCliCommand('install-a2a', ctx);

      expect(startServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('A2A server started successfully'),
        'success'
      );
    });

    it('handles server startup failure gracefully', async () => {
      vi.mocked(installA2AServer).mockResolvedValue(true);
      vi.mocked(startServer).mockRejectedValue(new Error('Port in use'));

      await handleGeminiCliCommand('install-a2a', ctx);

      expect(startServer).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Installation succeeded but server failed'),
        'warning'
      );
    });

    it('propagates installation errors', async () => {
      vi.mocked(installA2AServer).mockRejectedValue(
        new Error('Permission denied')
      );

      await handleGeminiCliCommand('install-a2a', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Command failed: Permission denied'),
        'error'
      );
    });
  });

  describe('server subcommand', () => {
    it('handles server start when already running', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'running',
        port: 41242,
        uptime: 1000,
        searchCount: 5,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });

      await handleGeminiCliCommand('server start', ctx);

      expect(startServer).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('already running'),
        'info'
      );
    });

    it('handles server stop when not running', async () => {
      vi.mocked(getServerState).mockReturnValue({
        status: 'stopped',
        port: 41242,
        uptime: null,
        searchCount: 0,
        providerTaskCount: 0,
        lastError: null,
        exitCode: null,
        stdoutBuffer: [],
        stderrBuffer: [],
      });

      await handleGeminiCliCommand('server stop', ctx);

      expect(stopServer).not.toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('not running'),
        'info'
      );
    });

    it('handles unknown server action', async () => {
      await handleGeminiCliCommand('server unknown', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Unknown server action'),
        'error'
      );
    });

    it('handles missing server action', async () => {
      await handleGeminiCliCommand('server', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('Usage: /gemini-cli server'),
        'warning'
      );
    });
  });

  describe('models subcommand', () => {
    it('reports no models when discovery fails', async () => {
      vi.mocked(getAvailableModelIds).mockResolvedValue([]);

      await handleGeminiCliCommand('models', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('No models discovered'),
        'warning'
      );
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining('npm install -g @google/gemini-cli'),
        'warning'
      );
    });

    it('lists all discovered models', async () => {
      vi.mocked(getAvailableModelIds).mockResolvedValue([
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-3-flash-preview',
      ]);

      await handleGeminiCliCommand('models', ctx);

      const output = ctx.ui.notify.mock.calls[0][0] as string;
      expect(output).toContain('3 total');
      expect(output).toContain('1. `gemini-2.5-pro`');
      expect(output).toContain('2. `gemini-2.5-flash`');
      expect(output).toContain('3. `gemini-3-flash-preview`');
    });
  });

  describe('error handling', () => {
    it('catches and reports command errors', async () => {
      vi.mocked(getServerState).mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      await handleGeminiCliCommand('status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Command failed: Unexpected error',
        'error'
      );
    });

    it('handles non-Error exceptions', async () => {
      vi.mocked(getServerState).mockImplementation(() => {
        throw 'String error';
      });

      await handleGeminiCliCommand('status', ctx);

      expect(ctx.ui.notify).toHaveBeenCalledWith(
        'Command failed: String error',
        'error'
      );
    });
  });
});
