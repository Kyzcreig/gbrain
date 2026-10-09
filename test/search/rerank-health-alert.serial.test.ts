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
  __setRerankHealthClockForTests,
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
let clock = 0;
const MIN = 60 * 1000;
const ALERTS = '1480528231286181948';
const LOGS = '1480525090331561984';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-rerank-health-'));
  notifications = [];
  clock = Date.parse('2026-10-09T12:00:00Z');
  __setRerankHealthClockForTests(() => clock);
  __setRerankHealthStatePathForTests(join(dir, 'state.json'));
  __setRerankHealthReporterForTests((notification) => {
    notifications.push(notification);
  });
});

afterEach(() => {
  __setRerankHealthReporterForTests(null);
  __setRerankHealthStatePathForTests(null);
  __setRerankHealthClockForTests(null);
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

const healthyFn: RerankerOpts['rerankerFn'] = async () => [
  { index: 1, relevanceScore: 0.9 },
  { index: 0, relevanceScore: 0.8 },
];

describe('applyReranker health transitions', () => {
  test('sustained failure pages once after the hold, suppresses repeats, recovers to #logs', async () => {
    const input = [result('first'), result('second')];
    const authFailure = opts(async () => {
      throw new RerankError('invalid api key', 'auth', 401);
    });

    // Opening edge is silent.
    expect(await applyReranker('q1', input, authFailure)).toEqual(input);
    clock += 14 * MIN;
    expect(await applyReranker('q2', input, authFailure)).toEqual(input);
    expect(notifications).toHaveLength(0);

    // Still failing past the 15 min hold: one page.
    clock += 2 * MIN;
    expect(await applyReranker('q3', input, authFailure)).toEqual(input);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'degraded',
      severity: 'error',
      target: ALERTS,
      model: 'zeroentropyai:zerank-2',
      reason: 'auth',
    });
    expect(notifications[0]!.message).toContain('Active degrade');
    expect(notifications[0]!.message).toContain('un-reranked');
    expect(notifications[0]!.message).toContain('16 min');

    clock += 30 * MIN;
    expect(await applyReranker('q4', input, authFailure)).toEqual(input);
    expect(notifications).toHaveLength(1);

    const healthy = opts(healthyFn);
    expect((await applyReranker('q5', input, healthy)).map((x) => x.slug)).toEqual(['second', 'first']);
    expect(await applyReranker('q6', input, healthy)).toHaveLength(2);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({
      kind: 'recovered',
      severity: 'info',
      target: LOGS,
      reason: 'auth',
    });
  });

  test('a flap that recovers inside the hold sends nothing', async () => {
    const input = [result('first'), result('second')];
    const timeoutFailure = opts(async () => {
      throw new RerankError('rerank timed out', 'timeout');
    });
    for (let i = 0; i < 9; i++) {
      expect(await applyReranker(`f${i}`, input, timeoutFailure)).toEqual(input);
      clock += 5 * MIN;
      expect(await applyReranker(`f${i}b`, input, timeoutFailure)).toEqual(input);
      clock += 5 * MIN;
      expect(await applyReranker(`h${i}`, input, opts(healthyFn))).toHaveLength(2);
      clock += 60 * MIN;
    }
    expect(notifications).toHaveLength(0);
  });

  test('a second sustained episode inside the 6 h cooldown goes to #logs, after it pages again', async () => {
    const input = [result('first'), result('second')];
    const failure = opts(async () => {
      throw new RerankError('rerank timed out', 'timeout');
    });
    const sustain = async () => {
      await applyReranker('a', input, failure);
      clock += 20 * MIN;
      await applyReranker('b', input, failure);
    };

    await sustain();
    expect(notifications.map((n) => n.target)).toEqual([ALERTS]);
    await applyReranker('ok', input, opts(healthyFn));
    clock += 60 * MIN;

    await sustain();
    expect(notifications).toHaveLength(3);
    expect(notifications[2]).toMatchObject({ kind: 'degraded', severity: 'warn', target: LOGS });
    await applyReranker('ok', input, opts(healthyFn));

    clock += 6 * 60 * MIN;
    await sustain();
    expect(notifications.at(-1)).toMatchObject({ kind: 'degraded', severity: 'error', target: ALERTS });
  });

  test('empty upstream response still opens a degrade and pages once it is sustained', async () => {
    const input = [result('only')];
    expect(await applyReranker('q', input, opts(async () => []))).toEqual(input);
    expect(notifications).toHaveLength(0);
    clock += 16 * MIN;
    expect(await applyReranker('q', input, opts(async () => []))).toEqual(input);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'degraded',
      reason: 'unknown',
      target: ALERTS,
    });
  });
});
