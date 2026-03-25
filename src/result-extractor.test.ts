import { describe, it, expect } from 'vitest';
import {
  detectReCall,
  extractToolResultMessages,
  normalizeToolResult,
  extractAllToolResults,
} from './result-extractor.js';

describe('result-extractor', () => {
  it('detects re-calls when the last message is a toolResult', () => {
    expect(
      detectReCall([
        { role: 'assistant', content: [] },
        { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [] },
      ]),
    ).toBe(true);
  });

  it('does not detect re-call from stale historical toolResult messages', () => {
    expect(
      detectReCall([
        { role: 'user', content: [] },
        { role: 'assistant', content: [] },
        { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [] },
        { role: 'assistant', content: [] },
        { role: 'user', content: [] },
      ]),
    ).toBe(false);
  });

  it('extracts tool result messages from the current tool-use turn only', () => {
    const messages = [
      { role: 'toolResult', toolCallId: 'stale', toolName: 'read', content: [] },
      { role: 'assistant', stopReason: 'stop', content: [] },
      { role: 'assistant', stopReason: 'toolUse', content: [] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [] },
      { role: 'assistant', content: [] },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [] },
    ];

    const extracted = extractToolResultMessages(messages);
    expect(extracted.map((msg) => msg.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('normalizes toolName and preserves text payloads', () => {
    const normalized = normalizeToolResult({
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'mcp_tools_read',
      isError: false,
      content: [{ type: 'text', text: 'file contents' }],
    });

    expect(normalized).toEqual({
      toolCallId: 'c1',
      toolName: 'mcp_tools_read',
      isError: false,
      payload: {
        name: 'mcp_tools_read',
        response: { output: 'file contents' },
      },
    });
  });

  it('preserves error state separately from the response payload', () => {
    const normalized = normalizeToolResult({
      role: 'toolResult',
      toolCallId: 'c2',
      toolName: 'bash',
      isError: true,
      content: [{ type: 'text', text: 'command failed' }],
    });

    expect(normalized.isError).toBe(true);
    expect(normalized.payload).toEqual({
      name: 'bash',
      response: { output: 'command failed' },
      isError: true,
    });
  });

  it('normalizes image payloads using data and mimeType', () => {
    const normalized = normalizeToolResult({
      role: 'toolResult',
      toolCallId: 'c3',
      toolName: 'screenshot',
      isError: false,
      content: [{ type: 'image', data: 'base64data', mimeType: 'image/png' }],
    });

    expect(normalized.payload.response).toEqual({
      image: { data: 'base64data', mimeType: 'image/png' },
    });
  });

  it('extracts and normalizes only current-turn tool results', () => {
    const results = extractAllToolResults([
      {
        role: 'toolResult',
        toolCallId: 'stale',
        toolName: 'old',
        isError: false,
        content: [{ type: 'text', text: 'ignore me' }],
      },
      {
        role: 'assistant',
        stopReason: 'toolUse',
        content: [],
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0]?.toolCallId).toBe('c1');
    expect(results[0]?.payload.name).toBe('read');
  });
});
