#!/usr/bin/env node
// One-off: every action's audience on main the day before the AI-actions
// rollout began → data/ai-audit-baseline.json, which S2 diffs against.
//
//   node scripts/build-ai-audit-baseline.mjs [--ref <sha>] [--out <file>]
//
// The rollout began with #13952 (Firecrawl + Apify), merged 2026-07-22 13:15
// UTC. The default ref is the last main commit before that day, found with
//   gh api "repos/activepieces/activepieces/commits?sha=main&until=2026-07-21T23:59:59Z&per_page=1"
// which answered 9ed198f (2026-07-21 19:41 UTC). Pinned rather than looked up
// each run so the committed file can be rebuilt byte for byte.
//
// Why so early: the council diffed against 2026-09-11 and found 433 actions
// demoted in 81 pieces, but 24 pieces were converted by 08-05 and any piece
// demoted before 09-11 was invisible to that diff. From the true start, every
// demotion of the rollout is in scope.
//
// It records audiences, never findings -- the same facts upstream's own history
// publishes -- so it is safe in this public repo. Run it again only to move the
// baseline, and say why in the commit.
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { cloneUpstream, readCatalog } from './fetch-ai-audit.mjs';
import { extractPiece, audiencesOf } from '../lib/ai-audit.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const ref = opt('--ref', '9ed198fb27f53755acd0df6711b84ac547ee066e');
const out = resolve(opt('--out', 'data/ai-audit-baseline.json'));

const tmp = mkdtempSync(join(tmpdir(), 'ai-baseline-'));
try {
  console.log(`baseline audiences at ${ref.slice(0, 11)}…`);
  const head = await cloneUpstream({ ref, dir: join(tmp, 'ap'), patterns: ['/packages/pieces/community/*/src/', '/packages/pieces/community/*/package.json'] });
  const pieces = readCatalog(join(tmp, 'ap'), extractPiece);
  const byPiece = audiencesOf(pieces);
  const total = (k) => Object.values(byPiece).reduce((s, g) => s + (g[k]?.length ?? 0), 0);
  const header = {
    commit: head.commit,
    committedAt: head.committedAt,
    actions: { both: total('both'), ai: total('ai'), human: total('human'), unset: total('unset'), expr: total('expr') },
  };
  // One line per piece: a 9,000-action file that still diffs per piece.
  const lines = Object.entries(byPiece).map(([slug, g]) => `    ${JSON.stringify(slug)}: ${JSON.stringify(g)}`);
  const json = JSON.stringify(header, null, 2).replace(/\n}$/, `,\n  "pieces": {\n${lines.join(',\n')}\n  }\n}\n`);
  JSON.parse(json);
  writeFileSync(out, json);
  console.log(`✓ ${Object.keys(byPiece).length} pieces · ${JSON.stringify(header.actions)} @ ${head.commit.slice(0, 11)} (${head.committedAt})`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
