import { describe, expect, test } from 'bun:test';

import type { GBrainConfig } from '../src/core/config.ts';
import type { ResolvedColumn } from '../src/core/types.ts';
import {
  OPENAI_GENERATION_STALE_THRESHOLD_MS,
  OPENAI_GENERATION_STALE_TRIGGER_ID,
  WRITE_BACKLOG_TRIGGER_IDS,
  executeGenerationAwareVectorBatchRead,
  executeGenerationAwareVectorRead,
  resolveGenerationAwareColumn,
  resolveGenerationRead,
} from '../src/core/search/embedding-generation.ts';

const NOW = Date.parse('2026-07-16T12:00:00Z');

function cfg(overrides: Partial<GBrainConfig> = {}): GBrainConfig {
  return {
    engine: 'postgres',
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    ...overrides,
  };
}

function zembedCfg(overrides: Partial<NonNullable<GBrainConfig['zembed']>> = {}): GBrainConfig {
  return cfg({
    zembed: {
      enabled: true,
      current_generation: 'zembed',
      dual_write_active: false,
      openai_last_write_at: '2026-07-16T11:00:00Z',
      p6_cutover_at: '2026-07-16T10:00:00Z',
      ...overrides,
    },
  });
}

describe('zembed generation routing — default OFF', () => {
  test('preserves the old OpenAI descriptor exactly', () => {
    const resolved = resolveGenerationAwareColumn(undefined, cfg());
    expect(resolved).toEqual({
      name: 'embedding',
      type: 'vector',
      dimensions: 1536,
      embeddingModel: 'openai:text-embedding-3-large',
    });
  });

  test('an explicit legacy column still wins when the flag is off', () => {
    const config = cfg({
      embedding_columns: {
        embedding_voyage: {
          provider: 'voyage:voyage-3-large',
          dimensions: 1024,
          type: 'vector',
        },
      },
    });
    expect(resolveGenerationAwareColumn({ embeddingColumn: 'embedding_voyage' }, config).name)
      .toBe('embedding_voyage');
  });
});

describe('zembed generation fallback policy', () => {
  test('healthy query embeds and reads only zembed', () => {
    const decision = resolveGenerationRead(zembedCfg().zembed, true, NOW);
    expect(decision).toEqual({
      mode: 'vector',
      generation: 'zembed',
      reason: 'zembed_healthy',
      triggerId: null,
      openaiGenerationAgeMs: null,
    });
  });

  test('dual-write failure swaps the whole generation to OpenAI', () => {
    const decision = resolveGenerationRead(
      zembedCfg({ dual_write_active: true }).zembed,
      false,
      NOW,
    );
    expect(decision.generation).toBe('openai');
    expect(decision.mode).toBe('vector');
    expect(decision.reason).toBe('dual_write_openai_fallback');
  });

  test('post-window fallback is allowed at exactly 30h', () => {
    const decision = resolveGenerationRead(
      zembedCfg({
        openai_last_write_at: new Date(NOW - OPENAI_GENERATION_STALE_THRESHOLD_MS).toISOString(),
        p6_cutover_at: new Date(NOW - OPENAI_GENERATION_STALE_THRESHOLD_MS - 1).toISOString(),
      }).zembed,
      false,
      NOW,
    );
    expect(decision.generation).toBe('openai');
    expect(decision.openaiGenerationAgeMs).toBe(OPENAI_GENERATION_STALE_THRESHOLD_MS);
  });

  test('post-window fallback refuses after 30h with a distinct page trigger', () => {
    const decision = resolveGenerationRead(
      zembedCfg({
        openai_last_write_at: new Date(NOW - OPENAI_GENERATION_STALE_THRESHOLD_MS - 1).toISOString(),
        p6_cutover_at: new Date(NOW - OPENAI_GENERATION_STALE_THRESHOLD_MS - 2).toISOString(),
      }).zembed,
      false,
      NOW,
    );
    expect(decision.mode).toBe('non_vector');
    expect(decision.generation).toBeNull();
    expect(decision.triggerId).toBe(OPENAI_GENERATION_STALE_TRIGGER_ID);
    expect(WRITE_BACKLOG_TRIGGER_IDS.has(decision.triggerId!)).toBe(false);
  });
});

