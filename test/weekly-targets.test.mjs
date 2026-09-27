// test/weekly-targets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TARGET_KEYS, validateTargets, validateTargetsFile, targetsForWeek } from '../weekly/lib/targets.mjs';

const FILE = { from: '2026-W40', targets: { aiActions: { kishan: 20, odai: 20 }, tickets: { kishan: 5 } } };

test('the committed targets file is valid and starts at W40', () => {
  const file = JSON.parse(readFileSync(new URL('../weekly/data/targets.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateTargetsFile(file));
  assert.equal(file.from, '2026-W40');
  assert.deepEqual(file.targets, {
    aiActions: { kishan: 20, odai: 20 },
    uiImprovements: { talal: 15 },
    testing: { sanket: 70 },
    tickets: { kishan: 5, odai: 5 },
  });
});

test('only the four tiles that carry targets are accepted', () =>
  assert.deepEqual(TARGET_KEYS, ['aiActions', 'uiImprovements', 'testing', 'tickets']));

test('an unknown workstream is named in the error', () =>
  assert.throws(() => validateTargets({ aiAction: { kishan: 20 } }), /targets\.aiAction: no such workstream/));

test('a person off the roster is named in the error', () =>
  assert.throws(() => validateTargets({ tickets: { ahmad: 5 } }), /targets\.tickets\.ahmad: not on the team roster/));

test('without a roster, only the shape is checked', () => {
  assert.doesNotThrow(() => validateTargets({ tickets: { ahmad: 5 } }, 'targets', { roster: null }));
  assert.throws(() => validateTargets({ tickets: { ahmad: '5' } }, 'targets', { roster: null }), /must be a positive integer/);
});

test('a target must be a positive integer — a string, a zero or a fraction is a typo', () => {
  for (const bad of ['20', 0, -1, 2.5, null]) {
    assert.throws(() => validateTargets({ tickets: { kishan: bad } }), /targets\.tickets\.kishan must be a positive integer/);
  }
});

test('the file needs a real week id in `from`', () => {
  assert.throws(() => validateTargetsFile({ ...FILE, from: 'W40' }), /from must be YYYY-Wnn/);
  assert.throws(() => validateTargetsFile({ targets: FILE.targets }), /from must be YYYY-Wnn/);
});

test('targets apply from `from` on, and never to a week before it', () => {
  assert.equal(targetsForWeek(FILE, '2026-W39'), null);
  assert.deepEqual(targetsForWeek(FILE, '2026-W40'), FILE.targets);
  assert.deepEqual(targetsForWeek(FILE, '2027-W02'), FILE.targets);
  assert.equal(targetsForWeek(null, '2026-W40'), null);
});

test('the snapshot gets a COPY — editing the file later cannot reach into history', () => {
  const t = targetsForWeek(FILE, '2026-W40');
  t.aiActions.kishan = 1;
  assert.equal(FILE.targets.aiActions.kishan, 20);
});

import { targetsFor, checkedByPerson } from '../weekly/lib/targets.mjs';

const AI = { key: 'aiActions', done: ['merged', 'approved'] };
const UI = { key: 'uiImprovements', done: ['live', 'merged'] };
const TESTING = { key: 'testing' };
const TICKETS = { key: 'tickets' };

const row = (name, stage, author) => ({ name, actions: 1, stage, ...(author ? { author } : {}) });
const wk = (week, over = {}) => ({ week, start: '2026-09-26', end: '2026-10-02', builtAt: '2026-10-03', decisions: [], ...over });
const ok = (roster, more = {}) => ({ status: 'ok', roster, ...more });

const TARGETS = { aiActions: { kishan: 20, odai: 20 }, uiImprovements: { talal: 15 },
                  testing: { sanket: 70 }, tickets: { kishan: 5, odai: 5 } };

const W39 = wk('2026-W39', {
  aiActions: ok([row('gmail', 'merged', 'kishanprmr'), row('asana', 'pr-open', 'kishanprmr')]),
  uiImprovements: ok([row('slack', 'merged', 'Talaljaber')]),
  testing: ok([row('apify', 'covered')]),
});
const W40 = wk('2026-W40', {
  targets: TARGETS,
  aiActions: ok([
    row('gmail', 'merged', 'kishanprmr'),        // done last week — not this week's
    row('asana', 'approved', 'kishanprmr'),      // approved this week — counts now
    row('docs', 'merged', 'kishanprmr'),         // one PR, two pieces: both count
    row('sheets', 'merged', 'kishanprmr'),
    row('notion', 'merged', 'OdaiAhmed99'),
    row('hubspot', 'merged', 'Talaljaber'),      // on the team, no AI target
    row('stripe', 'merged', 'ibrahim-abuznaid'), // off the team
    row('mistral', 'merged'),                    // no author found
    row('zoom', 'pr-open', 'OdaiAhmed99'),       // not done
  ]),
  uiImprovements: ok([row('slack', 'live', 'Talaljaber'), row('gmail', 'merged', 'talaljaber')]),
  testing: ok([row('apify', 'covered'), row('slack', 'covered'), row('gmail', 'covered')]),
  tickets: { status: 'ok', total: 9, byPerson: { kishan: 6, sanket: 1, odai: 2, talal: 0 } },
});
const WEEKS = [W39, W40];

test('AI actions: newly done pieces credited to their PR author', () => {
  const t = targetsFor(AI, WEEKS, W40);
  assert.deepEqual(t.rows, [
    { person: 'kishan', name: 'Kishan', actual: 3, target: 20, hit: false },
    { person: 'odai', name: 'Odai', actual: 1, target: 20, hit: false },
  ]);
  assert.equal(t.also, 'Talal 1 · 1 other · 1 not credited');
});

test('the rows and the also line add up to every piece done this week', () => {
  const t = targetsFor(AI, WEEKS, W40);
  const alsoTotal = [...t.also.matchAll(/(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const rowsTotal = t.rows.reduce((s, r) => s + r.actual, 0);
  assert.equal(rowsTotal + alsoTotal, 7, 'asana, docs, sheets, notion, hubspot, stripe, mistral');
});

test('an approved piece that merges the next week does not count twice', () => {
  const W41 = wk('2026-W41', { targets: TARGETS,
    aiActions: ok(W40.aiActions.roster.map((r) => (r.name === 'asana' ? { ...r, stage: 'merged' } : r))) });
  const t = targetsFor(AI, [W39, W40, W41], W41);
  assert.equal(t.rows.find((r) => r.person === 'kishan').actual, 0);
});

test('UI improvements: live and merged both count, logins match case-insensitively', () => {
  const t = targetsFor(UI, WEEKS, W40);
  assert.deepEqual(t.rows, [{ person: 'talal', name: 'Talal', actual: 1, target: 15, hit: false }]);
  assert.equal(t.also, '');
});

test('piece testing: every newly covered piece is Sanket\'s — a set difference, never negative', () => {
  const t = targetsFor(TESTING, WEEKS, W40);
  assert.deepEqual(t.rows, [{ person: 'sanket', name: 'Sanket', actual: 2, target: 70, hit: false }]);
  const shrunk = wk('2026-W40', { targets: TARGETS, testing: ok([row('zendesk', 'covered')]) });
  assert.equal(targetsFor(TESTING, [W39, shrunk], shrunk).rows[0].actual, 1, 'a reset week still counts what it added');
});

test('tickets: read straight off byPerson, the rest of the team on the also line', () => {
  const t = targetsFor(TICKETS, WEEKS, W40);
  assert.deepEqual(t.rows, [
    { person: 'kishan', name: 'Kishan', actual: 6, target: 5, hit: true },
    { person: 'odai', name: 'Odai', actual: 2, target: 5, hit: false },
  ]);
  assert.equal(t.also, 'Sanket 1');
});

test('hitting the target exactly is a hit', () => {
  const exact = wk('2026-W40', { targets: { tickets: { kishan: 6 } }, tickets: W40.tickets });
  assert.equal(targetsFor(TICKETS, [exact], exact).rows[0].hit, true);
});

test('no prior week to diff against: not measured, never zero', () => {
  const t = targetsFor(AI, [W40], W40);
  assert.deepEqual(t.rows.map((r) => [r.actual, r.hit]), [[null, false], [null, false]]);
  assert.equal(t.also, '');
});

test('a gap in the archive is not measured either', () => {
  const W38 = { ...W39, week: '2026-W38' };
  assert.equal(targetsFor(AI, [W38, W40], W40).rows[0].actual, null);
});

test('tickets whose per-person counts do not add up are not measured', () => {
  const bad = wk('2026-W40', { targets: TARGETS, tickets: { status: 'ok', total: 99, byPerson: { kishan: 6 } } });
  assert.equal(targetsFor(TICKETS, [bad], bad).rows[0].actual, null);
});

test('a degraded workstream draws no target rows', () => {
  const down = wk('2026-W40', { targets: TARGETS, aiActions: { status: 'no-data', reason: 'x' } });
  assert.equal(targetsFor(AI, [W39, down], down), null);
});

test('a week with no targets, or none for this tile, has none', () => {
  assert.equal(targetsFor(AI, WEEKS, { ...W40, targets: undefined }), null);
  assert.equal(targetsFor(AI, WEEKS, { ...W40, targets: { tickets: { kishan: 5 } } }), null);
});

test('checkedByPerson refuses a map that does not sum to its total', () => {
  assert.deepEqual(checkedByPerson({ kishan: 2, odai: 3 }, 5), { kishan: 2, odai: 3 });
  assert.equal(checkedByPerson({ kishan: 2, odai: 3 }, 6), null);
  assert.equal(checkedByPerson({ kishan: '2' }, 2), null);
  assert.equal(checkedByPerson({}, 0), null);
  assert.equal(checkedByPerson(undefined, 0), null);
});
