// Which rollout is an open PR doing, and for which piece?
//
// Every workstream here used to learn about a PR only when somebody typed its
// number into a claims file. That is fine for the MERGED counts -- those are
// measured against the cloud catalog and the repo tree, so landed work is found
// whether or not anyone wrote it down -- but it is the whole story for work IN
// FLIGHT. A PR nobody claimed is a PR the page cannot see, and the page then
// reports an empty queue, which reads as "nothing is happening" rather than
// "nobody typed it in". On the day this was written that cost the page 16 open
// PRs, including five step-form PRs and one of Kishan's own.
//
// So in-flight work is DISCOVERED from the diff rather than declared. The
// claims files keep what GitHub cannot know -- held reasons, wave membership,
// the curated note -- and stop being the only way a PR becomes visible.
//
// PURE on purpose: this module is handed PRs and their files, never a network.
// The fetching lives in scripts/fetch-pr-states.mjs, the classification lives
// here, and the rule that decides a rollout is a thing you can read in one
// screen and test without a token.

// Only the monorepo's piece directories. A PR that edits the engine, the UI or
// `packages/shared` is not piece work however it is titled.
const PIECE_PATH = /^packages\/pieces\/community\/([^/]+)\//;

// Added lines only, and never the `+++ b/path` file header -- which starts with
// a '+' and carries the filename, so an unfiltered scan tags every PR that so
// much as touches a file called `ai-metadata.ts`.
//
// Deletions are not adoption: a PR that REMOVES `propertyGroups` is doing the
// opposite of this rollout, and counting it would be worse than missing it.
function addedLines(patch) {
  if (typeof patch !== 'string') return '';
  return patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
}

// One signature per rollout, each chosen to be the thing the work cannot be done
// without:
//
// · outputSchema — the piece gains an `output-schemas.ts`. A path, not a
//   pattern, and the same file the cloud fetch greps for on main, so the
//   in-flight and landed halves agree on what the work IS.
// · uiImprovements — `propertyGroups` or `advanced: true` appears. Either
//   counts and neither is weighted, matching `liveOnCloud` in the build: the
//   essential/Advanced split alone is adoption for most of the catalog.
// · aiActions — `aiMetadata` appears.
//
// Attributed PER FILE, not per PR: one PR routinely carries two pieces (#15539
// did pinterest and trello), and a PR-level answer would put both rollouts on
// both pieces. The signal belongs to the piece whose file carried it.
export function classifyFiles(files) {
  const byPiece = new Map();
  const mark = (slug, rollout) => {
    if (!byPiece.has(slug)) byPiece.set(slug, new Set());
    byPiece.get(slug).add(rollout);
  };
  for (const f of files ?? []) {
    const m = PIECE_PATH.exec(f?.filename ?? '');
    if (!m) continue;
    const slug = m[1];
    if (/\/output-schemas\.ts$/.test(f.filename)) mark(slug, 'outputSchema');
    const added = addedLines(f.patch);
    if (/propertyGroups/.test(added) || /advanced\s*:\s*true/.test(added)) mark(slug, 'uiImprovements');
    if (/aiMetadata/.test(added)) mark(slug, 'aiActions');
  }
  return byPiece;
}

export const ROLLOUTS = ['outputSchema', 'uiImprovements', 'aiActions'];

// slug -> PR number, per rollout. The shape each build merges into its claims.
//
// `aiWave` is the AI-actions rollout's tracked piece list, and it is a FILTER
// rather than a hint. Every community piece scaffolded today ships `aiMetadata`
// because the CLI template carries it, so an unfiltered rule would fold three
// brand-new pieces a week into a rollout that is a defined wave of 28 -- the
// denominator stops meaning anything and the number stops being auditable.
// A new piece gaining AI actions is real and worth saying; it is just not this.
// The other two rollouts are catalog-wide and take no such filter.
//
// HIGHEST PR number wins when two open PRs carry the same piece and rollout.
// That is the supersede case -- a reopened or split-out PR -- and the later one
// is the live one; the earlier is what `fetch-pr-states.mjs` already warns about
// when it closes unmerged.
export function discoverClaims(prs, { aiWave = [] } = {}) {
  const wave = new Set(aiWave);
  const out = Object.fromEntries(ROLLOUTS.map((r) => [r, {}]));
  for (const pr of prs ?? []) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n)) continue;
    for (const [slug, rollouts] of classifyFiles(pr.files)) {
      for (const rollout of rollouts) {
        if (rollout === 'aiActions' && !wave.has(slug)) continue;
        const seen = out[rollout][slug];
        if (seen == null || n > seen) out[rollout][slug] = n;
      }
    }
  }
  return out;
}

// Curated wins, always. A discovered claim fills a gap; it never overrides a
// number a human put there, because the human is the one who knows that #15406
// superseded #15398 and the diff does not.
export const claimedPr = (curated, discovered, slug) => curated ?? discovered?.[slug] ?? null;
