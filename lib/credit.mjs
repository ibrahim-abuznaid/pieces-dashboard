// lib/credit.mjs
// Who shipped a piece's rollout work — the one credit rule the weekly targets
// use, resolved where the builds join their data so every dist row carries it.
//
// The row's own PR pointer wins: it is the claim a human curated or discovery
// found. A row done WITHOUT a pointer — the builds find most finished pieces on
// main, not in a claim — falls back to the landing scan (data/landings.json,
// written by scripts/fetch-pr-states.mjs): the earliest merged PR that added the
// rollout's lines to that piece. Anything else is null, which renders as "not
// credited". A guess would put a number next to a person's name that nobody can
// check.
const usable = (v) => (typeof v === 'string' && v ? v : null);

export function authorOf({ slug, pr = null }, rollout, prStates = {}, landings = {}) {
  return usable(pr != null ? prStates?.[pr]?.author : null)
    ?? usable(landings?.[rollout]?.[slug]?.author)
    ?? null;
}
