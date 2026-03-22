import { execSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

/**
 * Module-level cache for the A2A server path.
 * Only non-null results are cached to allow re-checking if user installs A2A mid-session.
 */
let cachedPath: string | null = null;

/**
 * Module-level cache for the A2A package root directory.
 * Cached separately from binary path since it's derived from the binary path.
 * Changes only when Node version changes (e.g., nvm switch v20 → v22).
 */
let cachedPackageRoot: string | null = null;

/**
 * Resolves and caches the A2A server path from `which gemini-cli-a2a-server`.
 * Returns null if the A2A server is not installed globally.
 * 
 * Uses execSync() with try-catch for synchronous error handling.
 * Only caches non-null results (allows re-checking after installation).
 * 
 * @returns The resolved path to gemini-cli-a2a-server, or null if not installed
 */
export function getA2APath(): string | null {
  // Return cached value if already resolved (only non-null values are cached)
  if (cachedPath !== null) {
    return cachedPath;
  }

  try {
    // Execute 'which gemini-cli-a2a-server' to find the binary path
    const result = execSync('which gemini-cli-a2a-server', { encoding: 'utf-8' });
    // Trim whitespace (execSync includes trailing newline)
    cachedPath = result.trim();
    return cachedPath;
  } catch (error) {
    // execSync throws on non-zero exit code (e.g., command not found)
    // Return null but don't cache it, allowing re-checking
    return null;
  }
}

/**
 * Resolves and caches the A2A server package root directory.
 * Derives the package root from the binary path by resolving symlinks (nvm uses symlinks)
 * and navigating to lib/node_modules/@google/gemini-cli-a2a-server.
 * 
 * Example:
 *   Binary symlink: /Users/skello/.nvm/versions/node/v22.22.1/bin/gemini-cli-a2a-server
 *   Real path:      /Users/skello/.nvm/versions/node/v22.22.1/lib/node_modules/@google/gemini-cli-a2a-server/dist/a2a-server.mjs
 *   Package root:   /Users/skello/.nvm/versions/node/v22.22.1/lib/node_modules/@google/gemini-cli-a2a-server
 * 
 * This correctly handles Node version switches (nvm, fnm, volta) since the binary path
 * includes the version-specific directory.
 * 
 * @returns The resolved path to the package root directory, or null if binary not found
 */
export function getA2APackageRoot(): string | null {
  // Return cached value if already resolved
  if (cachedPackageRoot !== null) {
    return cachedPackageRoot;
  }

  // Get the binary path first (may populate cache)
  const binaryPath = getA2APath();
  if (!binaryPath) {
    return null;
  }

  try {
    // Resolve symlinks to get the real path (nvm uses symlinks for global binaries)
    const realPath = realpathSync(binaryPath);
    
    // Navigate from dist/a2a-server.mjs to the package root
    const distDir = dirname(realPath);  // e.g., .../gemini-cli-a2a-server/dist
    const packageRoot = normalize(join(distDir, '..'));  // Navigate up to package root
    
    cachedPackageRoot = packageRoot;
    return cachedPackageRoot;
  } catch (error) {
    // Failed to derive package root (e.g., file doesn't exist, permission denied)
    return null;
  }
}

/**
 * Checks if the A2A server path has been successfully resolved and cached.
 * Returns true only if getA2APath() was called and returned a non-null result.
 * 
 * @returns true if A2A path is cached, false otherwise
 */
export function isA2APathResolved(): boolean {
  return cachedPath !== null;
}
