// test/weekly-collect-qa-sweeps.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectQaSweeps, qaSweepsForWindow } from '../weekly/collect/qa-sweeps.mjs';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const W45 = { start: '2026-10-31', end: '2026-11-06' };
const W44 = { start: '2026-10-24', end: '2026-10-30' };

const t = (id, project, team, assignee, statusType, status, over = {}) => ({
  id, project, team, assignee, assigneeName: assignee ? 'Someone' : null, statusType, status,
  createdAt: '2026-10-28', completedAt: null, canceledAt: null, priority: 2, milestone: null, ...over,
});

const QA = () => ({
  stamp: '2026-11-08', keyword: 'qa',
  projects: [
    { id: 'P-PIE-366', name: 'qa sweep 3', url: 'https://linear.app/activepieces/project/qa-sweep-3', teams: ['Pieces'], status: 'On Hold', issues: 7, inScope: 7 },
    { id: 'P-ENG-336', name: 'QA Sweep 2', url: 'https://linear.app/activepieces/project/qa-sweep-2', teams: ['Engineering'], status: 'Backlog', issues: 133, inScope: 1 },
  ],
  tickets: [
    t('PIE-1035', 'P-PIE-366', 'Pieces', 'kishan', 'started', 'In Review'),
    t('PIE-892', 'P-PIE-366', 'Pieces', null, 'completed', 'Done', { completedAt: '2026-11-06' }),
    t('PIE-896', 'P-PIE-366', 'Pieces', null, 'completed', 'Done', { completedAt: '2026-11-06' }),
    t('PIE-900', 'P-PIE-366', 'Pieces', 'odai', 'triage', 'Triage'),
    t('PIE-901', 'P-PIE-366', 'Pieces', 'odai', 'started', 'Blocked'),
    t('PIE-902', 'P-PIE-366', 'Pieces', 'sanket', 'completed', 'Done', { completedAt: '2026-10-30' }),
    t('PIE-903', 'P-PIE-366', 'Pieces', 'kishan', 'canceled', 'Canceled', { canceledAt: '2026-11-01' }),
    // An Engineering sweep's ticket, in scope because a roster member holds it …
    t('ENG-859', 'P-ENG-336', 'Engineering', 'sanket', 'completed', 'Done', { createdAt: '2026-10-06', completedAt: '2026-11-05' }),
    // … and one that is nobody's on this team: dropped.
    t('ENG-860', 'P-ENG-336', 'Engineering', 'other', 'backlog', 'Backlog', { createdAt: '2026-10-06' }),
  ],
});

const read = (qa = QA()) => (name) => { if (name !== 'qa.json') throw new Error(`no ${name}`); return qa; };

// ── the live reading ────────────────────────────────────────────────────────
test('the live reading classifies by the board and records the assignment', () => {
  const out = collectQaSweeps({ window: W45, readJson: read(), qaRefreshPending: false });
  assert.equal(out.status, 'ok');
  assert.deepEqual({ total: out.total, fixed: out.fixed, fixedThisWeek: out.fixedThisWeek,
    inReview: out.inReview, inProgress: out.inProgress, open: out.open, canceled: out.canceled },
  { total: 7, fixed: 4, fixedThisWeek: 3, inReview: 1, inProgress: 1, open: 1, canceled: 1 });
  assert.deepEqual(out.byPerson, {
    kishan: { assigned: 1, fixed: 0, fixedThisWeek: 0, inReview: 1, inProgress: 0 },
    sanket: { assigned: 2, fixed: 2, fixedThisWeek: 1, inReview: 0, inProgress: 0 },
    odai: { assigned: 2, fixed: 0, fixedThisWeek: 0, inReview: 0, inProgress: 1 },
    talal: { assigned: 0, fixed: 0, fixedThisWeek: 0, inReview: 0, inProgress: 0 },
  });
  assert.deepEqual(out.unassigned, { assigned: 2, fixed: 2, fixedThisWeek: 2, inReview: 0, inProgress: 0 });
  assert.deepEqual(out.others, { assigned: 0, fixed: 0, fixedThisWeek: 0, inReview: 0, inProgress: 0 });
});

test('projects carry their own counts and their Linear link', () => {
  const out = qaSweepsForWindow(QA(), W45);
  assert.deepEqual(out.projects, [
    { id: 'P-PIE-366', name: 'qa sweep 3', url: 'https://linear.app/activepieces/project/qa-sweep-3',
      total: 6, fixed: 3, fixedThisWeek: 2, inReview: 1, inProgress: 1, open: 1 },
    { id: 'P-ENG-336', name: 'QA Sweep 2', url: 'https://linear.app/activepieces/project/qa-sweep-2',
      total: 1, fixed: 1, fixedThisWeek: 1, inReview: 0, inProgress: 0, open: 0 },
  ]);
});

test('the ids fixed this week are listed, by key then number', () => {
  const qa = QA();
  qa.tickets.push(t('PIE-1017', 'P-PIE-366', 'Pieces', null, 'completed', 'Done', { completedAt: '2026-11-04' }));
  assert.deepEqual(qaSweepsForWindow(qa, W45).fixedIds, ['ENG-859', 'PIE-892', 'PIE-896', 'PIE-1017']);
});

