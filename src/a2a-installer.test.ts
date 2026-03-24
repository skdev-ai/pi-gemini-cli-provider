import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { installA2AServer, type InstallerContext } from './a2a-installer.js';
import { getA2APath, getA2APackageRoot } from './a2a-path.js';
import { checkA2AInstalled, checkA2APatched, checkA2AInjectResultPatched } from './availability.js';
import { applyInjectResultPatch } from './inject-result-patch.js';

const UNPATCHED = "function isHeadlessMode(options) {\n  return options?.headless ?? false;\n}\nconst currentTask = wrapper.task;\n} else if (outcomeString === 'proceed_always_and_save') {\n  return true;\n}";
const PATCHED = "function isHeadlessMode(options) { return false;\n  return options?.headless ?? false;\n}\nconst currentTask = wrapper.task; const _requestedModel = x;\n} else if (outcomeString === 'proceed_always_and_save') {\n  return true;\n} else if (outcomeString === 'inject_result') {\n  // PATCH: inject_result support\n  return true;\n}";

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
  applyInjectResultPatch: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execSync: vi.fn() }));
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('a2a-installer', () => {
  const ctx: InstallerContext = { ui: { notify: vi.fn(), confirm: vi.fn() } };
  const pkgRoot = '/mock/a2a';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getA2APath).mockReturnValue(null);
    vi.mocked(getA2APackageRoot).mockReturnValue(null);
    vi.mocked(checkA2AInstalled).mockReturnValue(false);
    vi.mocked(checkA2APatched).mockReturnValue(false);
    vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(mkdirSync).mockReturnValue(undefined);
    vi.mocked(writeFileSync).mockReturnValue(undefined);
  });

  describe('preCheck', () => {
    it('throws when gemini not installed', async () => {
      vi.mocked(execSync).mockImplementation(() => { throw new Error('not found'); });
      await expect(installA2AServer(ctx)).rejects.toThrow('Gemini CLI not installed');
    });

    it('throws when OAuth missing', async () => {
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      await expect(installA2AServer(ctx)).rejects.toThrow('Not authenticated');
    });

    it('returns true when fully patched', async () => {
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(getA2APath).mockReturnValue('/usr/bin/a2a');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(checkA2AInstalled).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(PATCHED);

      const result = await installA2AServer(ctx);
      expect(result).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith('A2A already installed and patched with all 3 patches');
    });

    it('returns true when patches missing', async () => {
      vi.mocked(execSync).mockReturnValue('/usr/bin/gemini');
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(getA2APath).mockReturnValue('/usr/bin/a2a');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(checkA2AInstalled).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(false);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(false);
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);

      let content = UNPATCHED;
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) return content;
        return '';
      });
      vi.mocked(writeFileSync).mockImplementation((p: any, c: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) content = c.toString();
      });
      vi.mocked(applyInjectResultPatch).mockImplementation(() => { content = PATCHED; return true; });

      const result = await installA2AServer(ctx);
      expect(result).toBe(true);
      expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('missing'));
    });
  });

  describe('installation', () => {
    const setup = () => {
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(getA2APath).mockReturnValue(null);
      vi.mocked(checkA2AInstalled).mockReturnValue(false);
    };

    it('installs and applies patches', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);

      let content = UNPATCHED;
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) return content;
        return '';
      });
      vi.mocked(writeFileSync).mockImplementation((p: any, c: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) content = c.toString();
      });
      vi.mocked(applyInjectResultPatch).mockImplementation(() => { content = PATCHED; return true; });

      const result = await installA2AServer(ctx);
      expect(result).toBe(true);
      expect(execSync).toHaveBeenCalledWith('npm install -g @google/gemini-cli-a2a-server@0.34.0', { stdio: 'pipe' });
      expect(ctx.ui.notify).toHaveBeenCalledWith('A2A server installation complete!');
    });

    it('throws on permission denied', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => {
        if (c.toString().includes('npm')) {
          const e = new Error('EACCES') as any;
          e.code = 'EACCES';
          throw e;
        }
        return '/usr/bin/gemini';
      });
      await expect(installA2AServer(ctx)).rejects.toThrow('Permission denied');
    });

    it('throws on network error', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => {
        if (c.toString().includes('npm')) {
          const e = new Error('ENOTFOUND') as any;
          e.code = 'ENOTFOUND';
          throw e;
        }
        return '/usr/bin/gemini';
      });
      await expect(installA2AServer(ctx)).rejects.toThrow('Network error');
    });

    it('returns false on cancel', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(false);
      const result = await installA2AServer(ctx);
      expect(result).toBe(false);
      expect(ctx.ui.notify).toHaveBeenCalledWith('Installation cancelled by user');
    });
  });

  describe('patch application', () => {
    const setup = () => {
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(getA2APath).mockReturnValue(null);
      vi.mocked(checkA2AInstalled).mockReturnValue(false);
    };

    it('applies all 3 patches', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);

      let content = UNPATCHED;
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) return content;
        return '';
      });
      vi.mocked(writeFileSync).mockImplementation((p: any, c: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) content = c.toString();
      });
      vi.mocked(applyInjectResultPatch).mockImplementation(() => { content = PATCHED; return true; });

      await installA2AServer(ctx);
      expect(writeFileSync).toHaveBeenCalled();
    });

    it('throws when target not found', async () => {
      setup();
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(readFileSync).mockReturnValue('no targets here');
      await expect(installA2AServer(ctx)).rejects.toThrow('Patch target not found');
    });

    it('skips when already patched', async () => {
      setup();
      vi.mocked(checkA2AInstalled).mockReturnValue(true);
      vi.mocked(getA2APath).mockReturnValue('/usr/bin/a2a');
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(PATCHED);
      await installA2AServer(ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith('A2A already installed and patched with all 3 patches');
    });
  });

  describe('verification', () => {
    it('verifies all patches', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(applyInjectResultPatch).mockReturnValue(true);
      vi.mocked(checkA2APatched).mockReturnValue(true);
      vi.mocked(checkA2AInjectResultPatched).mockReturnValue(true);
      vi.mocked(readFileSync).mockReturnValue(PATCHED);
      await installA2AServer(ctx);
      expect(ctx.ui.notify).toHaveBeenCalledWith('Patches applied and verified successfully');
    });

    it('restores backup on failure', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth') || p.toString().includes('.bak'));
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);
      vi.mocked(applyInjectResultPatch).mockReturnValue(true);
      const incomplete = "function isHeadlessMode(options) { return false; }\nconst currentTask = wrapper.task; const _requestedModel = x;";
      vi.mocked(readFileSync).mockReturnValue(incomplete);
      await expect(installA2AServer(ctx)).rejects.toThrow('inject_result support not applied');
      expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining('.bak'), expect.any(String), 'utf-8');
    });
  });

  describe('workspace', () => {
    it('creates workspace', async () => {
      vi.mocked(existsSync).mockImplementation((p: any) => p.toString().includes('oauth'));
      vi.mocked(ctx.ui.confirm).mockResolvedValue(true);
      vi.mocked(execSync).mockImplementation((c: any) => c.toString().includes('npm') ? '' : '/usr/bin/gemini');
      vi.mocked(getA2APackageRoot).mockReturnValue(pkgRoot);

      let content = UNPATCHED;
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) return content;
        return '';
      });
      vi.mocked(writeFileSync).mockImplementation((p: any, c: any) => {
        const path = p.toString();
        if (path.includes('a2a-server.mjs') && !path.includes('.bak')) content = c.toString();
      });
      vi.mocked(applyInjectResultPatch).mockImplementation(() => { content = PATCHED; return true; });

      await installA2AServer(ctx);
      expect(mkdirSync).toHaveBeenCalledWith(expect.stringContaining('a2a-workspace/.gemini'), { recursive: true });
      expect(writeFileSync).toHaveBeenCalledWith(expect.stringContaining('settings.json'), expect.stringContaining('pi-gemini-cli-provider'), 'utf-8');
    });
  });
});
