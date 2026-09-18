import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAiData } from '../ai-actions/validate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const good = () => ({
  pieces: [{ slug: 'a', atomics: 3, pr: 1, t2v: 3, t2t: 3 }, { slug: 'b', atomics: 1, held: 'why', t2v: 0, t2t: 1 }],
  categories: [{ id: 'framework', label: 'Framework' }],
  blockers: [{ id: 'x', cat: 'framework', sev: 'high', done: false, pieces: ['a'], title: 't', why: 'w', fix: 'f' }],
});

test('valid data → no problems', () => assert.deepEqual(validateAiData(good()), []));
test('the real migrated data is valid', () => {
  const problems = validateAiData({ ...read('ai-actions/blockers.json'), pieces: read('ai-actions/pieces.json').pieces });
  assert.deepEqual(problems, []);
});
test('piece with neither pr nor held is flagged', () => {
  const d = good(); d.pieces[0].pr = null;
  assert.match(validateAiData(d).join(' '), /no pr and no held/);
});
test('missing t2 counts flagged unless t2shared', () => {
  const d = good(); delete d.pieces[0].t2v;
  assert.match(validateAiData(d).join(' '), /t2v/);
  d.pieces[0].t2shared = 'b';
  assert.deepEqual(validateAiData(d), []);
});
test('unknown blocker category / bad severity / duplicate ids flagged', () => {
  const d = good();
  d.blockers.push({ ...d.blockers[0] });                      // duplicate id
  d.blockers[0] = { ...d.blockers[0], cat: 'nope', sev: 'huge' };
  const msgs = validateAiData(d).join(' ');
  assert.match(msgs, /unknown cat/); assert.match(msgs, /sev/); assert.match(msgs, /duplicate/);
});

// The stale-pointer bug that reported three finished pieces as `assigned` for
// six weeks: the PR number still resolved, so nothing else in the pipeline
// could tell "superseded" from "claimed, not started".
test('a claim pointing at a closed, unmerged PR is flagged', () => {
  const d = good();
  const msgs = validateAiData({ ...d, prStates: { 1: { state: 'CLOSED' } } }).join(' ');
  assert.match(msgs, /pr #1 closed without merging/);
  assert.match(msgs, /superseding PR|held reason/);
});
test('merged and open PRs are not flagged, and no prStates skips the check', () => {
  const d = good();
  for (const state of ['MERGED', 'OPEN']) {
    assert.deepEqual(validateAiData({ ...d, prStates: { 1: { state } } }), []);
  }
  assert.deepEqual(validateAiData(d), []);                    // pure call, no PR states
  assert.deepEqual(validateAiData({ ...d, prStates: {} }), []); // number not fetched
});
test('the real curated data has no claim on a closed PR', () => {
  const problems = validateAiData({
    ...read('ai-actions/blockers.json'),
    pieces: read('ai-actions/pieces.json').pieces,
    prStates: read('data/pr-states.json').prs,
  });
  assert.deepEqual(problems, []);
});
