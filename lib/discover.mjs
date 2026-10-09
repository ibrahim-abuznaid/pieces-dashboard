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
//
// Community only for CLAIMS: the main-side scans that mark a claim landed read
// community only, so a discovered core claim would be an in-flight row nothing
// could ever finish. LANDINGS also read core, because the UI build measures
// done off the cloud catalog, which carries core pieces too — without core,
// tables, date-helper, pdf and file-helper (all Talal's, all W39) could never be
// credited to anyone. No folder name is in both trees today.
const PIECE_PATH = /^packages\/pieces\/community\/([^/]+)\//;
const LANDING_PIECE_PATH = /^packages\/pieces\/(?:community|core)\/([^/]+)\//;

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

// An agent atomic: the action only an agent sees. Anchored to the start of an
// added line, because the phrase is also how the team COMMENTS these actions --
// 16 of 1576 matches on main were `// audience:'ai' atomics` -- and a comment is
// not an action. scripts/fetch-repo-ai.sh and scripts/backfill-ai-actions-from-
// main.mjs carry the POSIX copy for git grep; test/ai-pattern.test.mjs holds the
// three to the same answer.
export const AI_AUDIENCE = /^\+\s*audience\s*:\s*['"]ai['"]/m;

// The connection-identifier hook, as the auth property it is: `name: fn`,
// shorthand `name,` or a method `async name(`. Anchored to the start of an
// added line for the same reason as AI_AUDIENCE -- a comment naming the hook,
// or a call through `auth.getConnectionIdentifier`, is not a piece gaining one.
// Done is read off the cloud catalog, not main (connection-identifier/build.mjs),
// so this is the only copy of the rule.
export const CONN_ID_HOOK = /^\+\s*(?:async\s+)?getConnectionIdentifier\b\s*[:,(]/m;

// One signature per rollout, each chosen to be the thing the work cannot be done
// without:
//
// · outputSchema — the piece gains an `output-schemas.ts`. A path, not a
//   pattern, and the same file the cloud fetch greps for on main, so the
//   in-flight and landed halves agree on what the work IS.
// · uiImprovements — `propertyGroups` or `advanced: true` appears. Either
//   counts and neither is weighted, matching `liveOnCloud` in the build: the
//   essential/Advanced split alone is adoption for most of the catalog.
// · aiActions — an `audience: 'ai'` action appears: an agent atomic, the
//   action only an agent sees. NOT `aiMetadata` and NOT `audience: 'both'`,
//   which this rule keyed on until 2026-09-26: a catalog-wide migration put
//   the first on 720 of 733 pieces and the second on 663, so neither says
//   anything about this work. The same pattern is what
//   scripts/fetch-repo-ai.sh greps main for, so the in-flight and landed
//   halves agree on what the work IS -- change one, change both.
// · connectionIdentifier — a `getConnectionIdentifier` hook appears on an auth.
//   Only the HOOK road: a piece that labels its connections through the OAuth
//   token instead carries no line a diff could find, so those are curated in
//   connection-identifier/pieces.json.
//
// Attributed PER FILE, not per PR: one PR routinely carries two pieces (#15539
// did pinterest and trello), and a PR-level answer would put both rollouts on
// both pieces. The signal belongs to the piece whose file carried it.
export function classifyFiles(files, { piecePath = PIECE_PATH } = {}) {
  const byPiece = new Map();
  const mark = (slug, rollout) => {
    if (!byPiece.has(slug)) byPiece.set(slug, new Set());
    byPiece.get(slug).add(rollout);
  };
  for (const f of files ?? []) {
    const m = piecePath.exec(f?.filename ?? '');
    if (!m) continue;
    const slug = m[1];
    if (/\/output-schemas\.ts$/.test(f.filename)) mark(slug, 'outputSchema');
    const added = addedLines(f.patch);
    if (/propertyGroups/.test(added) || /advanced\s*:\s*true/.test(added)) mark(slug, 'uiImprovements');
    // src/ only, the same scope main is read in: a fixture under test/ is not
    // a shipped action.
    if (/\/src\//.test(f.filename) && AI_AUDIENCE.test(added)) mark(slug, 'aiActions');
    if (/\/src\//.test(f.filename) && CONN_ID_HOOK.test(added)) mark(slug, 'connectionIdentifier');
  }
  return byPiece;
}

export const ROLLOUTS = ['outputSchema', 'uiImprovements', 'aiActions', 'connectionIdentifier'];

// slug -> PR number, per rollout. The shape each build merges into its claims.
//
// No rollout takes a filter any more. AI-actions used to be narrowed to a
// curated wave of 28 (`aiWave`), because its old signature was on every
// scaffolded piece and an unfiltered rule would have swallowed the catalog.
// The filter was right for that signature and wrong for the team: by W39
// Kishan and Odai were giving agent atomics to pieces no list had ever heard of
// -- 23 landed that week, across 17 PRs -- and the page reported one. `audience: 'ai'` comes
// from no template, so the rollout is catalog-wide like the other two. A caller
// still passing `aiWave` is ignored rather than obeyed.
//
// When two open PRs carry the same piece and rollout, the one INTO MAIN wins: a
// stacked PR (Asana's #15758 sits on #15757's branch) lands through its parent,
// so the parent is the claim whatever its number. Between equals the HIGHEST
// number wins. That is the supersede case -- a reopened or split-out PR -- and
// the later one is the live one; the earlier is what `fetch-pr-states.mjs`
// already warns about when it closes unmerged. A PR with no recorded `base`
// competes as though it were into main, which every one before this field was.
const intoMain = (pr) => pr?.base == null || pr.base === 'main';

export function discoverClaims(prs) {
  const out = Object.fromEntries(ROLLOUTS.map((r) => [r, {}]));
  const byNumber = new Map((prs ?? []).map((pr) => [Number(pr?.number), pr]));
  const beats = (n, seen) => {
    const a = intoMain(byNumber.get(n));
    const b = intoMain(byNumber.get(seen));
    return a !== b ? a : n > seen;
  };
  for (const pr of prs ?? []) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n)) continue;
    for (const [slug, rollouts] of classifyFiles(pr.files)) {
      for (const rollout of rollouts) {
        const seen = out[rollout][slug];
        if (seen == null || beats(n, seen)) out[rollout][slug] = n;
      }
    }
  }
  return out;
}

// The PR that LANDED a rollout's lines on main, per piece. discoverClaims asks
// which OPEN PR is carrying a piece's work; this asks which MERGED one made the
// piece done, so the weekly targets can credit its author. Same classifier, so
// "this PR ships AI actions for asana" means one thing in both places — over
// community AND core (LANDING_PIECE_PATH above).
//
// EARLIEST merge wins. A piece is done the week its first qualifying PR lands;
// a later PR adding three more AI actions to an already-done piece changes
// nothing the targets count. Ties on the merge instant go to the lower number.
// Only PRs merged into main count — a stacked PR merged into its parent branch
// has shipped nothing (see lib/ai-roster.mjs).
export function discoverLandings(prs) {
  const out = Object.fromEntries(ROLLOUTS.map((r) => [r, {}]));
  const earlier = (a, b) => a.mergedAt < b.mergedAt || (a.mergedAt === b.mergedAt && a.pr < b.pr);
  for (const pr of prs ?? []) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n) || typeof pr.mergedAt !== 'string' || !pr.mergedAt || !intoMain(pr)) continue;
    const hit = { pr: n, author: typeof pr.author === 'string' && pr.author ? pr.author : null, mergedAt: pr.mergedAt };
    for (const [slug, rollouts] of classifyFiles(pr.files, { piecePath: LANDING_PIECE_PATH })) {
      for (const rollout of rollouts) {
        const seen = out[rollout][slug];
        if (!seen || earlier(hit, seen)) out[rollout][slug] = hit;
      }
    }
  }
  return out;
}

// Whether a landing scan can be trusted, and whether to refuse it. Complete
// means every call it made answered: the merged-PR list AND every per-PR files
// fetch. One lost files fetch is worse than it looks — it drops that PR's
// landings, and "earliest wins" then hands the piece to a LATER PR's author,
// quite possibly someone else.
//
// `required` is the Saturday job (refresh-weekly.sh sets LANDINGS_REQUIRED=1):
// its snapshot archives the credit as a measurement, forever, so an incomplete
// scan must stop the run and let tomorrow's retry take the week. Everywhere
// else — CI's daily rebuild — it stays best-effort: a missing credit renders as
// "not credited", and a failed deploy renders as nothing.
export function landingScanVerdict({ failures = [], required = false } = {}) {
  const complete = failures.length === 0;
  return {
    complete,
    error: complete || !required ? null
      : `landing scan incomplete and LANDINGS_REQUIRED=1 — refusing to hand the snapshot partial credit: ${failures.join('; ')}`,
  };
}

// Curated wins, always. A discovered claim fills a gap; it never overrides a
// number a human put there, because the human is the one who knows that #15406
// superseded #15398 and the diff does not.
export const claimedPr = (curated, discovered, slug) => curated ?? discovered?.[slug] ?? null;
