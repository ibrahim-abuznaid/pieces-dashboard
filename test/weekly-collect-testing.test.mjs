// test/weekly-collect-testing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTesting } from '../weekly/collect/testing.mjs';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const WINDOW = { start: '2026-07-25', end: '2026-07-31' };

const PRS = JSON.stringify([
  { number: 5, title: 'feat(health): piece health board', mergedAt: '2026-07-30T07:36:31Z',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5' },
  { number: 3, title: 'feat(assertions): output assertions', mergedAt: '2026-06-22T10:00:00Z',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/3' },
  { number: 4, title: 'feat: alerts', mergedAt: null,
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/4' },
]);

const COMMITS = JSON.stringify([{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }, { sha: 'd' }]);

const fakeGh = (prs = PRS, commits = COMMITS) => (args) =>
  args.includes('pr') ? prs : commits;

test('counts only PRs merged inside the window', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh() });
  assert.equal(out.status, 'ok');
  assert.equal(out.prsMerged, 1);
  assert.deepEqual(out.shipped, [{
    number: 5, title: 'feat(health): piece health board',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5',
  }]);
});

test('unmerged PRs are excluded', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 4, title: 'feat: alerts', mergedAt: null, url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 0);
  assert.deepEqual(out.shipped, []);
});

test('a PR merged on the final day of the window counts', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 9, title: 'edge', mergedAt: '2026-07-31T23:59:59Z', url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 1);
});

test('a PR merged the day after the window is excluded', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 9, title: 'edge', mergedAt: '2026-08-01T00:00:00Z', url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 0);
});

test('commit count comes from the commits query', () => {
  assert.equal(collectTesting({ window: WINDOW, gh: fakeGh() }).commits, 4);
});

test('a gh failure degrades to no-data with the reason', () => {
  const out = collectTesting({ window: WINDOW, gh: () => { throw new Error('gh: not authenticated'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /not authenticated/);
});

test('unparseable gh output degrades to no-data', () => {
  const out = collectTesting({ window: WINDOW, gh: () => 'not json' });
  assert.equal(out.status, 'no-data');
});

// ── coverage ─────────────────────────────────────────────────────────────────
// The pieces the tester covers, read from the live server's /api/coverage when
// PIECE_TESTER_URL points at it. "Covered" is pieces with at least one test
// plan — per-piece work someone did — never the cockpit's schedule flag, which
// one legacy wildcard schedule sets on the whole catalog at once.

const COVERAGE = JSON.stringify([
  { piece_name: '@activepieces/piece-slack', display_name: 'Slack',
    logo_url: 'https://cdn.activepieces.com/pieces/slack.png', plan_count: 2, covered: true },
  { piece_name: '@activepieces/piece-zendesk', display_name: 'Zendesk',
    logo_url: null, plan_count: 12, covered: true },
  { piece_name: '@activepieces/piece-github', display_name: 'GitHub',
    logo_url: 'https://cdn.activepieces.com/pieces/github.png', plan_count: 0, covered: true },
]);

const withCoverage = (raw = COVERAGE, url = 'http://tester.internal:4000') =>
  collectTesting({ window: WINDOW, gh: fakeGh(), curl: () => raw, testerUrl: url });

test('coverage becomes a roster of pieces with plans, most-planned first', () => {
  const out = withCoverage();
  assert.equal(out.status, 'ok');
  assert.equal(out.catalogPieces, 3);
  assert.deepEqual(out.roster, [
    { name: 'zendesk', folder: 'zendesk', displayName: 'Zendesk', logo: null, actions: 12, stage: 'covered' },
    { name: 'slack', folder: 'slack', displayName: 'Slack',
      logo: 'https://cdn.activepieces.com/pieces/slack.png', actions: 2, stage: 'covered' },
  ]);
});

test('a piece with no plans is not covered, whatever the schedule flag says', () => {
  assert.ok(!withCoverage().roster.some((r) => r.name === 'github'));
});

test('with no tester URL the coverage half is simply off', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(), curl: () => COVERAGE });
  assert.equal(out.status, 'ok');
  assert.ok(!('roster' in out) && !('catalogPieces' in out) && !('coverageError' in out));
});

test('an unreachable tester degrades coverage alone — PRs and commits survive', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(),
    curl: () => { throw new Error('connection refused'); }, testerUrl: 'http://tester' });
  assert.equal(out.status, 'ok');
  assert.equal(out.prsMerged, 1);
  assert.match(out.coverageError, /connection refused/);
  assert.ok(!('roster' in out));
});

test('a coverage endpoint returning junk degrades coverage alone', () => {
  const out = withCoverage('not json');
  assert.equal(out.status, 'ok');
  assert.match(out.coverageError, /coverage unreachable/);
});

test('a coverage payload that is not an array degrades coverage alone', () => {
  const out = withCoverage(JSON.stringify({ error: 'nope' }));
  assert.equal(out.status, 'ok');
  assert.match(out.coverageError, /did not return an array/);
});

test('a trailing slash on the tester URL does not double up', () => {
  const urls = [];
  collectTesting({ window: WINDOW, gh: fakeGh(),
    curl: (u) => { urls.push(u); return COVERAGE; }, testerUrl: 'http://tester:4000/' });
  assert.deepEqual(urls, ['http://tester:4000/api/coverage']);
});

// The roster this collector writes is committed and re-validated on every
// verify run, so its shape has to pass the archive's own gate — not just look
// right to the view.
test('a coverage roster validates as a snapshot workstream', () => {
  const noData = { status: 'no-data', reason: 'not collected in this test' };
  validateSnapshot({
    week: '2026-W31', start: WINDOW.start, end: WINDOW.end, builtAt: '2026-08-01',
    decisions: [], outputSchema: noData, aiActions: noData, tickets: noData,
    testing: withCoverage(),
  });
});
