// weekly/collect/ai-actions.mjs
// Reads the existing AI-actions build output. A missing file or a missing
// `stages` block is a no-data reason, never a zero — a silent 0 would read as
// "no progress this week" when it means "we could not measure".
import { readCatalogIndex } from './output-schema.mjs';

const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// Per-piece detail behind the tile. `stage` comes straight from the build, which
// derives it once for both the tile counts and this roster — the two can never
// disagree. Losing this file costs the list, not the numbers.
//
// These rows identify a piece by SLUG and carry neither its logo nor the name it
// is published under, so `catalog` — the folder → { displayName, logo } index —
// supplies both. The slug is the folder, so the lookup is a hit for all 28 tracked
// pieces today; one that stops matching keeps its slug and records no logo, rather
// than a URL built from the slug (a silent 404 in the reader's browser, visible
// nowhere a maintainer looks) or a name title-cased out of it (`Sendinblue` for a
// piece the catalog calls `Brevo`).
//
// `name` STAYS the slug. It is this row's identity: the week-over-week diff in
// lib/view.mjs matches on it, and the snapshots already committed carry no other
// key — so a display name replacing it would match nothing against them and
// re-report the whole finished backlog as this week's work.
//
// Spread rather than assigned, like `folder` in the outputSchema collector: an
// unresolved name carries no key at all instead of a `displayName: undefined` that
// JSON turns into a dead field.
function readRoster(readJson, catalog) {
  try {
    const { pieces } = readJson('dist/ai-actions/pieces.json');
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces
      .map((p) => {
        if (typeof p.slug !== 'string' || !p.slug) throw new Error('a piece has no slug');
        if (typeof p.atomics !== 'number') throw new Error(`${p.slug}: atomics is not a number`);
        const known = catalog.get(p.slug);
        return {
          name: p.slug,
          actions: p.atomics,
          stage: p.stage,
          ...(known?.displayName ? { displayName: known.displayName } : {}),
          logo: known?.logo ?? null,
        };
      })
      .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// The size of the WHOLE piece catalog, which is not something this initiative
// knows: `pieces` in the AI-actions summary is the 28 pieces the initiative
// tracks, and reporting "2 of 28" overstates catalog coverage ~27x to anyone
// reading the tile as progress. The catalog count lives in the outputSchema
// build, the one place that walks every piece.
//
// OPTIONAL, on the same terms as `roster`: if that summary is missing or its
// count is not a number we return undefined and the field is omitted, so the
// tile falls back to the tracked-count wording instead of implying a catalog
// denominator this week never measured. A denominator is detail — never a
// reason to turn a measurable week into no-data.
function readCatalogPieces(readJson) {
  try {
    // typeof, not truthiness: a catalog of 0 is a real (if alarming) reading.
    const { totals } = readJson('dist/output-schema/summary.json');
    return typeof totals?.pieces === 'number' ? totals.pieces : undefined;
  } catch {
    return undefined;
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
    const catalogPieces = readCatalogPieces(readJson);
    return {
      status: 'ok',
      merged: num(s.stages.merged, 'stages.merged'),
      prOpen: num(s.stages.prOpen, 'stages.prOpen'),
      assigned: num(s.stages.assigned, 'stages.assigned'),
      held: num(s.stages.held, 'stages.held'),
      totalPieces: num(s.pieces, 'pieces'),
      // Spread rather than assign: `catalogPieces: undefined` would survive into
      // the archive as a dead key and read as "recorded, but unknown".
      ...(catalogPieces === undefined ? {} : { catalogPieces }),
      blockersOpen: num(s.blockersOpen, 'blockersOpen'),
      roster: readRoster(readJson, readCatalogIndex(readJson)),
    };
  } catch (err) {
    return { status: 'no-data', reason: `AI-actions summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
