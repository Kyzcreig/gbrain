/**
 * Heavy Tests paid-leg wiring pin — provider-keys preload vs step env.
 *
 * bunfig.toml preloads test/helpers/provider-keys-preload.ts into EVERY
 * `bun test` process. It deletes the provider keys in its STRIPPED_KEYS list
 * from process.env unless GBRAIN_TEST_KEEP_PROVIDER_KEYS=1. A CI step that
 * passes one of those keys via `env:` and then relies on the test file seeing
 * it in process.env is silently keyless (2026-09-24, Heavy Tests run
 * 36066563665: opencode door T5 skipped with ANTHROPIC_API_KEY present,
 * hasOpencodeAuth() read an already-stripped env).
 *
 * Rule: every step in heavy-tests.yml that carries a PAID-SENTINEL (greps the
 * suite's 'SKIP paid tier' log line to refuse green) AND passes a STRIPPED key
 * in its env must also set GBRAIN_TEST_KEEP_PROVIDER_KEYS: '1'. The strip list
 * is read from the preload source, so a key newly added there (e.g. XAI) puts
 * the matching door under this rule automatically.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const yml = readFileSync(join(repoRoot, '.github/workflows/heavy-tests.yml'), 'utf8');
const preload = readFileSync(join(repoRoot, 'test/helpers/provider-keys-preload.ts'), 'utf8');

function strippedKeys(src: string): string[] {
  const m = src.match(/const STRIPPED_KEYS = \[([\s\S]*?)\]/);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/'([A-Z0-9_]+)'/g)].map((x) => x[1]);
}

/** Split the workflow into step blocks (`      - name:` / `      - uses:` at 6-space indent). */
function stepBlocks(src: string): string[] {
  return src.split(/\n(?=      - (?:name|uses|run):)/);
}

/** Env var names declared in the step's own `env:` mapping (10-space keys). */
function stepEnvKeys(block: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = block.match(/\n        env:\n((?:          [^\n]*\n|\s*#[^\n]*\n)+)/);
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^          ([A-Z0-9_]+):\s*(.*)$/);
    if (kv) out.set(kv[1], kv[2].trim());
  }
  return out;
}

describe('heavy-tests paid-sentinel steps keep provider keys through the preload', () => {
  const STRIPPED = strippedKeys(preload);

  test('strip list parsed (non-vacuous)', () => {
    expect(STRIPPED).toContain('ANTHROPIC_API_KEY');
  });

  const sentinelSteps = stepBlocks(yml).filter((b) => b.includes("grep -q 'SKIP paid tier'"));

  test('at least the opencode paid step is covered by the rule', () => {
    const covered = sentinelSteps.filter((b) =>
      [...stepEnvKeys(b).keys()].some((k) => STRIPPED.includes(k)),
    );
    expect(covered.some((b) => b.includes('install-real-opencode.serial.test.ts'))).toBe(true);
  });

  for (const block of sentinelSteps) {
    const name = block.match(/- name: ([^\n]+)/)?.[1] ?? '(unnamed step)';
    const env = stepEnvKeys(block);
    const strippedHere = [...env.keys()].filter((k) => STRIPPED.includes(k));
    if (strippedHere.length === 0) continue;
    test(`"${name}" passes ${strippedHere.join(', ')} → must set GBRAIN_TEST_KEEP_PROVIDER_KEYS: '1'`, () => {
      expect(env.get('GBRAIN_TEST_KEEP_PROVIDER_KEYS')).toBe("'1'");
    });
  }
});
