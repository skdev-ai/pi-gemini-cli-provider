/**
 * Centralized logging utility for gemini-cli-search extension.
 * 
 * Usage:
 * - debugLog(module, message, ...args) - Written to <extension-dir>/.debug/debug.log when GCS_DEBUG=1
 * - All visible output must use ctx.ui.notify() - no console.log anywhere
 * 
 * @module logger
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { cwd } from 'node:process';

// Resolve extension directory from import.meta.url (works with ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXT_DIR = join(__dirname, '..'); // Go up from src/ to extension root

// Debug log file path (in extension directory, not hardcoded ~/.pi path)
const LOG_DIR = join(EXT_DIR, '.debug');
const LOG_FILE = join(LOG_DIR, 'debug.log');

/**
 * Debug flag - set GCS_DEBUG=1 to enable verbose logging to file
 */
const GCS_DEBUG = process.env.GCS_DEBUG === '1';

/**
 * Session identifier for this process instance
 */
const SESSION_ID = randomUUID().slice(0, 4);
const PROCESS_PID = process.pid;

/**
 * Ensures log directory exists
 */
function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

/**
 * Logs a debug message to file only if GCS_DEBUG is enabled.
 * Never writes to console.log to avoid breaking GSD TUI.
 * 
 * Format: [ISO timestamp] [gcs:SESSION_ID:module] message
 * 
 * @param module - Module name for log prefix (e.g., 'transport', 'lifecycle')
 * @param message - Message to log (additional args joined with spaces)
 */
export function debugLog(module: string, message: string, ...args: any[]): void {
  if (!GCS_DEBUG) {
    return; // No-op when debug is off
  }
  
  try {
    ensureLogDir();
    
    const timestamp = new Date().toISOString();
    const fullMessage = args.length > 0 ? [message, ...args].join(' ') : message;
    const logLine = `[${timestamp}] [gcs:${SESSION_ID}:${module}] ${fullMessage}\n`;
    
    appendFileSync(LOG_FILE, logLine);
  } catch (err) {
    // Silently fail - never break the app due to logging
  }
}

/**
 * Writes session start marker to log file when GCS_DEBUG=1
 * Called once at module initialization
 */
function writeSessionStartMarker(): void {
  if (!GCS_DEBUG) {
    return;
  }
  
  try {
    ensureLogDir();
    
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] [gcs:${SESSION_ID}] === Session start === PID=${PROCESS_PID} cwd=${cwd()}\n`;
    
    appendFileSync(LOG_FILE, logLine);
  } catch (err) {
    // Silently fail
  }
}

// Write session start marker on module load
writeSessionStartMarker();

/**
 * Logs an error to file ALWAYS, regardless of GCS_DEBUG.
 * Use for errors that are too important to miss.
 *
 * @param module - Module name for log prefix
 * @param message - Error message
 * @param error - Optional error object for stack trace
 */
export function errorLog(module: string, message: string, error?: unknown): void {
  try {
    ensureLogDir();

    const timestamp = new Date().toISOString();
    let logLine = `[${timestamp}] [gcs:${SESSION_ID}:${module}] ERROR: ${message}\n`;

    if (error instanceof Error) {
      logLine += `[${timestamp}] [gcs:${SESSION_ID}:${module}]   ${error.message}\n`;
      if (error.stack) {
        logLine += `[${timestamp}] [gcs:${SESSION_ID}:${module}]   ${error.stack.split('\n').slice(1).join('\n  ')}\n`;
      }
    } else if (error !== undefined) {
      logLine += `[${timestamp}] [gcs:${SESSION_ID}:${module}]   ${String(error)}\n`;
    }

    appendFileSync(LOG_FILE, logLine);
  } catch {
    // Silently fail - never break the app due to logging
  }
}

// infoLog() has been removed - use ctx.ui.notify() for visible output or debugLog() for file logging
