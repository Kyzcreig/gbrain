import type { GBrainConfig } from '../config.ts';
import type { ResolvedColumn, SearchOpts } from '../types.ts';
import { resolveEmbeddingColumn } from './embedding-column.ts';

export const OPENAI_GENERATION_STALE_THRESHOLD_MS = 30 * 60 * 60 * 1000;
export const OPENAI_GENERATION_STALE_TRIGGER_ID = 'openai_generation_stale_30h';
export const WRITE_BACKLOG_TRIGGER_IDS = new Set([
  'pending_two_consecutive',
  'oldest_pending_30h',
]);

export type EmbeddingGeneration = 'openai' | 'zembed';
export type GenerationReadMode = 'vector' | 'non_vector';

export class EmbeddingGenerationInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingGenerationInvariantError';
  }
}

export interface ZembedGenerationConfig {
  enabled?: boolean;
  current_generation?: EmbeddingGeneration;
  dual_write_active?: boolean;
  openai_last_write_at?: string;
  p6_cutover_at?: string;
}

export interface GenerationReadDecision {
  mode: GenerationReadMode;
  generation: EmbeddingGeneration | null;
  reason: string;
  triggerId: string | null;
  openaiGenerationAgeMs: number | null;
}

export interface GenerationVectorReadResult<T> extends GenerationReadDecision {
  results: T[];
}

export interface GenerationVectorBatchReadResult<T> extends GenerationReadDecision {
  results: T[][];
  queryEmbeddings: Float32Array[];
  column: ResolvedColumn | null;
}

const ZEMBED_COLUMN: ResolvedColumn = Object.freeze({
  name: 'embedding_zembed',
  type: 'halfvec',
  dimensions: 2560,
  embeddingModel: 'zeroentropyai:zembed-1',
});

function openAIColumn(config: GBrainConfig): ResolvedColumn {
  const column = resolveEmbeddingColumn({ embeddingColumn: 'embedding' }, config);
  if (!column.embeddingModel.startsWith('openai:') || column.dimensions !== 1536) {
    throw new EmbeddingGenerationInvariantError(
      `OpenAI generation must resolve to openai:* at 1536 dimensions; got ` +
      `${column.embeddingModel} at ${column.dimensions}`,
    );
  }
  return column;
}

function parseTimestamp(value: string | undefined): number | null {
  if (value === undefined) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new EmbeddingGenerationInvariantError(`Invalid zembed generation timestamp: ${value}`);
  }
  return timestamp;
}

/**
 * Resolve the whole read generation. A query vector is never substituted
 * independently from the document-vector column that defines its space.
 */
export function resolveGenerationRead(
  config: ZembedGenerationConfig | undefined,
  queryEmbeddingHealthy: boolean,
  nowMs: number,
): GenerationReadDecision {
  if (!Number.isFinite(nowMs)) {
    throw new EmbeddingGenerationInvariantError('generation clock must be finite');
  }

  if (config?.enabled !== true || config.current_generation !== 'zembed') {
    return {
      mode: 'vector',
      generation: 'openai',
      reason: 'feature_off_or_openai_current',
      triggerId: null,
      openaiGenerationAgeMs: null,
    };
  }

  if (queryEmbeddingHealthy) {
    return {
      mode: 'vector',
      generation: 'zembed',
      reason: 'zembed_healthy',
      triggerId: null,
      openaiGenerationAgeMs: null,
    };
  }

  if (config.dual_write_active === true) {
    return {
      mode: 'vector',
      generation: 'openai',
      reason: 'dual_write_openai_fallback',
      triggerId: null,
      openaiGenerationAgeMs: null,
    };
  }

  const references = [
    parseTimestamp(config.openai_last_write_at),
    parseTimestamp(config.p6_cutover_at),
  ].filter((value): value is number => value !== null);
  if (references.length === 0) {
    return {
      mode: 'non_vector',
      generation: null,
      reason: 'openai_generation_clock_missing',
      triggerId: OPENAI_GENERATION_STALE_TRIGGER_ID,
      openaiGenerationAgeMs: null,
    };
  }

  const openaiGenerationAgeMs = Math.max(0, nowMs - Math.max(...references));
  if (openaiGenerationAgeMs <= OPENAI_GENERATION_STALE_THRESHOLD_MS) {
    return {
      mode: 'vector',
      generation: 'openai',
      reason: 'bounded_post_window_openai_fallback',
      triggerId: null,
      openaiGenerationAgeMs,
    };
  }

  return {
    mode: 'non_vector',
    generation: null,
    reason: 'openai_generation_stale',
    triggerId: OPENAI_GENERATION_STALE_TRIGGER_ID,
    openaiGenerationAgeMs,
  };
}

