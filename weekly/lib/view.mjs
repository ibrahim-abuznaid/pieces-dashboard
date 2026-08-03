// weekly/lib/view.mjs
// Pure: archive + selected week → everything the template renders. No I/O, no
// clock, so the whole page shape is unit-testable.
//
// The reader is a project manager, which sets the whole scope: a week header,
// four numbers, the pieces behind each number, and an ask when there is one.
// Nothing else is built here — a field computed but never rendered is how the
// next reader gets misled about what the page actually shows.
//
// Two invariants the page depends on:
//   1. `tiles` is ALWAYS length 4 in a fixed order, even when workstreams are
//      degraded — the layout must not reflow because a collector failed.
//   2. A degraded workstream renders as "unknown", never as 0. `value` and
//      `delta` both go empty and the collector's reason is carried through.
//
// A tile's `strip` is the opposite kind of field: OPTIONAL detail that exists
// only when a snapshot recorded a roster, so older snapshots stay renderable.
import { pick, deltaFor } from './deltas.mjs';
import { previousWeekId } from '../../lib/isoweek.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Every count on this page meets a noun, and "1 PRs shipped" is the kind of
// detail that makes a dashboard look unmaintained. Every phrase that needs it is
// assembled here, so the template no longer carries a copy of it.
export const plural = (n, word) => (n === 1 ? word : `${word}s`);

// "Jul 25–31" inside a month, "Jul 27 – Aug 2" across one. The year lives in
// the caption, so it is not repeated here.
const rangeOf = (start, end) => {
  const [, am, ad] = start.split('-').map(Number);
  const [, bm, bd] = end.split('-').map(Number);
  return am === bm
    ? `${MONTHS[am - 1]} ${ad}–${bd}`
    : `${MONTHS[am - 1]} ${ad} – ${MONTHS[bm - 1]} ${bd}`;
};

// MERGED, not cloud-live. Both `live` and `merged-not-live` are finished work;
// `live` merely also caught a release train the team does not control, so
// leading with `live` under-reports delivery by whatever is queued behind it.
// Derived rather than stored, which is why `pick` takes an accessor: every
// snapshot already in the archive keeps working, with no backfill.
const mergedSchemas = (snap) => {
  const live = pick(snap, 'outputSchema.live');
  const mergedNotLive = pick(snap, 'outputSchema.mergedNotLive');
  return live === null || mergedNotLive === null ? null : live + mergedNotLive;
};

// ── who closed the tickets ──────────────────────────────────────────────────
// One line inside the tickets box, read out of the SAME object the total is
// summed from. Never out of a list of names kept here: the team is hiring a
// third member, and a view iterating its own roster would print their tickets as
// a silent 0 beside a total that already counts them — a box contradicting
// itself, with nothing on the page to say so.
//
// So the attribution is CHECKED against the number it sits under, and dropped
// when the two disagree — a snapshot with no `byPerson` at all, a count that is
// not a number, a person the collector recorded after the total was computed.
// The archive validates `tickets.total` and nothing else here, so all of those
// are legal shapes on disk. A missing line is honest; a wrong one is not.
//
// The key is the collector's own person key ('kishan'), which is the display
// name lowercased, so a leading capital is the whole transform.
const titled = (key) => key.charAt(0).toUpperCase() + key.slice(1);

function perPersonLine(ws) {
  const entries = Object.entries(ws.byPerson ?? {});
  if (!entries.length) return '';
  if (entries.some(([, n]) => typeof n !== 'number' || !Number.isFinite(n))) return '';
  if (entries.reduce((sum, [, n]) => sum + n, 0) !== ws.total) return '';
  return entries.map(([key, n]) => `${titled(key)} ${n}`).join(' · ');
}

// ── the pieces strip ────────────────────────────────────────────────────────
// The pieces behind a number, inside the box that carries the number, so the
// reader never holds a figure in their head and scrolls for the list it means.
//
// CAPPED: a big week must not push the page past one screen, so the overflow is
// counted rather than listed. Capped here rather than in the template because
// the count is part of the view model a test can read.
//
// Six, measured rather than chosen: chips wrap, so a strip is the least
// predictable part of the page's height — piece names run from 'Slack' to
// 'Google Business Profile'. At eight the tallest legitimate week measured 4px
// past a 1366x768 laptop viewport in headless Chrome; six leaves the page room
// to breathe even when every name is a long one. See the one-screen test in
// test/weekly-render.test.mjs.
export const STRIP_CAP = 6;

const capped = (kind, label, items) => ({
  kind, label, items: items.slice(0, STRIP_CAP), more: Math.max(0, items.length - STRIP_CAP),
});

// Piece testing ships PRs, not pieces: its strip is their titles, and there is
// no logo to show for a pull request. The collector already windowed them to
// this week, so no diff is involved.
//
// `shipped` is optional detail the archive does not validate — a snapshot
// missing it, or carrying a titleless entry, costs the strip and never the
// tile's number.
function prStrip(shipped) {
  const items = (Array.isArray(shipped) ? shipped : [])
    .filter((pr) => typeof pr?.title === 'string' && pr.title)
    .map(({ title }) => ({ name: title }));
  return items.length ? capped('prs', 'Shipped', items) : null;
}

