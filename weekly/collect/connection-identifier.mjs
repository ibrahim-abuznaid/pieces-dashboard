// weekly/collect/connection-identifier.mjs
// Reads the connection-identifier build output. Same contract as the other
// dashboard collectors: a missing file or a missing block is a no-data reason,
// never a zero.
//
// The headline is landed work — `merged` is live plus merged-not-live, as on UI
// improvements — and `live` rides along as the subset cloud already serves. The
// gap between them is a release train, and deriveDecisions turns it into the
// one ask this workstream can make. `live` is optional on the same terms: the
// build omits it when the cloud half was not measured, and the backfilled
// weeks never had it.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

function readRoster(readJson) {
  try {
    const { pieces } = readJson('dist/connection-identifier/pieces.json');
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces.map((p) => {
      if (typeof p.folder !== 'string' || !p.folder) throw new Error('a piece has no folder');
      if (typeof p.steps !== 'number') throw new Error(`${p.folder}: steps is not a number`);
      return {
        folder: p.folder,
        name: p.folder,
        displayName: p.displayName ?? null,
        actions: p.steps,
        stage: p.stage,
        logo: p.logoUrl ?? null,
        ...(typeof p.author === 'string' && p.author ? { author: p.author } : {}),
      };
    });
  } catch {
    return [];
  }
}

export function collectConnectionIdentifier({ readJson }) {
  try {
    const s = readJson('dist/connection-identifier/summary.json');
    if (!s?.status) throw new Error('summary.json has no `status` block');
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      merged: num(s.merged, 'merged'),
      ...(typeof s.status.live === 'number' ? { live: s.status.live } : {}),
      review: num(s.status.review, 'status.review'),
      assigned: num(s.status.assigned, 'status.assigned'),
      totalPieces: num(s.totals?.pieces, 'totals.pieces'),
      roster: readRoster(readJson),
    };
  } catch (err) {
    return { status: 'no-data', reason: `Connection-identifier summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
