import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { enqueueZembedPageRevision } from '../src/core/zembed-daytime.ts';
import { withEnv } from './helpers/with-env.ts';

function engineWith(
  executeRaw: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
): BrainEngine {
  return { executeRaw } as unknown as BrainEngine;
}

describe('P3 cloud-only daytime enqueue', () => {
  test('default OFF performs no database work', async () => {
    await withEnv({ GBRAIN_ZEMBED_DAYTIME_ENABLED: undefined }, async () => {
      let calls = 0;
      const result = await enqueueZembedPageRevision(
        engineWith(async () => { calls++; return []; }),
        'p3/default-off',
        'default',
      );
      expect(result).toEqual({ status: 'disabled', persisted: false, enqueued: 0, cancelled: 0 });
      expect(calls).toBe(0);
    });
  });

  test('persists one current revision without calling a document provider', async () => {
    await withEnv({ GBRAIN_ZEMBED_DAYTIME_ENABLED: 'true' }, async () => {
      const statements: string[] = [];
      const engine = engineWith(async (sql, params) => {
        statements.push(sql);
        if (sql.includes('zembed_generation_state')) return [{ active: true }];
        if (sql.includes('SELECT cc.id::text')) {
          expect(params).toEqual(['p3/real-import', 'source-p3']);
          return [{ object_id: '7001', canonical_text: 'canonical chunk' }];
        }
        if (sql.includes('INSERT INTO zembed_embedding_jobs')) {
          expect(params?.[3]).toBe('zeroentropyai:zembed-1:2560:document');
          return [{ id: 91 }];
        }
        if (sql.includes("last_error_code = 'source_deleted'")) return [];
        throw new Error('unexpected SQL');
      });

      const result = await enqueueZembedPageRevision(engine, 'p3/real-import', 'source-p3');
      expect(result).toEqual({ status: 'persisted', persisted: true, enqueued: 1, cancelled: 0 });
      expect(statements.join('\n')).not.toContain('zembed-1/embeddings');
      expect(statements.join('\n')).not.toContain('fetch(');
    });
  });

  test('queue failure is loud, fail-open, and never claims persistence', async () => {
    await withEnv({ GBRAIN_ZEMBED_DAYTIME_ENABLED: 'true' }, async () => {
      const writes: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      try {
        const result = await enqueueZembedPageRevision(
          engineWith(async (sql) => {
            if (sql.includes('zembed_generation_state')) return [{ active: true }];
            throw new Error('queue unavailable with canonical text hidden');
          }),
          'p3/fail-open',
          'default',
        );
        expect(result.persisted).toBeFalse();
        expect(result.status).toBe('failed');
        expect(writes.join('')).toContain('ZEMBED_ENQUEUE status=failed consumer=gbrain');
        expect(writes.join('')).not.toContain('canonical text hidden');
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  test('missing pre-migration state is disabled, but a missing queue after enablement is loud', async () => {
    await withEnv({ GBRAIN_ZEMBED_DAYTIME_ENABLED: 'true' }, async () => {
      const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
      const preMigration = await enqueueZembedPageRevision(
        engineWith(async () => { throw missing; }),
        'p3/pre-migration',
        'default',
      );
      expect(preMigration.status).toBe('disabled');

      const writes: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      let calls = 0;
      try {
        const queueMissing = await enqueueZembedPageRevision(
          engineWith(async () => {
            calls++;
            if (calls === 1) return [{ active: true }];
            throw missing;
          }),
          'p3/enabled-but-missing-queue',
          'default',
        );
        expect(queueMissing.status).toBe('failed');
        expect(queueMissing.persisted).toBeFalse();
        expect(writes.join('')).toContain('ZEMBED_ENQUEUE status=failed');
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});
