#!/usr/bin/env node
// Joins cloud catalog + cloud coverage + repo schema files + manual overrides
// into data/pieces.json, then renders TRACKING.md and index.html.
// Refresh the inputs first with scripts/fetch-cloud.sh + scripts/fetch-pr-states.mjs (or npm run fetch) (or run this alone to re-render).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveStage, assigneesOf } from '../lib/stages.mjs';
import { renderPage } from '../lib/render.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const catalog = read('data/cloud-catalog.json');
const coverage = read('data/cloud-coverage.json');
const repoPieces = new Set(read('data/repo-pieces.json'));
const repoSchemas = read('data/repo-schemas.json');
const overrides = read('overrides.json');
const prStates = read('../data/pr-states.json').prs;
const DIST = join(ROOT, '../dist/output-schema');
mkdirSync(DIST, { recursive: true });

const GENERATED = new Date().toISOString().slice(0, 10);
const folderOf = (npmName) => npmName.replace('@activepieces/piece-', '');
const covByName = new Map(coverage.map((c) => [c.name, c]));

const waveOf = {};
for (const [ticket, folders] of Object.entries(overrides.aiAtomicsWaves ?? {})) {
  for (const f of folders) waveOf[f] = ticket;
}

const tierOf = (usage) => (usage >= 20 ? 'P1' : usage >= 5 ? 'P2' : usage >= 1 ? 'P3' : 'P4');
const effortOf = (steps) => (steps <= 3 ? 'XS' : steps <= 8 ? 'S' : steps <= 15 ? 'M' : steps <= 30 ? 'L' : 'XL');

const pieces = catalog.map((p) => {
  const folder = folderOf(p.name);
  const cov = covByName.get(p.name);
  const wiredLive = cov && !cov.error ? (cov.actionsWithSchema ?? 0) + (cov.triggersWithSchema ?? 0) : 0;
  const steps = (p.actions ?? 0) + (p.triggers ?? 0);
  const repoSchema = repoSchemas.pieces[folder];
  const ov = overrides.pieces?.[folder] ?? {};
  const claim = { assignee: ov.assignee ?? null, pr: ov.pr ?? null };

  let status;
  if (ov.status === 'in-progress') status = 'in-progress';
  else if (wiredLive > 0) status = 'live';
  else if (repoSchema) status = 'merged-not-live';
  else if (ov.status === 'review' || ov.status === 'skip') status = ov.status;
  else status = 'todo';

  let gapReason = null;
  if (status === 'merged-not-live' && repoSchema) {
    gapReason = repoSchema.repoVersion !== p.version
      ? `stale publish (repo ${repoSchema.repoVersion} > cloud ${p.version})`
      : 'stripped ingestion (pre-#13983) — needs patch bump + republish';
  }

  return {
    folder,
    npmName: p.name,
    displayName: p.displayName,
    logoUrl: p.logoUrl,
    categories: p.categories ?? [],
    pieceType: p.pieceType,
    cloudVersion: p.version,
    actions: p.actions ?? 0,
    triggers: p.triggers ?? 0,
    steps,
    usage: p.projectUsage ?? 0,
    tier: tierOf(p.projectUsage ?? 0),
    effort: effortOf(steps),
    inRepo: repoPieces.has(folder),
    status,
    wiredLive,
    wiredRepo: repoSchema?.wiredRepo ?? (wiredLive || null),
    repoVersion: repoSchema?.repoVersion ?? null,
    gapReason,
    aiAtomicsWave: waveOf[folder] ?? null,
    linear: ov.linear ?? null,
    stage: (wiredLive > 0 || repoSchema) ? 'merged' : deriveStage(claim, prStates),
    pr: claim.pr,
    assignees: assigneesOf(claim, prStates),
    note: ov.note ?? null,
  };
});

// sanity warnings
for (const f of Object.keys(repoSchemas.pieces)) {
  if (!pieces.some((p) => p.folder === f)) console.warn(`WARN repo-schema piece not in catalog: ${f}`);
}
for (const f of Object.keys(waveOf)) {
  if (!pieces.some((p) => p.folder === f)) console.warn(`WARN AI-atomics wave folder not in catalog: ${f}`);
}
for (const f of Object.keys(overrides.pieces ?? {})) {
  if (!pieces.some((p) => p.folder === f)) console.warn(`WARN override folder not in catalog: ${f}`);
}

const by = (s) => pieces.filter((p) => p.status === s);
const sum = (arr, fn) => arr.reduce((a, x) => a + fn(x), 0);
const totalUsage = sum(pieces, (p) => p.usage);
const liveUsage = sum(by('live'), (p) => p.usage);
const mergedUsage = sum(by('merged-not-live'), (p) => p.usage);
const reviewUsage = sum(pieces.filter((p) => p.status === 'review' || p.status === 'skip'), (p) => p.usage);
const eligibleUsage = totalUsage - reviewUsage;

