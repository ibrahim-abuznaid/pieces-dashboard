// test/weekly-verify.test.mjs
// Everything here is offline: the live page is a real build of the real template
// (via buildAll) and every fetch is a stub. A test that reached the network
// would fail on a plane and pass on a broken deploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../weekly/build.mjs';
import {
  parseEmbeddedArchive, renderLive, weekProblems, checkLive, fetchLivePage, fetchUntil,
  pickRun, awaitRun, runChecks, daysBetween, parseArgs, localToday,
  WORKFLOW_NAME, MAX_SNAPSHOT_AGE_DAYS,
} from '../verify-weekly.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5 }, prsMerged: {}, reviews: {}, shipped: [] },
  decisions: [], ...over,
});

// The page under test is built by the same code CI builds it with, so these
// tests break if the template stops embedding an archive or stops rendering.
function page(weeks) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/weeks.json'), JSON.stringify({ weeks }));
  return buildAll({ archiveDir: join(dir, 'data'), outDir: join(dir, 'out') }).html;
}

const noSleep = async () => {};

// --- parsing the embedded blob ------------------------------------------------

test('parseEmbeddedArchive reads the blob a built page actually carries', () => {
  const archive = parseEmbeddedArchive(page([snap('2026-W30'), snap('2026-W31')]));
  assert.equal(archive.default, '2026-W31');
  assert.deepEqual(Object.keys(archive.views).sort(), ['2026-W30', '2026-W31']);
});

test('parseEmbeddedArchive rejects a page that is not the weekly page', () => {
  assert.throws(() => parseEmbeddedArchive('<html><body>404</body></html>'), /not the weekly page/);
});

test('parseEmbeddedArchive rejects an unbuilt template', () => {
  const tpl = readFileSync(new URL('../weekly/template.html', import.meta.url), 'utf8');
  assert.throws(() => parseEmbeddedArchive(tpl), /placeholder/);
});

test('parseEmbeddedArchive rejects a truncated blob rather than returning junk', () => {
  assert.throws(() => parseEmbeddedArchive('<script>const ARCHIVE = {"views":;</script>'), /not valid JSON/);
});

test('parseEmbeddedArchive rejects an empty body', () => {
  assert.throws(() => parseEmbeddedArchive(''), /empty/);
});

// --- executing the page ------------------------------------------------------

test('renderLive produces the DOM the page builds client-side', () => {
  const html = page([snap('2026-W31')]);
  const dom = renderLive(html);
  assert.match(dom, /2026-W31/);
  assert.match(dom, /Pieces Team/);
  // Why this whole approach exists: outside the embedded blob the raw HTML says
  // nothing about which week it serves, so grepping the served file for a week
  // id is a guaranteed false negative.
  assert.doesNotMatch(html.replace(/const ARCHIVE = [\s\S]*?;\s*<\/script>/, ''), /2026-W31/);
});

test('renderLive surfaces a page whose own script throws', () => {
  assert.throws(() => renderLive('<script>const ARCHIVE = {};</script><script>boom()</script>'),
    /boom is not defined/);
});

test('renderLive rejects a page with no scripts at all', () => {
  assert.throws(() => renderLive('<html><body><div id="app"></div></body></html>'), /no inline <script>/);
});

