// test/ai-audit-wiring.test.mjs
// The privacy rule for the AI-actions audit, held where it can break: the
// public files carry counts only, CI never asks for the private report, and the
// private report can never be written inside the repo. The weekly job's private
// step is test/ai-audit-weekly.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { qualityModel } from '../lib/ai-quality.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(src(p));

// Everything a public counts file may say. A key outside this set, or a string
// that is not a sha, a date, a version, a week, a severity or a reason code,
// is how a piece or action name would get in -- so either fails the test.
const KEYS = new Set([
  'commit', 'committedAt', 'fetched', 'baseline', 'latestRelease', 'canvasFloor', 'catalog', 'pieces', 'actions', 'audience',
  'both', 'ai', 'human', 'unset', 'expr', 'factoryCalls', 'toolingErrors', 'grepLines', 'unresolvedProps', 'unregisteredUnchecked',
  'checks', 'S1', 'S1b', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'severity', 'allOptionalCheckbox', 'demoted', 'reason', 'exempt',
  'k4', 'p1Actions', 'p1PassPct', 'piecesCleanOfP1', 'piecesCleanIncludingS2', 'soft', 'descWords', 'p10', 'median', 'p90', 'props', 'max',
  'measured', 'npm', 'atMain', 'atMainPct', 'behind', 'lagMinutes', 'n', 'collisions', 'cloud', 'registered', 'served', 'servedPct',
  'servedWithAi', 'servedWithAiPct', 'stuck24h', 'count',
]);
const STRING = [
  /^[0-9a-f]{7,40}$/, /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/, /^\d+\.\d+\.\d+$/, /^P[12]$/,
  /^(no-baseline|no-breaking-changes-docs|no-latest-release)$/,
];
function countsOnly(value, at, { keys = KEYS, strings = STRING } = {}) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    assert.ok(strings.some((re) => re.test(value)), `${at} = ${JSON.stringify(value)} is not a sha, date, version or code`);
    return;
  }
  assert.ok(!Array.isArray(value) || keys !== KEYS, `${at} is a list — the counts files have none`);
  for (const [k, v] of Object.entries(value)) {
    if (!Array.isArray(value)) assert.ok(keys.has(k), `${at}.${k}: not a known counts key`);
    countsOnly(v, `${at}.${k}`, { keys, strings });
  }
}

test('the committed data/ai-audit.json and data/ai-rollout.json are counts only', () => {
  for (const f of ['data/ai-audit.json', 'data/ai-rollout.json']) {
    if (!existsSync(join(ROOT, f))) continue;
    countsOnly(json(f), f);
  }
  assert.ok(existsSync(join(ROOT, 'data/ai-audit.json')), 'data/ai-audit.json is committed');
});

// Belt and braces on the same files: no piece folder name appears as a value.
// (`ai` is both a counts key and a piece, which is why keys are checked by the
// allowlist above and only values here.)
test('no piece slug appears as a value in the public counts', () => {
  const slugs = Object.keys(json('data/ai-audit-baseline.json').pieces);
  assert.ok(slugs.length > 600);
  const values = [];
  const collect = (v) => { if (typeof v === 'string') values.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  for (const f of ['data/ai-audit.json', 'data/ai-rollout.json']) if (existsSync(join(ROOT, f))) collect(json(f));
  for (const v of values) assert.ok(!slugs.includes(v), `"${v}" is a piece`);
});

// The page embeds the quality model in public HTML; it must be counts plus the
// check titles and week ids, built only from the counts files.
test('the page model built from the committed files is counts only', () => {
  const audit = json('data/ai-audit.json');
  const rollout = existsSync(join(ROOT, 'data/ai-rollout.json')) ? json('data/ai-rollout.json') : null;
  const m = qualityModel({ audit, rollout, pace: null });
  const keys = new Set([...KEYS, 'audit', 'rollout', 'k1', 'k3', 'k9', 'pct', 'withAiPct', 'lag', 'passPct', 'failing', 'piecesClean',
    'baselineCommit', 'baselineAt', 'id', 'floor', 's1All', 's8Exempt']);
  countsOnly(m, 'quality', { keys, strings: [...STRING, /^S\d+b?$/] });
});

test('npm run fetch runs the audit, and nothing CI runs asks for the private report', () => {
  const pkg = json('package.json');
  assert.match(pkg.scripts.fetch, /node scripts\/fetch-ai-audit\.mjs$/);
  for (const s of Object.values(pkg.scripts)) assert.doesNotMatch(s, /--private/);
  const yml = src('.github/workflows/deploy.yml');
  assert.doesNotMatch(yml, /--private|AI_AUDIT_PRIVATE/);
  const ci = yml.search(/^\s*- run: npm ci\b/m);
  assert.ok(ci >= 0, 'deploy.yml installs the pinned typescript');
  assert.ok(ci < yml.search(/^\s*- run: npm run fetch\b/m), 'before the fetch that needs it');
});

test('typescript is pinned to 5.9.3 in package.json and the lockfile', () => {
  assert.equal(json('package.json').devDependencies.typescript, '5.9.3');
  assert.equal(json('package-lock.json').packages['node_modules/typescript'].version, '5.9.3');
});

test('the page build never loads the TypeScript compiler', () => {
  for (const f of ['ai-actions/build.mjs', 'lib/ai-quality.mjs', 'lib/ai-rollout.mjs', 'lib/ai-checks.mjs']) {
    assert.doesNotMatch(src(f), /from ['"](typescript|\.\.?\/(lib\/)?ai-audit\.mjs)['"]/, f);
  }
});

test('a --private dir inside the repo is refused before anything is fetched', () => {
  const dir = join(ROOT, 'tmp-private-should-not-exist');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/fetch-ai-audit.mjs'), '--private', dir], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /outside this repo/);
  assert.ok(!existsSync(dir));
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts/fetch-ai-audit.mjs'), '--private', tmpdir(), '--out-dir', join(ROOT, 'data')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.status, 1, 'and so is a private run told to put its counts in the repo');
});
