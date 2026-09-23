/**
 * Local ZeroEntropy reranker health contract.
 *
 * SERIAL: mutates the rerank-health reporter/state-path test seams.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RerankError } from '../../src/core/ai/gateway.ts';
import {
  __setRerankHealthReporterForTests,
  __setRerankHealthStatePathForTests,
  type RerankHealthNotification,
} from '../../src/core/rerank-health-alert.ts';
import { applyReranker, type RerankerOpts } from '../../src/core/search/rerank.ts';
import type { SearchResult } from '../../src/core/types.ts';

function result(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `content for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1,
    stale: false,
  };
}

let dir = '';
let notifications: RerankHealthNotification[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-health-'));
  notifications = [];
  __setRerankHealthStatePathForTests(join(dir, 'state.json'));
  __setRerankHealthReporterForTests((notification) => {
    notifications.push(notification);
  });
});

afterEach(() => {
  __setRerankHealthReporterForTests(null);
  __setRerankHealthStatePathForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function opts(rerankerFn: RerankerOpts['rerankerFn']): RerankerOpts {
  return {
    enabled: true,
    topNIn: 2,
    topNOut: null,
    model: 'zeroentropyai:zerank-2',
    rerankerFn,
  };
}

describe('applyReranker health transitions', () => {
  test('failure pages once, suppresses repeats, recovers once, then re-arms', async () => {
    const input = [result('first'), result('second')];
    const authFailure = opts(async () => {
      throw new RerankError('invalid api key', 'auth', 401);
    });

    expect(await applyReranker('q1', input, authFailure)).toEqual(input);
    expect(await applyReranker('q2', input, authFailure)).toEqual(input);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'degraded',
      severity: 'error',
      target: '1480528231286181948',
      model: 'zeroentropyai:zerank-2',
      reason: 'auth',
    });
    expect(notifications[0]!.message).toContain('Active degrade');
    expect(notifications[0]!.message).toContain('un-reranked');

    const healthy = opts(async () => [
      { index: 1, relevanceScore: 0.9 },
      { index: 0, relevanceScore: 0.8 },
    ]);
    expect((await applyReranker('q3', input, healthy)).map((x) => x.slug)).toEqual(['second', 'first']);
    expect(await applyReranker('q4', input, healthy)).toHaveLength(2);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({
      kind: 'recovered',
      severity: 'info',
      target: '1480528231286181948',
      model: 'zeroentropyai:zerank-2',
      reason: 'auth',
    });

    const timeoutFailure = opts(async () => {
      throw new RerankError('rerank timed out', 'timeout');
    });
    expect(await applyReranker('q5', input, timeoutFailure)).toEqual(input);
    expect(notifications).toHaveLength(3);
    expect(notifications[2]).toMatchObject({
      kind: 'degraded',
      target: '1480528231286181948',
      reason: 'timeout',
    });
  });

  test('empty upstream response degrades loudly instead of silently passing through', async () => {
    const input = [result('only')];
    expect(await applyReranker('q', input, opts(async () => []))).toEqual(input);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'degraded',
      reason: 'unknown',
      target: '1480528231286181948',
    });
  });
});
