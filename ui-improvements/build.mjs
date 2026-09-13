#!/usr/bin/env node
// Joins the curated claim list + live PR states + the cloud catalog into
// dist/ui-improvements/. No page of its own: this workstream's only reader today
// is the weekly snapshot, and a tracking page nobody asked for is a page nobody
// maintains. Refresh the inputs with `npm run fetch` first.
//
// The question this build answers is "which pieces have the new step-settings
// UI", and it has two halves that must not be conflated:
//
//   · MERGED — the adoption landed in the repo. Read from the claim's PR state,
//     so it is true the moment a PR merges.
//   · LIVE   — the cloud catalog actually publishes the metadata. Read from the
//     catalog itself, so it only turns true after a release train and a
//     registry ingestion the team does not control.
//
// Live implies merged; the gap between them is the release queue, which is why
// the weekly page's headline is MERGED (what the team did) and `live` rides
// along as the detail (what a user can see).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveStage, assigneesOf } from '../lib/stages.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const { pieces: claims } = read('pieces.json');
const catalog = read('../output-schema/data/cloud-catalog.json');
const coverage = read('../output-schema/data/cloud-coverage.json');
const prData = read('../data/pr-states.json');

const DIST = join(ROOT, '../dist/ui-improvements');

// The catalog is keyed by npm name; every other file here is keyed by folder.
const folderOf = (npmName) => npmName.replace('@activepieces/piece-', '');
const catalogByFolder = new Map(catalog.map((p) => [folderOf(p.name), p]));
const covByFolder = new Map(coverage.map((c) => [folderOf(c.name), c]));

// What "this piece has the new property UI" means, measured against the cloud
// catalog. Either signal counts and neither is weighted: a piece that only
// flags a few props `advanced` has adopted the redesign's core visual change
// (the essential/Advanced split), and most of the catalog needs nothing more
// than that — see the per-piece definition of done in the team's
// ui-improvements/README.md.
//
// The shared `custom_api_call` action is already excluded upstream, in
// scripts/fetch-cloud.sh, where the field is computed. It is one generic form
// injected into ~500 pieces, and counting its four `advanced` props here would
// have reported 10 pieces as adopters of work nobody on this team did.
const liveOnCloud = (cov) => (cov?.uiGrouped ?? 0) > 0 || (cov?.uiAdvanced ?? 0) > 0;

// Whether the cloud half was measured AT ALL. The two ui* fields are computed in
// scripts/fetch-cloud.sh, so a coverage file written before they existed — or
// one left stale by a build that skipped the fetch — carries neither, and every
// piece reads as "not on cloud". That is the difference between `live: 0` and no
// measurement, and it is not cosmetic: `merged − live` is the page's
// "needs a cloud release" ask, so an unmeasured file would put five pieces'
// worth of a false ask in front of whoever runs the release.
//
// So an unmeasured file publishes no `live` at all — the same shape the
// backfilled weeks carry, and the reason the archive makes the field optional.
const cloudMeasured = coverage.some((c) => typeof c?.uiGrouped === 'number');

// A stage per piece, in the order the work actually moves. `live` and `merged`
// are the two that count as done.
//
// Deliberately NOT outputSchema's `merged-not-live`: that name asserts a piece
// is absent from cloud, and this build is the only place that ever measures
// cloud. The backfill reconstructs past weeks from PR dates alone and cannot
// make that claim for them, so the stage it writes is the weaker, true one —
// `merged` — and `live` is a strictly-narrower subset of it.
function stageOf(claim, cov) {
  if (cloudMeasured && liveOnCloud(cov)) return 'live';
  const derived = deriveStage(claim, prData.prs);
  if (derived === 'merged') return 'merged';
  if (derived === 'pr-open') return 'review';
  if (derived === 'assigned') return 'assigned';
  return 'planned';
}

const rowFor = (claim) => {
  const cov = covByFolder.get(claim.slug);
  const cat = catalogByFolder.get(claim.slug);
  const pr = claim.pr ?? null;
  return {
    folder: claim.slug,
    // The published name, falling back to the folder for a piece the catalog
    // does not carry — a claim can legitimately precede the piece existing on
    // cloud, and a row with no name at all would render as a nameless chip.
    displayName: cat?.displayName || claim.slug,
    logoUrl: cat?.logoUrl ?? null,
    // The piece's size, and the roster's sort key. Steps, not props: it is the
    // number the other two workstreams' rosters carry, so one reader reads all
    // three the same way.
    steps: (cov?.totalActions ?? 0) + (cov?.totalTriggers ?? 0),
    grouped: cov?.uiGrouped ?? 0,
    advanced: cov?.uiAdvanced ?? 0,
    stage: stageOf(claim, cov),
    pr,
    prState: pr != null ? (prData.prs[pr]?.state ?? null) : null,
    mergedAt: pr != null ? (prData.prs[pr]?.mergedAt ?? null) : null,
    assignees: assigneesOf({ assignee: claim.assignee ?? null, pr }, prData.prs),
    note: claim.note ?? null,
  };
};

const rows = claims.map(rowFor);

// A piece can reach cloud with the new UI without ever passing through this
// file — it arrives inside a piece's own PR (WhatsScale, Sage Accounting), or a
// community contributor authors it grouped from the start. The cloud catalog is
// the measurement, so those pieces are counted; the WARN is how the claim list
// catches up, and it names the piece rather than just counting it so that the
// fix is a copy-paste.
const claimed = new Set(rows.map((r) => r.folder));
for (const [folder, cov] of covByFolder) {
  if (claimed.has(folder) || !cloudMeasured || !liveOnCloud(cov)) continue;
  console.warn(`WARN ${folder} publishes the new property UI but has no row in ui-improvements/pieces.json — add it (slug + pr) so the week it landed can be attributed`);
  rows.push(rowFor({ slug: folder }));
}

rows.sort((a, b) => b.steps - a.steps || a.folder.localeCompare(b.folder));

const stageCount = (s) => rows.filter((r) => r.stage === s).length;
const summary = {
  generated: new Date().toISOString().slice(0, 10),
  prFetched: prData.fetched,
  // The whole catalog, which is the denominator that matters: this workstream's
  // job is the 765 published pieces, not the 8 currently claimed.
  totals: { pieces: catalog.length, claimed: rows.length },
  status: {
    // Spread, not assigned: `live: undefined` would survive into the weekly
    // snapshot as a key that reads "recorded, but unknown".
    ...(cloudMeasured ? { live: stageCount('live') } : {}),
    merged: stageCount('merged'),
    review: stageCount('review'),
    assigned: stageCount('assigned'),
    planned: stageCount('planned'),
  },
};
// Landed either way — the headline, and the one number the weekly tile shows.
summary.merged = (summary.status.live ?? 0) + summary.status.merged;

if (!cloudMeasured) {
  console.warn('WARN output-schema/data/cloud-coverage.json carries no uiGrouped/uiAdvanced — run `npm run fetch` (scripts/fetch-cloud.sh computes them). Reporting merged work only; nothing is claimed about what is live.');
}

mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(join(DIST, 'pieces.json'), `${JSON.stringify({ generated: summary.generated, pieces: rows }, null, 2)}\n`);
console.log(`✓ ui-improvements: ${summary.merged} of ${summary.totals.pieces} pieces landed (${
  cloudMeasured ? `${summary.status.live} live on cloud` : 'cloud state not measured'}) · ${
  summary.status.review} in review / ${summary.status.assigned} assigned / ${summary.status.planned} planned`);
