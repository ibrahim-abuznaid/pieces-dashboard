// test/reviews.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewVerdict } from '../lib/reviews.mjs';

const r = (login, state, at, type = 'User') => ({ user: { login, type }, state, submitted_at: at });

test('a human approval approves, and dates itself', () =>
  assert.deepEqual(reviewVerdict([r('ibrahim-abuznaid', 'APPROVED', '2026-09-26T15:40:00Z')]),
    { approved: true, approvedAt: '2026-09-26T15:40:00Z' }));

test('no reviews is not approved', () =>
  assert.deepEqual(reviewVerdict([]), { approved: false, approvedAt: null }));

// Greptile comments on every PR; a bot is never a reviewer here.
test('a bot review never approves', () =>
  assert.equal(reviewVerdict([r('greptile-apps[bot]', 'APPROVED', '2026-09-26T00:00:00Z', 'Bot')]).approved, false));

test('changes requested by anyone outweighs an approval', () =>
  assert.equal(reviewVerdict([
    r('ibrahim-abuznaid', 'APPROVED', '2026-09-26T10:00:00Z'),
    r('kishanprmr', 'CHANGES_REQUESTED', '2026-09-26T11:00:00Z'),
  ]).approved, false));

// A comment after an approval is a comment, not a withdrawal.
test('a later comment by the approver keeps the approval', () =>
  assert.equal(reviewVerdict([
    r('ibrahim-abuznaid', 'APPROVED', '2026-09-26T10:00:00Z'),
    r('ibrahim-abuznaid', 'COMMENTED', '2026-09-26T11:00:00Z'),
  ]).approved, true));

test('a dismissed approval is no approval', () =>
  assert.equal(reviewVerdict([r('ibrahim-abuznaid', 'DISMISSED', '2026-09-26T10:00:00Z')]).approved, false));

test('a reviewer who approves after requesting changes has approved', () =>
  assert.equal(reviewVerdict([
    r('ibrahim-abuznaid', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'),
    r('ibrahim-abuznaid', 'APPROVED', '2026-09-26T10:00:00Z'),
  ]).approved, true));
