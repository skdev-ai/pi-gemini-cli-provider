import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveVertexUrls } from './url-resolver.js';

describe('resolveVertexUrls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns text unchanged when no vertex URLs present', async () => {
    const text = '> Sources:\n> [1] weather.com (https://weather.com/forecast)';
    expect(await resolveVertexUrls(text)).toBe(text);
  });

  it('resolves vertex redirect URLs to final destinations', async () => {
    const vertexUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/ABC123';
    const resolvedUrl = 'https://weather.com/forecast';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ Location: resolvedUrl }),
    } as Response);

    const text = `> Sources:\n> [1] weather.com\n> (${vertexUrl})`;
    const result = await resolveVertexUrls(text);

    expect(result).toContain(resolvedUrl);
    expect(result).not.toContain('vertexaisearch');
  });

  it('resolves multiple URLs in parallel', async () => {
    const url1 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA';
    const url2 = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB';

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ Location: 'https://a.com' }),
      } as Response)
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ Location: 'https://b.com' }),
      } as Response);

    const text = `> [1] (${url1})\n> [2] (${url2})`;
    const result = await resolveVertexUrls(text);

    expect(result).toContain('https://a.com');
    expect(result).toContain('https://b.com');
    expect(result).not.toContain('vertexaisearch');
  });

  it('deduplicates same URL appearing multiple times', async () => {
    const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/SAME';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      status: 302,
      headers: new Headers({ Location: 'https://resolved.com' }),
    } as Response);

    const text = `> [1] (${url})\n> [2] (${url})`;
    await resolveVertexUrls(text);

    // Should only fetch once despite two occurrences
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('falls back to original URL on fetch error', async () => {
    const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/FAIL';
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));

    const text = `> [1] (${url})`;
    const result = await resolveVertexUrls(text);

    // Original URL preserved
    expect(result).toContain(url);
  });

  it('falls back on non-redirect response', async () => {
    const url = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/NOLOC';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 200,
      headers: new Headers(),
    } as Response);

    const text = `> [1] (${url})`;
    const result = await resolveVertexUrls(text);

    expect(result).toContain(url);
  });

  it('leaves non-vertex URLs untouched', async () => {
    const vertexUrl = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/XYZ';
    const normalUrl = 'https://example.com/page';

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      status: 302,
      headers: new Headers({ Location: 'https://resolved.com' }),
    } as Response);

    const text = `> [1] (${normalUrl})\n> [2] (${vertexUrl})`;
    const result = await resolveVertexUrls(text);

    expect(result).toContain(normalUrl);
    expect(result).toContain('https://resolved.com');
    expect(result).not.toContain('vertexaisearch');
  });
});
