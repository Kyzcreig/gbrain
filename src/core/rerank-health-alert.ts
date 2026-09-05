/**
 * Local reranker health edge detector + fleet notification hook.
 *
 * Search remains fail-open. The first failure transition pages #alerts, repeated
 * failures stay suppressed, and the first subsequent valid rerank emits one
 * recovery to #alerts. State lives beside the rerank audit so transitions survive
 * process restarts and one-shot CLI invocations.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveAuditDir } from './audit/audit-writer.ts';
import type { RerankFailureReason } from './rerank-audit.ts';

const DISCORD_ALERTS_CHANNEL = '1480528231286181948';

interface RerankHealthState {
  status: 'healthy' | 'failed';
  updated_at: string;
  model?: string;
  reason?: RerankFailureReason;
}

export interface RerankHealthNotification {
  kind: 'degraded' | 'recovered';
  severity: 'error' | 'info';
  target: string;
  model: string;
  reason: RerankFailureReason;
  message: string;
}

type Reporter = (notification: RerankHealthNotification) => void;

let statePathForTests: string | null = null;
let reporterForTests: Reporter | null = null;

function statePath(): string {
  const override = process.env.GBRAIN_RERANK_HEALTH_STATE_FILE?.trim();
  return statePathForTests ?? override ?? join(resolveAuditDir(), 'rerank-health-state.json');
}

function readState(): RerankHealthState {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8')) as RerankHealthState;
    if (parsed.status === 'failed' || parsed.status === 'healthy') return parsed;
  } catch {
    // Missing/corrupt state fails loud: treat the next failure as a fresh edge.
  }
  return { status: 'healthy', updated_at: new Date(0).toISOString() };
}

function writeState(state: RerankHealthState): boolean {
  const file = statePath();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] reranker health state write failed (${message}); transition remains fail-loud\n`);
    return false;
  }
}

function defaultReporter(notification: RerankHealthNotification): void {
  const notifyPath = process.env.GBRAIN_RERANK_NOTIFY_PATH?.trim()
    || join(homedir(), '.hermes', 'scripts', 'notify.py');
  if (!existsSync(notifyPath)) {
    process.stderr.write(`[gbrain] reranker health notification helper missing: ${notifyPath}\n`);
    return;
  }
  const python = process.env.GBRAIN_RERANK_NOTIFY_PYTHON?.trim() || '/usr/bin/python3';
  const hermesHome = process.env.GBRAIN_RERANK_NOTIFY_HERMES_HOME?.trim()
    || join(homedir(), '.hermes');
  const child = spawn(
    python,
    [
      notifyPath,
      '--send', notification.message,
      '--channel', 'discord',
      '--target', notification.target,
      '--sev', notification.severity,
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, HERMES_HOME: hermesHome },
    },
  );
  child.on('error', (err) => {
    process.stderr.write(`[gbrain] reranker health notification spawn failed (${err.message})\n`);
  });
  child.unref();
}

function report(notification: RerankHealthNotification): void {
  try {
    (reporterForTests ?? defaultReporter)(notification);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] reranker health notification failed (${message}); search continues\n`);
  }
}

export function recordRerankFailure(input: {
  model: string;
  reason: RerankFailureReason;
}): 'notified' | 'suppressed' {
  // Ordinary Bun unit tests exercise fail-open paths with synthetic failures.
  // Only the dedicated health contract installs a reporter seam; all other
  // tests must not mutate operator state or page real channels.
  if (process.env.NODE_ENV === 'test' && reporterForTests === null) return 'suppressed';
  const state = readState();
  if (state.status === 'failed') return 'suppressed';

  const now = new Date().toISOString();
  writeState({ status: 'failed', updated_at: now, model: input.model, reason: input.reason });
  report({
    kind: 'degraded',
    severity: 'error',
    target: DISCORD_ALERTS_CHANNEL,
    model: input.model,
    reason: input.reason,
    message:
      `🔴 **gbrain reranker · degraded**\n` +
      `Failure: ${input.reason} (${input.model})\n` +
      'Active degrade: search is returning un-reranked hybrid results.',
  });
  return 'notified';
}

export function recordRerankSuccess(input: { model: string }): 'notified' | 'noop' {
  if (process.env.NODE_ENV === 'test' && reporterForTests === null) return 'noop';
  const state = readState();
  if (state.status !== 'failed') return 'noop';

  const priorReason = state.reason ?? 'unknown';
  writeState({ status: 'healthy', updated_at: new Date().toISOString(), model: input.model });
  report({
    kind: 'recovered',
    severity: 'info',
    target: DISCORD_ALERTS_CHANNEL,
    model: input.model,
    reason: priorReason,
    message:
      `🟢 **gbrain reranker · recovered**\n` +
      `Prior failure: ${priorReason} (${state.model ?? input.model})\n` +
      'Reranking is active again; search has left degraded mode.',
  });
  return 'notified';
}

export function __setRerankHealthReporterForTests(reporter: Reporter | null): void {
  reporterForTests = reporter;
}

export function __setRerankHealthStatePathForTests(path: string | null): void {
  statePathForTests = path;
}
