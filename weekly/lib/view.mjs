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
import { previousWeekId } from '../../lib/isoweek.mjs';
import { TESTING_NOTE } from '../collect/testing.mjs';

const PEOPLE = [{ key: 'kishan', name: 'Kishan' }, { key: 'sanket', name: 'Sanket' }];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Every count on this page meets a noun, and "1 PRs merged" is the kind of
// detail that makes a leadership page look unmaintained. The template keeps its
// own copy of this — it cannot import — so the two must stay in step.
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

// key, title, the metric the big number shows, and how to phrase it. `sub` is
// one line: the tile is a headline, and the detail behind it is the roster.
const TILES = [
  { key: 'outputSchema', title: 'outputSchema', path: mergedSchemas,
    unit: (ws) => `of ${ws.totalPieces} merged`,
    sub: (ws) => `${ws.live} live on cloud · ${ws.review} in review` },
  // `totalPieces` here is only the 28 pieces the initiative TRACKS, so
  // "2 of 28 merged" reads as ~7% catalog coverage when the real figure is
  // 0.3%. When the snapshot recorded the catalog size, count against that and
  // demote the tracked count to the sub-line. When it did not — every snapshot
  // written before the field existed — keep the old wording: a historical week
  // must not be retrofitted with a denominator it never measured.
  { key: 'aiActions', title: 'AI-actions', path: 'aiActions.merged',
    unit: (ws) => (typeof ws.catalogPieces === 'number'
      ? `of ${ws.catalogPieces} have AI actions`
      : `of ${ws.totalPieces} merged`),
    // Blockers stay on the page: they are the reason only 2 of 28 have landed,
    // and dropping them would make the tile look like idle progress.
    sub: (ws) => `${ws.totalPieces} tracked · ${ws.prOpen} ${plural(ws.prOpen, 'PR')} open`
      + ` · ${ws.blockersOpen} ${plural(ws.blockersOpen, 'blocker')}` },
  { key: 'testing', title: 'Piece testing', path: 'testing.prsMerged',
    unit: (ws) => `${plural(ws.prsMerged, 'PR')} shipped`,
    sub: (ws) => `${ws.commits} ${plural(ws.commits, 'commit')}` },
  { key: 'tickets', title: 'Tickets solved', path: 'tickets.total',
    unit: () => 'closed this week',
    sub: (ws) => `${ws.byPerson?.kishan ?? 0} Kishan · ${ws.byPerson?.sanket ?? 0} Sanket` },
];

// ── the verdict ─────────────────────────────────────────────────────────────
// The lede. One or two sentences a person would say out loud, assembled ONLY
// from workstreams that reported — a verdict must never state a number the
// collectors did not measure. Degraded workstreams get named, briefly, at the
// end: the reader has to know what the sentence is silent about.
const VERDICT_ORDER = [
  { key: 'outputSchema',
    say: (ws) => `Output schemas are merged on ${ws.live + ws.mergedNotLive} of ${ws.totalPieces} `
      + `${plural(ws.totalPieces, 'piece')}; ${ws.live} ${ws.live === 1 ? 'is' : 'are'} live on cloud.` },
  { key: 'aiActions',
    say: (ws) => `${ws.merged} ${plural(ws.merged, 'piece')} ${ws.merged === 1 ? 'has' : 'have'} AI actions.` },
  { key: 'tickets',
    say: (ws) => `${ws.total} ${plural(ws.total, 'ticket')} closed this week.` },
  { key: 'testing',
    say: (ws) => `${ws.prsMerged} tester ${plural(ws.prsMerged, 'PR')} shipped.` },
];

const DEGRADED_NAME = {
  outputSchema: 'output-schema', aiActions: 'AI-actions', testing: 'testing', tickets: 'ticket',
};

const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const listOf = (names) => (names.length < 2
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function verdictFor(selected) {
  const sentences = [];
  const degraded = [];
  for (const { key, say } of VERDICT_ORDER) {
    const ws = selected[key];
    if (ws?.status !== 'ok') { degraded.push(DEGRADED_NAME[key]); continue; }
    // Two sentences is the whole budget: this is a 30-second read, and a third
    // clause is what turns a verdict back into a list of numbers.
    if (sentences.length < 2) sentences.push(say(ws));
  }
  if (!sentences.length) return 'No data is available for this week.';
  if (degraded.length) sentences.push(sentenceCase(`${listOf(degraded)} data unavailable.`));
  return sentences.join(' ');
}

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

// The per-piece list behind a tile. Stages are listed in pipeline order, most
// advanced first, so the page reads as "how far along is each piece".
//
// `done` is the subset of those stages that means MERGED. For outputSchema that
// is both `live` and `merged-not-live` — the work landed either way; `live`
// merely also shipped to cloud — so counting only `live` would undercount
// delivered work by whatever is queued behind a cloud release.
const ROSTERS = [
  { key: 'outputSchema', title: 'outputSchema', unit: 'actions',
    stages: ['live', 'merged-not-live', 'review', 'in-progress'],
    done: ['live', 'merged-not-live'] },
  { key: 'aiActions', title: 'AI-actions', unit: 'AI actions',
    stages: ['merged', 'pr-open', 'assigned', 'held'],
    done: ['merged'] },
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

// Done = merged, split into the running total and what crossed the line this
// week. `thisWeek` is EMPTY whenever `hasPrior` is false: with nothing to diff
// against, listing every finished piece would report the whole backlog of
// completed work as one week's output.
function doneFor(spec, rows, prior) {
  const isDone = (r) => spec.done.includes(r.stage);
  const doneNow = rows.filter(isDone).map((r) => r.name);
  const base = { total: doneNow.length, stages: [...spec.done] };
  if (!prior) return { ...base, thisWeek: [], hasPrior: false };
  const before = new Set(prior.filter(isDone).map((r) => r.name));
  return {
    ...base,
    thisWeek: doneNow.filter((name) => !before.has(name)).sort((a, b) => a.localeCompare(b)),
    hasPrior: true,
  };
}

function rostersFor(weeks, selected) {
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

    out.push({ key: spec.key, title: spec.title, total: rows.length, unit: spec.unit, groups,
               done: doneFor(spec, rows, priorRoster(weeks, selected, spec.key)) });
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
               value: null, delta: null, unit: '', sub: '', spark: [] };
    }
    return {
      key: spec.key, title: spec.title, status: 'ok', reason: '',
      value: pick(selected, spec.path),
      delta: deltaFor(weeks, selected.week, spec.path),
      unit: spec.unit(ws),
      sub: spec.sub(ws),
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

  const weekNo = Number(selected.week.split('-W')[1]);

  return {
    week: selected.week, start: selected.start, end: selected.end, builtAt: selected.builtAt,
    title: `Pieces Team · Week ${weekNo}`,
    range: rangeOf(selected.start, selected.end),
    weeks: list,
    verdict: verdictFor(selected),
    tiles, people,
    // Said once, in the caption, rather than stamped on all four tiles.
    noPriorWeek: tiles.every((tile) => tile.delta === null),
    rosters: rostersFor(weeks, selected),
    shipped: {
      tickets: t?.status === 'ok' ? (t.shipped ?? []) : [],
      testing: selected.testing?.status === 'ok' ? (selected.testing.shipped ?? []) : [],
    },
    decisions: (selected.decisions ?? []).filter(isAsk),
    // Too big for a compact tile, too important to drop: the testing numbers
    // are build progress, not piece health, and the page has to keep saying so.
    testingNote: selected.testing?.status === 'ok' ? TESTING_NOTE : '',
  };
}