test('renderLive rejects a page that runs but renders nothing', () => {
  assert.throws(() => renderLive('<script>const x = 1;</script>'), /left #app empty/);
});

// --- matching vs mismatched week ---------------------------------------------

test('checkLive passes when the page serves the expected week', () => {
  const r = checkLive({ html: page([snap('2026-W31')]), expectWeek: '2026-W31' });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.deepEqual(r.problems, []);
});

test('checkLive fails on a deliberately wrong week id', () => {
  const r = checkLive({ html: page([snap('2026-W31')]), expectWeek: '2026-W99' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('; '), /defaults to 2026-W31, expected 2026-W99/);
  assert.match(r.problems.join('; '), /no view for 2026-W99/);
});

test('checkLive catches a stale build — right week committed, older week served', () => {
  // What a Pages deploy that never picked up the push looks like from outside.
  const r = checkLive({ html: page([snap('2026-W30')]), expectWeek: '2026-W31' });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('; '), /defaults to 2026-W30, expected 2026-W31/);
});

test('weekProblems flags a week present in views but not the default', () => {
  const archive = { default: '2026-W30', views: { '2026-W30': {}, '2026-W31': {} } };
  const problems = weekProblems({ archive, dom: 'shows 2026-W31', expectWeek: '2026-W31' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /defaults to 2026-W30/);
});

test('weekProblems flags the empty-archive placeholder', () => {
  const problems = weekProblems({
    archive: { default: null, views: {} }, dom: 'No weeks recorded yet', expectWeek: '2026-W31',
  });
  assert.match(problems.join('; '), /defaults to null/);
  assert.match(problems.join('; '), /empty-archive placeholder/);
});

// --- fetching ----------------------------------------------------------------

test('fetchLivePage busts the CDN cache and returns the body', async () => {
  const seen = [];
  const html = await fetchLivePage('https://example.test/weekly/', {
    fetchImpl: async (url, init) => {
      seen.push([url, init]);
      return { ok: true, status: 200, text: async () => '<html>ok</html>' };
    },
  });
  assert.equal(html, '<html>ok</html>');
  assert.match(seen[0][0], /\?_verify=\d+$/);
  assert.equal(seen[0][1].headers['cache-control'], 'no-cache');
});

test('fetchLivePage turns a 404 into a clear error', async () => {
  await assert.rejects(
    () => fetchLivePage('https://example.test/weekly/', { fetchImpl: async () => ({ ok: false, status: 404 }) }),
    /HTTP 404/,
  );
});

test('fetchUntil retries Pages lag and passes once the new build appears', async () => {
  const bodies = [page([snap('2026-W30')]), page([snap('2026-W30')]), page([snap('2026-W31')])];
  let n = 0;
  const logs = [];
  const r = await fetchUntil({
    url: 'https://example.test/', expectWeek: '2026-W31', attempts: 5, delayMs: 1, sleep: noSleep,
    log: (m) => logs.push(m),
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => bodies[n++] }),
  });
  assert.equal(r.ok, true, r.problems.join('; '));
  assert.equal(n, 3);
  assert.equal(logs.length, 3);
  assert.match(logs.at(-1), /is being served/);
});

test('fetchUntil gives up after the last attempt and keeps the reason', async () => {
  let n = 0;
  const r = await fetchUntil({
    url: 'https://example.test/', expectWeek: '2026-W31', attempts: 3, delayMs: 1, sleep: noSleep,
    fetchImpl: async () => { n++; return { ok: true, status: 200, text: async () => page([snap('2026-W30')]) }; },
  });
  assert.equal(r.ok, false);
  assert.equal(n, 3);
  assert.match(r.problems.join('; '), /expected 2026-W31/);
});

