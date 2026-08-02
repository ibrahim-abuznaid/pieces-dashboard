import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOutputSchema } from '../weekly/collect/output-schema.mjs';
import { collectAiActions } from '../weekly/collect/ai-actions.mjs';

const OS_SUMMARY = {
  generated: '2026-07-23',
  totals: { pieces: 756, steps: 7019, actions: 5539, triggers: 1480 },
  status: { live: 9, 'merged-not-live': 6, 'in-progress': 0, todo: 733, review: 8, skip: 0 },
};

const AI_SUMMARY = {
  generated: '2026-07-23', prFetched: '2026-07-22', pieces: 28, atomics: 763,
  stages: { held: 2, assigned: 0, prOpen: 24, merged: 2 },
  prsOpen: 15, prsMerged: 1, blockersOpen: 30, blockersDone: 2,
};

// Roster fixtures. Both collectors read a second file for the per-piece detail;
// the aggregate tiles must survive that file being absent or junk.
const OS_PIECES = {
  summary: {},
  pieces: [
    { displayName: 'Slack', actions: 12, triggers: 3, tier: 'P1', status: 'live' },
    { displayName: 'Notion', actions: 12, triggers: 1, tier: 'P1', status: 'merged-not-live' },
    { displayName: 'Airtable', actions: 20, triggers: 2, tier: 'P2', status: 'review' },
    { displayName: 'Zendesk', actions: 4, triggers: 0, tier: 'P3', status: 'in-progress' },
    { displayName: 'Trello', actions: 99, triggers: 9, tier: 'P1', status: 'todo' },
    { displayName: 'Webhook', actions: 88, triggers: 8, tier: 'P1', status: 'skip' },
  ],
};

const AI_PIECES = {
  generated: '2026-07-23',
  pieces: [
    { slug: 'gmail', atomics: 19, stage: 'pr-open', pr: 13930, prState: 'OPEN' },
    { slug: 'google-docs', atomics: 37, stage: 'merged', pr: 13926, prState: 'MERGED' },
    { slug: 'airtable', atomics: 19, stage: 'held', pr: null, prState: null },
    { slug: 'asana', atomics: 5, stage: 'assigned', pr: null, prState: null },
  ],
};

// A path absent from the map throws, exactly like the real fs-backed reader.
const reader = (files) => (path) => {
  if (!(path in files)) throw new Error(`ENOENT: no such file, open '${path}'`);
  return files[path];
};

const osRead = (over = {}) => reader({
  'dist/output-schema/summary.json': OS_SUMMARY,
  'dist/output-schema/pieces.json': OS_PIECES,
  ...over,
});

const aiRead = (over = {}) => reader({
  'dist/ai-actions/summary.json': AI_SUMMARY,
  'dist/ai-actions/pieces.json': AI_PIECES,
  ...over,
});

const OS_ROSTER = [
  { name: 'Airtable', actions: 20, triggers: 2, stage: 'review', tier: 'P2' },
  { name: 'Notion', actions: 12, triggers: 1, stage: 'merged-not-live', tier: 'P1' },
  { name: 'Slack', actions: 12, triggers: 3, stage: 'live', tier: 'P1' },
  { name: 'Zendesk', actions: 4, triggers: 0, stage: 'in-progress', tier: 'P3' },
];

test('collectOutputSchema maps the real summary shape', () => {
  assert.deepEqual(collectOutputSchema({ readJson: () => OS_SUMMARY }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756, roster: [],
  });
});