// key, title, the metric the big number shows, and how to phrase it. A box is a
// number, its unit and the pieces behind it: the sub-lines each one used to
// carry (`9 live on cloud · 8 in review`, `28 tracked · 24 PRs open`,
// `2 commits`) were collector detail, not signal for this reader.
//
// `strip` is the pieces the number refers to — see pieceStrip below — and `done`
// is which of a workstream's stages count as finished for it.
const TILES = [
  // Done = MERGED, so both `live` and `merged-not-live`: the work landed either
  // way; `live` merely also caught a cloud release the team does not control, so
  // counting only `live` under-reports delivery by whatever is queued behind it.
  { key: 'outputSchema', title: 'outputSchema', path: mergedSchemas,
    unit: (ws) => `of ${ws.totalPieces} merged`,
    strip: pieceStrip, done: ['live', 'merged-not-live'] },
  // `totalPieces` here is only the 28 pieces the initiative TRACKS, so
  // "2 of 28 merged" reads as ~7% catalog coverage when the real figure is
  // 0.3%. When the snapshot recorded the catalog size, count against that. When
  // it did not — every snapshot written before the field existed — keep the old
  // wording: a historical week must not be retrofitted with a denominator it
  // never measured.
  { key: 'aiActions', title: 'AI-actions', path: 'aiActions.merged',
    unit: (ws) => (typeof ws.catalogPieces === 'number'
      ? `of ${ws.catalogPieces} have AI actions`
      : `of ${ws.totalPieces} merged`),
    strip: pieceStrip, done: ['merged'] },
  { key: 'testing', title: 'Piece testing', path: 'testing.prsMerged',
    unit: (ws) => `${plural(ws.prsMerged, 'PR')} shipped`,
    strip: (ws) => prStrip(ws.shipped) },
  // No strip: tickets are not pieces. Who closed them is the one piece of detail
  // management does read, so it folds into this box as a single line rather than
  // into a table of its own.
  { key: 'tickets', title: 'Tickets solved', path: 'tickets.total',
    unit: () => 'closed this week', perPerson: perPersonLine },
];

// ── decisions ───────────────────────────────────────────────────────────────
// The band earns attention only if every line asks someone to DO something.
// Pure status (PRs sitting in review, blockers open) and "no data" reports are
// already carried by the tiles, and repeating them there is exactly what taught
// readers to skip the band. Filtering here rather than only at snapshot time
// cleans up the weeks already committed to the archive as they render.
const NOT_AN_ASK = [
  /awaiting review/i,
  /blockers?\b[^.]*\bopen\b/i,
  /\bno data\b/i,
];

const isAsk = (line) =>
  typeof line === 'string' && line.trim() !== '' && !NOT_AN_ASK.some((re) => re.test(line));

// ── which pieces are done ───────────────────────────────────────────────────
// A snapshot's roster is the per-piece record behind two of the numbers. The
// page has no roster SECTION any more — stage-grouped tables of every tracked
// piece, which is the cross-referencing this page was rebuilt to remove — so the
// only question asked of a roster now is which pieces are DONE, and of those,
// which crossed the line this week.

// A strip chip: the two things a reader recognises a piece by. `logo` is
// normalised to null unless it is a usable URL — an empty string in an
// `<img src>` re-requests the page and renders as a broken image, and a
// snapshot written before logos existed carries no `logo` at all.
const toChip = ({ name, logo }) =>
  ({ name, logo: typeof logo === 'string' && logo ? logo : null });

// The roster of the immediately-preceding archive entry, or null when there is
// nothing legitimate to diff against. Mirrors the gap guard in `deltaFor`: the
// preceding ENTRY is only the preceding WEEK if it literally is, so a hole in
// the archive yields no comparison instead of two weeks' work labelled as one.
// An empty roster counts as no roster — the collectors return `[]` for a lost
// pieces.json, so "[] last week" cannot be read as "nothing was done last week".
function priorRoster(weeks, selected, key) {
  const at = weeks.findIndex((w) => w.week === selected.week);
  if (at <= 0) return null;
  if (weeks[at - 1].week !== previousWeekId(selected.week)) return null;
  const ws = weeks[at - 1][key];
  if (ws?.status !== 'ok' || !Array.isArray(ws.roster) || !ws.roster.length) return null;
  return ws.roster;
}

// A row's stable identity, or null when it carries none. `folder` is the piece's
// directory: the catalog's own key, unique across every row, and the one thing
// about a piece that does not change.
//
// A DISPLAY NAME is not an identity. It is editorial — the cloud catalog renames
// pieces, 'Telegram Bot' and 'Google Gemini' among them — and it is not unique:
// two folders publish 'Cashfree Payments' and two publish 'Weekdone' today. Both
// failures land in the diff below, and since the strip is the tile's headline
// claim they land above the fold: a rename re-reports finished work as this
// week's output, and a duplicated name hides a genuinely new piece behind its
// twin, so the tile's delta pill and its strip contradict each other.
const folderOf = (r) => (typeof r.folder === 'string' && r.folder ? r.folder : null);

