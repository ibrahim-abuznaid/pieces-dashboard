// weekly/collect/ui-improvements.mjs
// Reads the property-UI rollout build output. Same contract as the other two
// dashboard collectors: a missing file or a missing block is a no-data reason,
// never a zero — this workstream sits at 5 of 765, and a silent 0 beside those
// numbers is indistinguishable from a real week of no progress.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// The headline is MERGED — the adoption landed in the repo — and `live` is the
// subset a cloud user can actually see. Recorded separately because the gap
// between them is a release train the team does not control, and because only
// this collector ever measures cloud: the backfill that reconstructed the
// already-archived weeks from PR dates writes `merged` and omits `live`, which
// is why the archive validates `live` as optional.
//
// `mergedNotLive` is deliberately NOT stored. It is merged − live, derivable
// wherever both exist, and a stored third count is one more number that can
// contradict the two it came from.
function readRoster(readJson) {
  try {
    const { pieces } = readJson('dist/ui-improvements/pieces.json');
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces.map((p) => {
      if (typeof p.folder !== 'string' || !p.folder) throw new Error('a piece has no folder');
      if (typeof p.steps !== 'number') throw new Error(`${p.folder}: steps is not a number`);
      // `name` is the row's identity for the week-over-week diff and `actions`
      // is the count every roster row carries — the archive validates both, and
      // the page reads them the same way for all three workstreams. The
      // published name rides alongside in `displayName`, exactly as the
      // AI-actions roster does with its slug.
      return {
        folder: p.folder,
        name: p.folder,
        displayName: p.displayName ?? null,
        actions: p.steps,
        stage: p.stage,
        logo: p.logoUrl ?? null,
      };
    });
  } catch {
    return [];
  }
}

export function collectUiImprovements({ readJson }) {
  try {
    const s = readJson('dist/ui-improvements/summary.json');
    if (!s?.status) throw new Error('summary.json has no `status` block');
    // typeof, not truthiness: every count here starts at 0 and a real 0 must
    // never read as "missing".
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      merged: num(s.merged, 'merged'),
      // Optional on the same terms the archive makes it optional: the build
      // omits it when the cloud half was never measured, and "not measured" must
      // not arrive here as a zero — see ../../ui-improvements/build.mjs.
      ...(typeof s.status.live === 'number' ? { live: s.status.live } : {}),
      review: num(s.status.review, 'status.review'),
      assigned: num(s.status.assigned, 'status.assigned'),
      totalPieces: num(s.totals?.pieces, 'totals.pieces'),
      roster: readRoster(readJson),
    };
  } catch (err) {
    return { status: 'no-data', reason: `UI-improvements summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
