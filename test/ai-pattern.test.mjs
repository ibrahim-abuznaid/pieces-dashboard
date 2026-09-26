// test/ai-pattern.test.mjs
// One rule, three copies: AI_AUDIENCE classifies open-PR diffs in JS, and the
// same rule in POSIX ERE counts main (scripts/fetch-repo-ai.sh) and restates the
// archive (scripts/backfill-ai-actions-from-main.mjs). If they drift, a piece is
// in review by one rule and never lands by the other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_AUDIENCE } from '../lib/discover.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = (p) => readFileSync(join(ROOT, p), 'utf8');

const shellPattern = () => {
  const m = /^PATTERN="(.*)"$/m.exec(src('scripts/fetch-repo-ai.sh'));
  assert.ok(m, 'fetch-repo-ai.sh has a PATTERN="..." line');
  return m[1].replace(/\\"/g, '"');
};
const backfillPattern = () => {
  const m = /^const PATTERN = ("(?:[^"\\]|\\.)*");$/m.exec(src('scripts/backfill-ai-actions-from-main.mjs'));
  assert.ok(m, 'the backfill has a const PATTERN = "..." line');
  return JSON.parse(m[1]);
};

test('the fetch and the backfill carry the same pattern', () => {
  assert.equal(backfillPattern(), shellPattern());
});

// The lines that matter, including the 16 comment shapes main actually carries.
const LINES = [
  ["  audience: 'ai',", true],
  ["audience:'ai',", true],
  ['    audience: "ai",', true],
  ["\taudience : 'ai',", true],
  ["// audience:'ai' atomics", false],
  ["    // AI agent atomics (audience: 'ai')", false],
  [" * Shared helpers for the audience:'ai' Trello atomics.", false],
  ["  audience: 'both',", false],
  ["  audience: 'human',", false],
  ['  aiMetadata: { description: "x" },', false],
  ["  mintOidcToken({ audience: 'https://ai.example' })", false],
];

test('the JS rule and the git grep rule agree, line by line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-pattern-'));
  const file = join(dir, 'sample.ts');
  writeFileSync(file, LINES.map(([l]) => l).join('\n') + '\n');
  let out = '';
  try {
    out = execFileSync('grep', ['-n', '-E', shellPattern(), file], { encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;
  }
  const byGrep = new Set(out.split('\n').filter(Boolean).map((l) => Number(l.split(':')[0])));
  LINES.forEach(([line, want], i) => {
    assert.equal(byGrep.has(i + 1), want, `grep on: ${line}`);
    // Discovery sees the line as an ADDED diff line, with its leading '+'.
    assert.equal(AI_AUDIENCE.test(`+${line}`), want, `AI_AUDIENCE on: ${line}`);
  });
});
