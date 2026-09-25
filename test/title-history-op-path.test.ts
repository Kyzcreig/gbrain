/**
 * PROPOSED by Argus (t_45d21a15 review round 2) -- title history on the PRODUCTION revert path.
 *
 * `revert_version` always passes `ctx.sourceId` (cli makeContext and mcp buildOperationContext
 * both default it to 'default'), so the engines' sourceId branch of revertToVersion is the branch
 * every real revert takes. test/title-precedence-reconcile.test.ts calls
 * `engine.revertToVersion(slug, id)` with NO opts, which exercises only the other branch; with the
 * sourceId-branch title restore (or its COALESCE) removed from pglite-engine.ts, that suite stays
 * green while `gbrain revert` on the default engine silently regresses.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

describe('title history via the revert_version op (PGLite, sourceId branch)', () => {
  let engine: PGLiteEngine;

  const ctx = (): OperationContext => ({
    engine,
    config: { engine: 'pglite' },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
  }) as unknown as OperationContext;
  const op = (name: string, params: Record<string, unknown>) => operationsByName[name]!.handler(ctx(), params);

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  test('title-only edit: revert_version restores the title', async () => {
    const slug = 'people/op-title-edit';
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Op Orig\n---\n\nBody.\n', { noEmbed: true });
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Op Edited\n---\n\nBody.\n', { noEmbed: true });
    expect((await engine.getPage(slug))!.title).toBe('Op Edited');

    const versions = await op('get_versions', { slug }) as Array<{ id: number }>;
    expect(versions.length).toBe(1);
    await op('revert_version', { slug, version_id: versions[versions.length - 1]!.id });
    expect((await engine.getPage(slug))!.title).toBe('Op Orig');
  }, 60_000);

  test('pre-v146 version (title NULL): revert_version restores the body and keeps the current title', async () => {
    const slug = 'people/op-null-title';
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Kept Title\n---\n\nv1 body.\n', { noEmbed: true });
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Kept Title\n---\n\nv2 body.\n', { noEmbed: true });
    await engine.executeRaw(
      `UPDATE page_versions SET title = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      [slug],
    );

    const versions = await op('get_versions', { slug }) as Array<{ id: number }>;
    await op('revert_version', { slug, version_id: versions[versions.length - 1]!.id });
    const page = await engine.getPage(slug);
    expect(page!.title).toBe('Kept Title');
    expect(page!.compiled_truth).toContain('v1 body.');
  }, 60_000);
});
