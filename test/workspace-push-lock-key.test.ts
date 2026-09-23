/**
 * pushLockDir() keys the push lock on the CANONICAL repo path (Kyzcreig/gbrain#2).
 *
 * workspacePush() derives its root from `git rev-parse --show-toplevel` (physical path) while a
 * caller may hold the same repo through a symlink — on macOS mkdtemp() gives /var/... and git
 * gives /private/var/.... Hashing the raw string once produced TWO lock dirs for ONE repo, so a
 * second pusher never saw the first. These tests pin the contract the fix restored, plus the
 * fallback branch (a path that no longer exists still yields a deterministic lock path).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGbrainHome } from '../src/core/gbrain-home.ts';
import { pushLockDir } from '../src/core/workspace-push.ts';
import { withEnv } from './helpers/with-env.ts';

describe('pushLockDir — canonical lock key', () => {
  test('a symlinked path, its raw path and its realpath all share ONE lock dir', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-lockkey-home-'));
    const real = mkdtempSync(join(tmpdir(), 'gb-lockkey-repo-'));
    const linkParent = mkdtempSync(join(tmpdir(), 'gb-lockkey-link-'));
    const link = join(linkParent, 'via-symlink');
    symlinkSync(real, link);
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        const viaRaw = pushLockDir(real);
        const viaLink = pushLockDir(link);
        const viaReal = pushLockDir(realpathSync(real));
        expect(viaLink).toBe(viaRaw);
        expect(viaReal).toBe(viaRaw);
        expect(viaRaw.startsWith(join(ensureGbrainHome(), 'locks'))).toBe(true);
        expect(viaRaw).toMatch(/\/push-[0-9a-f]{16}\.lock$/);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
      rmSync(linkParent, { recursive: true, force: true });
    }
  });

  test('a repo path that no longer exists still yields a deterministic lock path (fallback, never throws)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gb-lockkey-home-'));
    const gone = join(tmpdir(), `gb-lockkey-absent-${process.pid}-${Date.now()}`);
    try {
      await withEnv({ GBRAIN_HOME: home }, () => {
        const a = pushLockDir(gone);
        const b = pushLockDir(gone);
        expect(a).toBe(b);
        expect(a.startsWith(join(ensureGbrainHome(), 'locks'))).toBe(true);
        // and a different absent path keys differently — the fallback still discriminates repos
        expect(pushLockDir(gone + '-other')).not.toBe(a);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
