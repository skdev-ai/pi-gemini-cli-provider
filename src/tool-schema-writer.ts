/**
 * Tool Schema Writer
 * 
 * Serializes GSD tools to a JSON file on disk for MCP server consumption.
 * The MCP server reads this file on tools/list requests (file-based IPC).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { TSchema } from '@sinclair/typebox';

/**
 * Tool info matching the PI ExtensionAPI.getAllTools() return type.
 * Defined locally to avoid dependency on @gsd/pi-coding-agent.
 */
export interface ToolInfo {
  name: string;
  description: string;
  parameters: TSchema;
}

/**
 * Denylist of search-related tools to exclude from MCP exposure.
 * These tools are handled separately via A2A/ACP/cold search transports.
 */
const DENYLIST = new Set([
  'gemini_cli_search',
  'search_the_web',
  'search-the-web',
  'search_and_read',
  'google_search',
  'fetch_page',
]);

/**
 * Schema format matching MCP tools/list response structure.
 */
export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Result of writing tool schemas to disk.
 */
export interface WriteToolSchemasResult {
  /** Path to the written schema file */
  path: string;
  /** True if schemas changed since last write (stale detection) */
  isStale: boolean;
  /** Number of tools written (after denylist filtering) */
  toolCount: number;
}

/**
 * Convert TypeBox schema to JSON Schema format.
 * TypeBox schemas are already JSON Schema compatible.
 */
function typeBoxToJsonSchema(schema: TSchema): Record<string, unknown> {
  // TypeBox schemas are already JSON Schema compatible
  // Just need to ensure we have a plain object representation
  return schema as unknown as Record<string, unknown>;
}

/**
 * Filter tools by denylist and convert to MCP schema format.
 */
function filterAndConvertTools(tools: ToolInfo[]): ToolSchema[] {
  return tools
    .filter(tool => !DENYLIST.has(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: typeBoxToJsonSchema(tool.parameters),
    }));
}

/**
 * Get the schema file path.
 * Uses PI_GEMINI_SCHEMA_PATH env var if set (for testing), otherwise defaults to standard location.
 */
export function getSchemaFilePath(): string {
  const envPath = process.env.PI_GEMINI_SCHEMA_PATH;
  if (envPath) {
    return envPath;
  }
  return join(homedir(), '.pi', 'agent', 'extensions', 'pi-gemini-cli-provider', 'tool-schemas.json');
}

/**
 * Write tool schemas to disk.
 * 
 * @param pi - Extension API with getAllTools() and optional getActiveTools()
 * @returns Result with path, staleness, and tool count
 */
export function writeToolSchemas(pi: { getAllTools(): ToolInfo[]; getActiveTools?(): string[] }): WriteToolSchemasResult {
  const schemaFilePath = getSchemaFilePath();

  // Only export tools that are both registered AND active in the session.
  // getAllTools() returns the full registry, but the agent loop only executes
  // tools in the active set. Advertising inactive tools causes "Tool not found."
  const allTools = pi.getAllTools();
  const activeNames = pi.getActiveTools ? new Set(pi.getActiveTools()) : null;
  const activeTools = activeNames ? allTools.filter(t => activeNames.has(t.name)) : allTools;
  const filteredSchemas = filterAndConvertTools(activeTools);
  
  // Ensure directory exists
  const schemaDir = dirname(schemaFilePath);
  if (!existsSync(schemaDir)) {
    mkdirSync(schemaDir, { recursive: true });
  }
  
  // Check for staleness by comparing with existing file
  let isStale = true;
  if (existsSync(schemaFilePath)) {
    try {
      const existingContent = readFileSync(schemaFilePath, 'utf-8');
      
      // Compare schemas (simple JSON string comparison for now)
      const newContent = JSON.stringify(filteredSchemas, null, 2);
      isStale = existingContent !== newContent;
    } catch {
      // File exists but can't be read - treat as stale
      isStale = true;
    }
  }
  
  // Write schemas to disk
  const content = JSON.stringify(filteredSchemas, null, 2);
  writeFileSync(schemaFilePath, content, 'utf-8');
  
  return {
    path: schemaFilePath,
    isStale,
    toolCount: filteredSchemas.length,
  };
}

/**
 * Check if schemas are stale (different from what's on disk).
 */
export function areSchemasStale(pi: { getAllTools(): ToolInfo[]; getActiveTools?(): string[] }): boolean {
  const schemaFilePath = getSchemaFilePath();

  if (!existsSync(schemaFilePath)) {
    return true; // No file exists - definitely stale
  }

  try {
    const allTools = pi.getAllTools();
    const activeNames = pi.getActiveTools ? new Set(pi.getActiveTools()) : null;
    const activeTools = activeNames ? allTools.filter(t => activeNames.has(t.name)) : allTools;
    const filteredSchemas = filterAndConvertTools(activeTools);
    const existingContent = readFileSync(schemaFilePath, 'utf-8');
    
    // Compare by JSON string representation
    const newContent = JSON.stringify(filteredSchemas, null, 2);
    return existingContent !== newContent;
  } catch {
    return true; // Can't read/parse - treat as stale
  }
}

/**
 * Read tool schemas from disk.
 */
export function readToolSchemas(): ToolSchema[] {
  const schemaFilePath = getSchemaFilePath();
  
  if (!existsSync(schemaFilePath)) {
    return [];
  }
  
  const content = readFileSync(schemaFilePath, 'utf-8');
  return JSON.parse(content) as ToolSchema[];
}

export { DENYLIST };
