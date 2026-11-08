// weekly/collect/ai-actions.mjs
// Reads the existing AI-actions build output. A missing file or a missing
// `stages` block is a no-data reason, never a zero — a silent 0 would read as
// "no progress this week" when it means "we could not measure".
import { readCatalogIndex, readCatalogPieces } from './output-schema.mjs';
import { zeroed, personOf } from './people.mjs';

const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// Per-piece detail behind the tile. `stage` comes straight from the build, which
// derives it once for both the tile counts and this roster — the two can never
// disagree. Losing this file costs the list, not the numbers.
//
// These rows identify a piece by SLUG and carry neither its logo nor the name it
// is published under, so `catalog` — the folder → { displayName, logo } index —
// supplies both. The slug is the folder, so the lookup is a hit for every piece
// with AI actions today; one that stops matching keeps its slug and records no logo, rather
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
          ...(typeof p.author === 'string' && p.author ? { author: p.author } : {}),
          logo: known?.logo ?? null,
        };
      })
      .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// ── AI actions landed this week ─────────────────────────────────────────────
// The tile counts PIECES, and credits each one once, the week it first went
// done. Most of the AI-actions work is now more actions on pieces that already
// count — #17034 gave bexio 103 — and none of that moves a pieces number. This
// is the count of the actions themselves: the net `audience: 'ai'` lines each
// PR merged into main this week added, per author. Shown beside the pieces,
// never targeted (weekly/data/targets.json targets pieces).
//
// Read off data/landings.json, which scripts/fetch-pr-states.mjs writes from
// the same 21-day merged-PR scan that credits the pieces (lib/discover.mjs
// discoverActionsLanded). PURE, handed the file, so the rule is testable
// without one.
//
// Null — not measured — rather than a zero whenever the scan cannot vouch for
// the whole week: no file, a file from before the field existed, a scan whose
// 21 days do not reach back to the week's first day, or one that lost a call
// (`complete: false`; the Saturday job refuses those anyway, see
// landingScanVerdict). A partial count would read as a slow week. A scan that
// covered the week and found nothing is a real 0, for everyone.
//
// In the window by the merge's UTC DAY, the same inWindow rule as
// weekly/collect/shipping.mjs, so "this week" means one thing on the page.
// Credit is the PR author, as everywhere on the targets: a login off the team,
// or none at all, is `others` — the per-person map must still add up to the
// total (weekly/lib/archive.mjs checks it), so nothing can fall out of it.
const inWindow = (day, { start, end }) => Boolean(day) && day >= start && day <= end;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function actionsLandedForWindow(landings, window) {
  if (!window || !Array.isArray(landings?.actionsLanded)) return null;
  if (typeof landings.since !== 'string' || landings.since > window.start) return null;
  if (landings.complete === false) return null;
  const byPerson = { ...zeroed(), others: 0 };
  const prs = [];
  for (const e of landings.actionsLanded) {
    if (!inWindow(typeof e?.mergedAt === 'string' ? e.mergedAt.slice(0, 10) : null, window)) continue;
    // One malformed row in the week is a broken reading, not a row to skip:
    // skipping it would publish a total short by an amount nobody can see.
    if (!Number.isInteger(e.pr) || typeof e.n !== 'number' || !Number.isFinite(e.n) || !isObject(e.pieces)) return null;
    const author = typeof e.author === 'string' && e.author ? e.author : null;
    byPerson[personOf(author) ?? 'others'] += e.n;
    // Spread, never assigned: a PR with no recorded author carries no key,
    // rather than an `author: null` the archive would have to explain.
    prs.push({ pr: e.pr, n: e.n, pieces: e.pieces, ...(author ? { author } : {}) });
  }
  return { total: prs.reduce((sum, p) => sum + p.n, 0), byPerson, prs };
}

// Best-effort, unlike the summary below: losing landings.json costs this one
// field and never the tile, whose pieces count stands on its own.
function readActionsLanded(readJson, window) {
  try {
    return actionsLandedForWindow(readJson('data/landings.json'), window);
  } catch {
    return null;
  }
}

export function collectAiActions({ readJson, window }) {
  try {
    const s = readJson('dist/ai-actions/summary.json');
    if (!s?.stages) throw new Error('summary.json has no `stages` block');
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    const catalogPieces = readCatalogPieces(readJson);
    const actionsLanded = readActionsLanded(readJson, window);
    return {
      status: 'ok',
      merged: num(s.stages.merged, 'stages.merged'),
      prOpen: num(s.stages.prOpen, 'stages.prOpen'),
      // Spread, like catalogPieces: a build from before the stage existed has no
      // count to report, and an absent field already reads as none.
      ...(s.stages.approved === undefined ? {} : { approved: num(s.stages.approved, 'stages.approved') }),
      assigned: num(s.stages.assigned, 'stages.assigned'),
      held: num(s.stages.held, 'stages.held'),
      totalPieces: num(s.pieces, 'pieces'),
      // Spread rather than assign: `catalogPieces: undefined` would survive into
      // the archive as a dead key and read as "recorded, but unknown".
      ...(catalogPieces === undefined ? {} : { catalogPieces }),
      blockersOpen: num(s.blockersOpen, 'blockersOpen'),
      roster: readRoster(readJson, readCatalogIndex(readJson)),
      // Spread, so a week the scan could not vouch for records no key at all —
      // absent is "not measured", and the page then draws nothing for it.
      ...(actionsLanded ? { actionsLanded } : {}),
    };
  } catch (err) {
    return { status: 'no-data', reason: `AI-actions summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
