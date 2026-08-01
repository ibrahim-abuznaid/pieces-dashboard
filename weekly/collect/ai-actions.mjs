// weekly/collect/ai-actions.mjs
// Reads the existing AI-actions build output. A missing file or a missing
// `stages` block is a no-data reason, never a zero — a silent 0 would read as
// "no progress this week" when it means "we could not measure".
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// Per-piece detail behind the tile. `stage` comes straight from the build, which
// derives it once for both the tile counts and this roster — the two can never
// disagree. Losing this file costs the list, not the numbers.
function readRoster(readJson) {
  try {
    const { pieces } = readJson('dist/ai-actions/pieces.json');
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces
      .map((p) => {
        if (typeof p.slug !== 'string' || !p.slug) throw new Error('a piece has no slug');
        if (typeof p.atomics !== 'number') throw new Error(`${p.slug}: atomics is not a number`);
        return { name: p.slug, actions: p.atomics, stage: p.stage };
      })
      .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function collectAiActions({ readJson }) {
  try {
    const s = readJson('dist/ai-actions/summary.json');
    if (!s?.stages) throw new Error('summary.json has no `stages` block');
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      merged: num(s.stages.merged, 'stages.merged'),
      prOpen: num(s.stages.prOpen, 'stages.prOpen'),
      assigned: num(s.stages.assigned, 'stages.assigned'),
      held: num(s.stages.held, 'stages.held'),
      totalPieces: num(s.pieces, 'pieces'),
      blockersOpen: num(s.blockersOpen, 'blockersOpen'),
      roster: readRoster(readJson),
    };
  } catch (err) {
    return { status: 'no-data', reason: `AI-actions summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
