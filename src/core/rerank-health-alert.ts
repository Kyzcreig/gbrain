/**
 * Local reranker health edge detector + fleet notification hook.
 *
 * Search remains fail-open. A failure opens a degrade episode but does NOT page:
 * the local reranker sits behind an SSH tunnel to a host that reboots and
 * dual-boots, and every short flap used to page #alerts (9 pages/day on
 * 2026-10-09, card t_96c519fb). The episode pages #alerts only when a failure
 * is still observed PAGE_HOLD_MS after it opened, and at most once per
 * PAGE_COOLDOWN_MS; a later episode inside the cooldown gets one #logs line.
 * Recovery of an announced episode goes to #logs (resolves are not pages).
 * Brief flaps that recover inside the hold stay in the rerank-failures audit
 * only. State lives beside the rerank audit so transitions survive process
 * restarts and one-shot CLI invocations.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveAuditDir } from './audit/audit-writer.ts';
import type { RerankFailureReason } from './rerank-audit.ts';

const DISCORD_ALERTS_CHANNEL = '1480528231286181948';
const DISCORD_LOGS_CHANNEL = '1480525090331561984';
/** Producer name in the fleet notify ledger and pager-owners.json (t_ea800980). */
export const RERANK_NOTIFY_PRODUCER = 'gbrain-rerank-health';

/** A degrade must still be failing this long after it opened before it pages. */
const PAGE_HOLD_MS = 15 * 60 * 1000;
/** At most one #alerts page per this window; later episodes go to #logs. */
const PAGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * FLEET FORK PATCH (t_38369f66): the local zerank-2 primary lives on ACE-AI (tunnel :18084), a dual-boot
 * box. Booted into Windows on purpose, the reranker is OFF by design, not degraded: 10-11 13:08 PT ACE-AI
 * went to Windows and 13:25 PT this paged #alerts 'degraded'. A ping/:22 probe cannot tell (Windows answers
 * both), so ask the fleet's host_os preflight, the same one every OS-dependent cron uses: rc 76 = the host
 * is in its other OS. A transport failure there is announced once to #logs as DEFERRED. Any probe error,
 * a Linux/down host, or a non-transport reason keeps the #alerts page.
 */
const RERANK_HOST = process.env.GBRAIN_RERANK_HOST?.trim() || 'ace-ai';
const HOST_OS_RC_OTHER_OS = 76;
const TRANSPORT_REASONS = new Set<RerankFailureReason>(['network', 'timeout']);

interface RerankHealthState {
  status: 'healthy' | 'failed';
  updated_at: string;
  model?: string;
  reason?: RerankFailureReason;
  /** ISO time the current degrade episode opened (status=failed only). */
  failed_since?: string;
  /** True once the current episode was announced (#alerts page or #logs line). */
  announced?: boolean;
  /** ISO time of the last #alerts page; survives recovery so the cooldown holds. */
  last_paged_at?: string;
  /** True when the episode was announced as DEFERRED (host in its other OS). */
  os_deferred?: boolean;
}

export interface RerankHealthNotification {
  kind: 'degraded' | 'deferred' | 'recovered';
  severity: 'error' | 'warn' | 'info';
  target: string;
  model: string;
  reason: RerankFailureReason;
  message: string;
}

type Reporter = (notification: RerankHealthNotification) => void;
/** The host_os preflight line when the reranker host is in its other OS, else null. */
type OsDeferral = () => string | null;

let statePathForTests: string | null = null;
let reporterForTests: Reporter | null = null;
let nowForTests: (() => number) | null = null;
let osDeferralForTests: OsDeferral | null = null;

function defaultOsDeferral(): string | null {
  const hostOs = process.env.GBRAIN_RERANK_HOST_OS_PATH?.trim()
    || join(homedir(), '.hermes', 'scripts', 'lib', 'host_os.py');
  if (!existsSync(hostOs)) return null;
  const r = spawnSync('/usr/bin/python3', [hostOs, RERANK_HOST, '--require', 'linux', '--job', 'gbrain-reranker'],
    { encoding: 'utf8', timeout: 8000 });
  if (r.error || r.status !== HOST_OS_RC_OTHER_OS) return null;
  return (r.stderr || r.stdout || '').trim() || `${RERANK_HOST} is in its other OS (host_os rc 76)`;
}