test('a ticket that is neither the Pieces team\'s nor a roster member\'s is not counted', () => {
  const out = qaSweepsForWindow(QA(), W45);
  assert.equal(out.projects[1].total, 1, 'ENG-860 (team Engineering, assignee other) is out of scope');
});

test('the live block validates as an archived week', () => {
  const qaSweeps = qaSweepsForWindow(QA(), W45);
  validateSnapshot(snapWith(qaSweeps));
});

// ── the dates-only reading ──────────────────────────────────────────────────
test('as of a day, only the dates speak: no board state, no assignment', () => {
  const out = qaSweepsForWindow(QA(), W45, { asOf: '2026-11-06' });
  assert.deepEqual({ total: out.total, fixed: out.fixed, fixedThisWeek: out.fixedThisWeek },
    { total: 7, fixed: 4, fixedThisWeek: 3 });
  for (const f of ['inReview', 'inProgress', 'open', 'canceled']) assert.equal(out[f], undefined, f);
  assert.deepEqual(out.byPerson.sanket, { fixed: 2, fixedThisWeek: 1 });
  assert.deepEqual(out.unassigned, { fixed: 2, fixedThisWeek: 2 });
  assert.deepEqual(out.projects[0], { id: 'P-PIE-366', name: 'qa sweep 3',
    url: 'https://linear.app/activepieces/project/qa-sweep-3', total: 6, fixed: 3, fixedThisWeek: 2 });
  validateSnapshot(snapWith(out));
});

test('as of an earlier day, a later fix is not yet fixed and a later cancel still counts', () => {
  const out = qaSweepsForWindow(QA(), W44, { asOf: '2026-10-30' });
  // PIE-903 was canceled on 11-01, so on 10-30 it still existed; ENG-859 was
  // fixed on 11-05, so on 10-30 it was open.
  assert.deepEqual({ total: out.total, fixed: out.fixed, fixedThisWeek: out.fixedThisWeek },
    { total: 8, fixed: 1, fixedThisWeek: 1 });
  assert.deepEqual(out.fixedIds, ['PIE-902']);
});

test('a ticket created after the day did not exist', () => {
  const out = qaSweepsForWindow(QA(), { start: '2026-09-26', end: '2026-10-02' }, { asOf: '2026-10-02' });
  assert.deepEqual({ total: out.total, fixed: out.fixed, fixedThisWeek: out.fixedThisWeek }, { total: 0, fixed: 0, fixedThisWeek: 0 });
  assert.deepEqual(out.fixedIds, []);
});

test('a day after the stamp cannot be restated', () =>
  assert.throws(() => qaSweepsForWindow(QA(), W45, { asOf: '2026-11-09' }), /stamped 2026-11-08, before/));

// ── degrading, never zero ───────────────────────────────────────────────────
test('a pending QA refresh is no-data', () => {
  const out = collectQaSweeps({ window: W45, readJson: read(), qaRefreshPending: true });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /NEEDS-QA-REFRESH/);
});

test('a file that predates the week\'s end is no-data, not a stale count', () => {
  const out = collectQaSweeps({ window: W45, readJson: read({ ...QA(), stamp: '2026-11-05' }), qaRefreshPending: false });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /only reaches 2026-11-05.*needs a QA refresh/);
});

test('a missing file is no-data', () => {
  const out = collectQaSweeps({ window: W45, readJson: () => { throw new Error('ENOENT'); }, qaRefreshPending: false });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /ENOENT/);
});

test('a row with a state type this module does not know is no-data, not a guess', () => {
  const qa = QA();
  qa.tickets[0].statusType = 'done';
  const out = collectQaSweeps({ window: W45, readJson: read(qa), qaRefreshPending: false });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /PIE-1035: unknown statusType "done"/);
});

test('a row with an assignee that is not a roster key is no-data', () => {
  const qa = QA();
  qa.tickets[0].assignee = 'Kishan Parmar';
  assert.match(collectQaSweeps({ window: W45, readJson: read(qa), qaRefreshPending: false }).reason, /not a roster key/);
});

test('a ticket pointing at a project the file does not list is no-data', () => {
  const qa = QA();
  qa.tickets[0].project = 'P-PIE-999';
  assert.match(collectQaSweeps({ window: W45, readJson: read(qa), qaRefreshPending: false }).reason, /P-PIE-999 is not in qa.json/);
});

// A whole snapshot around one qaSweeps block, so validateSnapshot can judge it.
function snapWith(qaSweeps) {
  return {
    week: '2026-W45', start: '2026-10-31', end: '2026-11-06', builtAt: '2026-11-07',
    outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
    uiImprovements: { status: 'ok', merged: 5, live: 5, review: 2, assigned: 0, totalPieces: 765 },
    connectionIdentifier: { status: 'ok', merged: 58, live: 58, review: 0, assigned: 0, totalPieces: 111 },
    testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
    tickets: { status: 'ok', total: 0, byPerson: {}, prsMerged: {}, reviews: {}, shipped: [] },
    shipping: { status: 'ok', prsMerged: 0, piecePrs: 0, byPerson: {}, reviews: 0, reviewsByPerson: {}, reviewsApprox: true, shipped: [] },
    qaSweeps,
    decisions: [],
  };
}
