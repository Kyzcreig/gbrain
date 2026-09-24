/**
 * revert_version must re-chunk the restored body.
 *
 * Pre-fix, the op ran a bare `UPDATE pages SET compiled_truth = pv.compiled_truth`
 * (engine.revertToVersion). pages.compiled_truth went back to the old text but
 * content_chunks still held the reverted-away text, so chunk / keyword / vector
 * search kept returning the page for text it no longer contained and missed the
 * restored text until something re-imported the page.
 *
 * The op now re-publishes the version through importFromContent with
 * forceRechunk (upstream v0.51+ shape). Runs the real op handler on PGLite.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let ctx: OperationContext;

const chunkText = async (slug: string): Promise<string> => {
  const rows = await engine.executeRaw<{ t: string | null }>(
    `SELECT string_agg(c.chunk_text, ' | ' ORDER BY c.chunk_index) AS t
       FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1`,
    [slug],
  );
  return rows[0]?.t ?? '';
};

const page = (body: string, title = 'Probe') =>
  `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;

describe('revert_version re-chunks the restored body', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    ctx = {
      engine,
      config: { engine: 'pglite' },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      dryRun: false,
      remote: false,
      sourceId: 'default',
    } as unknown as OperationContext;
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  test('chunks and keyword search follow the reverted body', async () => {
    const slug = 'notes/revert-rechunk';
    await importFromContent(engine, slug, page('Alpha original zebrafish body text.'), { noEmbed: true });
    await importFromContent(engine, slug, page('Bravo edited narwhal body text.'), { noEmbed: true });
    expect(await chunkText(slug)).toContain('narwhal');

    const versions = await operationsByName.get_versions!.handler(ctx, { slug }) as Array<{ id: number }>;
    const oldest = versions[versions.length - 1]!;
    const res = await operationsByName.revert_version!.handler(ctx, { slug, version_id: oldest.id }) as { status: string };
    expect(res.status).toBe('reverted');

    const after = await engine.getPage(slug);
    expect(after!.compiled_truth).toContain('zebrafish');
    const chunks = await chunkText(slug);
    expect(chunks).toContain('zebrafish');
    expect(chunks).not.toContain('narwhal');

    const hitOld = await engine.searchKeyword('narwhal');
    expect(hitOld.some(r => r.slug === slug)).toBe(false);
    const hitNew = await engine.searchKeyword('zebrafish');
    expect(hitNew.some(r => r.slug === slug)).toBe(true);

    // The revert itself stays undoable: the pre-revert (narwhal) body was snapshotted.
    const afterVersions = await engine.getVersions(slug);
    expect(afterVersions.some(v => v.compiled_truth.includes('narwhal'))).toBe(true);
  }, 60_000);

  test('title is restored and hash stays consistent (re-import of same content is a no-op)', async () => {
    const slug = 'notes/revert-title';
    await importFromContent(engine, slug, page('Charlie body.', 'First'), { noEmbed: true });
    await importFromContent(engine, slug, page('Delta body.', 'Second'), { noEmbed: true });
    const versions = await engine.getVersions(slug);
    await operationsByName.revert_version!.handler(ctx, { slug, version_id: versions[versions.length - 1]!.id });
    const after = await engine.getPage(slug);
    expect(after!.title).toBe('First');
    expect(after!.compiled_truth.trim()).toBe('Charlie body.');
    const again = await importFromContent(engine, slug, page('Charlie body.', 'First'), { noEmbed: true });
    expect(again.status).toBe('skipped');
  }, 60_000);

  test('unknown version id is rejected without touching the page', async () => {
    const slug = 'notes/revert-rechunk';
    const before = await engine.getPage(slug);
    await expect(
      operationsByName.revert_version!.handler(ctx, { slug, version_id: 99999999 }),
    ).rejects.toThrow(/not found/i);
    const after = await engine.getPage(slug);
    expect(after!.compiled_truth).toBe(before!.compiled_truth);
  }, 60_000);
});
