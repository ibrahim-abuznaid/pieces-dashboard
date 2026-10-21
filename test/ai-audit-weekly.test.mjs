// test/ai-audit-weekly.test.mjs
// The weekly job's private AI-actions report must never cost the week: it runs
// once per ISO week, writes outside the repo, and a failure is a WARN line.
// These run the real block out of refresh-weekly.sh under the job's own
// `set -e` and ERR trap, with a stub `node`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

const sh = src('refresh-weekly.sh');
const stepBlock = () => {
  const start = sh.indexOf('AI_AUDIT_PRIVATE_DIR="${AI_AUDIT_PRIVATE_DIR-');
  const end = sh.indexOf('\n', sh.indexOf('ai_audit_private ||', start));
  assert.ok(start > 0 && end > start, 'refresh-weekly.sh has the private step');
  return sh.slice(start, end);
};

test('the private step defaults outside the repo, runs before the snapshot guard, and cannot abort the job', () => {
  const block = stepBlock();
  const dflt = /AI_AUDIT_PRIVATE_DIR-([^}]+)\}/.exec(block)[1];
  assert.ok(!dflt.startsWith(ROOT) && dflt.startsWith('/'), `default ${dflt} is outside the repo`);
  assert.match(block, /fetch-ai-audit\.mjs --private "\$AI_AUDIT_PRIVATE_DIR"/);
  assert.match(block, /^ai_audit_private \|\| log "WARN/m);
  assert.ok(sh.indexOf(block) < sh.indexOf('STATE="$(week_state)"'), 'the guard exits early on most runs, so the step goes first');
});

// The stub `node` answers the week lookup and records the audit call.
function runStep({ fakeExit, dir }) {
  const bin = mkdtempSync(join(tmpdir(), 'ai-step-bin-'));
  const calls = join(bin, 'calls');
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nif [ "$1" = "-e" ]; then echo 2026-W43; exit 0; fi\necho "$@" >> "${calls}"\nexit ${fakeExit}\n`);
  chmodSync(join(bin, 'node'), 0o755);
  const script = `set -euo pipefail\ntrap 'echo TRAPPED; exit 9' ERR\nlog() { echo "$*"; }\nTODAY=2026-10-21\n${stepBlock()}\necho AFTER\n`;
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_AUDIT_PRIVATE_DIR: dir } });
  return { ...r, calls: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('a failing private run logs a WARN, writes no stamp, and the job carries on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-step-dir-'));
  const r = runStep({ fakeExit: 1, dir });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WARN ai-audit private report failed/);
  assert.match(r.stdout, /AFTER/);
  assert.doesNotMatch(r.stdout, /TRAPPED/);
  assert.ok(!existsSync(join(dir, '.done-week')), 'a failed week is retried at the next run');
});

test('a good private run stamps the week, and the next run that week does nothing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'ai-step-dir-')), 'audit');
  mkdirSync(dir);
  const first = runStep({ fakeExit: 0, dir });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.calls.length, 1);
  assert.match(first.calls[0], /scripts\/fetch-ai-audit\.mjs --private /);
  assert.equal(readFileSync(join(dir, '.done-week'), 'utf8').trim(), '2026-W43');
  const second = runStep({ fakeExit: 0, dir });
  assert.equal(second.calls.length, 0, 'once per ISO week');
  assert.match(second.stdout, /AFTER/);
});

test('AI_AUDIT_PRIVATE_DIR="" turns the step off', () => {
  const r = runStep({ fakeExit: 1, dir: '' });
  assert.equal(r.calls.length, 0);
  assert.doesNotMatch(r.stdout, /WARN/);
});
