/**
 * Unit tests for Tool Schema Writer
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeToolSchemas, areSchemasStale, readToolSchemas, getSchemaFilePath, DENYLIST } from './tool-schema-writer.js';
import { existsSync, readFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { Type } from '@sinclair/typebox';

// Mock tool schemas for testing
const mockTools = [
  {
    name: 'read',
    description: 'Read a file from disk',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to read' }),
    }),
  },
  {
    name: 'write',
    description: 'Write content to a file',
    parameters: Type.Object({
      path: Type.String({ description: 'File path to write' }),
      content: Type.String({ description: 'Content to write' }),
    }),
  },
  {
    name: 'bash',
    description: 'Execute a shell command',
    parameters: Type.Object({
      command: Type.String({ description: 'Shell command to execute' }),
    }),
  },
  // Denylist tools
  {
    name: 'gemini_cli_search',
    description: 'Search the web using Gemini CLI',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
  },
  {
    name: 'search_the_web',
    description: 'Search the web',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
  },
  {
    name: 'search-the-web',
    description: 'Search the web (alternate)',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
  },
  {
    name: 'search_and_read',
    description: 'Search and read content',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
  },
  {
    name: 'google_search',
    description: 'Google search',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query' }),
    }),
  },
  {
    name: 'fetch_page',
    description: 'Fetch a web page',
    parameters: Type.Object({
      url: Type.String({ description: 'URL to fetch' }),
    }),
  },
];

describe('tool-schema-writer', () => {
  const schemaFilePath = getSchemaFilePath();
  const schemaDir = dirname(schemaFilePath);

  beforeEach(() => {
    // Clean up before each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
    // Ensure directory exists
    if (!existsSync(schemaDir)) {
      mkdirSync(schemaDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(schemaFilePath)) {
      unlinkSync(schemaFilePath);
    }
  });

  describe('DENYLIST', () => {
    it('should contain 6 search-related tools', () => {
      expect(DENYLIST.size).toBe(6);
      expect(DENYLIST.has('gemini_cli_search')).toBe(true);
      expect(DENYLIST.has('search_the_web')).toBe(true);
      expect(DENYLIST.has('search-the-web')).toBe(true);
      expect(DENYLIST.has('search_and_read')).toBe(true);
      expect(DENYLIST.has('google_search')).toBe(true);
      expect(DENYLIST.has('fetch_page')).toBe(true);
    });
  });

  describe('denylist filtering', () => {
    it('should exclude all denylist tools', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      const result = writeToolSchemas(mockPi);
      const schemas = readToolSchemas();

      // Should have 3 tools (read, write, bash)
      expect(result.toolCount).toBe(3);
      expect(schemas.length).toBe(3);

      // Verify denylist tools are excluded
      const toolNames = schemas.map(s => s.name);
      expect(toolNames).toContain('read');
      expect(toolNames).toContain('write');
      expect(toolNames).toContain('bash');
      
      expect(toolNames).not.toContain('gemini_cli_search');
      expect(toolNames).not.toContain('search_the_web');
      expect(toolNames).not.toContain('search-the-web');
      expect(toolNames).not.toContain('search_and_read');
      expect(toolNames).not.toContain('google_search');
      expect(toolNames).not.toContain('fetch_page');
    });

    it('should handle empty tool list', () => {
      const mockPi = {
        getAllTools: () => [],
      };

      const result = writeToolSchemas(mockPi);
      const schemas = readToolSchemas();

      expect(result.toolCount).toBe(0);
      expect(schemas.length).toBe(0);
    });
  });

  describe('schema format', () => {
    it('should match MCP tools/list response structure', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      writeToolSchemas(mockPi);
      const schemas = readToolSchemas();

      // Each schema should have name, description, inputSchema
      schemas.forEach(schema => {
        expect(schema).toHaveProperty('name');
        expect(schema).toHaveProperty('description');
        expect(schema).toHaveProperty('inputSchema');
        expect(typeof schema.name).toBe('string');
        expect(typeof schema.description).toBe('string');
        expect(typeof schema.inputSchema).toBe('object');
      });

      // Verify inputSchema structure for 'read' tool
      const readSchema = schemas.find(s => s.name === 'read');
      expect(readSchema).toBeDefined();
      expect(readSchema!.inputSchema).toHaveProperty('type', 'object');
      expect(readSchema!.inputSchema).toHaveProperty('properties');
    });
  });

  describe('file writing', () => {
    it('should create directory if it does not exist', () => {
      // Remove directory if it exists
      if (existsSync(schemaDir)) {
        rmSync(schemaDir, { recursive: true, force: true });
      }

      const mockPi = {
        getAllTools: () => mockTools.slice(0, 1), // Just one tool
      };

      const result = writeToolSchemas(mockPi);

      expect(existsSync(schemaFilePath)).toBe(true);
      expect(result.path).toBe(schemaFilePath);
    });

    it('should write valid JSON file', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      writeToolSchemas(mockPi);

      const content = readFileSync(schemaFilePath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(3); // 3 non-denylist tools
    });

    it('should write formatted JSON (pretty-printed)', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      writeToolSchemas(mockPi);

      const content = readFileSync(schemaFilePath, 'utf-8');
      
      // Should contain indentation (2 spaces)
      expect(content).toContain('  "name":');
      expect(content).toContain('  "description":');
      expect(content).toContain('  "inputSchema":');
    });
  });

  describe('stale detection', () => {
    it('should return isStale=true when file does not exist', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      const result = writeToolSchemas(mockPi);

      expect(result.isStale).toBe(true);
    });

    it('should return isStale=false when schemas are unchanged', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      // First write
      writeToolSchemas(mockPi);

      // Second write with same tools
      const result = writeToolSchemas(mockPi);

      expect(result.isStale).toBe(false);
    });

    it('should return isStale=true when tool list changes', () => {
      const mockPi1 = {
        getAllTools: () => mockTools.slice(0, 2), // 2 tools
      };

      const mockPi2 = {
        getAllTools: () => mockTools.slice(0, 3), // 3 tools
      };

      // First write with 2 tools
      writeToolSchemas(mockPi1);

      // Second write with 3 tools
      const result = writeToolSchemas(mockPi2);

      expect(result.isStale).toBe(true);
      expect(result.toolCount).toBe(3);
    });

    it('should detect staleness correctly with areSchemasStale', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      // No file exists
      expect(areSchemasStale(mockPi)).toBe(true);

      // Write schemas
      writeToolSchemas(mockPi);

      // Should not be stale
      expect(areSchemasStale(mockPi)).toBe(false);

      // Change tools
      const mockPi2 = {
        getAllTools: () => mockTools.slice(0, 1),
      };

      // Should be stale now
      expect(areSchemasStale(mockPi2)).toBe(true);
    });
  });

  describe('readToolSchemas', () => {
    it('should return empty array when file does not exist', () => {
      const schemas = readToolSchemas();
      expect(schemas).toEqual([]);
    });

    it('should return schemas from file', () => {
      const mockPi = {
        getAllTools: () => mockTools,
      };

      writeToolSchemas(mockPi);
      const schemas = readToolSchemas();

      expect(schemas.length).toBe(3);
      expect(schemas.map(s => s.name)).toEqual(['read', 'write', 'bash']);
    });
  });
});
