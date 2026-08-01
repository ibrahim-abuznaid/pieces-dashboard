// weekly/lib/view.mjs
// Pure: archive + selected week → everything the template renders. No I/O, no
// clock, so the whole page shape is unit-testable.
//
// Two invariants the page depends on:
//   1. `tiles` is ALWAYS length 4 in a fixed order, even when workstreams are
//      degraded — the layout must not reflow because a collector failed.
//   2. A degraded workstream renders as "unknown", never as 0. `value`, `delta`
//      and `spark` all go empty and the collector's reason is carried through.
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
    shipped: {
      tickets: t?.status === 'ok' ? (t.shipped ?? []) : [],
      testing: selected.testing?.status === 'ok' ? (selected.testing.shipped ?? []) : [],
    },
    decisions: selected.decisions ?? [],
  };
}
