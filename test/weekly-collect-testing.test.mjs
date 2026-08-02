// test/weekly-collect-testing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTesting, TESTING_NOTE } from '../weekly/collect/testing.mjs';

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

test('the tile note states the build-progress caveat', () =>
  assert.match(TESTING_NOTE, /health/i));
