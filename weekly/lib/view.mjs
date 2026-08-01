// weekly/lib/view.mjs
// Pure: archive + selected week → everything the template renders. No I/O, no
// clock, so the whole page shape is unit-testable.
//
// Two invariants the page depends on:
//   1. `tiles` is ALWAYS length 4 in a fixed order, even when workstreams are
//      degraded — the layout must not reflow because a collector failed.
//   2. A degraded workstream renders as "unknown", never as 0. `value`, `delta`
//      and `spark` all go empty and the collector's reason is carried through.
//
// `rosters` is the opposite kind of list: OPTIONAL detail that appears only
// when a snapshot recorded it, so older snapshots stay renderable.
import { pick, deltaFor, seriesFor } from './deltas.mjs';
import { TESTING_NOTE } from '../collect/testing.mjs';

const PEOPLE = [{ key: 'kishan', name: 'Kishan' }, { key: 'sanket', name: 'Sanket' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pretty = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return { short: `${MONTHS[m - 1]} ${d}`, year: y };
};

// key, title, the metric the big number shows, and how to phrase it.
const TILES = [
  { key: 'outputSchema', title: 'outputSchema', path: 'outputSchema.live',
    unit: (ws) => `of ${ws.totalPieces} live on cloud`,
    note: (ws) => `${ws.mergedNotLive} merged awaiting cloud release · ${ws.review} in review` },
  { key: 'aiActions', title: 'AI-actions', path: 'aiActions.merged',
    unit: (ws) => `of ${ws.totalPieces} merged`,
    note: (ws) => `${ws.prOpen} PRs open · ${ws.blockersOpen} blockers` },
  { key: 'testing', title: 'Piece testing', path: 'testing.prsMerged',
    unit: () => 'PRs merged this week',
    note: (ws) => `${ws.commits} commits · ${TESTING_NOTE}` },
  { key: 'tickets', title: 'Tickets solved', path: 'tickets.total',
    unit: () => 'closed this week',
    note: (ws) => `${ws.byPerson.kishan} Kishan · ${ws.byPerson.sanket} Sanket` },
];

// The per-piece list behind a tile. Stages are listed in pipeline order, most
// advanced first, so the page reads as "how far along is each piece".
const ROSTERS = [
  { key: 'outputSchema', title: 'outputSchema', unit: 'actions',
    stages: ['live', 'merged-not-live', 'review', 'in-progress'] },
  { key: 'aiActions', title: 'AI-actions', unit: 'AI actions',
    stages: ['merged', 'pr-open', 'assigned', 'held'] },
];

const STAGE_LABELS = {
  live: 'Live on cloud',
  'merged-not-live': 'Merged, awaiting release',
  review: 'In review',
  'in-progress': 'In progress',
  merged: 'Merged',
  'pr-open': 'PR open',
  assigned: 'Assigned',
  held: 'Held',
};

// `tier` only exists on the outputSchema roster; adding it as `undefined`
// elsewhere would put a dead key in the embedded JSON.
const toPiece = ({ name, actions, tier }) =>
  (tier === undefined ? { name, actions } : { name, actions, tier });

function rostersFor(selected) {
  const out = [];
  for (const spec of ROSTERS) {
    const ws = selected[spec.key];
    if (ws?.status !== 'ok') continue;
    const rows = Array.isArray(ws.roster) ? ws.roster : [];
    if (!rows.length) continue;

    // A stage we do not know about still gets a group, at the end, labelled
    // with the raw string. Upstream adding a status must make the page look
    // odd — never make pieces silently disappear from it.
    const unknown = [...new Set(rows.map((r) => r.stage))].filter((s) => !spec.stages.includes(s));
    const groups = [...spec.stages, ...unknown]
      // `filter` copies: the collector's ordering (actions desc) is preserved
      // and the input roster is never sorted in place.
      .map((stage) => {
        const pieces = rows.filter((r) => r.stage === stage).map(toPiece);
        return { stage, label: STAGE_LABELS[stage] ?? String(stage), count: pieces.length, pieces };
      })
      .filter((g) => g.count > 0);

    out.push({ key: spec.key, title: spec.title, total: rows.length, unit: spec.unit, groups });
  }
  return out;
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
      return { key: spec.key, title: spec.title, status: 'no-data',
               reason: ws?.reason ?? 'workstream missing from this snapshot',
               value: null, delta: null, unit: '', note: '', spark: [] };
    }
    return {
      key: spec.key, title: spec.title, status: 'ok',
      value: pick(selected, spec.path),
      delta: deltaFor(weeks, selected.week, spec.path),
      unit: spec.unit(ws),
      note: spec.note(ws),
      spark: seriesFor(weeks, selected.week, spec.path),
    };
  });

  const t = selected.tickets;
  const people = t?.status === 'ok'
    ? PEOPLE.map(({ key, name }) => ({
        key, name,
        tickets: t.byPerson?.[key] ?? 0,
        prsMerged: t.prsMerged?.[key] ?? 0,
        reviews: t.reviews?.[key] ?? 0,
      }))
    : [];

  const from = pretty(selected.start);
  const to = pretty(selected.end);
  const weekNo = Number(selected.week.split('-W')[1]);

  return {
    week: selected.week, start: selected.start, end: selected.end, builtAt: selected.builtAt,
    label: `Week ${weekNo} · ${from.short} – ${to.short}, ${to.year}`,
    weeks: list,
    tiles, people,
    rosters: rostersFor(selected),
    shipped: {
      tickets: t?.status === 'ok' ? (t.shipped ?? []) : [],
      testing: selected.testing?.status === 'ok' ? (selected.testing.shipped ?? []) : [],
    },
    decisions: selected.decisions ?? [],
  };
}