const summary = {
  generated: GENERATED,
  totals: {
    pieces: pieces.length,
    steps: sum(pieces, (p) => p.steps),
    actions: sum(pieces, (p) => p.actions),
    triggers: sum(pieces, (p) => p.triggers),
  },
  status: Object.fromEntries(
    ['live', 'merged-not-live', 'in-progress', 'todo', 'review', 'skip'].map((s) => [s, by(s).length]),
  ),
  stepsWiredLive: sum(pieces, (p) => p.wiredLive),
  stepsWiredRepo: sum(pieces, (p) => (p.status === 'live' || p.status === 'merged-not-live' ? (p.wiredRepo ?? 0) : 0)),
  usageWeighted: {
    total: totalUsage,
    liveShare: +(liveUsage / totalUsage * 100).toFixed(1),
    repoShare: +((liveUsage + mergedUsage) / totalUsage * 100).toFixed(1),
    eligibleLiveShare: +(liveUsage / eligibleUsage * 100).toFixed(1),
    eligibleRepoShare: +((liveUsage + mergedUsage) / eligibleUsage * 100).toFixed(1),
  },
  tiers: Object.fromEntries(
    ['P1', 'P2', 'P3', 'P4'].map((t) => {
      const tp = pieces.filter((p) => p.tier === t);
      return [t, {
        pieces: tp.length,
        byStatus: Object.fromEntries(
          ['live', 'merged-not-live', 'in-progress', 'todo', 'review', 'skip'].map((s) => [s, tp.filter((p) => p.status === s).length]),
        ),
      }];
    }),
  ),
  stages: {
    assigned: pieces.filter((p) => p.stage === 'assigned').length,
    prOpen: pieces.filter((p) => p.stage === 'pr-open').length,
    merged: by('merged-not-live').length,
    live: by('live').length,
  },
};

writeFileSync(join(DIST, 'pieces.json'), JSON.stringify({ summary, pieces }, null, 2));

// ---------------------------------------------------------------- TRACKING.md
const chip = { live: '🟢 live', 'merged-not-live': '🟡 merged, not live', 'in-progress': '🔵 in progress', todo: '⚪ todo', review: '🔶 review', skip: '⏭ skip' };
const md = [];
md.push(`# Output Schema Rollout — Tracking`);
md.push(``);
md.push(`> Generated ${GENERATED} by \`build.mjs\`. **Do not hand-edit** — computed from the cloud catalog, cloud piece metadata, the upstream repo tree, and \`output-schema/overrides.json\` (manual state goes THERE). Dashboard: \`index.html\`. Full data: \`data/pieces.json\`. How-to: the upstream \`piece-output-schema\` skill (PR #14346).`);
md.push(``);
md.push(`## Where we are`);
md.push(``);
md.push(`| | |`);
md.push(`|---|---|`);
md.push(`| Pieces with schemas **live on cloud** | **${summary.status.live}** of ${summary.totals.pieces} published pieces |`);
md.push(`| Pieces merged in repo but **not live** | **${summary.status['merged-not-live']}** (publish/ingestion gap — see below) |`);
md.push(`| Steps wired live | **${summary.stepsWiredLive}** of ${summary.totals.steps} (${(summary.stepsWiredLive / summary.totals.steps * 100).toFixed(1)}%) |`);
md.push(`| Usage-weighted coverage (live) | **${summary.usageWeighted.liveShare}%** of all project usage · ${summary.usageWeighted.eligibleLiveShare}% of schema-eligible usage |`);
md.push(`| Usage-weighted coverage (if merged pieces go live) | ${summary.usageWeighted.repoShare}% · ${summary.usageWeighted.eligibleRepoShare}% eligible |`);
md.push(`| In progress / review-flagged | ${summary.status['in-progress']} / ${summary.status.review + summary.status.skip} |`);
md.push(``);

const done = pieces.filter((p) => p.status === 'live' || p.status === 'merged-not-live').sort((a, b) => b.usage - a.usage);
md.push(`## Done pieces (PR [#13757](https://github.com/activepieces/activepieces/pull/13757), merged 2026-06-29)`);
md.push(``);
md.push(`| Piece | Usage | Steps | Wired (live) | Cloud ver | State | Gap |`);
md.push(`|---|---|---|---|---|---|---|`);
for (const p of done) {
  md.push(`| ${p.displayName} | ${p.usage} | ${p.actions}a + ${p.triggers}t | ${p.wiredLive}/${p.steps} | ${p.cloudVersion} | ${chip[p.status]} | ${p.gapReason ?? '—'} |`);
}
md.push(``);
md.push(`**Action needed on the 🟡 rows:** stale-publish rows just need the release train / cloud sync to pick up the new patch; stripped-ingestion rows (same version on both sides, schema missing from served metadata) need a **patch bump + republish** so the registry re-ingests with \`outputSchema\` (fix landed in [#13983](https://github.com/activepieces/activepieces/pull/13983) but pieces ingested before it stay stripped until re-published).`);
md.push(``);