function osDeferral(): string | null {
  try {
    return (osDeferralForTests ?? defaultOsDeferral)();
  } catch {
    return null;  // fail toward the page
  }
}

function nowMs(): number {
  return nowForTests ? nowForTests() : Date.now();
}

function msSince(iso: string | undefined, now: number): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY;
}

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
      // NOTIFY_PRODUCER names this sender in notify.py's send ledger (else it books
      // `unknown`: the parent is bun) and lets fleet-hosts.json list it as an
      // ace-ai dependent, so a page during an announced ace-ai down goes to #logs.
      env: { ...process.env, HERMES_HOME: hermesHome, NOTIFY_PRODUCER: RERANK_NOTIFY_PRODUCER },
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
  const now = nowMs();
  const nowIso = new Date(now).toISOString();

  if (state.status !== 'failed') {
    // Open the episode silently; it pages only if it outlives PAGE_HOLD_MS.
    writeState({
      status: 'failed',
      updated_at: nowIso,
      model: input.model,
      reason: input.reason,
      failed_since: nowIso,
      announced: false,
      ...(state.last_paged_at ? { last_paged_at: state.last_paged_at } : {}),
    });
    return 'suppressed';
  }
  if (state.announced) return 'suppressed';
  const openFor = msSince(state.failed_since, now);
  if (openFor < PAGE_HOLD_MS) return 'suppressed';

  const minutes = Number.isFinite(openFor) ? Math.round(openFor / 60000) : PAGE_HOLD_MS / 60000;
  const deferral = TRANSPORT_REASONS.has(input.reason) ? osDeferral() : null;
  if (deferral) {
    writeState({ ...state, updated_at: nowIso, model: input.model, reason: input.reason, announced: true,
      os_deferred: true });
    report({
      kind: 'deferred',
      severity: 'info',
      target: DISCORD_LOGS_CHANNEL,
      model: input.model,
      reason: input.reason,
      message: `⏸️ gbrain reranker · DEFERRED (host in other OS), not degraded: ${input.reason} ` +
        `(${input.model}) for ${minutes} min. ${deferral}. Search is un-reranked until it boots Linux.`,
    });
    return 'notified';
  }
  const page = msSince(state.last_paged_at, now) >= PAGE_COOLDOWN_MS;
  writeState({
    ...state,
    updated_at: nowIso,
    model: input.model,
    reason: input.reason,
    announced: true,
    ...(page ? { last_paged_at: nowIso } : {}),
  });
  report({
    kind: 'degraded',
    severity: page ? 'error' : 'warn',
    target: page ? DISCORD_ALERTS_CHANNEL : DISCORD_LOGS_CHANNEL,
    model: input.model,
    reason: input.reason,
    message: page
      ? `🔴 **gbrain reranker · degraded**\n` +
        `Failure: ${input.reason} (${input.model}), failing for ${minutes} min\n` +
        'Active degrade: search is returning un-reranked hybrid results.'
      : `🟠 gbrain reranker · degraded again: ${input.reason} (${input.model}), failing for ${minutes} min. ` +
        'Already paged in the last 6 h, so this is logged, not paged. Search is un-reranked.',
  });
  return 'notified';
}

export function recordRerankSuccess(input: { model: string }): 'notified' | 'noop' {
  if (process.env.NODE_ENV === 'test' && reporterForTests === null) return 'noop';
  const state = readState();
  if (state.status !== 'failed') return 'noop';

  const priorReason = state.reason ?? 'unknown';
  writeState({
    status: 'healthy',
    updated_at: new Date(nowMs()).toISOString(),
    model: input.model,
    ...(state.last_paged_at ? { last_paged_at: state.last_paged_at } : {}),
  });
  // A flap that recovered inside the hold was never announced: nothing to resolve.
  if (!state.announced) return 'noop';
  report({
    kind: 'recovered',
    severity: 'info',
    target: DISCORD_LOGS_CHANNEL,
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

/** The real notify.py spawn, for the contract test that pins its env (t_ea800980). */
export const __defaultRerankReporterForTests: Reporter = defaultReporter;

export function __setRerankOsDeferralForTests(probe: OsDeferral | null): void {
  osDeferralForTests = probe;
}

export function __setRerankHealthClockForTests(now: (() => number) | null): void {
  nowForTests = now;
}
