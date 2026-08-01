// test/weekly-archive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSnapshot, appendWeek, readArchive } from '../weekly/lib/archive.mjs';

const ok = (over = {}) => ({
  week: '2026-W31', start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  decisions: [],
  ...over,
});

test('a well-formed snapshot validates', () => validateSnapshot(ok()));

test('a no-data workstream validates when it carries a reason', () =>
  validateSnapshot(ok({ tickets: { status: 'no-data', reason: 'Linear refresh pending' } })));

test('no-data without a reason is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ tickets: { status: 'no-data' } })), /tickets.*reason/));

test('a bad week id is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ week: '2026-31' })), /week/));

test('a missing workstream is rejected', () => {
  const snap = ok();
  delete snap.testing;
  assert.throws(() => validateSnapshot(snap), /testing/);
});

test('an ok workstream missing a numeric field is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ testing: { status: 'ok', commits: 4, shipped: [] } })), /prsMerged/));

test('a zero value is valid — only absence is an error', () =>
  validateSnapshot(ok({ testing: { status: 'ok', prsMerged: 0, commits: 0, shipped: [] } })));

test('decisions must be an array of strings', () =>
  assert.throws(() => validateSnapshot(ok({ decisions: 'nope' })), /decisions/));

test('appendWeek adds to an empty archive', () => {
  const out = appendWeek({ weeks: [] }, ok());
  assert.equal(out.weeks.length, 1);
  assert.equal(out.weeks[0].week, '2026-W31');
});

test('appendWeek does not mutate the input archive', () => {
  const before = { weeks: [] };
  appendWeek(before, ok());
  assert.equal(before.weeks.length, 0);
});

test('appendWeek keeps weeks sorted ascending', () => {
  const a = appendWeek({ weeks: [] }, ok({ week: '2026-W31' }));
  const b = appendWeek(a, ok({ week: '2026-W29' }));
  const c = appendWeek(b, ok({ week: '2026-W30' }));
  assert.deepEqual(c.weeks.map((w) => w.week), ['2026-W29', '2026-W30', '2026-W31']);
});

test('a corrupt archive with a non-array weeks field reads as empty', () => {
  const p = join(tmpdir(), `weekly-corrupt-${process.pid}.json`);
  writeFileSync(p, JSON.stringify({ weeks: null }));
  try {
    assert.deepEqual(readArchive(p).weeks, []);
  } finally {
    rmSync(p, { force: true });
  }
});

test('re-appending an existing week throws', () => {
  const a = appendWeek({ weeks: [] }, ok());
  assert.throws(() => appendWeek(a, ok()), /2026-W31 already exists/);
});

test('force replaces an existing week in place', () => {
  const a = appendWeek({ weeks: [] }, ok());
  const b = appendWeek(a, ok({ builtAt: '2026-08-08' }), { force: true });
  assert.equal(b.weeks.length, 1);
  assert.equal(b.weeks[0].builtAt, '2026-08-08');
});

test('appendWeek validates before appending', () =>
  assert.throws(() => appendWeek({ weeks: [] }, ok({ week: 'bad' })), /week/));

test('readArchive on a missing file yields an empty archive', () =>
  assert.deepEqual(readArchive('/tmp/definitely-not-here-9f3a.json'), { weeks: [] }));

// --- roster (optional per-piece detail) --------------------------------------

const withRoster = (roster) => ok({
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster },
});

test('a snapshot with no roster field validates — the field is optional', () => {
  const snap = ok();
  assert.equal(snap.outputSchema.roster, undefined);
  validateSnapshot(snap);
});

test('every already-committed snapshot still validates unchanged', () => {
  const archive = JSON.parse(readFileSync(new URL('../weekly/data/weeks.json', import.meta.url), 'utf8'));
  assert.ok(archive.weeks.length > 0, 'the committed archive should not be empty');
  for (const w of archive.weeks) validateSnapshot(w);
});

test('a well-formed roster validates', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 12, triggers: 3, stage: 'live', tier: 'P1' }])));

test('an empty roster validates', () => validateSnapshot(withRoster([])));

test('a roster entry with zero actions validates — only absence is an error', () =>
  validateSnapshot(withRoster([{ name: 'Slack', actions: 0 }])));

test('a non-array roster is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster({ Slack: 12 })), /outputSchema\.roster must be an array/));

test('a roster entry that is not an object is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster(['Slack'])), /outputSchema\.roster\[0\]/));

test('a roster entry without a name is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ actions: 12 }])), /outputSchema\.roster\[0\]\.name/));

test('a roster entry with an empty name is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: '', actions: 12 }])), /outputSchema\.roster\[0\]\.name/));

test('a roster entry with a non-numeric actions count is rejected', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: 'Slack', actions: '12' }])),
    /outputSchema\.roster\[0\]\.actions/));

test('the offending roster index is named, not just the first one', () =>
  assert.throws(() => validateSnapshot(withRoster([{ name: 'Slack', actions: 12 }, { name: 'Notion' }])),
    /outputSchema\.roster\[1\]\.actions/));

test('an aiActions roster is validated too', () =>
  assert.throws(() => validateSnapshot(ok({
    aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
                 roster: [{ name: 'gmail' }] },
  })), /aiActions\.roster\[0\]\.actions/));
