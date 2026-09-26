#!/usr/bin/env node
// One-off, kept for the record: restates the archived aiActions blocks from
// main's own history, on 2026-09-26.
//
// Third in a line (backfill-ai-actions.mjs, backfill-ai-actions-roster.mjs) and
// the first that does not start from ai-actions/pieces.json. Both earlier ones
// restated rows the curated roster KNEW about. W39 is what a curated roster
// cannot fix: 23 pieces gained agent atomics that week -- 17 PRs, #15722 alone
// carrying four -- and 22 of them had no row, so the week archived as
// `merged 30, +1 vs prior week, done: Pinterest`.
//
// Same doctrine as before: reconstruct, do not estimate. Which pieces had an
// audience:'ai' action on main when a week ended has one correct answer, and
// git keeps it. A week ends at 23:59:59Z on its `end` day, the same
// day-resolution the other backfills use (a PR merged ON the Friday counts).
//
//   · MERGED  = at least one audience:'ai' action on main at that commit. The
//               rule scripts/fetch-repo-ai.sh applies live, so a restated week
//               and a live one mean the same thing.
//   · PR-OPEN = not on main yet, and a PR giving it agent atomics existed that
//               week: the PR that later landed them (the first commit on main
//               to add one, which carries `(#N)` in its subject), or one still
//               open today (data/discovered-claims.json). Either way the PR's
//               createdAt decides it, and a PR opened after the week says
//               nothing about it.
//
// ADDED rows only for pieces the week can be dated into. An EXISTING row's
// stage moves only to `merged`, and only when main had it -- a row the archive
// recorded as held or in review keeps that, because its reason is curated and
// dateless. An existing `merged` row that main did NOT have is printed, not
// changed: that is the pubrio/quizell shape, which the last backfill already
// settled by hand.
//
// Untouched, as before: `catalogPieces`, `blockersOpen`, `status`, `builtAt`,
// and every existing row's `actions` (the count that week's page showed).
//
//   node scripts/backfill-ai-actions-from-main.mjs --repo <full clone> [--ref origin/main] [--apply]
//
// Needs a clone of activepieces/activepieces WITH history (not the shallow one
// fetch-repo-ai.sh makes), fetched up to date. Prints the table and changes
// nothing without --apply.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readArchive, writeArchive, validateSnapshot } from '../weekly/lib/archive.mjs';
import { readCatalogIndex } from '../weekly/collect/output-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };

const REPO = arg('--repo');
const REF = arg('--ref') ?? 'origin/main';
if (!REPO) throw new Error('--repo <path to a full clone of activepieces/activepieces> is required');
const apply = process.argv.includes('--apply');

// The same pattern as scripts/fetch-repo-ai.sh and AI_AUDIENCE in lib/discover.mjs;
// test/ai-pattern.test.mjs reads this line to hold the copies together.
const PATTERN = "^[[:space:]]*audience[[:space:]]*:[[:space:]]*['\"]ai['\"]";
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function countsAt(sha) {
  let out = '';
  try {
    out = git('-c', 'core.quotePath=false', 'grep', '--no-color', '-c', '-E', PATTERN, sha, '--', 'packages/pieces/community/*/src/**');
  } catch (e) {
    if (e.status !== 1) throw e;                 // 1 = no match, a reading of zero
  }
  const counts = {};
  for (const line of out.split('\n')) {
    const m = /^[^:]+:packages\/pieces\/community\/([^/]+)\/.*:(\d+)$/.exec(line);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + Number(m[2]);
  }
  return counts;
}