test('fetchUntil reports a network failure instead of throwing', async () => {
  const r = await fetchUntil({
    url: 'https://example.test/', expectWeek: '2026-W31', attempts: 2, delayMs: 1, sleep: noSleep,
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('; '), /fetch failed: ENOTFOUND/);
});

// --- picking the right CI run -----------------------------------------------

const run = (over = {}) => ({
  workflowName: WORKFLOW_NAME, status: 'completed', conclusion: 'success',
  url: 'https://github.test/run/1', createdAt: '2026-08-08T06:00:00Z', ...over,
});

test('pickRun ignores the Claim bot runs that share the commit', () => {
  const picked = pickRun([
    run({ workflowName: 'Claim bot', conclusion: 'skipped', url: 'https://github.test/claim', createdAt: '2026-08-08T07:00:00Z' }),
    run({ url: 'https://github.test/deploy' }),
  ]);
  assert.equal(picked.url, 'https://github.test/deploy');
});

test('pickRun takes the newest deploy run — the pages group cancels older ones', () => {
  const picked = pickRun([
    run({ createdAt: '2026-08-08T06:00:00Z', url: 'https://github.test/old' }),
    run({ createdAt: '2026-08-08T06:05:00Z', url: 'https://github.test/new' }),
  ]);
  assert.equal(picked.url, 'https://github.test/new');
});

test('pickRun returns null when only other workflows ran for the commit', () => {
  assert.equal(pickRun([run({ workflowName: 'Claim bot' })]), null);
  assert.equal(pickRun([]), null);
  assert.equal(pickRun(null), null);
});

// --- waiting for the run ----------------------------------------------------

test('awaitRun succeeds on an already-finished run without sleeping', async () => {
  let slept = 0;
  const r = await awaitRun({
    sha: 'abc1234', listRuns: () => [run()], sleep: async () => { slept++; },
  });
  assert.equal(r.ok, true);
  assert.equal(slept, 0);
  assert.equal(r.run.url, 'https://github.test/run/1');
});

test('awaitRun polls while the run is queued then in_progress', async () => {
  const states = ['queued', 'in_progress', 'completed'];
  let i = 0;
  const logs = [];
  const r = await awaitRun({
    sha: 'abc1234', sleep: noSleep, log: (m) => logs.push(m), pollMs: 1,
    listRuns: () => [run({ status: states[i++], conclusion: states[i - 1] === 'completed' ? 'success' : null })],
  });
  assert.equal(r.ok, true);
  assert.equal(logs.length, 3);
  assert.match(logs[0], /run is queued/);
  assert.match(logs[1], /run is in_progress/);
  assert.match(logs[2], /completed — success/);
});

test('awaitRun fails loudly on a red run and keeps the URL', async () => {
  const r = await awaitRun({
    sha: 'abc1234', sleep: noSleep, listRuns: () => [run({ conclusion: 'failure', url: 'https://github.test/red' })],
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, false);
  assert.equal(r.run.url, 'https://github.test/red');
});

test('awaitRun times out rather than waiting forever for a run that never appears', async () => {
  let clock = 0;
  const logs = [];
  const r = await awaitRun({
    sha: 'abc1234', listRuns: () => [], sleep: async () => { clock += 20_000; }, log: (m) => logs.push(m),
    now: () => clock, timeoutMs: 60_000, pollMs: 20_000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.match(logs[0], /no "Refresh & deploy" run for abc1234 yet/);
  assert.match(logs.at(-1), /giving up/);
});

test('awaitRun treats a transient gh failure as "retry", not "deploy failed"', async () => {
  let call = 0;
  const logs = [];
  const r = await awaitRun({
    sha: 'abc1234', sleep: noSleep, log: (m) => logs.push(m),
    listRuns: () => {
      if (++call === 1) throw new Error('gh: connection reset');
      return [run()];
    },
  });
  assert.equal(r.ok, true);
  assert.match(logs[0], /could not list runs \(gh: connection reset\) — will retry/);
});

// --- the daily health check --------------------------------------------------

const check = (result, name) => result.checks.find((c) => c.name === name);

const healthy = (over = {}) => ({
  liveHtml: page([snap('2026-W31', { builtAt: '2026-08-08' })]),
  archive: { weeks: [snap('2026-W31', { builtAt: '2026-08-08' })] },
  today: '2026-08-10',
  marker: { present: false },
  ...over,
});

test('runChecks passes on a healthy, fresh, matching deploy', () => {
  const r = runChecks(healthy());
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.equal(check(r, 'live page').ok, true);
  assert.equal(check(r, 'default week').ok, true);
  assert.equal(check(r, 'archive valid').ok, true);
  assert.equal(check(r, 'snapshot fresh').ok, true);
  assert.equal(check(r, 'linear refresh').ok, true);
});

test('runChecks fails when the live page serves an older week than we committed', () => {
  // A push that never deployed, or a deploy that served a stale build.
  const r = runChecks(healthy({ liveHtml: page([snap('2026-W30', { builtAt: '2026-08-01' })]) }));
  assert.equal(r.ok, false);
  assert.equal(check(r, 'default week').ok, false);
  assert.match(check(r, 'default week').detail, /defaults to 2026-W30, expected 2026-W31/);
  assert.equal(check(r, 'live page').ok, true, 'the page itself is fine — only the content is stale');
});

test('runChecks fails when the live page is unreachable, and skips the week comparison', () => {
  const r = runChecks(healthy({ liveHtml: undefined, liveError: 'HTTP 503 from …' }));
  assert.equal(r.ok, false);
  assert.equal(check(r, 'live page').ok, false);
  assert.match(check(r, 'live page').detail, /unreachable — HTTP 503/);
  assert.equal(check(r, 'default week').skipped, true);
  // The archive checks are local, so they still report.
  assert.equal(check(r, 'archive valid').ok, true);
});

test('runChecks fails on a page that parses but does not render', () => {
  const r = runChecks(healthy({ liveHtml: '<script>const ARCHIVE = {"views":{},"default":null};</script>' }));
  assert.equal(r.ok, false);
  assert.match(check(r, 'live page').detail, /left #app empty/);
});

test('runChecks accepts a snapshot exactly at the age limit', () => {
  const r = runChecks(healthy({ today: '2026-08-16' }));   // builtAt 2026-08-08 → 8 days
  assert.equal(daysBetween('2026-08-08', '2026-08-16'), MAX_SNAPSHOT_AGE_DAYS);
  assert.equal(check(r, 'snapshot fresh').ok, true);
});

test('runChecks fails one day past the limit — a missed Saturday', () => {
  const r = runChecks(healthy({ today: '2026-08-17' }));   // 9 days
  assert.equal(r.ok, false);
  assert.equal(check(r, 'snapshot fresh').ok, false);
  assert.match(check(r, 'snapshot fresh').detail, /9 days ago \(limit 8\)/);
});

test('runChecks reports an unparseable builtAt instead of reading it as fresh', () => {
  const weeks = [snap('2026-W31', { builtAt: '2026-08-08' })];
  weeks[0].builtAt = 'last tuesday';
  const r = runChecks(healthy({ archive: { weeks } }));
  assert.equal(check(r, 'snapshot fresh').ok, false);
  assert.match(check(r, 'snapshot fresh').detail, /unparseable builtAt/);
});

test('runChecks fails when a committed week no longer validates', () => {
  const broken = snap('2026-W31', { builtAt: '2026-08-08' });
  delete broken.outputSchema.live;
  const r = runChecks(healthy({ archive: { weeks: [broken] } }));
  assert.equal(r.ok, false);
  assert.equal(check(r, 'archive valid').ok, false);
  assert.match(check(r, 'archive valid').detail, /2026-W31: outputSchema\.live must be a number/);
});

test('runChecks fails an empty committed archive', () => {
  const r = runChecks(healthy({ archive: { weeks: [] } }));
  assert.equal(r.ok, false);
  assert.match(check(r, 'default week').detail, /no weeks/);
  assert.match(check(r, 'snapshot fresh').detail, /no snapshots at all/);
});

test('runChecks compares against the NEWEST week, not the array order', () => {
  const older = snap('2026-W30', { builtAt: '2026-08-01' });
  const newer = snap('2026-W31', { builtAt: '2026-08-08' });
  const r = runChecks(healthy({ archive: { weeks: [newer, older] } }));
  assert.equal(r.ok, true, JSON.stringify(r.failed));
  assert.match(check(r, 'snapshot fresh').detail, /newest is 2026-W31/);
});

test('the NEEDS-LINEAR-REFRESH marker warns but does not fail the check', () => {
  const r = runChecks(healthy({ marker: { present: true, ageDays: 16, path: '/tmp/NEEDS-LINEAR-REFRESH' } }));
  assert.equal(r.ok, true, 'a stale Linear refresh is a warning — another agent automates that');
  const c = check(r, 'linear refresh');
  assert.equal(c.ok, false);
  assert.equal(c.warn, true);
  assert.match(c.detail, /16 days old/);
  assert.equal(r.failed.length, 0);
});

// --- CLI plumbing -----------------------------------------------------------

test('parseArgs rejects a mistyped week rather than checking the wrong one', () => {
  assert.throws(() => parseArgs(['--live=2026-W3']), /--live must be YYYY-Wnn/);
  assert.throws(() => parseArgs(['--live']), /unknown argument/);
  assert.throws(() => parseArgs(['--await-run=not-a-sha']), /must be a commit SHA/);
  assert.throws(() => parseArgs(['--live=2026-W31', '--await-run=abc1234']), /separate modes/);
  assert.throws(() => parseArgs(['--attempts=0']), /positive number/);
});

test('parseArgs defaults to the daily health check against the live URL', () => {
  const o = parseArgs([]);
  assert.equal(o.week, undefined);
  assert.equal(o.sha, undefined);
  assert.match(o.url, /ibrahim-abuznaid\.github\.io\/pieces-dashboard\/weekly\//);
  assert.equal(o.attempts, 6);
});

test('localToday is a local calendar date, matching the builtAt that date +%F writes', () => {
  assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(localToday(new Date(2026, 7, 4, 1, 30)), '2026-08-04');
});

// --- wiring: the scripts must stay honest ------------------------------------

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('the workflow name verify-weekly.mjs filters on is deploy.yml\'s real name', () => {
  const yml = read('../.github/workflows/deploy.yml');
  assert.match(yml, new RegExp(`^name: ${WORKFLOW_NAME}$`, 'm'),
    'deploy.yml was renamed — the run lookup would silently find nothing');
});

test('refresh-weekly.sh verifies CI and liveness after the push', () => {
  const sh = read('../refresh-weekly.sh');
  assert.match(sh, /verify-weekly\.mjs --await-run=/);
  assert.match(sh, /verify-weekly\.mjs --live=/);
  assert.ok(sh.indexOf('git push') < sh.indexOf('--await-run='), 'verification must come after the push');
});

// Comments in both files discuss the push and the snapshot they must not do, so
// the read-only assertion has to look at code rather than prose.
const decomment = (src) => src.replace(/^\s*(\/\/|#).*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('verify-weekly.sh is read-only — it must never mutate the archive or the remote', () => {
  const sh = read('../verify-weekly.sh');
  const mjs = read('../verify-weekly.mjs');
  for (const src of [decomment(sh), decomment(mjs)]) {
    assert.doesNotMatch(src, /git (add|commit|push)/);
    assert.doesNotMatch(src, /snapshot\.mjs/);
    assert.doesNotMatch(src, /writeArchive|writeFileSync|appendWeek/);
  }
  assert.match(sh, /^export PATH=/m, 'cron has no nvm node on its default PATH');
  assert.match(sh, /set -euo pipefail/);
});
