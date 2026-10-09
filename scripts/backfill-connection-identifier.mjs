#!/usr/bin/env node
// One-off, kept for the record: adds the `connectionIdentifier` block to the
// weeks archived before the workstream existed.
//
// Legitimate for the same reason scripts/backfill-ui-improvements.mjs was: every
// stage it writes is decided by two TIMESTAMPS per claim, `createdAt` and
// `mergedAt`, which GitHub keeps permanently and data/pr-states.json carries.
// "How many pieces had a connection identifier merged by Friday 2026-10-02" has
// one correct answer, and it is the same today as it was that Friday.
//
// What it does NOT write is `live`: whether a merged hook was on cloud that week
// is in no timestamp we hold, and the archive makes `live` optional so a
// reconstructed week can stay silent rather than guess. Landed rows come from the
// claims file — every piece that has landed has a row there today, which the
// build checks by WARNing about any hook it finds on cloud without one.
//
// The point of doing it at all: the first live snapshot (W41) needs a W40
// roster beside it, or its strip can only say "Done in total" and its delta
// pill stays empty — the week the team shipped 24 hooks would read as no news.
//
//   node scripts/backfill-connection-identifier.mjs [--apply]
//
// Prints the table and changes nothing without --apply. Run `npm run fetch &&
// npm run build` first: it needs the PR timestamps and today's build.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { blockAt, validateClaims } from '../lib/connection-identifier.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const claimsFile = read('connection-identifier/pieces.json');
validateClaims(claimsFile);
const { prs } = read('data/pr-states.json');
// Hook PRs discovered open today were open in the weeks since they were
// created, so they are that history's review queue too. Curated wins, as in
// the build.
let discovered = {};
try { discovered = read('data/discovered-claims.json').connectionIdentifier ?? {}; } catch { /* claims alone */ }
const curated = new Set(claimsFile.pieces.map((c) => c.slug));
const claims = [...claimsFile.pieces,
  ...Object.entries(discovered).filter(([slug]) => !curated.has(slug)).map(([slug, pr]) => ({ slug, road: 'hook', pr }))];
const rowsNow = read('dist/connection-identifier/pieces.json').pieces;
const totalPieces = read('dist/connection-identifier/summary.json').totals?.pieces;
if (typeof totalPieces !== 'number') {
  throw new Error('dist/connection-identifier/summary.json has no denominator — run `npm run fetch && npm run build` first');
}

const missing = claims.filter((c) => c.pr != null && !prs[c.pr]).map((c) => `${c.slug} (#${c.pr})`);
if (missing.length) {
  throw new Error(`data/pr-states.json has no state for ${missing.join(', ')} — run \`npm run fetch:prs\` first`);
}

const apply = process.argv.includes('--apply');
const archive = readArchive(ARCHIVE);
if (!archive.weeks.length) throw new Error('empty archive — nothing to backfill');

for (const week of archive.weeks) {
  const block = blockAt({ claims, prs, rowsNow, totalPieces, end: week.end });
  const had = week.connectionIdentifier ? 'already present, replaced' : 'added';
  console.log(`${week.week} (…${week.end})  merged ${block.merged}  review ${block.review}  of ${totalPieces}  · ${had}`);
  week.connectionIdentifier = block;
  validateSnapshot(week);
}

if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
