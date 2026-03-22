/**
 * Port availability checking utility.
 * Used to detect if a TCP port is already in use before attempting to bind.
 */

import { createConnection } from 'node:net';

/**
 * Checks if a TCP port is already in use by attempting to connect.
 * Returns true if connection succeeds (port in use), false if it fails (port available).
 * 
 * @param port - Port number to check
 * @param timeout - Connection timeout in milliseconds (default: 500ms)
 * @returns true if port is in use, false if available
 */
export async function isPortInUse(port: number, timeout: number = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port });
    
    socket.on('connect', () => {
      socket.destroy();
      resolve(true); // Port is in use
    });
    
    socket.on('error', () => {
      resolve(false); // Port is available
    });
    
    // Timeout after specified ms
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeout);
  });
}

/**
 * Checks if an existing A2A server is healthy by hitting the health endpoint.
 * 
 * @param port - Port number (default: 41242)
 * @returns true if server responds with healthy status
 */
export async function isServerHealthy(port: number = 41242): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/.well-known/agent-card.json`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000), // 2s timeout
    });
    return response.ok;
  } catch {
    return false;
  }
}
