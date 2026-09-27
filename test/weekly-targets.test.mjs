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