/** Default-OFF keeps the pre-P2 resolver result; enabled zembed is fixed-space. */
export function resolveGenerationAwareColumn(
  opts: SearchOpts | undefined,
  config: GBrainConfig,
): ResolvedColumn {
  if (config.zembed?.enabled !== true || config.zembed.current_generation !== 'zembed') {
    return resolveEmbeddingColumn(opts, config);
  }
  return ZEMBED_COLUMN;
}

function assertDimensions(vector: Float32Array, column: ResolvedColumn): void {
  if (vector.length !== column.dimensions) {
    throw new EmbeddingGenerationInvariantError(
      `Query embedding dimension mismatch for ${column.name}: ` +
      `expected ${column.dimensions}, got ${vector.length}`,
    );
  }
}

/**
 * Executes the model+column pair as one generation. Only provider failures on
 * the zembed query call enter fallback; dimension/column invariant failures do
 * not get hidden by a different generation.
 */
export async function executeGenerationAwareVectorRead<T>(args: {
  config: GBrainConfig;
  query: string;
  nowMs: number;
  embedQuery: (query: string, column: ResolvedColumn) => Promise<Float32Array>;
  searchVector: (vector: Float32Array, column: ResolvedColumn) => Promise<T[]>;
}): Promise<GenerationVectorReadResult<T>> {
  const batch = await executeGenerationAwareVectorBatchRead({
    config: args.config,
    queries: [args.query],
    nowMs: args.nowMs,
    embedQuery: args.embedQuery,
    searchVector: args.searchVector,
  });
  return { ...batch, results: batch.results[0] ?? [] };
}

/** All expanded query variants succeed or fall back as one generation. */
export async function executeGenerationAwareVectorBatchRead<T>(args: {
  config: GBrainConfig;
  queries: string[];
  nowMs: number;
  embedQuery: (query: string, column: ResolvedColumn) => Promise<Float32Array>;
  searchVector: (vector: Float32Array, column: ResolvedColumn) => Promise<T[]>;
}): Promise<GenerationVectorBatchReadResult<T>> {
  const { config, queries, nowMs, embedQuery, searchVector } = args;

  if (config.zembed?.enabled !== true || config.zembed.current_generation !== 'zembed') {
    const column = resolveEmbeddingColumn(undefined, config);
    const vectors = await Promise.all(queries.map(query => embedQuery(query, column)));
    for (const vector of vectors) assertDimensions(vector, column);
    const results = await Promise.all(vectors.map(vector => searchVector(vector, column)));
    return {
      ...resolveGenerationRead(config.zembed, true, nowMs),
      results,
      queryEmbeddings: vectors,
      column,
    };
  }

  let zembedVectors: Float32Array[];
  try {
    zembedVectors = await Promise.all(
      queries.map(query => embedQuery(query, ZEMBED_COLUMN)),
    );
  } catch {
    const decision = resolveGenerationRead(config.zembed, false, nowMs);
    if (decision.mode === 'non_vector') {
      return { ...decision, results: [], queryEmbeddings: [], column: null };
    }
    const column = openAIColumn(config);
    let vectors: Float32Array[];
    try {
      vectors = await Promise.all(queries.map(query => embedQuery(query, column)));
    } catch {
      return {
        ...decision,
        mode: 'non_vector',
        generation: null,
        reason: 'openai_fallback_query_embedding_failed',
        results: [],
        queryEmbeddings: [],
        column: null,
      };
    }
    for (const vector of vectors) assertDimensions(vector, column);
    const results = await Promise.all(vectors.map(vector => searchVector(vector, column)));
    return { ...decision, results, queryEmbeddings: vectors, column };
  }

  for (const vector of zembedVectors) assertDimensions(vector, ZEMBED_COLUMN);
  const results = await Promise.all(
    zembedVectors.map(vector => searchVector(vector, ZEMBED_COLUMN)),
  );
  return {
    ...resolveGenerationRead(config.zembed, true, nowMs),
    results,
    queryEmbeddings: zembedVectors,
    column: ZEMBED_COLUMN,
  };
}
