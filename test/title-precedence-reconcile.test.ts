/**
 * Fork-local title-precedence reconcile (37fe2d04) + title history (v146).
 *
 * #2446 changed title derivation to frontmatter > body H1 > humanized
 * filename. Rows imported before it that had NO frontmatter title carry a
 * hash computed with the humanized-filename title; the reconcile stamps the
 * new title + canonical hash without a re-chunk.
 *
 * Frontmatter `title:` is stripped from the stored + hashed frontmatter, so a
 * title-only edit is invisible to everything except `pages.title`. The class
 * swept here, against the shared importer:
 *   - replace an explicit title          -> imported, versioned, revert restores
 *   - delete an explicit title (== slug) -> reconciled (row shape is identical
 *     to a legacy row, so it cannot be told apart) but versioned + revertible
 *   - introduce an explicit title        -> imported, versioned, revert restores
 *   - legacy filename-titled row + H1    -> reconciled: skipped, 0 chunks,
 *     versioned, revert restores the filename title
 *   - unchanged explicit / no-title      -> skipped, no version
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contentHash } from '../src/core/utils.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('title-precedence reconcile + title history (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  const title = async (slug: string) => (await engine.getPage(slug))!.title;
  const revertOldest = async (slug: string) => {
    const versions = await engine.getVersions(slug);
    await engine.revertToVersion(slug, versions[versions.length - 1]!.id);
  };

  test('parseMarkdown reports titleExplicit only for frontmatter titles', () => {
    expect(parseMarkdown('---\ntitle: X\n---\n\nbody\n', 'a/b.md').titleExplicit).toBe(true);
    expect(parseMarkdown('# Heading\n\nbody\n', 'a/b.md').titleExplicit).toBe(false);
    expect(parseMarkdown('body\n', 'a/b.md').titleExplicit).toBe(false);
  });

  test('legacy filename-titled row with a body H1: reconciled without re-chunk, versioned, revertible', async () => {
    const slug = 'topics/legacy-h1-page';
    const content = '---\ntype: concept\n---\n\n# Real Heading\n\nLegacy body.\n';
    const parsed = parseMarkdown(content, slug + '.md');
    expect(parsed.title).toBe('Real Heading');
    const oldTitle = 'Legacy H1 Page';
    const oldHash = contentHash({
      title: oldTitle,
      type: parsed.type as never,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: parsed.tags,
    });
    // Simulate a pre-#2446 row: filename title + hash computed with it.
    await engine.putPage(slug, {
      type: parsed.type as never,
      title: oldTitle,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      content_hash: oldHash,
    });

    const res = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(res.status).toBe('skipped');
    expect(res.chunks).toBe(0);
    expect(await title(slug)).toBe('Real Heading');
    expect((await engine.getVersions(slug)).length).toBe(1);

    // Canonical hash stamped: a second import is a plain fast-path skip.
    const again = await importFromContent(engine, slug, content, { noEmbed: true });
    expect(again.status).toBe('skipped');
    expect((await engine.getVersions(slug)).length).toBe(1);

    await revertOldest(slug);
    expect(await title(slug)).toBe(oldTitle);
  }, 60_000);

  test('replace an explicit title equal to the humanized filename: imported, versioned, revert restores', async () => {
    const slug = 'people/sarah-chen';
    const original = '---\ntype: person\ntitle: Sarah Chen\n---\n\nSarah body.\n';
    expect((await importFromContent(engine, slug, original, { noEmbed: true })).status).toBe('imported');

    const modified = original.replace('Sarah Chen', 'Sarah Chen (Modified)');
    expect((await importFromContent(engine, slug, modified, { noEmbed: true })).status).toBe('imported');
    expect(await title(slug)).toBe('Sarah Chen (Modified)');
    expect((await engine.getVersions(slug)).length).toBe(1);

    await revertOldest(slug);
    expect(await title(slug)).toBe('Sarah Chen');
  }, 60_000);

  test('delete an explicit title equal to the humanized filename: versioned, revert restores', async () => {
    const slug = 'people/ada-lovelace';
    const original = '---\ntype: person\ntitle: Ada Lovelace\n---\n\n# Another Heading\n\nSame body.\n';
    expect((await importFromContent(engine, slug, original, { noEmbed: true })).status).toBe('imported');

    const deleted = original.replace('title: Ada Lovelace\n', '');
    await importFromContent(engine, slug, deleted, { noEmbed: true });
    expect(await title(slug)).toBe('Another Heading');
    expect((await engine.getVersions(slug)).length).toBe(1);

    await revertOldest(slug);
    expect(await title(slug)).toBe('Ada Lovelace');
  }, 60_000);

  test('introduce an explicit title on a no-title page: imported, versioned, revert restores', async () => {
    const slug = 'people/grace-hopper';
    const original = '---\ntype: person\n---\n\nGrace body.\n';
    expect((await importFromContent(engine, slug, original, { noEmbed: true })).status).toBe('imported');
    expect(await title(slug)).toBe('Grace Hopper');

    const introduced = '---\ntype: person\ntitle: Rear Admiral Hopper\n---\n\nGrace body.\n';
    expect((await importFromContent(engine, slug, introduced, { noEmbed: true })).status).toBe('imported');
    expect(await title(slug)).toBe('Rear Admiral Hopper');
    expect((await engine.getVersions(slug)).length).toBe(1);

    await revertOldest(slug);
    expect(await title(slug)).toBe('Grace Hopper');
  }, 60_000);

  test('unchanged explicit-title and no-title pages: skipped, no version', async () => {
    for (const [slug, content] of [
      ['people/alan-turing', '---\ntype: person\ntitle: Alan Turing\n---\n\nAlan body.\n'],
      ['people/no-title-page', '---\ntype: person\n---\n\nPlain body.\n'],
      ['people/h1-only-page', '---\ntype: person\n---\n\n# H1 Only\n\nBody.\n'],
    ] as const) {
      expect((await importFromContent(engine, slug, content, { noEmbed: true })).status).toBe('imported');
      expect((await importFromContent(engine, slug, content, { noEmbed: true })).status).toBe('skipped');
      expect((await engine.getVersions(slug)).length).toBe(0);
    }
  }, 60_000);

  test('pre-v146 version rows (title NULL) revert without blanking the title', async () => {
    const slug = 'people/null-title-version';
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Kept Title\n---\n\nv1 body.\n', { noEmbed: true });
    await importFromContent(engine, slug, '---\ntype: person\ntitle: Kept Title\n---\n\nv2 body.\n', { noEmbed: true });
    await engine.executeRaw(
      `UPDATE page_versions SET title = NULL WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      [slug],
    );
    await revertOldest(slug);
    const page = await engine.getPage(slug);
    expect(page!.title).toBe('Kept Title');
    expect(page!.compiled_truth).toContain('v1 body.');
  }, 60_000);
});
