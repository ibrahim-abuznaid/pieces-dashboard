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

test('collectOutputSchema maps the real summary shape', () => {
  assert.deepEqual(collectOutputSchema({ readJson: () => OS_SUMMARY }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
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
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
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
