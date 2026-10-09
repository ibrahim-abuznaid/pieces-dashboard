// test/weekly-collect-connection-identifier.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectConnectionIdentifier } from '../weekly/collect/connection-identifier.mjs';

const SUMMARY = {
  generated: '2026-10-09', prFetched: '2026-10-09',
  totals: { pieces: 111, oauth2: 121, noIdentity: 10, claimed: 58 },
  status: { live: 58, merged: 0, review: 2, assigned: 0, planned: 0 },
  merged: 58,
  roads: { hook: 26, token: 32 },
};
const PIECES = { generated: '2026-10-09', pieces: [
  { folder: 'google-sheets', displayName: 'Google Sheets', logoUrl: 'https://cdn/gs.png', steps: 28, road: 'token', stage: 'live', author: 'AhmadTash' },
  { folder: 'gmail', displayName: 'Gmail', logoUrl: null, steps: 20, road: 'hook', stage: 'live', author: 'ibrahim-abuznaid' },
  { folder: 'box', displayName: 'Box', logoUrl: 'https://cdn/box.png', steps: 9, road: 'hook', stage: 'review', author: null },
] };

const reader = (files) => (path) => {
  if (!(path in files)) throw new Error(`ENOENT ${path}`);
  return structuredClone(files[path]);
};
const read = (over = {}) => reader({
  'dist/connection-identifier/summary.json': SUMMARY,
  'dist/connection-identifier/pieces.json': PIECES,
  ...over,
});

test('the headline counts and the denominator come off the build summary', () => {
  const ws = collectConnectionIdentifier({ readJson: read() });
  assert.equal(ws.status, 'ok');
  assert.equal(ws.merged, 58);
  assert.equal(ws.live, 58);
  assert.equal(ws.review, 2);
  assert.equal(ws.assigned, 0);
  assert.equal(ws.totalPieces, 111);
});

test('the roster is keyed on folder and carries name, size, stage, logo and author', () => {
  const { roster } = collectConnectionIdentifier({ readJson: read() });
  assert.deepEqual(roster[0], {
    folder: 'google-sheets', name: 'google-sheets', displayName: 'Google Sheets',
    actions: 28, stage: 'live', logo: 'https://cdn/gs.png', author: 'AhmadTash',
  });
  assert.equal('author' in roster[2], false, 'no author is absent, never null');
  assert.equal(roster[1].logo, null);
});

test('a summary with no live count passes the absence through, never a 0', () => {
  const { live, ...status } = SUMMARY.status;
  const ws = collectConnectionIdentifier({ readJson: read({
    'dist/connection-identifier/summary.json': { ...SUMMARY, status },
  }) });
  assert.equal(ws.status, 'ok');
  assert.equal('live' in ws, false);
});

// The build publishes a null denominator when the coverage file was never
// measured. "58 of null" cannot render, and "of 0" would be a lie.
test('an unmeasured denominator degrades the workstream to no-data', () => {
  const ws = collectConnectionIdentifier({ readJson: read({
    'dist/connection-identifier/summary.json': { ...SUMMARY, totals: { ...SUMMARY.totals, pieces: null } },
  }) });
  assert.equal(ws.status, 'no-data');
  assert.match(ws.reason, /totals\.pieces/);
});

test('a missing build output is no-data with the command to fix it', () => {
  const ws = collectConnectionIdentifier({ readJson: reader({}) });
  assert.equal(ws.status, 'no-data');
  assert.match(ws.reason, /npm run fetch && npm run build/);
});

test('a lost pieces.json costs the roster, not the counts', () => {
  const ws = collectConnectionIdentifier({ readJson: reader({ 'dist/connection-identifier/summary.json': SUMMARY }) });
  assert.equal(ws.status, 'ok');
  assert.deepEqual(ws.roster, []);
});
