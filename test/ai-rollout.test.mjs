// test/ai-rollout.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pieceRollout, summarizeRollout } from '../lib/ai-rollout.mjs';

const NOW = Date.parse('2026-10-21T12:00:00Z');
const piece = { slug: 'acme', version: '0.4.0', aiActions: ['get_a', 'update_a'] };
const live = { version: '0.4.0', aiActions: ['get_a', 'update_a'] };
const row = (over = {}) => pieceRollout({
  piece, npm: { latest: '0.4.0', publishedAt: '2026-10-20T10:06:00Z' }, cloud: live, mergedAt: '2026-10-20T10:00:00Z', now: NOW, ...over,
});

test('a piece live everywhere: on npm at main, served with its AI actions, lag in minutes', () => {
  const r = row();
  assert.equal(r.npmAtMain, true);
  assert.equal(r.lagMin, 6);
  assert.equal(r.collision, false);
  assert.equal(r.served, true);
  assert.equal(r.servedWithAi, true);
  assert.deepEqual(r.missingAi, []);
  assert.equal(r.stuck24h, false);
});

// npm had the version before main merged it: the merge never published.
test('negative merge → npm lag is the version-collision signature', () => {
  const r = row({ npm: { latest: '0.4.0', publishedAt: '2026-10-20T09:00:00Z' } });
  assert.equal(r.lagMin, -60);
  assert.equal(r.collision, true);
});

test('Cloud on an older version is not served, and stuck once the merge is a day old', () => {
  const r = row({ cloud: { version: '0.3.9', aiActions: ['get_a'] } });
  assert.equal(r.served, false);
  assert.equal(r.servedWithAi, false);
  assert.equal(r.stuck24h, true);
  const fresh = row({ cloud: { version: '0.3.9', aiActions: [] }, mergedAt: '2026-10-21T08:00:00Z' });
  assert.equal(fresh.stuck24h, false, 'four hours is the release train, not stuck');
});

test('Cloud at main but missing an AI action is served, not served-with-AI', () => {
  const r = row({ cloud: { version: '0.4.0', aiActions: ['get_a'] } });
  assert.equal(r.served, true);
  assert.equal(r.servedWithAi, false);
  assert.deepEqual(r.missingAi, ['update_a']);
});

test('a 404 is a reading (not registered); a failed call is not measured', () => {
  const gone = row({ cloud: { missing: true } });
  assert.equal(gone.cloudRegistered, false);
  assert.equal(gone.served, false);
  const failed = row({ cloud: { error: true }, npm: { error: true } });
  assert.equal(failed.served, null);
  assert.equal(failed.servedWithAi, null);
  assert.equal(failed.stuck24h, null);
  assert.equal(failed.npmAtMain, null);
  assert.equal(failed.lagMin, null);
  assert.equal(row({ mergedAt: null }).stuck24h, null, 'no merge time, no verdict');
});

test('npm behind main, or not on npm at all, is behind', () => {
  assert.equal(row({ npm: { latest: '0.3.2', publishedAt: null } }).npmBehind, true);
  const none = row({ npm: { latest: null, publishedAt: null } });
  assert.equal(none.npmAtMain, false);
  assert.equal(none.npmBehind, true);
});

test('the counts: percentages over what was measured, lag median/p90/max, collisions apart', () => {
  const rows = [
    row(),
    row({ npm: { latest: '0.4.0', publishedAt: '2026-10-20T10:20:00Z' } }),
    row({ npm: { latest: '0.4.0', publishedAt: '2026-10-20T10:58:00Z' } }),
    row({ npm: { latest: '0.4.0', publishedAt: '2026-10-20T09:00:00Z' } }),
    row({ cloud: { error: true } }),
    row({ cloud: { version: '0.3.0', aiActions: [] } }),
  ];
  const s = summarizeRollout(rows, { commit: 'abc', fetched: '2026-10-21' });
  assert.equal(s.pieces, 6);
  assert.deepEqual(s.npm.lagMinutes, { n: 5, median: 6, p90: 58, max: 58 }, 'the collision is not a lag');
  assert.equal(s.npm.collisions, 1);
  assert.equal(s.npm.atMainPct, 100);
  assert.equal(s.cloud.measured, 5, 'the failed Cloud call leaves the denominator');
  assert.equal(s.cloud.served, 4);
  assert.equal(s.cloud.servedPct, 80);
  assert.equal(s.stuck24h.count, 1);
});

test('a stage that measured nothing is null, not 0%', () => {
  const s = summarizeRollout([row({ cloud: { error: true }, npm: { error: true } })]);
  assert.equal(s.npm, null);
  assert.equal(s.cloud, null);
  assert.equal(s.stuck24h, null);
});