describe('executeGenerationAwareVectorRead — embedding-space isolation', () => {
  test('expanded variants fall back together rather than mixing generations', async () => {
    const searches: string[] = [];
    const result = await executeGenerationAwareVectorBatchRead({
      config: zembedCfg({ dual_write_active: true }),
      queries: ['variant one', 'variant two'],
      nowMs: NOW,
      embedQuery: async (query, column) => {
        if (column.name === 'embedding_zembed' && query === 'variant two') {
          throw new Error('provider unavailable');
        }
        return new Float32Array(column.dimensions).fill(0.25);
      },
      searchVector: async (_vector, column) => {
        searches.push(column.name);
        return [column.name];
      },
    });
    expect(result.generation).toBe('openai');
    expect(result.column?.name).toBe('embedding');
    expect(searches).toEqual(['embedding', 'embedding']);
    expect(result.results).toEqual([['embedding'], ['embedding']]);
  });

  test('zembed failure performs an OpenAI embed and OpenAI-column read as one generation', async () => {
    const trace: Array<{ phase: string; model?: string; column?: string; dimensions: number }> = [];
    const result = await executeGenerationAwareVectorRead({
      config: zembedCfg({ dual_write_active: true }),
      query: 'where is the clone proof?',
      nowMs: NOW,
      embedQuery: async (_query, column) => {
        trace.push({ phase: 'embed', model: column.embeddingModel, dimensions: column.dimensions });
        if (column.name === 'embedding_zembed') throw new Error('provider unavailable');
        return new Float32Array(1536).fill(0.25);
      },
      searchVector: async (vector, column) => {
        trace.push({ phase: 'search', column: column.name, dimensions: vector.length });
        return ['openai-result'];
      },
    });
    expect(result.generation).toBe('openai');
    expect(result.results).toEqual(['openai-result']);
    expect(trace).toEqual([
      { phase: 'embed', model: 'zeroentropyai:zembed-1', dimensions: 2560 },
      { phase: 'embed', model: 'openai:text-embedding-3-large', dimensions: 1536 },
      { phase: 'search', column: 'embedding', dimensions: 1536 },
    ]);
  });

  test('healthy zembed query never touches the OpenAI column', async () => {
    const searched: ResolvedColumn[] = [];
    const result = await executeGenerationAwareVectorRead({
      config: zembedCfg(),
      query: 'healthy',
      nowMs: NOW,
      embedQuery: async (_query, column) => new Float32Array(column.dimensions).fill(0.25),
      searchVector: async (_vector, column) => {
        searched.push(column);
        return ['zembed-result'];
      },
    });
    expect(result.generation).toBe('zembed');
    expect(searched.map((column) => column.name)).toEqual(['embedding_zembed']);
  });

  test('wrong embedding dimensions reject before any vector-column query', async () => {
    let searched = false;
    await expect(executeGenerationAwareVectorRead({
      config: zembedCfg(),
      query: 'dimension drift',
      nowMs: NOW,
      embedQuery: async () => new Float32Array(1536),
      searchVector: async () => {
        searched = true;
        return [];
      },
    })).rejects.toThrow(/dimension/i);
    expect(searched).toBe(false);
  });

  test('stale fallback degrades without calling either vector search or OpenAI embed', async () => {
    const calls: string[] = [];
    const result = await executeGenerationAwareVectorRead({
      config: zembedCfg({
        openai_last_write_at: '2026-07-15T04:59:59Z',
        p6_cutover_at: '2026-07-15T04:59:58Z',
      }),
      query: 'stale',
      nowMs: NOW,
      embedQuery: async (_query, column) => {
        calls.push(`embed:${column.name}`);
        throw new Error('provider unavailable');
      },
      searchVector: async (_vector, column) => {
        calls.push(`search:${column.name}`);
        return [];
      },
    });
    expect(result.mode).toBe('non_vector');
    expect(result.triggerId).toBe(OPENAI_GENERATION_STALE_TRIGGER_ID);
    expect(calls).toEqual(['embed:embedding_zembed']);
  });
});