// "Was this piece already done a week ago?", keyed on identity.
//
// Falls back to matching by NAME when last week's roster is not fully
// folder-keyed. That is not a preference, it is a bridge: the AI-actions roster
// identifies a piece by SLUG in `name`, which already is stable and unique, and
// every snapshot written before `folder` existed is name-keyed — comparing this
// week's folders against those rows would find nothing in common and report the
// whole finished backlog as one week's work. When in doubt this errs toward
// "already done", because the one rule this page has is never to overstate a
// week.
function alreadyDone(priorDone) {
  const folders = new Set(priorDone.map(folderOf).filter(Boolean));
  const names = new Set(priorDone.map((r) => r.name));
  const keyedByFolder = priorDone.length > 0 && folders.size === priorDone.length;
  return (r) => (keyedByFolder && folderOf(r) ? folders.has(folderOf(r)) : names.has(r.name));
}

// The pieces strip: the LABEL and the list come out of this one computation, so
// they can never end up describing different weeks.
//
// The label is the load-bearing part. What crossed the line THIS WEEK is only
// claimable against a real immediately-preceding week; with no prior week, or
// across a gap in the archive, the strip is the running TOTAL and has to say so.
// A finished backlog presented as one week's output is the overclaim this page
// has guarded against throughout.
//
// `filter` copies, so the collector's ordering (actions desc) is preserved and
// the input roster is never sorted in place.
function pieceStrip(ws, spec, weeks, selected) {
  const rows = Array.isArray(ws.roster) ? ws.roster : [];
  if (!rows.length) return null;                  // no roster recorded: nothing to show
  const isDone = (r) => spec.done.includes(r.stage);
  const done = rows.filter(isDone);
  const prior = priorRoster(weeks, selected, spec.key);
  // With nothing to diff against, the tile's own number is the whole answer, so
  // a workstream with nothing finished yet carries no strip at all.
  if (!prior) return done.length ? capped('pieces', 'Done in total', done.map(toChip)) : null;
  const before = alreadyDone(prior.filter(isDone));
  const landed = done.filter((r) => !before(r)).sort((a, b) => a.name.localeCompare(b.name));
  // A week that moved nothing has to say it out loud — silence reads as "not
  // measured".
  return landed.length
    ? capped('pieces', 'Done this week', landed.map(toChip))
    : { kind: 'pieces', label: 'Nothing new this week', items: [], more: 0 };
}

// `opts.today` is accepted for caller symmetry with snapshot.mjs but deliberately
// unused: the newest entry in the archive already is the newest complete week,
// and reading a clock here would break purity.
export function buildView(archive, { weekId } = {}) {
  const weeks = archive?.weeks ?? [];
  if (!weeks.length) return { empty: true, weeks: [] };

  // Resolve the selection FIRST, then only ever use `selected.week` downstream.
  // `deltaFor` → `previousWeekId` throws on a week id that is not `YYYY-Wnn`, so
  // an unknown or malformed caller-supplied id must never reach it.
  const selected = weeks.find((w) => w.week === weekId) ?? weeks.at(-1);
  const list = weeks.map((w) => w.week).reverse();

  const tiles = TILES.map((spec) => {
    const ws = selected[spec.key];
    if (ws?.status !== 'ok') {
      // No strip on a degraded tile: the reason is the only honest content it
      // has, and a stale list beside it would read as this week's work.
      return { key: spec.key, title: spec.title, status: 'no-data',
               reason: ws?.reason ?? 'workstream missing from this snapshot',
               value: null, delta: null, unit: '', strip: null, perPerson: '' };
    }
    return {
      key: spec.key, title: spec.title, status: 'ok', reason: '',
      value: pick(selected, spec.path),
      delta: deltaFor(weeks, selected.week, spec.path),
      unit: spec.unit(ws),
      strip: spec.strip?.(ws, spec, weeks, selected) ?? null,
      perPerson: spec.perPerson?.(ws) ?? '',
    };
  });

  const weekNo = Number(selected.week.split('-W')[1]);

  return {
    // `start`/`end` are the counting window itself, published in
    // dist/weekly/summary.json for machine readers. The page shows `range`
    // instead, which is lossy on purpose — no year, no ISO dates.
    week: selected.week, start: selected.start, end: selected.end, builtAt: selected.builtAt,
    title: `Pieces Team · Week ${weekNo}`,
    range: rangeOf(selected.start, selected.end),
    weeks: list,
    tiles,
    // Said once, in the caption, rather than stamped on all four tiles.
    noPriorWeek: tiles.every((tile) => tile.delta === null),
    decisions: (selected.decisions ?? []).filter(isAsk),
  };
}
