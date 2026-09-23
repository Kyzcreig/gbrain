/**
 * Fork-local title-precedence reconcile (37fe2d04) — both directions.
 *
 * #2446 changed title derivation to frontmatter > body H1 > humanized
 * filename. Rows imported before it that had NO frontmatter title carry a
 * hash computed with the humanized-filename title; the reconcile stamps the
 * new title + canonical hash without a re-import.
 *
 * Regression: frontmatter `title:` is stripped from the hashed frontmatter, so
 * an EDIT to an explicit frontmatter title whose old value equals the
 * humanized filename (people/sarah-chen, `title: Sarah Chen`) matched the
 * old-title hash and was swallowed as `skipped` — no re-import, no version
 * snapshot. That was E2E `Versions > put_page creates version, revert restores`.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contentHash } from '../src/core/utils.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

describe('title-precedence reconcile (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
  });

  test('parseMarkdown reports titleExplicit only for frontmatter titles', () => {
    expect(parseMarkdown('---\ntitle: X\n---\n\nbody\n', 'a/b.md').titleExplicit).toBe(true);
    expect(parseMarkdown('# Heading\n\nbody\n', 'a/b.md').titleExplicit).toBe(false);
    expect(parseMarkdown('body\n', 'a/b.md').titleExplicit).toBe(false);
  });

  test('legacy filename-titled row with a body H1 is reconciled, not re-imported', async () => {
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
    const rows = await engine.executeRaw<{ title: string }>(
      `SELECT title FROM pages WHERE source_id = 'default' AND slug = $1`,
      [slug],
    );
    expect(rows[0]!.title).toBe('Real Heading');
    expect((await engine.getVersions(slug)).length).toBe(0);
  }, 60_000);

  test('edit to an explicit frontmatter title equal to the humanized filename is imported + versioned', async () => {
    const slug = 'people/sarah-chen';
    const original = '---\ntype: person\ntitle: Sarah Chen\n---\n\nSarah body.\n';
    const first = await importFromContent(engine, slug, original, { noEmbed: true });
    expect(first.status).toBe('imported');

    const modified = original.replace('Sarah Chen', 'Sarah Chen (Modified)');
    const second = await importFromContent(engine, slug, modified, { noEmbed: true });
    expect(second.status).toBe('imported');

    const page = await engine.getPage(slug);
    expect(page!.title).toBe('Sarah Chen (Modified)');
    expect((await engine.getVersions(slug)).length).toBeGreaterThanOrEqual(1);
  }, 60_000);
});
