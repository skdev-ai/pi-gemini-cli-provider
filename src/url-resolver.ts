/**
 * Resolves Vertex AI grounding redirect URLs to their final destinations.
 *
 * Gemini's google_web_search returns sources as vertexaisearch.cloud.google.com
 * redirect URLs. This module resolves them to actual website URLs via HEAD
 * requests with manual redirect following.
 *
 * Reuses the proven pattern from gemini-cli-search/src/url-resolver.ts.
 */

const VERTEX_REDIRECT_PREFIX = 'vertexaisearch.cloud.google.com/grounding-api-redirect/';
const PER_URL_TIMEOUT_MS = 2000;

/**
 * Regex to match vertex grounding redirect URLs in free text.
 * Matches full URL including path — stops at whitespace, closing paren, or end of line.
 */
const VERTEX_URL_REGEX = /https:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[^\s)]+/g;

/**
 * Resolves a single vertex redirect URL to its final destination.
 *
 * @param url - Vertex grounding redirect URL
 * @returns Resolved URL, or original URL on failure
 */
async function resolveOne(url: string): Promise<string> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PER_URL_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (response.status >= 301 && response.status <= 308) {
      const location = response.headers.get('Location');
      if (location) return location;
    }

    return url;
  } catch {
    return url;
  }
}

/**
 * Resolves all vertex grounding redirect URLs found in a text blob.
 *
 * Extracts URLs via regex, resolves them in parallel, and replaces them
 * in the original text. Non-vertex URLs are left untouched.
 *
 * @param text - Text containing vertex redirect URLs
 * @returns Text with resolved URLs substituted
 */
export async function resolveVertexUrls(text: string): Promise<string> {
  if (!text.includes(VERTEX_REDIRECT_PREFIX)) {
    return text;
  }

  const matches = [...text.matchAll(VERTEX_URL_REGEX)];
  if (matches.length === 0) {
    return text;
  }

  // Deduplicate URLs (same URL may appear multiple times)
  const unique = [...new Set(matches.map((m) => m[0]))];

  // Resolve all in parallel
  const resolved = await Promise.all(
    unique.map(async (url) => ({
      original: url,
      resolved: await resolveOne(url),
    }))
  );

  // Replace in text
  let result = text;
  for (const { original, resolved: resolvedUrl } of resolved) {
    if (resolvedUrl !== original) {
      result = result.replaceAll(original, resolvedUrl);
    }
  }

  return result;
}
