import { createHash } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { isUndefinedTableError } from './utils.ts';

const MODEL_SIGNATURE = 'zeroentropyai:zembed-1:2560:document';
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export interface ZembedEnqueueResult {
  status: 'disabled' | 'persisted' | 'failed';
  persisted: boolean;
  enqueued: number;
  cancelled: number;
}

interface ChunkRow {
  object_id: string;
  canonical_text: string;
}

interface IdRow {
  id: string | number;
}

function runtimeEnabled(): boolean {
  return TRUE_VALUES.has((process.env.GBRAIN_ZEMBED_DAYTIME_ENABLED ?? '').trim().toLowerCase());
}

async function generationEnabled(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ active: boolean }>(
    `SELECT enabled AND dual_write_active AS active
       FROM zembed_generation_state
      WHERE consumer = 'gbrain'`,
  );
  return Boolean(rows[0]?.active);
}

async function currentRows(
  engine: BrainEngine,
  slug?: string,
  sourceId?: string,
): Promise<ChunkRow[]> {
  const where = slug === undefined
    ? ''
    : 'WHERE p.slug = $1 AND p.source_id = $2';
  const params = slug === undefined ? [] : [slug, sourceId ?? 'default'];
  return engine.executeRaw<ChunkRow>(
    `SELECT cc.id::text AS object_id, cc.chunk_text AS canonical_text
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       ${where}
      ORDER BY cc.id`,
    params,
  );
}

async function persistCurrentRevision(
  engine: BrainEngine,
  row: ChunkRow,
): Promise<boolean> {
  const sourceSha256 = createHash('sha256').update(row.canonical_text, 'utf8').digest('hex');
  const results = await engine.executeRaw<IdRow>(
    `WITH locked AS (
       SELECT id, embedding_zembed IS NULL AS vector_missing
         FROM content_chunks
        WHERE id::text = $1 AND chunk_text = $2
        FOR UPDATE
     ), cleared AS (
       UPDATE content_chunks cc
          SET embedding_zembed = NULL,
              zembed_source_sha256 = NULL,
              zembed_model_signature = NULL,
              zembed_backend = NULL,
              zembed_provider_request_id = NULL,
              zembed_embedded_at = NULL
         FROM locked l
        WHERE cc.id = l.id
          AND cc.zembed_source_sha256 IS DISTINCT FROM $3
       RETURNING cc.id
     ), superseded AS (
       UPDATE zembed_embedding_jobs j
          SET status = 'superseded', lease_owner = NULL, lease_expires_at = NULL
         FROM locked l
        WHERE j.consumer = 'gbrain'
          AND j.object_kind = 'content_chunk'
          AND j.object_id = l.id::text
          AND j.source_sha256 <> $3
          AND j.status IN ('pending', 'leased')
       RETURNING j.id
     )
     INSERT INTO zembed_embedding_jobs(
       consumer, object_kind, object_id, source_sha256, model_signature, status
     )
     SELECT 'gbrain', 'content_chunk', l.id::text, $3, $4, 'pending'
       FROM locked l
     ON CONFLICT (consumer, object_kind, object_id, source_sha256, model_signature)
     DO UPDATE SET
       status = CASE
         WHEN (SELECT vector_missing FROM locked)
          AND zembed_embedding_jobs.status IN ('completed', 'superseded', 'dead_letter', 'cancelled')
         THEN 'pending'
         ELSE zembed_embedding_jobs.status
       END,
       lease_owner = CASE WHEN (SELECT vector_missing FROM locked) THEN NULL ELSE zembed_embedding_jobs.lease_owner END,
       lease_expires_at = CASE WHEN (SELECT vector_missing FROM locked) THEN NULL ELSE zembed_embedding_jobs.lease_expires_at END,
       next_attempt_at = CASE WHEN (SELECT vector_missing FROM locked) THEN now() ELSE zembed_embedding_jobs.next_attempt_at END,
       last_error_code = CASE WHEN (SELECT vector_missing FROM locked) THEN NULL ELSE zembed_embedding_jobs.last_error_code END,
       completed_at = CASE WHEN (SELECT vector_missing FROM locked) THEN NULL ELSE zembed_embedding_jobs.completed_at END
     RETURNING id`,
    [row.object_id, row.canonical_text, sourceSha256, MODEL_SIGNATURE],
  );
  return results.length === 1;
}

async function cancelDeleted(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<IdRow>(
    `UPDATE zembed_embedding_jobs j
        SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'source_deleted'
      WHERE j.consumer = 'gbrain'
        AND j.object_kind = 'content_chunk'
        AND j.status IN ('pending', 'leased')
        AND NOT EXISTS (
          SELECT 1 FROM content_chunks cc WHERE cc.id::text = j.object_id
        )
      RETURNING j.id`,
  );
  return rows.length;
}

async function enqueue(
  engine: BrainEngine,
  slug?: string,
  sourceId?: string,
): Promise<ZembedEnqueueResult> {
  if (!runtimeEnabled()) {
    return { status: 'disabled', persisted: false, enqueued: 0, cancelled: 0 };
  }
  try {
    if (!(await generationEnabled(engine))) {
      return { status: 'disabled', persisted: false, enqueued: 0, cancelled: 0 };
    }
  } catch (error) {
    if (isUndefinedTableError(error)) {
      return { status: 'disabled', persisted: false, enqueued: 0, cancelled: 0 };
    }
    const reason = error instanceof Error ? error.name : typeof error;
    process.stderr.write(`[gbrain] ZEMBED_ENQUEUE status=failed consumer=gbrain reason=${reason}\n`);
    return { status: 'failed', persisted: false, enqueued: 0, cancelled: 0 };
  }
  try {
    const rows = await currentRows(engine, slug, sourceId);
    let enqueued = 0;
    for (const row of rows) {
      if (await persistCurrentRevision(engine, row)) enqueued++;
    }
    const cancelled = await cancelDeleted(engine);
    return { status: 'persisted', persisted: true, enqueued, cancelled };
  } catch (error) {
    const reason = error instanceof Error ? error.name : typeof error;
    process.stderr.write(`[gbrain] ZEMBED_ENQUEUE status=failed consumer=gbrain reason=${reason}\n`);
    return { status: 'failed', persisted: false, enqueued: 0, cancelled: 0 };
  }
}

/** Post-commit hook for the real import path. Never calls a document embedder. */
export async function enqueueZembedPageRevision(
  engine: BrainEngine,
  slug: string,
  sourceId?: string,
): Promise<ZembedEnqueueResult> {
  return enqueue(engine, slug, sourceId);
}

/** Repairs jobs missed by a transient post-commit queue outage. */
export async function reconcileZembedChunkRevisions(
  engine: BrainEngine,
): Promise<ZembedEnqueueResult> {
  return enqueue(engine);
}
