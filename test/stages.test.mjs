import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveStage, assigneesOf } from '../lib/stages.mjs';

const prs = {
  100: { state: 'OPEN', assignees: ['kishanprmr'] },
  200: { state: 'MERGED', assignees: [] },
  300: { state: 'CLOSED', assignees: [] },
};

test('unclaimed → null', () => assert.equal(deriveStage({}, prs), null));
test('assignee only → assigned', () => assert.equal(deriveStage({ assignee: 'sanket-a11y' }, prs), 'assigned'));
test('open PR → pr-open', () => assert.equal(deriveStage({ pr: 100 }, prs), 'pr-open'));
test('merged PR wins over assignee', () => assert.equal(deriveStage({ assignee: 'x', pr: 200 }, prs), 'merged'));
test('closed-unmerged PR falls back to the claim', () => {
  assert.equal(deriveStage({ assignee: 'x', pr: 300 }, prs), 'assigned');
  assert.equal(deriveStage({ pr: 300 }, prs), null);
});
test('unknown PR number falls back to the claim', () =>
  assert.equal(deriveStage({ assignee: 'x', pr: 999 }, prs), 'assigned'));
test('a PR assignee alone counts as a claim', () =>
  assert.equal(deriveStage({ pr: 300 }, { 300: { state: 'CLOSED', assignees: ['a'] } }), 'assigned'));
test('assigneesOf merges manual + PR assignees, deduped, manual first', () => {
  assert.deepEqual(assigneesOf({ assignee: 'kishanprmr', pr: 100 }, prs), ['kishanprmr']);
  assert.deepEqual(assigneesOf({ assignee: 'x', pr: 100 }, prs), ['x', 'kishanprmr']);
  assert.deepEqual(assigneesOf({}, prs), []);
});
