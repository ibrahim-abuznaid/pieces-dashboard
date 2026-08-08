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
//      `delta` both go empty and the box says it was not measured — see
//      NOT_MEASURED below for why it does not repeat the collector's own words.
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
// CAPPED, not truncated: a big week must not push the page past one screen, so
// the strip OPENS at five chips — but the overflow rides along in `rest`, and
// the "+N more" chip is a button that reveals it in place. The page a reader
// lands on always fits the screen; a page a reader deliberately expanded is
// allowed to scroll, because that height was asked for. Capped here rather
// than in the template because the split is part of the view model a test can
// read, and `more` stays the count `rest` must agree with.
//
// Five, measured rather than chosen. A COLLAPSED strip's height is ROWS of
// chips, and the page's CSS guarantees two chips per row whatever the names
// are (a chip is one line and at most half a row wide — see template.html), so
// the cap is what decides how many rows a box can grow to: five plus the
// "+N more" chip is six chips, three rows, a 202px box.
//
// Measured in headless Chrome at 1366x768, which is 681px of viewport. The
// tallest legitimate week — two weeks recorded, every strip at the cap plus
// "+N more", all four workstreams ok, one "Needs you" line — comes to 662px at
// five and 691px at six. See the one-screen tests in test/weekly-render.test.mjs.
export const STRIP_CAP = 5;

const capped = (kind, label, items, cap = STRIP_CAP) => ({
  kind, label, items: items.slice(0, cap), rest: items.slice(cap),
  more: Math.max(0, items.length - cap),
});

// ── a PR title, for a reader outside the repo ───────────────────────────────
// A shipped PR's title is a commit subject: `feat(health): piece health board,
// needs-attention inbox, persisted ru…`. Everything up to the colon is a
// machine-readable classifier — a conventional-commit type and scope, written for
// the repo's own tooling — and it is charged to the front of a chip clamped to half
// a strip row, so what it actually costs is the words at the END of the sentence,
// ellipsized away. This reader can use `piece health board`; they cannot use
// `feat(health)`.
//
// DISPLAY ONLY. The collector records the subject verbatim and the committed
// archive keeps it that way, because that is the record of what shipped; this is
// the last transform before the chip. Here rather than in the template so it is
// unit-testable — see test/weekly-view.test.mjs.
//
// Matched against the conventional-commit VOCABULARY rather than `\w+:`, and only
// in lower case, which is the form the specification defines and the form the repo
// commits in. A colon is ordinary punctuation: a generic pattern amputates whatever
// stands in front of one — `Update: the tester UI` losing its verb, a bare URL
// losing its scheme — and a page that drops a word to save nine characters is
// misleading its reader, which costs more than the nine characters buy. An
// unrecognised prefix therefore stays, exactly as a title with no prefix does.
const CC_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
// `type(scope)!:` — the scope and the breaking-change marker are both optional, and
// both belong to the classifier rather than to the sentence.
const CC_PREFIX = new RegExp(`^(?:${CC_TYPES.join('|')})(?:\\([^)]*\\))?!?:\\s*`);

