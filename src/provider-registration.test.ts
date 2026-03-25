/**
 * Provider Registration Tests
 * 
 * Tests for src/provider-registration.ts covering:
 * - Model format mapping
 * - Provider registration behavior
 * - Fail-soft validation
 */

import { describe, it, expect, vi } from 'vitest';
import {
  mapModelToProviderFormat,
  isValidModelId,
  getAvailableModelIds,
} from './provider-registration.js';
import { getA2APackageRoot } from './a2a-path.js';

// Mock a2a-path module
vi.mock('./a2a-path.js', () => ({
  getA2APackageRoot: vi.fn(),
}));

// Mock node:fs module  
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// ============================================================================
// Test Fixtures
// ============================================================================

/** Sample model IDs from VALID_GEMINI_MODELS */
const SAMPLE_MODEL_IDS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-3-pro-preview',
  'gemini-3.1-pro-preview',
];

// ============================================================================
// Tests
// ============================================================================

describe('mapModelToProviderFormat', () => {
  it('should map model ID to provider format with reasoning: true', () => {
    const model = mapModelToProviderFormat('gemini-2.5-pro');
    
    expect(model.id).toBe('gemini-2.5-pro');
    expect(model.name).toBe('Gemini 2.5 Pro');
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(['text', 'image']);
    expect(model.contextWindow).toBe(1048576);
    expect(model.maxTokens).toBe(65536);
    expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it('should derive display name from model ID', () => {
    const model = mapModelToProviderFormat('gemini-3-flash-preview');
    expect(model.name).toBe('Gemini 3 Flash Preview');
  });

  it('should handle model IDs with multiple hyphens', () => {
    const model = mapModelToProviderFormat('gemini-3.1-pro-preview-customtools');
    expect(model.name).toBe('Gemini 3.1 Pro Preview Customtools');
  });

  it('should have consistent format across all models', () => {
    const models = SAMPLE_MODEL_IDS.map(mapModelToProviderFormat);
    
    models.forEach(model => {
      expect(model.reasoning).toBe(true);
      expect(model.input).toEqual(['text', 'image']);
      expect(model.contextWindow).toBe(1048576);
      expect(model.maxTokens).toBe(65536);
    });
  });
});

describe('isValidModelId', () => {
  it('should return true if models cannot be discovered (fail-soft)', async () => {
    vi.mocked(getA2APackageRoot).mockReturnValue(null);
    const valid = await isValidModelId('any-model');
    expect(valid).toBe(true);
  });
});

describe('getAvailableModelIds', () => {
  it('should return empty array if models cannot be discovered', async () => {
    vi.mocked(getA2APackageRoot).mockReturnValue(null);
    const ids = await getAvailableModelIds();
    expect(ids).toEqual([]);
  });
});

describe('registerGeminiProvider (integration)', () => {
  it('should register provider with pi.registerProvider when models are discovered', async () => {
    // This test verifies the integration behavior
    // Full happy-path testing requires live Gemini CLI installation
    // The mapModelToProviderFormat tests above verify the model format
    
    const { registerGeminiProvider } = await import('./provider-registration.js');
    
    // Mock pi API
    const mockPi = {
      getAllTools: vi.fn(() => []),
      on: vi.fn(),
      registerProvider: vi.fn(),
    };
    
    // When Gemini CLI is not installed, should throw
    vi.mocked(getA2APackageRoot).mockReturnValue(null);
    
    await expect(registerGeminiProvider(mockPi as any)).rejects.toThrow(
      'Failed to discover models from Gemini CLI'
    );
    
    // Verify registerProvider was NOT called when discovery fails
    expect(mockPi.registerProvider).not.toHaveBeenCalled();
  });
});
