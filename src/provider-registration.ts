/**
 * Provider Registration Module
 * 
 * Registers the gemini-a2a provider with GSD using exact model discovery
 * from the installed Gemini CLI package's models.js file.
 * 
 * Key behaviors:
 * - Discovers models from Gemini CLI's own VALID_GEMINI_MODELS set
 * - Maps each model to GSD's custom provider format
 * - Exposes all model IDs without filtering
 * - Detects invalid model IDs via SSE metadata.error parsing
 */

import { getA2APackageRoot } from './a2a-path.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Model definition in GSD's custom provider format.
 */
export interface ProviderModel {
  /** Model identifier used in API requests */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Whether the model supports reasoning/thinking */
  reasoning: boolean;
  /** Supported input modalities */
  input: Array<'text' | 'image'>;
  /** Context window size in tokens */
  contextWindow: number;
  /** Maximum output tokens */
  maxTokens: number;
  /** Cost metadata expected by GSD's provider model schema */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

/**
 * Result from provider registration.
 */
export interface ProviderRegistrationResult {
  /** List of registered models */
  models: ProviderModel[];
  /** Provider ID */
  providerId: string;
  /** Gemini CLI package root path */
  geminiCliRoot: string;
}

// ============================================================================
// Model Discovery
// ============================================================================

/**
 * Resolves the path to Gemini CLI's models.js file.
 * 
 * Derives from the A2A package root:
 *   A2A root: /path/to/@google/gemini-cli-a2a-server
 *   Gemini CLI root: /path/to/@google/gemini-cli
 *   Models file: /path/to/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/config/models.js
 * 
 * @returns The resolved path to models.js, or null if Gemini CLI not found
 */
async function resolveModelsPath(): Promise<string | null> {
  const a2aPackageRoot = getA2APackageRoot();
  if (!a2aPackageRoot) {
    return null;
  }

  try {
    // Navigate from A2A server to Gemini CLI
    // A2A server is at: @google/gemini-cli-a2a-server
    // Gemini CLI is a sibling: @google/gemini-cli
    const pathModule = await import('node:path');
    const fsModule = await import('node:fs');
    
    const { join, normalize } = pathModule;
    const { existsSync } = fsModule;
    
    const googleDir = normalize(join(a2aPackageRoot, '..'));
    const geminiCliDir = join(googleDir, 'gemini-cli');
    const modelsPath = join(
      geminiCliDir,
      'node_modules',
      '@google',
      'gemini-cli-core',
      'dist',
      'src',
      'config',
      'models.js'
    );

    if (!existsSync(modelsPath)) {
      return null;
    }

    return modelsPath;
  } catch {
    return null;
  }
}

/**
 * Discovers available models from Gemini CLI's models.js file.
 * 
 * Imports VALID_GEMINI_MODELS directly from the installed Gemini CLI package.
 * Returns all model IDs without filtering - no experiment-flag reimplementation.
 * 
 * @returns Set of model IDs, or null if discovery failed
 */
export async function discoverModels(): Promise<Set<string> | null> {
  const modelsPath = await resolveModelsPath();
  if (!modelsPath) {
    return null;
  }

  try {
    // Import the models.js file to get VALID_GEMINI_MODELS
    const modelsModule = await import(modelsPath);
    const { VALID_GEMINI_MODELS } = modelsModule;

    if (!(VALID_GEMINI_MODELS instanceof Set)) {
      return null;
    }

    return VALID_GEMINI_MODELS;
  } catch (error) {
    // Import failed - Gemini CLI may not be installed or path is wrong
    return null;
  }
}

// ============================================================================
// Provider Registration
// ============================================================================

/**
 * Maps a model ID to GSD's custom provider format.
 * 
 * All Gemini models get:
 * - reasoning: true (all Gemini 2.x/3.x models support reasoning)
 * - input: ['text', 'image'] (multimodal support)
 * - contextWindow: 1048576 (1M tokens)
 * - maxTokens: 65536 (64K output tokens)
 * 
 * @param modelId - The model ID from VALID_GEMINI_MODELS
 * @returns ProviderModel object
 */
export function mapModelToProviderFormat(modelId: string): ProviderModel {
  // Derive display name from model ID
  // e.g., 'gemini-2.5-pro' → 'Gemini 2.5 Pro'
  // e.g., 'gemini-3-flash-preview' → 'Gemini 3 Flash Preview'
  const name = modelId
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

  return {
    id: modelId,
    name,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1048576,
    maxTokens: 65536,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

/**
 * Registers the gemini-a2a provider with GSD.
 * 
 * Discovers models from Gemini CLI's own models.js, maps them to the
 * provider format, and registers with GSD's provider API.
 * 
 * @param pi - GSD extension API with registerProvider method
 * @returns ProviderRegistrationResult with registered models
 * @throws Error if Gemini CLI package root cannot be resolved
 */
export async function registerGeminiProvider(
  pi: {
    getAllTools(): any[];
    on(event: string, handler: Function): void;
    registerProvider(id: string, config: {
      api: string;
      baseUrl: string;
      apiKey: string;
      models: ProviderModel[];
      streamSimple: Function;
    }): void;
  }
): Promise<ProviderRegistrationResult> {
  // Discover models from Gemini CLI
  const validModels = await discoverModels();
  
  if (!validModels) {
    throw new Error(
      'Failed to discover models from Gemini CLI. ' +
      'Ensure @google/gemini-cli is installed globally.'
    );
  }

  // Map all discovered models to provider format
  const models: ProviderModel[] = Array.from(validModels).map(mapModelToProviderFormat);

  if (models.length === 0) {
    throw new Error(
      'No models discovered from Gemini CLI. ' +
      'VALID_GEMINI_MODELS set is empty.'
    );
  }

  const providerId = 'gemini-a2a';

  // Import streamSimple for the provider config
  const { streamSimpleGsd } = await import('./stream-simple.js');

  // Register the provider with GSD
  // GSD's ModelRegistry.validateProviderConfig() requires api, baseUrl, and apiKey when streamSimple is set
  // baseUrl: A2A server endpoint (local process)
  // apiKey: Dummy value required by validation (our streamSimple doesn't use it - A2A server has no API key auth)
  pi.registerProvider(providerId, {
    api: 'gemini-a2a',
    baseUrl: 'http://localhost:41242',
    apiKey: 'local',
    models,
    streamSimple: streamSimpleGsd,
  });

  return {
    models,
    providerId,
    geminiCliRoot: (await resolveModelsPath()) || 'unknown',
  };
}

/**
 * Validates a model ID against the discovered models.
 * 
 * @param modelId - The model ID to validate
 * @returns True if the model ID is valid
 */
export async function isValidModelId(modelId: string): Promise<boolean> {
  const validModels = await discoverModels();
  if (!validModels) {
    // If we can't discover models, assume the model is valid
    // (fail-soft to allow operation without Gemini CLI)
    return true;
  }
  return validModels.has(modelId);
}

/**
 * Gets all available model IDs.
 * 
 * @returns Array of model IDs, or empty array if discovery failed
 */
export async function getAvailableModelIds(): Promise<string[]> {
  const validModels = await discoverModels();
  if (!validModels) {
    return [];
  }
  return Array.from(validModels);
}