export function prTitle(title) {
  const sentence = title.replace(CC_PREFIX, '');
  // Nothing but a prefix is all the title there is: stripping it would render a
  // chip with no name at all, which reads as a broken page rather than as a PR.
  if (sentence === title || !sentence) return title;
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

// ── links on chips ──────────────────────────────────────────────────────────
// A chip that names an artifact with a home of its own — a PR, a ticket — links
// to it, so the reader who wants the detail behind a one-line name is one click
// from the source instead of searching for it. https only, checked here rather
// than trusted from the archive: a chip's href lands verbatim in an <a>, and
// weeks.json is hand-editable, so this is the same boundary the template's
// escaping defends. A refused href costs the chip its link, never its place.
const httpsHref = (v) => (typeof v === 'string' && /^https:\/\//.test(v) ? v : undefined);

// Piece testing ships PRs, not pieces: its strip is their titles, and there is
// no logo to show for a pull request. The collector already windowed them to
// this week, so no diff is involved.
//
// `shipped` is optional detail the archive does not validate — a snapshot
// missing it, or carrying a titleless entry, costs the strip and never the
// tile's number. `href` is omitted rather than set undefined when the URL is
// unusable, so a chip's shape says what it carries.
function prStrip(shipped) {
  const items = (Array.isArray(shipped) ? shipped : [])
    .filter((pr) => typeof pr?.title === 'string' && pr.title)
    .map(({ title, url }) => {
      const href = httpsHref(url);
      return href ? { name: prTitle(title), href } : { name: prTitle(title) };
    });
  return items.length ? capped('prs', 'Shipped', items) : null;
}

// ── the tickets a week closed ───────────────────────────────────────────────
// One chip per closed ticket: the id, a shortened title, and a link to the
// ticket itself. The strip carries NO label — the tile's unit line ("closed
// this week") already says exactly what these are, and a second heading between
// the number and its list was the kind of filler this page has none of.
//
// The link is the ticket's home in Linear, built from the id rather than stored:
// the workspace is fixed for this team, and Linear resolves id-only URLs. Only
// ids in Linear's own shape get a chip at all — the id goes into a URL, so junk
// stays off the page entirely rather than becoming a dead link.
const LINEAR_ID = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const ticketUrl = (id) => `https://linear.app/activepieces/issue/${id}`;

// A ticket's subject leads with routing tags — `[BUG] [Pieces] [Salesforce]
// Find Record always fails: …` — written for the tracker's triage, not for a
// reader. Tags are stripped by VOCABULARY, exactly as prTitle strips
// conventional-commit types: `[BUG]` and `[Pieces]` classify, but `[Salesforce]`
// is the sentence's subject and a generic bracket-stripper would amputate it.
// The verbatim title survives in the chip's hover tooltip and in weeks.json.
const TICKET_TAGS = ['bug', 'feature', 'improvement', 'request', 'task', 'pieces', 'piece'];
const TICKET_TAG = new RegExp(`^\\[\\s*(?:${TICKET_TAGS.join('|')})\\s*\\]\\s*:?\\s*`, 'i');

export function ticketTitle(title) {
  let out = String(title);
  while (TICKET_TAG.test(out)) out = out.replace(TICKET_TAG, '');
  // Nothing left but tags is all the title there is — as with prTitle, an empty
  // chip reads as a broken page, so the verbatim title wins.
  if (!out || out === title) return title;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function ticketStrip(ws) {
  const items = (Array.isArray(ws.shipped) ? ws.shipped : [])
    .filter((t) => typeof t?.id === 'string' && LINEAR_ID.test(t.id))
    .map((t) => ({
      id: t.id,
      name: typeof t.title === 'string' && t.title ? ticketTitle(t.title) : '',
      href: ticketUrl(t.id),
    }));
  return items.length ? capped('tickets', '', items) : null;
}

// ── the pieces the tester covers ────────────────────────────────────────────
// When a snapshot recorded the tester's coverage (see collect/testing.mjs), the
// tile's headline is pieces COVERED — cumulative state, not weekly output, so
// there is no done-this-week diff to run and no label to carry: the unit line
// ("of 720 pieces covered") has already said what the chips are. Rows arrive
// most-tested first from the collector, so the cap keeps the most meaningful.
//
// An empty roster is still a measurement: the tile says 0 covered, with no
// strip. That is different from no roster at all, which is "coverage was not
// measured" and falls back to build progress — see the TILES entry.
const coveredRows = (ws) => (Array.isArray(ws?.roster) ? ws.roster : null);

// Accessor (not a stored field) so every already-committed snapshot keeps
// working, and so the delta compares like with like: a week that did not
// measure coverage yields null here, never a PR count in disguise.
const coveredCount = (snap) => {
  const rows = coveredRows(snap.testing);
  return rows ? rows.length : null;
};

function coveredStrip(ws) {
  const rows = coveredRows(ws) ?? [];
  return rows.length ? capped('pieces', '', rows.map(toChip)) : null;
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
  // Two headlines, chosen by what the snapshot measured. With coverage recorded
  // the number a PM wants is pieces COVERED, and build progress (PRs, commits)
  // drops to the note line; without it — every older snapshot, and any week the
  // tester was unreachable — the tile is build progress exactly as it always
  // was. `pathFor` picks per week, and hands deltaFor the same accessor it
  // hands `value`, so a delta can never compare a coverage count against a PR
  // count across the changeover: coveredCount is null on unmeasured weeks, and
  // a null side yields no delta at all.
  { key: 'testing', title: 'Piece testing',
    pathFor: (ws) => (coveredRows(ws) ? coveredCount : 'testing.prsMerged'),
    unit: (ws) => (coveredRows(ws)
      ? (typeof ws.catalogPieces === 'number'
        ? `of ${ws.catalogPieces} pieces covered`
        : `${plural(coveredRows(ws).length, 'piece')} covered`)
      : `${plural(ws.prsMerged, 'PR')} shipped`),
    strip: (ws) => (coveredRows(ws) ? coveredStrip(ws) : prStrip(ws.shipped)),
    note: (ws) => (coveredRows(ws)
      ? `${ws.prsMerged} ${plural(ws.prsMerged, 'PR')} merged · ${ws.commits} ${plural(ws.commits, 'commit')} this week`
      : '') },
  // Tickets are not pieces, so the strip is ids and titles, each linking to the
  // ticket itself. Who closed them is the one line of detail management does
  // read, so it stays folded into this box rather than becoming a table.
  { key: 'tickets', title: 'Tickets solved', path: 'tickets.total',
    unit: () => 'closed this week', perPerson: perPersonLine,
    strip: (ws) => ticketStrip(ws) },
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

// A strip chip: the two things a reader recognises a piece by, and nothing else.
//
// The NAME is the piece's published name when the snapshot resolved one, and the
// row's own `name` otherwise. The AI-actions roster identifies a piece by slug, so
// without this the box read `apify`, `firecrawl`, `google-docs` beside a box
// reading `ClickUp`, `Google Sheets` — one page, two naming conventions, one of
// them the name of a directory in a monorepo this reader has never opened.
//
// It is resolved HERE and not by renaming the row, because `name` is the identity
// the done-this-week diff matches on and the only key the snapshots in the archive
// carry — see `alreadyDone` below. The diff never sees this function.
//
// Both fields are normalised rather than trusted: an empty string in an `<img src>`
// re-requests the page and renders as a broken image, an empty display name renders
// as a chip with no name at all, and a snapshot written before either field existed
// carries neither. In every one of those cases the honest answer is what the row
// already says.
const usable = (v) => (typeof v === 'string' && v ? v : null);

const toChip = ({ name, displayName, logo }) =>
  ({ name: usable(displayName) ?? name, logo: usable(logo) });

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
// A DISPLAY NAME is not an identity, which is exactly why a row may carry one for
// the chip to render (see `toChip`) and the diff still reads this. It is editorial —
// the cloud catalog renames pieces, 'Telegram Bot' and 'Google Gemini' among
// them — and it is not unique:
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
    : { kind: 'pieces', label: 'Nothing new this week', items: [], rest: [], more: 0 };
}

// ── a box with no number ────────────────────────────────────────────────────
// A degraded box has to explain its em dash or it reads as a broken page. What it
// must not do is repeat the collector's `reason`: those are written for whoever
// has to fix the pipeline, and they carry the internal marker the tickets refresh
// writes (NEEDS-LINEAR-REFRESH), the JSON field that went missing
// (`summary.json has no status block`) and the commands to re-run (`npm run fetch
// && npm run build`). An internal field name and a process explanation — the two
// things this page was stripped of everywhere else, sitting on the one box that is
// dark in the week the site is serving right now.
//
// So the box says the only part this reader can use: the number is MISSING, not
// zero. The collector's sentence is not lost — every snapshot stores it verbatim
// in weekly/data/weeks.json, which is committed, where whoever can act on it is
// already looking. The same trade as the piece-tester-web caveat, which moved to
// README.md rather than being deleted.
//
// Phrased on RENDER rather than at snapshot time, so the weeks already in the
// archive read clean too — as with the NOT_AN_ASK filter above. Which is also why
// there is no per-workstream wording: the tile's own heading already names what is
// missing, and a second copy of that name is the filler this page has none of.
const NOT_MEASURED = 'not measured this week';

// ── the note line ───────────────────────────────────────────────────────────
// One sentence of prose under a tile's number: the "what actually happened"
// that no derived count can say. Curated per week in weekly/data/notes.json —
// display layer, never the archive, so a note can be written or fixed after
// the week is sealed — and passed in by the caller because this module does no
// I/O. A tile with no curated note falls back to whatever its spec derives
// (today only piece testing derives one), and to nothing at all.
//
// Collapsed to one line before it renders: the note shares the page's height
// budget, and a pasted paragraph would spend it.
const curatedNote = (v) =>
  (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ') : null);

// ── the UI-improvements band ────────────────────────────────────────────────
// Pieces-related UI work — the piece-selector descriptions project, builder
// fixes around pieces — is real weekly output with no derived number behind it:
// what counts as "pieces-related UI work" is the team's judgment, and half of it
// ships from outside the tickets collector's people list. So the band is CURATED,
// exactly like the note line: weekly/data/updates.json maps week → { note, items },
// display layer, never the archive, editable after the week is sealed.
//
// Items become ordinary strip chips (name + optional link, no icon) through the
// same capped() split the tiles use, so "+N more" behaves identically. The open
// cap is 3, not the tiles' 5: the band is full-width, the half-row clamp
// guarantees two chips per row, so 3 plus "+N more" is at most two rows — the
// band stays ~100px and the landing view keeps the one-screen budget.
//
// Shape errors degrade per entry rather than failing the build: an item without
// a usable label is dropped, and a week with neither a note nor a usable item
// renders no band at all — absence, not an empty box.
const BAND_CAP = 3;

function uiUpdatesFor(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const note = curatedNote(entry.note);
  const items = (Array.isArray(entry.items) ? entry.items : [])
    .filter((it) => it && typeof it === 'object' && curatedNote(it.label))
    .map((it) => {
      const href = httpsHref(it.href);          // same rule as PR chips: https or unlinked
      return { name: curatedNote(it.label), ...(href ? { href } : {}) };
    });
  if (!note && !items.length) return null;
  return { note: note ?? '', strip: items.length ? capped('updates', '', items, BAND_CAP) : null };
}

// `opts.today` is accepted for caller symmetry with snapshot.mjs but deliberately
// unused: the newest entry in the archive already is the newest complete week,
// and reading a clock here would break purity.
export function buildView(archive, { weekId, notes, updates } = {}) {
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
      // No strip on a degraded tile: that the number is missing is the only honest
      // content it has, and a stale list beside it would read as this week's work.
      // A workstream absent from the snapshot altogether lands here too — there is
      // nothing to distinguish for this reader between "not collected" and
      // "collected and failed".
      return { key: spec.key, title: spec.title, status: 'no-data', reason: NOT_MEASURED,
               value: null, delta: null, unit: '', strip: null, perPerson: '', note: '' };
    }
    // Resolved per week when the spec asks (pathFor), so value and delta always
    // share one metric — see the piece-testing entry in TILES.
    const path = spec.pathFor ? spec.pathFor(ws) : spec.path;
    return {
      key: spec.key, title: spec.title, status: 'ok', reason: '',
      value: pick(selected, path),
      delta: deltaFor(weeks, selected.week, path),
      unit: spec.unit(ws),
      strip: spec.strip?.(ws, spec, weeks, selected) ?? null,
      perPerson: spec.perPerson?.(ws) ?? '',
      note: curatedNote(notes?.[selected.week]?.[spec.key]) ?? spec.note?.(ws) ?? '',
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
    uiUpdates: uiUpdatesFor(updates?.[selected.week]),
  };
}
