// weekly/collect/output-schema.mjs
// Reads the existing outputSchema build output. `dist/` is gitignored and built
// fresh, so a missing file means "npm run build hasn't run here" — that is a
// no-data reason, not a zero.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

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
    };
  } catch (err) {
    return { status: 'no-data', reason: `outputSchema summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