// The PR that first put an agent atomic on this piece's main, or null.
function landingPr(slug) {
  const log = git('log', REF, '--reverse', '--format=%s', '-G', PATTERN, '--', `packages/pieces/community/${slug}/src`);
  const first = log.split('\n').find(Boolean);
  const m = first ? /\(#(\d+)\)\s*$/.exec(first) : null;
  return m ? Number(m[1]) : null;
}

const { prs: prStates } = read('data/pr-states.json');
const createdCache = new Map();
function createdAt(n) {
  if (prStates[n]?.createdAt) return prStates[n].createdAt;
  if (!createdCache.has(n)) {
    createdCache.set(n, execFileSync('gh', ['api', `repos/activepieces/activepieces/pulls/${n}`, '--jq', '.created_at'],
      { encoding: 'utf8' }).trim());
  }
  return createdCache.get(n);
}

const catalog = readCatalogIndex(read);
const rowFor = (slug, stage, actions) => {
  const known = catalog.get(slug);
  return {
    name: slug,
    actions,
    stage,
    ...(known?.displayName ? { displayName: known.displayName } : {}),
    logo: known?.logo ?? null,
  };
};

const onMainNow = countsAt(git('rev-parse', REF).trim());
const landing = new Map(Object.keys(onMainNow).map((slug) => [slug, landingPr(slug)]));
const openNow = (() => { try { return read('data/discovered-claims.json').aiActions ?? {}; } catch { return {}; } })();

const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const archive = readArchive(ARCHIVE);
if (!archive.weeks.length) throw new Error('empty archive — nothing to backfill');

for (const week of archive.weeks) {
  const ws = week.aiActions;
  if (ws?.status !== 'ok' || !Array.isArray(ws.roster)) {
    console.log(`${week.week}  skipped — no ok aiActions block with a roster`);
    continue;
  }
  const endOfWeek = `${week.end}T23:59:59Z`;
  const sha = git('rev-list', '-1', `--before=${endOfWeek}`, REF).trim();
  if (!sha) throw new Error(`${week.week}: no ${REF} commit before ${endOfWeek} — the clone is shallow; deepen it (git fetch --shallow-since=<date> origin main)`);
  const counts = countsAt(sha);
  const openedBy = (n) => n != null && Date.parse(createdAt(n)) <= Date.parse(endOfWeek);
  const before = `merged ${ws.merged} / PR-open ${ws.prOpen} / held ${ws.held} / tracked ${ws.totalPieces}`;

  const promoted = [];
  const contradicted = [];
  for (const row of ws.roster) {
    if (counts[row.name] > 0 && row.stage !== 'merged') { promoted.push(`${row.name}:${row.stage}→merged`); row.stage = 'merged'; }
    else if (!(counts[row.name] > 0) && row.stage === 'merged') contradicted.push(row.name);
  }

  const present = new Set(ws.roster.map((r) => r.name));
  const added = [];
  const add = (slug, stage, actions) => { ws.roster.push(rowFor(slug, stage, actions)); present.add(slug); added.push(`${slug}:${stage}`); };
  for (const slug of Object.keys(counts).sort()) {
    if (!present.has(slug) && counts[slug] > 0) add(slug, 'merged', counts[slug]);
  }
  for (const [slug, n] of [...landing].sort()) {
    if (!present.has(slug) && openedBy(n)) add(slug, 'pr-open', 0);
  }
  for (const slug of Object.keys(openNow).sort()) {
    if (!present.has(slug) && openedBy(openNow[slug])) add(slug, 'pr-open', 0);
  }
  ws.roster.sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));

  // Recounted from the roster, as ai-actions/build.mjs does live, so the tile
  // and the pieces behind it can never disagree.
  const count = (s) => ws.roster.filter((r) => r.stage === s).length;
  ws.merged = count('merged');
  ws.prOpen = count('pr-open');
  ws.assigned = count('assigned');
  ws.held = count('held');
  ws.totalPieces = ws.roster.length;

  const after = `merged ${ws.merged} / PR-open ${ws.prOpen} / held ${ws.held} / tracked ${ws.totalPieces}`;
  console.log(`${week.week} (…${week.end}, main ${sha.slice(0, 11)})  ${before}  →  ${after}`);
  if (promoted.length) console.log(`    promoted: ${promoted.join(' ')}`);
  if (added.length) console.log(`    added:    ${added.join(' ')}`);
  if (contradicted.length) console.log(`    ⚠ archived merged, not on main that week (left as is): ${contradicted.join(' ')}`);
  validateSnapshot(week);
}

if (!apply) {
  console.log('\ndry run — pass --apply to write weekly/data/weeks.json');
} else {
  writeArchive(ARCHIVE, archive);
  console.log('\n✓ weekly/data/weeks.json updated');
}
