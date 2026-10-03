// lib/credit.mjs
// Who shipped a piece's rollout work — the one credit rule the weekly targets
// use, resolved where the builds join their data so every dist row carries it.
//
// The row's own PR pointer wins, but only when that PR is the work that made
// the piece done: it MERGED, or the row is `approved` (an approved open PR is
// done work — doneAiActions in weekly/lib/view.mjs counts it). A merged pointer
// beats the landing even when they differ, because it is the claim a human
// curated (sendinblue's is). An OPEN or CLOSED pointer has shipped nothing, and
// the builds read done off the cloud catalog and main whatever the pointer says
// — on W39 gmail went live through Talal's merged #15753 while its curated row
// still pointed at Kishan's open #14943, and the pointer handed Kishan the
// credit.
//
// The one exception is an open-PR row (`pr-open` on AI actions, `review` on UI
// improvements) whose own PR is still OPEN. Nothing has shipped, but from W40
// both targets count open PRs (Ibrahim's call 2026-10-03,
// weekly/lib/targets.mjs), and on such a row that PR is the only work there is
// to credit.
//
// Otherwise the landing scan (data/landings.json, written by
// scripts/fetch-pr-states.mjs): the earliest merged PR that added the rollout's
// lines to that piece. Anything else is null, which renders as "not credited".
// A guess would put a number next to a person's name that nobody can check.
const usable = (v) => (typeof v === 'string' && v ? v : null);
const OPEN_PR_STAGES = ['pr-open', 'review'];

export function authorOf({ slug, pr = null, stage = null }, rollout, prStates = {}, landings = {}) {
  const own = pr != null ? prStates?.[pr] : null;
  const theWork = own?.state === 'MERGED' || stage === 'approved'
    || (OPEN_PR_STAGES.includes(stage) && own?.state === 'OPEN');
  return usable(theWork ? own?.author : null)
    ?? usable(landings?.[rollout]?.[slug]?.author)
    ?? null;
}
