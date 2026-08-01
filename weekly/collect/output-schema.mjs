// weekly/collect/output-schema.mjs
// Reads the existing outputSchema build output. `dist/` is gitignored and built
// fresh, so a missing file means "npm run build hasn't run here" — that is a
// no-data reason, not a zero.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// Statuses that are NOT work in flight. Excluding rather than allow-listing
// keeps a newly-introduced in-flight status visible in the roster instead of
// silently vanishing from it. `todo` alone is 733 pieces — carrying those in
// every snapshot forever would bloat the archive for no signal.
const PARKED = new Set(['todo', 'skip']);

// The roster is DETAIL behind the tile, so it degrades on its own: a missing or
// malformed pieces.json costs the per-piece list, never the headline numbers.
function readRoster(readJson) {
  try {
    const { pieces } = readJson('dist/output-schema/pieces.json');
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces
      .filter((p) => !PARKED.has(p?.status))
      .map((p) => {
        // typeof, not truthiness: a 0-action piece is a real row.
        if (typeof p.displayName !== 'string' || !p.displayName) throw new Error('a piece has no displayName');
        if (typeof p.actions !== 'number') throw new Error(`${p.displayName}: actions is not a number`);
        if (typeof p.triggers !== 'number') throw new Error(`${p.displayName}: triggers is not a number`);
        return { name: p.displayName, actions: p.actions, triggers: p.triggers, stage: p.status, tier: p.tier };
      })
      .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function collectOutputSchema({ readJson }) {
  try {
    const s = readJson('dist/output-schema/summary.json');
    if (!s?.status) throw new Error('summary.json has no `status` block');
    // typeof, not truthiness: every numeric field here follows the same
    // zero-survives rule, so a real 0 must never read as "missing".
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      live: num(s.status.live, 'status.live'),
      mergedNotLive: num(s.status['merged-not-live'], 'status.merged-not-live'),
      review: num(s.status.review, 'status.review'),
      todo: num(s.status.todo, 'status.todo'),
      totalPieces: num(s.totals?.pieces, 'totals.pieces'),
      roster: readRoster(readJson),
    };
  } catch (err) {
    return { status: 'no-data', reason: `outputSchema summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