test('collectOutputSchema degrades to no-data with the reason when the file is missing', () => {
  const out = collectOutputSchema({ readJson: () => { throw new Error('ENOENT: no such file'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /npm run build/);
});

test('collectOutputSchema rejects a summary missing the status block', () => {
  const out = collectOutputSchema({ readJson: () => ({ totals: { pieces: 1 } }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /status/);
});

test('collectAiActions maps the real summary shape', () => {
  assert.deepEqual(collectAiActions({ readJson: () => AI_SUMMARY }), {
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30, roster: [],
  });
});

test('collectAiActions degrades when stages are absent', () => {
  const out = collectAiActions({ readJson: () => ({ pieces: 28 }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /stages/);
});

test('a zero stage count survives as 0, not no-data', () => {
  const out = collectAiActions({ readJson: () => ({ ...AI_SUMMARY, stages: { held: 0, assigned: 0, prOpen: 0, merged: 0 } }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.merged, 0);
});

// Both collectors must apply the zero-survives rule identically. A truthiness
// check here previously made outputSchema disagree with ai-actions.
test('a zero live count survives as 0, not no-data', () => {
  const out = collectOutputSchema({ readJson: () => ({
    totals: { pieces: 756 }, status: { live: 0, 'merged-not-live': 0, review: 0, todo: 756 },
  }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 0);
});

test('a non-numeric totals.pieces degrades instead of flowing through untyped', () => {
  const out = collectOutputSchema({ readJson: () => ({
    totals: { pieces: '756' }, status: { live: 9, 'merged-not-live': 6, review: 8, todo: 733 },
  }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /totals\.pieces/);
});

// --- rosters -----------------------------------------------------------------
// The roster is the per-piece detail behind each tile. It is DETAIL: losing it
// must never turn a measurable week into no-data.

test('collectOutputSchema carries an in-flight roster, sorted by actions desc then name', () => {
  assert.deepEqual(collectOutputSchema({ readJson: osRead() }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
    roster: OS_ROSTER,
  });
});

test('todo and skip pieces never reach the outputSchema roster', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(roster.map((r) => r.name), ['Airtable', 'Notion', 'Slack', 'Zendesk']);
  assert.equal(roster.length, 4);
});

test('outputSchema roster stages are the piece status verbatim', () => {
  const { roster } = collectOutputSchema({ readJson: osRead() });
  assert.deepEqual(roster.map((r) => r.stage), ['review', 'merged-not-live', 'live', 'in-progress']);
});

test('a missing outputSchema roster file leaves the tile numbers intact', () => {
  const out = collectOutputSchema({ readJson: reader({ 'dist/output-schema/summary.json': OS_SUMMARY }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 9);
  assert.equal(out.totalPieces, 756);
  assert.deepEqual(out.roster, []);
});

test('a malformed outputSchema roster file yields an empty roster, not no-data', () => {
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': { pieces: 'nope' } }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

test('an outputSchema roster row with a non-numeric actions count drops the whole roster', () => {
  const broken = { pieces: [{ displayName: 'Slack', actions: '12', triggers: 3, tier: 'P1', status: 'live' }] };
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.live, 9);
  assert.deepEqual(out.roster, []);
});

test('an outputSchema roster row with zero actions survives — only absence drops it', () => {
  const zeroed = { pieces: [{ displayName: 'Slack', actions: 0, triggers: 0, tier: 'P1', status: 'review' }] };
  const out = collectOutputSchema({ readJson: osRead({ 'dist/output-schema/pieces.json': zeroed }) });
  assert.deepEqual(out.roster, [{ name: 'Slack', actions: 0, triggers: 0, stage: 'review', tier: 'P1' }]);
});

test('collectAiActions carries a roster, sorted by actions desc then name', () => {
  assert.deepEqual(collectAiActions({ readJson: aiRead() }), {
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
    roster: [
      { name: 'google-docs', actions: 37, stage: 'merged' },
      { name: 'airtable', actions: 19, stage: 'held' },
      { name: 'gmail', actions: 19, stage: 'pr-open' },
      { name: 'asana', actions: 5, stage: 'assigned' },
    ],
  });
});

test('a missing AI-actions roster file leaves the tile numbers intact', () => {
  const out = collectAiActions({ readJson: reader({ 'dist/ai-actions/summary.json': AI_SUMMARY }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.equal(out.totalPieces, 28);
  assert.deepEqual(out.roster, []);
});

test('a malformed AI-actions roster file yields an empty roster, not no-data', () => {
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': { pieces: { gmail: 19 } } }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

test('an AI-actions roster row with a non-numeric atomics count drops the whole roster', () => {
  const broken = { pieces: [{ slug: 'gmail', atomics: null, stage: 'pr-open' }] };
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.prOpen, 24);
  assert.deepEqual(out.roster, []);
});

test('an AI-actions roster row with an empty slug drops the whole roster', () => {
  const broken = { pieces: [{ slug: '', atomics: 3, stage: 'held' }] };
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': broken }) });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.roster, []);
});

// --- catalog denominator -------------------------------------------------------
// The AI-actions initiative TRACKS 28 pieces; the catalog is 756. `totalPieces`
// stays the tracked count — the committed snapshot has it and the schema
// requires it — and `catalogPieces` carries the real catalog size so the tile
// can stop reading as "2 of 28", which overstates coverage ~27x. Like `roster`
// it is OPTIONAL detail: losing it costs the denominator, never the workstream.

const withCatalog = (over) => aiRead({ 'dist/output-schema/summary.json': over ?? OS_SUMMARY });

test('collectAiActions carries the catalog denominator from the outputSchema summary', () => {
  const out = collectAiActions({ readJson: withCatalog() });
  assert.equal(out.catalogPieces, 756);
  assert.equal(out.totalPieces, 28);
});

test('a missing outputSchema summary omits the denominator rather than guessing one', () => {
  const out = collectAiActions({ readJson: aiRead() });
  assert.equal(out.status, 'ok');
  assert.equal(out.merged, 2);
  assert.ok(!('catalogPieces' in out), 'the key must be absent, not present-and-undefined');
});

test('a non-numeric totals.pieces omits the denominator instead of flowing through untyped', () => {
  const out = collectAiActions({ readJson: withCatalog({ ...OS_SUMMARY, totals: { pieces: '756' } }) });
  assert.equal(out.status, 'ok');
  assert.ok(!('catalogPieces' in out));
});

test('an outputSchema summary with no totals block omits the denominator', () => {
  const out = collectAiActions({ readJson: withCatalog({ status: OS_SUMMARY.status }) });
  assert.equal(out.status, 'ok');
  assert.ok(!('catalogPieces' in out));
});

// typeof, not truthiness — the same rule every other numeric field here follows.
test('a zero catalog survives as 0', () => {
  const out = collectAiActions({ readJson: withCatalog({ ...OS_SUMMARY, totals: { pieces: 0 } }) });
  assert.equal(out.catalogPieces, 0);
});