const queue = pieces.filter((p) => p.status === 'todo').sort((a, b) => b.usage - a.usage || b.steps - a.steps);
const q1 = queue.filter((p) => p.tier === 'P1');
const q2 = queue.filter((p) => p.tier === 'P2');
md.push(`## Priority queue — next up`);
md.push(``);
md.push(`Ranked by cloud \`projectUsage\`. Effort from step count (XS ≤3 · S ≤8 · M ≤15 · L ≤30 · XL >30). The **Linear** column stays empty until tickets are opened (then set it in \`output-schema/overrides.json\`).`);
md.push(``);
md.push(`### P1 — usage ≥ 20 (${q1.length} pieces)`);
md.push(``);
md.push(`| # | Piece | Usage | Steps | Effort | AI-atomics overlap | Linear | Assignee |`);
md.push(`|---|---|---|---|---|---|---|---|`);
q1.forEach((p, i) => md.push(`| ${i + 1} | ${p.displayName} (\`${p.folder}\`) | ${p.usage} | ${p.actions}a + ${p.triggers}t | ${p.effort} | ${p.aiAtomicsWave ?? '—'} | ${p.linear ?? ''} | ${p.assignees.join(', ')}${p.stage ? ` (${p.stage})` : ''} |`));
md.push(``);
md.push(`### P2 — usage 5–19 (${q2.length} pieces)`);
md.push(``);
md.push(`| # | Piece | Usage | Steps | Effort | AI-atomics overlap | Linear | Assignee |`);
md.push(`|---|---|---|---|---|---|---|---|`);
q2.forEach((p, i) => md.push(`| ${i + 1} | ${p.displayName} (\`${p.folder}\`) | ${p.usage} | ${p.actions}a + ${p.triggers}t | ${p.effort} | ${p.aiAtomicsWave ?? '—'} | ${p.linear ?? ''} | ${p.assignees.join(', ')}${p.stage ? ` (${p.stage})` : ''} |`));
md.push(``);
md.push(`P3 (usage 1–4): ${pieces.filter((p) => p.tier === 'P3' && p.status === 'todo').length} pieces · P4 (usage 0): ${pieces.filter((p) => p.tier === 'P4' && p.status === 'todo').length} pieces — full list in \`data/pieces.json\` / dashboard.`);
md.push(``);

const review = pieces.filter((p) => p.status === 'review' || p.status === 'skip').sort((a, b) => b.usage - a.usage);
md.push(`## Review-flagged (decide: schema, partial, or skip)`);
md.push(``);
md.push(`| Piece | Usage | Why flagged |`);
md.push(`|---|---|---|`);
for (const p of review) md.push(`| ${p.displayName} (\`${p.folder}\`) | ${p.usage} | ${p.note ?? ''} |`);
md.push(``);
md.push(`## Related workstream — AI-agent atomics (separate track, same skill)`);
md.push(``);
md.push(`PIE-364 · PIE-365 · PIE-366: add \`outputSchema\` to ~716 \`audience:'ai'\` actions across the 16 AI-actions wave PRs. Those schemas live on the PR branches, not the catalog — but the pieces overlap (see the AI-atomics column above), so whoever takes a piece here should coordinate with the wave ticket to share captured outputs and field-sets.`);
md.push(``);
md.push(`## Refresh`);
md.push(``);
md.push('```bash');
md.push(`npm run fetch                        # refetch cloud + repo + PR states (from repo root)`);
md.push(`npm run build                        # re-render all dashboards (after editing output-schema/overrides.json)`);
md.push('```');
md.push(``);
writeFileSync(join(DIST, 'TRACKING.md'), md.join('\n'));

// ---------------------------------------------------------------- index.html
const slim = pieces.map((p) => ({
  f: p.folder, d: p.displayName, u: p.usage, a: p.actions, t: p.triggers,
  e: p.effort, r: p.tier, s: p.status, w: p.wiredLive, wr: p.wiredRepo,
  v: p.cloudVersion, rv: p.repoVersion, g: p.gapReason, ai: p.aiAtomicsWave,
  li: p.linear, n: p.note, c: p.categories,
  st: p.stage, pr: p.pr, ass: p.assignees,
}));
renderPage({
  templatePath: join(ROOT, 'template.html'),
  themePath: join(ROOT, '../shared/theme.css'),
  data: { summary, pieces: slim },
  outPath: join(DIST, 'index.html'),
});
writeFileSync(join(DIST, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');

console.log(`Built ${GENERATED}: ${pieces.length} pieces — live ${summary.status.live}, merged-not-live ${summary.status['merged-not-live']}, todo ${summary.status.todo}, review ${summary.status.review + summary.status.skip}`);
console.log(`Steps wired live: ${summary.stepsWiredLive}/${summary.totals.steps} · usage-weighted live ${summary.usageWeighted.liveShare}% (eligible ${summary.usageWeighted.eligibleLiveShare}%)`);
console.log(`Wrote dist/output-schema/{pieces.json, TRACKING.md, summary.json, index.html}`);
