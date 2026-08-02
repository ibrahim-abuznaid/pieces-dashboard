# Weekly Progress Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/weekly` page to `pieces-dashboard` that shows one week of Pieces-team progress across four workstreams — outputSchema, AI-actions, piece testing, tickets solved — on a single permanent link, defaulting to the most recently completed week with an archive behind it.

**Architecture:** Snapshots are **written locally** (Saturday cron) and **committed** to `weekly/data/weeks.json`; CI **only renders** them. This split is mandatory: CI runs daily at 06:00 UTC, so computing snapshots in CI would recompute and mutate past weeks. All snapshot logic is pure functions over injected data, so every task is unit-testable without network or `gh`.

**Tech Stack:** Node ≥20 ESM (`.mjs`), `node --test` + `node:assert/strict`, existing `lib/render.mjs` template renderer, `shared/theme.css`, `gh` CLI, GitHub Pages via existing `.github/workflows/deploy.yml`.

**Spec:** `docs/superpowers/specs/2026-08-01-weekly-progress-page-design.md`

## Global Constraints

- Node ESM only — `.mjs` files, `import`/`export`, no CommonJS, no TypeScript.
- No new npm dependencies. Zero-dependency stdlib only.
- Tests live in `test/*.test.mjs` and run under `npm test` (`node --test`). Match the style of `test/stages.test.mjs`: `import test from 'node:test'`, `import assert from 'node:assert/strict'`.
- All rendering goes through `renderPage()` from `lib/render.mjs`. Never write HTML with `fs.writeFileSync` directly. Templates MUST contain both markers `/*__THEME__*/` and `/*__DATA__*/null` or `renderPage` throws.
- Never hand-edit generated `dist/` output. `dist/` is gitignored.
- **Week window: 7 days ending Friday** (Saturday 00:00 → Friday 23:59 inclusive). Week id = ISO week of the ending Friday. This window is lossless (no day belongs to zero or two weeks) and fully closed when the Saturday job runs.
- **All dates are UTC-normalized `YYYY-MM-DD` strings.** Never use local-time `Date` methods (`getDay`, `getMonth`, `getDate`) — only `getUTC*`. Date arithmetic via `Date.UTC` epoch math.
- **A failed collector returns `{status: 'no-data', reason: '<why>'}` — never `0`, never a thrown error that aborts the whole snapshot.** Every `status: 'ok'` payload carries its numeric fields.
- Snapshots are immutable: appending an existing week id throws unless `force: true`.
- Person keys are exactly `kishan` and `sanket` (lowercase), matching `linear.json` / `github.json`.
- Internal dashboard path comes from `process.env.PIECES_TEAM_DASHBOARD`, defaulting to `/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard`.

## Snapshot schema (the contract every task shares)

```json
{
  "week": "2026-W31",
  "start": "2026-07-25",
  "end": "2026-07-31",
  "builtAt": "2026-08-01",
  "outputSchema": { "status": "ok", "live": 9, "mergedNotLive": 6, "review": 8, "todo": 733, "totalPieces": 756 },
  "aiActions":    { "status": "ok", "merged": 2, "prOpen": 24, "assigned": 0, "held": 2, "totalPieces": 28, "blockersOpen": 30 },
  "testing":      { "status": "ok", "prsMerged": 1, "commits": 4,
                    "shipped": [{ "number": 5, "title": "feat(health): piece health board", "url": "https://github.com/..." }] },
  "tickets":      { "status": "ok", "total": 11,
                    "byPerson": { "kishan": 5, "sanket": 6 },
                    "prsMerged": { "kishan": 3, "sanket": 4 },
                    "reviews":   { "kishan": 12, "sanket": 9 },
                    "shipped": [{ "id": "GIT-1612", "title": "Bundler inlines native dep sharp", "assignee": "kishan", "team": "GIT" }] },
  "decisions": ["6 outputSchema pieces merged but not cloud-live"]
}
```

A degraded workstream replaces its object with `{ "status": "no-data", "reason": "…" }`.
Archive file shape: `{ "weeks": [ <snapshot>, … ] }`, sorted ascending by `week`.

## File Structure

| File | Responsibility |
|---|---|
| `lib/isoweek.mjs` | ISO week id ↔ date-window math. Pure, no I/O. |
| `weekly/lib/archive.mjs` | Read/validate/append the snapshot archive. Enforces immutability. |
| `weekly/lib/deltas.mjs` | Pull a metric across weeks: current value, week-over-week delta, sparkline series. Pure. |
| `weekly/lib/view.mjs` | Compose one week's render model (tiles, people, shipped, decisions, picker). Pure. |
| `weekly/collect/output-schema.mjs` | Read `dist/output-schema/summary.json` → workstream payload. |
| `weekly/collect/ai-actions.mjs` | Read `dist/ai-actions/summary.json` → workstream payload. |
| `weekly/collect/testing.mjs` | `gh` on `piece-tester-web` → merged PRs + commits in window. |
| `weekly/collect/tickets.mjs` | Read internal dashboard `linear.json` + `github.json` → per-person counts. |
| `weekly/snapshot.mjs` | **Local-only CLI.** Runs collectors, appends one week, writes archive. |
| `weekly/build.mjs` | **CI render.** `weeks.json` → `dist/weekly/index.html` + `summary.json`. Pure render, no fetching. |
| `weekly/template.html` | Page markup + client-side week switching. |
| `weekly/data/weeks.json` | Committed append-only archive. |
| `refresh-weekly.sh` | The single Saturday job. |

## Dispatch graph (for subagent-driven execution)

Tasks in the same wave are independent and can be dispatched in parallel.

```
Wave 0 (alone):       Task 1   — lib/isoweek.mjs, imported by Tasks 3 and 6
Wave 1 (5 parallel):  Task 2  Task 3  Task 4  Task 5  Task 6
Wave 2 (2 parallel):  Task 7 (needs 1,2,4,5,6)   Task 8 (needs 1,3)
Wave 3:               Task 9 (needs 8)
Wave 4:               Task 10 (needs 9)
Wave 5:               Task 11 (needs 7,10)
```

Task 1 must land before Wave 1: Task 3 imports `previousWeekId` and Task 6 imports
`mondayOfWeekId` from it, so their tests cannot pass until `lib/isoweek.mjs` exists.
Wave-1 tasks touch files disjoint from each other and need no interface from each other —
only Task 1 plus the schema above.

**Parallel-execution note:** when tasks are dispatched concurrently, skip each task's
`git commit` step — concurrent `git add`/`commit` in one worktree races on `index.lock`.
The dispatcher commits each task's files as it lands instead.

---

### Task 1: ISO week math

**Files:**
- Create: `lib/isoweek.mjs`
- Test: `test/isoweek.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isoWeekId(date: string|Date): string` → `'2026-W31'`
  - `mondayOfWeekId(weekId: string): string` → `'2026-07-27'`
  - `windowForWeekId(weekId: string): {start: string, end: string}` → `{start:'2026-07-25', end:'2026-07-31'}`
  - `latestCompleteWeek(today: string): string` → week id of the most recent Friday ≤ `today`
  - `previousWeekId(weekId: string): string` → `'2026-W30'`

- [ ] **Step 1: Write the failing test**

```javascript
// test/isoweek.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { isoWeekId, mondayOfWeekId, windowForWeekId, latestCompleteWeek, previousWeekId } from '../lib/isoweek.mjs';

test('isoWeekId: mid-year Monday', () => assert.equal(isoWeekId('2026-07-27'), '2026-W31'));
test('isoWeekId: the Friday of the same week', () => assert.equal(isoWeekId('2026-07-31'), '2026-W31'));
test('isoWeekId: Sunday belongs to the week that started Monday', () =>
  assert.equal(isoWeekId('2026-08-02'), '2026-W31'));
test('isoWeekId: Jan 1 2026 is a Thursday, so week 01', () =>
  assert.equal(isoWeekId('2026-01-01'), '2026-W01'));
test('isoWeekId: late Dec rolls into the next ISO year', () =>
  assert.equal(isoWeekId('2025-12-29'), '2026-W01'));

test('mondayOfWeekId', () => assert.equal(mondayOfWeekId('2026-W31'), '2026-07-27'));
test('mondayOfWeekId: ISO year boundary', () => assert.equal(mondayOfWeekId('2026-W01'), '2025-12-29'));

test('windowForWeekId is 7 days ending Friday', () =>
  assert.deepEqual(windowForWeekId('2026-W31'), { start: '2026-07-25', end: '2026-07-31' }));

test('latestCompleteWeek on a Saturday returns the week that just ended', () =>
  assert.equal(latestCompleteWeek('2026-08-01'), '2026-W31'));
test('latestCompleteWeek on the Friday itself includes that Friday', () =>
  assert.equal(latestCompleteWeek('2026-07-31'), '2026-W31'));
test('latestCompleteWeek mid-week returns the prior Friday', () =>
  assert.equal(latestCompleteWeek('2026-07-29'), '2026-W30'));

test('previousWeekId', () => assert.equal(previousWeekId('2026-W31'), '2026-W30'));
test('previousWeekId crosses the ISO year', () => assert.equal(previousWeekId('2026-W01'), '2025-W52'));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/ibrahim/AP_work/Activepieces_v/pieces-dashboard && node --test test/isoweek.test.mjs`
Expected: FAIL — `Cannot find module '../lib/isoweek.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// lib/isoweek.mjs
// ISO-8601 week math, UTC only. A "week window" is the 7 days ending on that
// week's Friday (Sat 00:00 → Fri 23:59), which is lossless and is already
// closed when the Saturday snapshot job runs.
const DAY = 86400000;

const toUTC = (d) => (d instanceof Date ? d : new Date(`${d}T00:00:00Z`));
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (d, days) => new Date(d.getTime() + days * DAY);
// Monday = 0 … Sunday = 6
const isoDayIndex = (d) => (d.getUTCDay() + 6) % 7;

const thursdayOfWeek = (d) => shift(d, 3 - isoDayIndex(d));

export function isoWeekId(date) {
  const thu = thursdayOfWeek(toUTC(date));
  const year = thu.getUTCFullYear();
  const firstThu = thursdayOfWeek(new Date(Date.UTC(year, 0, 4)));
  const week = 1 + Math.round((thu.getTime() - firstThu.getTime()) / (7 * DAY));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function mondayOfWeekId(weekId) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekId);
  if (!m) throw new Error(`bad week id: ${weekId}`);
  const [, year, week] = m;
  const firstThu = thursdayOfWeek(new Date(Date.UTC(Number(year), 0, 4)));
  const thu = shift(firstThu, (Number(week) - 1) * 7);
  return iso(shift(thu, -3));
}

export function windowForWeekId(weekId) {
  const monday = toUTC(mondayOfWeekId(weekId));
  return { start: iso(shift(monday, -2)), end: iso(shift(monday, 4)) };
}

export function latestCompleteWeek(today) {
  const d = toUTC(today);
  // Friday = index 4. Walk back to the most recent Friday, inclusive.
  const back = (isoDayIndex(d) - 4 + 7) % 7;
  return isoWeekId(shift(d, -back));
}

export function previousWeekId(weekId) {
  return isoWeekId(shift(toUTC(mondayOfWeekId(weekId)), -7));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/isoweek.test.mjs`
Expected: PASS — 13 tests

- [ ] **Step 5: Commit**

```bash
git add lib/isoweek.mjs test/isoweek.test.mjs
git commit -m "feat(weekly): ISO week math with Sat→Fri windows"
```

---

### Task 2: Snapshot archive — validate, append, immutability

**Files:**
- Create: `weekly/lib/archive.mjs`
- Test: `test/weekly-archive.test.mjs`

**Interfaces:**
- Consumes: the snapshot schema (top of plan). Does NOT import `lib/isoweek.mjs`.
- Produces:
  - `validateSnapshot(snap: object): void` — throws `Error` with a specific message on the first violation
  - `appendWeek(archive: {weeks: object[]}, snap: object, opts?: {force?: boolean}): {weeks: object[]}` — returns a NEW archive, never mutates the input, sorted ascending by `week`
  - `readArchive(path: string): {weeks: object[]}` — returns `{weeks: []}` if the file does not exist
  - `writeArchive(path: string, archive: {weeks: object[]}): void` — pretty-printed with 2-space indent + trailing newline

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-archive.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, appendWeek, readArchive } from '../weekly/lib/archive.mjs';

const ok = (over = {}) => ({
  week: '2026-W31', start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  decisions: [],
  ...over,
});

test('a well-formed snapshot validates', () => validateSnapshot(ok()));

test('a no-data workstream validates when it carries a reason', () =>
  validateSnapshot(ok({ tickets: { status: 'no-data', reason: 'Linear refresh pending' } })));

test('no-data without a reason is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ tickets: { status: 'no-data' } })), /tickets.*reason/));

test('a bad week id is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ week: '2026-31' })), /week/));

test('a missing workstream is rejected', () => {
  const snap = ok();
  delete snap.testing;
  assert.throws(() => validateSnapshot(snap), /testing/);
});

test('an ok workstream missing a numeric field is rejected', () =>
  assert.throws(() => validateSnapshot(ok({ testing: { status: 'ok', commits: 4, shipped: [] } })), /prsMerged/));

test('a zero value is valid — only absence is an error', () =>
  validateSnapshot(ok({ testing: { status: 'ok', prsMerged: 0, commits: 0, shipped: [] } })));

test('decisions must be an array of strings', () =>
  assert.throws(() => validateSnapshot(ok({ decisions: 'nope' })), /decisions/));

test('appendWeek adds to an empty archive', () => {
  const out = appendWeek({ weeks: [] }, ok());
  assert.equal(out.weeks.length, 1);
  assert.equal(out.weeks[0].week, '2026-W31');
});

test('appendWeek does not mutate the input archive', () => {
  const before = { weeks: [] };
  appendWeek(before, ok());
  assert.equal(before.weeks.length, 0);
});

test('appendWeek keeps weeks sorted ascending', () => {
  const a = appendWeek({ weeks: [] }, ok({ week: '2026-W31' }));
  const b = appendWeek(a, ok({ week: '2026-W29' }));
  const c = appendWeek(b, ok({ week: '2026-W30' }));
  assert.deepEqual(c.weeks.map((w) => w.week), ['2026-W29', '2026-W30', '2026-W31']);
});

test('re-appending an existing week throws', () => {
  const a = appendWeek({ weeks: [] }, ok());
  assert.throws(() => appendWeek(a, ok()), /2026-W31 already exists/);
});

test('force replaces an existing week in place', () => {
  const a = appendWeek({ weeks: [] }, ok());
  const b = appendWeek(a, ok({ builtAt: '2026-08-08' }), { force: true });
  assert.equal(b.weeks.length, 1);
  assert.equal(b.weeks[0].builtAt, '2026-08-08');
});

test('appendWeek validates before appending', () =>
  assert.throws(() => appendWeek({ weeks: [] }, ok({ week: 'bad' })), /week/));

test('readArchive on a missing file yields an empty archive', () =>
  assert.deepEqual(readArchive('/tmp/definitely-not-here-9f3a.json'), { weeks: [] }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-archive.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/lib/archive.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/lib/archive.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

const WEEK_RE = /^\d{4}-W\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Numeric fields every `status: 'ok'` workstream must carry. Absence is an
// error; zero is not — a silent 0 is exactly what the no-data path exists to
// prevent, so a genuine 0 has to be distinguishable from a missing field.
const REQUIRED = {
  outputSchema: ['live', 'mergedNotLive', 'review', 'todo', 'totalPieces'],
  aiActions: ['merged', 'prOpen', 'assigned', 'held', 'totalPieces', 'blockersOpen'],
  testing: ['prsMerged', 'commits'],
  tickets: ['total'],
};

export function validateSnapshot(snap) {
  if (!snap || typeof snap !== 'object') throw new Error('snapshot must be an object');
  if (!WEEK_RE.test(snap.week ?? '')) throw new Error(`bad week id: ${snap.week}`);
  for (const f of ['start', 'end', 'builtAt']) {
    if (!DATE_RE.test(snap[f] ?? '')) throw new Error(`${f} must be YYYY-MM-DD, got ${snap[f]}`);
  }
  if (!Array.isArray(snap.decisions) || snap.decisions.some((d) => typeof d !== 'string')) {
    throw new Error('decisions must be an array of strings');
  }
  for (const [key, fields] of Object.entries(REQUIRED)) {
    const ws = snap[key];
    if (!ws || typeof ws !== 'object') throw new Error(`missing workstream: ${key}`);
    if (ws.status === 'no-data') {
      if (typeof ws.reason !== 'string' || !ws.reason) throw new Error(`${key}: no-data needs a reason`);
      continue;
    }
    if (ws.status !== 'ok') throw new Error(`${key}: status must be "ok" or "no-data", got ${ws.status}`);
    for (const f of fields) {
      if (typeof ws[f] !== 'number') throw new Error(`${key}.${f} must be a number`);
    }
  }
}

export function appendWeek(archive, snap, { force = false } = {}) {
  validateSnapshot(snap);
  const weeks = [...(archive?.weeks ?? [])];
  const at = weeks.findIndex((w) => w.week === snap.week);
  if (at !== -1 && !force) throw new Error(`${snap.week} already exists — pass --force-week to replace it`);
  if (at !== -1) weeks[at] = snap;
  else weeks.push(snap);
  weeks.sort((a, b) => a.week.localeCompare(b.week));
  return { ...archive, weeks };
}

export function readArchive(path) {
  if (!existsSync(path)) return { weeks: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  return { weeks: [], ...parsed };
}

export function writeArchive(path, archive) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(archive, null, 2)}\n`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-archive.test.mjs`
Expected: PASS — 15 tests

- [ ] **Step 5: Commit**

```bash
git add weekly/lib/archive.mjs test/weekly-archive.test.mjs
git commit -m "feat(weekly): snapshot schema validation + immutable archive append"
```

---

### Task 3: Deltas and sparkline series

**Files:**
- Create: `weekly/lib/deltas.mjs`
- Test: `test/weekly-deltas.test.mjs`

**Interfaces:**
- Consumes: archive shape `{weeks: [...]}` from the schema at the top of this plan. Imports nothing from other tasks.
- Produces:
  - `pick(snap: object, path: string): number|null` — dotted path (`'tickets.total'`). Returns `null` when the snapshot is missing, the workstream is `no-data`, or the value is not a number.
  - `deltaFor(weeks: object[], weekId: string, path: string): number|null` — `null` when either the current or previous week's value is unavailable.
  - `seriesFor(weeks: object[], weekId: string, path: string, count?: number): Array<{week: string, value: number|null}>` — oldest→newest, ending at `weekId`, at most `count` entries (default `6`). Only weeks present in the archive; never synthesizes gaps.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-deltas.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pick, deltaFor, seriesFor } from '../weekly/lib/deltas.mjs';

const snap = (week, total, live) => ({
  week,
  tickets: total === null ? { status: 'no-data', reason: 'x' } : { status: 'ok', total },
  outputSchema: { status: 'ok', live },
});

const weeks = [snap('2026-W29', 8, 5), snap('2026-W30', 9, 7), snap('2026-W31', 11, 9)];

test('pick reads a dotted path', () => assert.equal(pick(weeks[2], 'tickets.total'), 11));
test('pick returns null for a no-data workstream', () =>
  assert.equal(pick(snap('2026-W32', null, 9), 'tickets.total'), null));
test('pick returns null for an unknown path', () => assert.equal(pick(weeks[0], 'nope.nope'), null));
test('pick returns null for a missing snapshot', () => assert.equal(pick(undefined, 'tickets.total'), null));
test('pick preserves a real zero', () => assert.equal(pick(snap('2026-W32', 0, 0), 'tickets.total'), 0));

test('deltaFor computes week-over-week', () => assert.equal(deltaFor(weeks, '2026-W31', 'tickets.total'), 2));
test('deltaFor is null for the first week in the archive', () =>
  assert.equal(deltaFor(weeks, '2026-W29', 'tickets.total'), null));
test('deltaFor is null when the previous week is no-data', () => {
  const w = [snap('2026-W30', null, 7), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), null);
});
test('deltaFor is null when the previous week is absent from the archive', () => {
  const w = [snap('2026-W29', 8, 5), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), null);
});
test('deltaFor can be negative', () => {
  const w = [snap('2026-W30', 12, 7), snap('2026-W31', 11, 9)];
  assert.equal(deltaFor(w, '2026-W31', 'tickets.total'), -1);
});

test('seriesFor returns oldest to newest ending at the given week', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W31', 'outputSchema.live'), [
    { week: '2026-W29', value: 5 },
    { week: '2026-W30', value: 7 },
    { week: '2026-W31', value: 9 },
  ]));
test('seriesFor caps at count, keeping the most recent', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W31', 'tickets.total', 2), [
    { week: '2026-W30', value: 9 },
    { week: '2026-W31', value: 11 },
  ]));
test('seriesFor stops at the selected week, ignoring later ones', () =>
  assert.deepEqual(seriesFor(weeks, '2026-W30', 'tickets.total').map((p) => p.week), ['2026-W29', '2026-W30']));
test('seriesFor emits null values for no-data weeks rather than dropping them', () => {
  const w = [snap('2026-W30', null, 7), snap('2026-W31', 11, 9)];
  assert.deepEqual(seriesFor(w, '2026-W31', 'tickets.total'), [
    { week: '2026-W30', value: null },
    { week: '2026-W31', value: 11 },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-deltas.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/lib/deltas.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/lib/deltas.mjs
// Pure reads over the snapshot archive. A metric is unavailable (null) rather
// than zero whenever its workstream degraded — the page must never imply "0"
// when it means "we don't know".

export function pick(snap, path) {
  let cur = snap;
  for (const key of path.split('.')) {
    if (!cur || typeof cur !== 'object') return null;
    if (cur.status === 'no-data') return null;
    cur = cur[key];
  }
  return typeof cur === 'number' ? cur : null;
}

const indexOfWeek = (weeks, weekId) => weeks.findIndex((w) => w.week === weekId);

export function deltaFor(weeks, weekId, path) {
  const at = indexOfWeek(weeks, weekId);
  if (at <= 0) return null;
  const current = pick(weeks[at], path);
  const previous = pick(weeks[at - 1], path);
  if (current === null || previous === null) return null;
  return current - previous;
}

export function seriesFor(weeks, weekId, path, count = 6) {
  const at = indexOfWeek(weeks, weekId);
  if (at === -1) return [];
  return weeks
    .slice(Math.max(0, at + 1 - count), at + 1)
    .map((w) => ({ week: w.week, value: pick(w, path) }));
}
```

> Note on `deltaFor`: it compares against the **immediately preceding entry in the archive**, not `previousWeekId()`. If a week was never snapshotted, `seriesFor`/`deltaFor` must not invent it — but a gap also must not silently compare across a two-week jump. Guard that in Step 3b.

- [ ] **Step 3b: Make gaps explicit, then re-run**

Add to `deltaFor`, before computing, so a missing intermediate week yields `null` instead of a misleading two-week delta:

```javascript
// at the top of deltas.mjs
import { previousWeekId } from '../../lib/isoweek.mjs';
```

```javascript
// inside deltaFor, after `if (at <= 0) return null;`
  if (weeks[at - 1].week !== previousWeekId(weekId)) return null;
```

The test `'deltaFor is null when the previous week is absent from the archive'` covers this.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-deltas.test.mjs`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add weekly/lib/deltas.mjs test/weekly-deltas.test.mjs
git commit -m "feat(weekly): week-over-week deltas + sparkline series"
```

---

### Task 4: Collectors — outputSchema and AI-actions

**Files:**
- Create: `weekly/collect/output-schema.mjs`
- Create: `weekly/collect/ai-actions.mjs`
- Test: `test/weekly-collect-dashboards.test.mjs`

**Interfaces:**
- Consumes: `dist/output-schema/summary.json` and `dist/ai-actions/summary.json`, produced by the existing `npm run build`. Real shapes:
  - outputSchema: `{ generated, totals: {pieces, steps, actions, triggers}, status: {live, 'merged-not-live', 'in-progress', todo, review, skip}, … }`
  - aiActions: `{ generated, prFetched, pieces, atomics, t2v, t2t, stages: {held, assigned, prOpen, merged}, prsOpen, prsMerged, blockersOpen, blockersDone }`
- Produces:
  - `collectOutputSchema({readJson}): object` — the `outputSchema` workstream payload
  - `collectAiActions({readJson}): object` — the `aiActions` workstream payload
  - Both take an injected `readJson(relPath: string) => object` that throws when the file is absent, so tests need no filesystem. Both catch and convert failure to `{status:'no-data', reason}`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-collect-dashboards.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOutputSchema } from '../weekly/collect/output-schema.mjs';
import { collectAiActions } from '../weekly/collect/ai-actions.mjs';

const OS_SUMMARY = {
  generated: '2026-07-23',
  totals: { pieces: 756, steps: 7019, actions: 5539, triggers: 1480 },
  status: { live: 9, 'merged-not-live': 6, 'in-progress': 0, todo: 733, review: 8, skip: 0 },
};

const AI_SUMMARY = {
  generated: '2026-07-23', prFetched: '2026-07-22', pieces: 28, atomics: 763,
  stages: { held: 2, assigned: 0, prOpen: 24, merged: 2 },
  prsOpen: 15, prsMerged: 1, blockersOpen: 30, blockersDone: 2,
};

test('collectOutputSchema maps the real summary shape', () => {
  assert.deepEqual(collectOutputSchema({ readJson: () => OS_SUMMARY }), {
    status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756,
  });
});

test('collectOutputSchema degrades to no-data with the reason when the file is missing', () => {
  const out = collectOutputSchema({ readJson: () => { throw new Error('ENOENT: no such file'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /npm run build/);
});

test('collectOutputSchema rejects a summary missing the status block', () => {
  const out = collectOutputSchema({ readJson: () => ({ totals: { pieces: 1 } }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /status/);
});

test('collectAiActions maps the real summary shape', () => {
  assert.deepEqual(collectAiActions({ readJson: () => AI_SUMMARY }), {
    status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30,
  });
});

test('collectAiActions degrades when stages are absent', () => {
  const out = collectAiActions({ readJson: () => ({ pieces: 28 }) });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /stages/);
});

test('a zero stage count survives as 0, not no-data', () => {
  const out = collectAiActions({ readJson: () => ({ ...AI_SUMMARY, stages: { held: 0, assigned: 0, prOpen: 0, merged: 0 } }) });
  assert.equal(out.status, 'ok');
  assert.equal(out.merged, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-collect-dashboards.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/collect/output-schema.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/collect/output-schema.mjs
// Reads the existing outputSchema build output. `dist/` is gitignored and built
// fresh, so a missing file means "npm run build hasn't run here" — that is a
// no-data reason, not a zero.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

export function collectOutputSchema({ readJson }) {
  try {
    const s = readJson('dist/output-schema/summary.json');
    if (!s?.status) throw new Error('summary.json has no `status` block');
    if (!s?.totals?.pieces) throw new Error('summary.json has no `totals.pieces`');
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json status.${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      live: num(s.status.live, 'live'),
      mergedNotLive: num(s.status['merged-not-live'], 'merged-not-live'),
      review: num(s.status.review, 'review'),
      todo: num(s.status.todo, 'todo'),
      totalPieces: s.totals.pieces,
    };
  } catch (err) {
    return { status: 'no-data', reason: `outputSchema summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
```

```javascript
// weekly/collect/ai-actions.mjs
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

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
    };
  } catch (err) {
    return { status: 'no-data', reason: `AI-actions summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-collect-dashboards.test.mjs`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add weekly/collect/output-schema.mjs weekly/collect/ai-actions.mjs test/weekly-collect-dashboards.test.mjs
git commit -m "feat(weekly): outputSchema + AI-actions collectors"
```

---

### Task 5: Collector — testing (`piece-tester-web`)

**Files:**
- Create: `weekly/collect/testing.mjs`
- Test: `test/weekly-collect-testing.test.mjs`

**Interfaces:**
- Consumes: `gh` CLI against `ibrahim-abuznaid/piece-tester-web` (public repo, default branch `main`).
- Produces:
  - `collectTesting({window, gh}): object` — the `testing` workstream payload.
    - `window`: `{start: 'YYYY-MM-DD', end: 'YYYY-MM-DD'}` (inclusive both ends)
    - `gh(args: string[]) => string` — injected runner returning raw stdout; throws on non-zero exit
  - `TESTING_NOTE: string` — the caveat string the page shows for this tile.

**Context for the implementer:** this workstream reports **build progress**, not piece health. `piece-tester-web` keeps run results in a local SQLite DB and its export script dumps only config tables, so pass/fail counts are not reachable yet. Do not attempt to read the DB.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-collect-testing.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTesting, TESTING_NOTE } from '../weekly/collect/testing.mjs';

const WINDOW = { start: '2026-07-25', end: '2026-07-31' };

const PRS = JSON.stringify([
  { number: 5, title: 'feat(health): piece health board', mergedAt: '2026-07-30T07:36:31Z',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5' },
  { number: 3, title: 'feat(assertions): output assertions', mergedAt: '2026-06-22T10:00:00Z',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/3' },
  { number: 4, title: 'feat: alerts', mergedAt: null,
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/4' },
]);

const COMMITS = JSON.stringify([{ sha: 'a' }, { sha: 'b' }, { sha: 'c' }, { sha: 'd' }]);

const fakeGh = (prs = PRS, commits = COMMITS) => (args) =>
  args.includes('pr') ? prs : commits;

test('counts only PRs merged inside the window', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh() });
  assert.equal(out.status, 'ok');
  assert.equal(out.prsMerged, 1);
  assert.deepEqual(out.shipped, [{
    number: 5, title: 'feat(health): piece health board',
    url: 'https://github.com/ibrahim-abuznaid/piece-tester-web/pull/5',
  }]);
});

test('unmerged PRs are excluded', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 4, title: 'feat: alerts', mergedAt: null, url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 0);
  assert.deepEqual(out.shipped, []);
});

test('a PR merged on the final day of the window counts', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 9, title: 'edge', mergedAt: '2026-07-31T23:59:59Z', url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 1);
});

test('a PR merged the day after the window is excluded', () => {
  const out = collectTesting({ window: WINDOW, gh: fakeGh(JSON.stringify([
    { number: 9, title: 'edge', mergedAt: '2026-08-01T00:00:00Z', url: 'u' },
  ])) });
  assert.equal(out.prsMerged, 0);
});

test('commit count comes from the commits query', () => {
  assert.equal(collectTesting({ window: WINDOW, gh: fakeGh() }).commits, 4);
});

test('a gh failure degrades to no-data with the reason', () => {
  const out = collectTesting({ window: WINDOW, gh: () => { throw new Error('gh: not authenticated'); } });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /not authenticated/);
});

test('unparseable gh output degrades to no-data', () => {
  const out = collectTesting({ window: WINDOW, gh: () => 'not json' });
  assert.equal(out.status, 'no-data');
});

test('the tile note states the build-progress caveat', () =>
  assert.match(TESTING_NOTE, /health/i));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-collect-testing.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/collect/testing.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/collect/testing.mjs
// Progress on Sanket's piece-tester-web. Reports BUILD progress (PRs merged,
// commits) — not piece health. Run results live in a local SQLite DB that the
// repo's export script does not dump, so pass/fail counts are not reachable
// yet; unlocking them needs a stats endpoint or a committed health.json.
export const REPO = 'ibrahim-abuznaid/piece-tester-web';
export const TESTING_NOTE = 'Build progress only — piece health numbers need a stats endpoint on piece-tester-web.';

const dayOf = (iso) => String(iso).slice(0, 10);
const inWindow = (iso, { start, end }) => {
  const d = dayOf(iso);
  return Boolean(iso) && d >= start && d <= end;
};

export function collectTesting({ window, gh }) {
  try {
    const prs = JSON.parse(gh(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--limit', '100', '--json', 'number,title,mergedAt,url']));
    const merged = prs.filter((pr) => inWindow(pr.mergedAt, window));
    const commits = JSON.parse(gh(['api',
      `repos/${REPO}/commits?since=${window.start}T00:00:00Z&until=${window.end}T23:59:59Z&per_page=100`]));
    return {
      status: 'ok',
      prsMerged: merged.length,
      commits: Array.isArray(commits) ? commits.length : 0,
      shipped: merged.map(({ number, title, url }) => ({ number, title, url })),
    };
  } catch (err) {
    return { status: 'no-data', reason: `piece-tester-web unreachable (${err.message})` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-collect-testing.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 5: Verify against the live repo**

Run:
```bash
node -e "
import('./weekly/collect/testing.mjs').then(async (m) => {
  const { execFileSync } = await import('node:child_process');
  const gh = (a) => execFileSync('gh', a, { encoding: 'utf8' });
  console.log(JSON.stringify(m.collectTesting({ window: { start: '2026-07-25', end: '2026-07-31' }, gh }), null, 2));
});"
```
Expected: `status: 'ok'` with `prsMerged: 1` and PR #5 in `shipped` (merged 2026-07-30).

- [ ] **Step 6: Commit**

```bash
git add weekly/collect/testing.mjs test/weekly-collect-testing.test.mjs
git commit -m "feat(weekly): piece-tester-web build-progress collector"
```

---

### Task 6: Collector — tickets solved

**Files:**
- Create: `weekly/collect/tickets.mjs`
- Test: `test/weekly-collect-tickets.test.mjs`

**Interfaces:**
- Consumes: the internal dashboard's data files (outside this repo, local only). Real shapes:
  - `linear.json`: `{ stamp, events: [{d, c, p, t, pri, src, area, bountyAmt, rewarded}], recent: [{id, title, team, assignee, status, completedAt}], … }` where `d` = completion date `YYYY-MM-DD`, `p` = `'kishan'|'sanket'`, `t` = `'Pieces'|'GIT'`
  - `github.json`: `{ stamp, mergedEvents: [{d, p, kind}], reviews: {kishan, sanket, weekly: [{w, kishan, sanket}], approx}, … }` where `reviews.weekly[].w` is a **Monday** date string
- Produces:
  - `collectTickets({window, weekId, readJson, linearRefreshPending}): object` — the `tickets` workstream payload
    - `readJson(name: 'linear.json'|'github.json') => object`, throws when absent
    - `linearRefreshPending: boolean` — true when the internal `NEEDS-LINEAR-REFRESH` marker exists
    - `weekId` is needed because `reviews.weekly` is keyed by Monday date, so it is looked up via `mondayOfWeekId(weekId)`

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-collect-tickets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTickets } from '../weekly/collect/tickets.mjs';

const WINDOW = { start: '2026-07-25', end: '2026-07-31' };
const WEEK = '2026-W31';   // Monday = 2026-07-27

const LINEAR = {
  events: [
    { d: '2026-07-27', p: 'kishan', t: 'Pieces' },
    { d: '2026-07-30', p: 'kishan', t: 'GIT' },
    { d: '2026-07-31', p: 'sanket', t: 'Pieces' },
    { d: '2026-07-25', p: 'sanket', t: 'Pieces' },   // Saturday — inside a Sat→Fri window
    { d: '2026-08-01', p: 'sanket', t: 'Pieces' },   // outside
    { d: '2026-07-10', p: 'kishan', t: 'GIT' },      // outside
  ],
  recent: [
    { id: 'PIE-101', title: 'Add Notion outputSchema', team: 'Pieces', assignee: 'kishan',
      status: 'Done', completedAt: '2026-07-27T09:00:00Z' },
    { id: 'GIT-1612', title: 'Bundler inlines sharp', team: 'GIT', assignee: 'kishan',
      status: 'Done', completedAt: '2026-07-10T09:00:00Z' },   // outside window
    { id: 'PIE-999', title: 'In flight', team: 'Pieces', assignee: 'sanket',
      status: 'In Progress', completedAt: null },
  ],
};

const GITHUB = {
  mergedEvents: [
    { d: '2026-07-27', p: 'kishan', kind: 'pieces' },
    { d: '2026-07-28', p: 'kishan', kind: 'platform' },
    { d: '2026-07-31', p: 'sanket', kind: 'pieces' },
    { d: '2026-07-10', p: 'sanket', kind: 'pieces' },
  ],
  reviews: { kishan: 199, sanket: 120, approx: true,
    weekly: [{ w: '2026-07-20', kishan: 3, sanket: 2 }, { w: '2026-07-27', kishan: 12, sanket: 9 }] },
};

const read = (over = {}) => (name) => ({ 'linear.json': LINEAR, 'github.json': GITHUB, ...over }[name]);

test('counts completions inside the window, per person', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.equal(out.status, 'ok');
  assert.equal(out.total, 4);
  assert.deepEqual(out.byPerson, { kishan: 2, sanket: 2 });
});

test('merged PRs counted per person inside the window', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.prsMerged, { kishan: 2, sanket: 1 });
});

test('reviews come from the weekly bucket keyed by the Monday of the week', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.reviews, { kishan: 12, sanket: 9 });
});

test('a missing weekly review bucket yields zeros, not a crash', () => {
  const gh = { ...GITHUB, reviews: { ...GITHUB.reviews, weekly: [] } };
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read({ 'github.json': gh }), linearRefreshPending: false });
  assert.deepEqual(out.reviews, { kishan: 0, sanket: 0 });
});

test('shipped lists only completed issues inside the window', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: false });
  assert.deepEqual(out.shipped, [
    { id: 'PIE-101', title: 'Add Notion outputSchema', assignee: 'kishan', team: 'Pieces' },
  ]);
});

test('a pending Linear refresh degrades to no-data instead of undercounting', () => {
  const out = collectTickets({ window: WINDOW, weekId: WEEK, readJson: read(), linearRefreshPending: true });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /Linear refresh pending/);
});

test('a missing data file degrades to no-data', () => {
  const out = collectTickets({
    window: WINDOW, weekId: WEEK, linearRefreshPending: false,
    readJson: () => { throw new Error('ENOENT linear.json'); },
  });
  assert.equal(out.status, 'no-data');
  assert.match(out.reason, /ENOENT/);
});

test('an empty week is a real zero, not no-data', () => {
  const out = collectTickets({
    window: { start: '2026-06-06', end: '2026-06-12' }, weekId: '2026-W24',
    readJson: read(), linearRefreshPending: false,
  });
  assert.equal(out.status, 'ok');
  assert.equal(out.total, 0);
  assert.deepEqual(out.byPerson, { kishan: 0, sanket: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-collect-tickets.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/collect/tickets.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/collect/tickets.mjs
// Tickets come from the internal pieces-team dashboard's already-refreshed data
// files, NOT from a fresh Linear query — the Linear MCP is not reachable
// headless, and refresh.sh already solves that. One Linear pipeline, not two.
import { mondayOfWeekId } from '../../lib/isoweek.mjs';

const PEOPLE = ['kishan', 'sanket'];
const zeroed = () => Object.fromEntries(PEOPLE.map((p) => [p, 0]));
const inWindow = (day, { start, end }) => Boolean(day) && day >= start && day <= end;

export function collectTickets({ window, weekId, readJson, linearRefreshPending }) {
  if (linearRefreshPending) {
    return { status: 'no-data', reason: 'Linear refresh pending — internal dashboard wrote NEEDS-LINEAR-REFRESH' };
  }
  try {
    const linear = readJson('linear.json');
    const github = readJson('github.json');
    if (!Array.isArray(linear?.events)) throw new Error('linear.json has no `events` array');
    if (!Array.isArray(github?.mergedEvents)) throw new Error('github.json has no `mergedEvents` array');

    const byPerson = zeroed();
    for (const e of linear.events) {
      if (inWindow(e.d, window) && e.p in byPerson) byPerson[e.p] += 1;
    }

    const prsMerged = zeroed();
    for (const e of github.mergedEvents) {
      if (inWindow(e.d, window) && e.p in prsMerged) prsMerged[e.p] += 1;
    }

    const monday = mondayOfWeekId(weekId);
    const bucket = (github.reviews?.weekly ?? []).find((w) => w.w === monday);
    const reviews = Object.fromEntries(PEOPLE.map((p) => [p, Number(bucket?.[p] ?? 0)]));

    const shipped = (linear.recent ?? [])
      .filter((i) => inWindow(i.completedAt?.slice(0, 10), window))
      .map(({ id, title, assignee, team }) => ({ id, title, assignee, team }));

    return {
      status: 'ok',
      total: PEOPLE.reduce((sum, p) => sum + byPerson[p], 0),
      byPerson, prsMerged, reviews, shipped,
    };
  } catch (err) {
    return { status: 'no-data', reason: `internal dashboard data unavailable (${err.message})` };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-collect-tickets.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
git add weekly/collect/tickets.mjs test/weekly-collect-tickets.test.mjs
git commit -m "feat(weekly): tickets collector over internal dashboard data"
```

---

### Task 7: `snapshot.mjs` — the local append CLI

**Files:**
- Create: `weekly/snapshot.mjs`
- Test: `test/weekly-snapshot.test.mjs`

**Interfaces:**
- Consumes:
  - `lib/isoweek.mjs`: `latestCompleteWeek`, `windowForWeekId`
  - `weekly/lib/archive.mjs`: `readArchive`, `appendWeek`, `writeArchive`
  - `weekly/collect/*.mjs`: `collectOutputSchema`, `collectAiActions`, `collectTesting`, `collectTickets`
- Produces:
  - `buildSnapshot({weekId, today, collectors}): object` — a complete, validated snapshot. `collectors` is `{outputSchema, aiActions, testing, tickets}`, each a zero-arg-from-caller thunk already bound to its window.
  - `deriveDecisions(snap): string[]` — the "needs a decision" lines
  - `main(argv): void` — CLI: `--week=<id>` (default `latestCompleteWeek(today)`), `--force-week`, `--today=<YYYY-MM-DD>`

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-snapshot.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, deriveDecisions } from '../weekly/snapshot.mjs';
import { validateSnapshot } from '../weekly/lib/archive.mjs';

const collectors = (over = {}) => ({
  outputSchema: () => ({ status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 }),
  aiActions: () => ({ status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 }),
  testing: () => ({ status: 'ok', prsMerged: 1, commits: 4, shipped: [] }),
  tickets: () => ({ status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
                    prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] }),
  ...over,
});

test('buildSnapshot stamps the week, its Sat→Fri window, and builtAt', () => {
  const snap = buildSnapshot({ weekId: '2026-W31', today: '2026-08-01', collectors: collectors() });
  assert.equal(snap.week, '2026-W31');
  assert.equal(snap.start, '2026-07-25');
  assert.equal(snap.end, '2026-07-31');
  assert.equal(snap.builtAt, '2026-08-01');
});

test('buildSnapshot output passes schema validation', () =>
  validateSnapshot(buildSnapshot({ weekId: '2026-W31', today: '2026-08-01', collectors: collectors() })));

test('a throwing collector becomes no-data rather than aborting the snapshot', () => {
  const snap = buildSnapshot({
    weekId: '2026-W31', today: '2026-08-01',
    collectors: collectors({ testing: () => { throw new Error('gh exploded'); } }),
  });
  assert.equal(snap.testing.status, 'no-data');
  assert.match(snap.testing.reason, /gh exploded/);
  assert.equal(snap.outputSchema.status, 'ok');   // the others still land
  validateSnapshot(snap);
});

test('deriveDecisions flags merged-but-not-live outputSchema pieces', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 6, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    tickets: { status: 'ok' }, testing: { status: 'ok' },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /6 outputSchema pieces merged but not cloud-live/);
});

test('deriveDecisions flags a degraded workstream', () => {
  const lines = deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    testing: { status: 'ok' },
    tickets: { status: 'no-data', reason: 'Linear refresh pending' },
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /tickets.*Linear refresh pending/);
});

test('a clean week produces no decision lines', () => {
  assert.deepEqual(deriveDecisions({
    outputSchema: { status: 'ok', mergedNotLive: 0, review: 0 },
    aiActions: { status: 'ok', prOpen: 0, blockersOpen: 0 },
    testing: { status: 'ok' }, tickets: { status: 'ok' },
  }), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-snapshot.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/snapshot.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
#!/usr/bin/env node
// weekly/snapshot.mjs
// LOCAL ONLY. Appends one immutable week to weekly/data/weeks.json, which is
// committed. CI must never run this: CI rebuilds daily, so recomputing here
// would rewrite history. CI only runs weekly/build.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { latestCompleteWeek, windowForWeekId } from '../lib/isoweek.mjs';
import { readArchive, appendWeek, writeArchive } from './lib/archive.mjs';
import { collectOutputSchema } from './collect/output-schema.mjs';
import { collectAiActions } from './collect/ai-actions.mjs';
import { collectTesting } from './collect/testing.mjs';
import { collectTickets } from './collect/tickets.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = join(ROOT, 'weekly/data/weeks.json');
const TEAM_DASHBOARD = process.env.PIECES_TEAM_DASHBOARD
  ?? '/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard';

const WORKSTREAMS = ['outputSchema', 'aiActions', 'testing', 'tickets'];

export function buildSnapshot({ weekId, today, collectors }) {
  const { start, end } = windowForWeekId(weekId);
  const snap = { week: weekId, start, end, builtAt: today };
  for (const key of WORKSTREAMS) {
    try {
      snap[key] = collectors[key]();
    } catch (err) {
      // A collector that throws instead of degrading must not lose the other three.
      snap[key] = { status: 'no-data', reason: `${key} collector threw (${err.message})` };
    }
  }
  snap.decisions = deriveDecisions(snap);
  return snap;
}

export function deriveDecisions(snap) {
  const lines = [];
  const os = snap.outputSchema;
  if (os?.status === 'ok' && os.mergedNotLive > 0) {
    lines.push(`${os.mergedNotLive} outputSchema pieces merged but not cloud-live — needs a cloud release`);
  }
  if (os?.status === 'ok' && os.review > 0) {
    lines.push(`${os.review} outputSchema PRs awaiting review`);
  }
  const ai = snap.aiActions;
  if (ai?.status === 'ok' && ai.blockersOpen > 0) {
    lines.push(`${ai.blockersOpen} AI-actions blockers still open`);
  }
  for (const key of WORKSTREAMS) {
    if (snap[key]?.status === 'no-data') lines.push(`${key}: no data — ${snap[key].reason}`);
  }
  return lines;
}

function main(argv) {
  const arg = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const today = arg('today') ?? new Date().toISOString().slice(0, 10);
  const weekId = arg('week') ?? latestCompleteWeek(today);
  const force = argv.includes('--force-week');
  const window = windowForWeekId(weekId);

  const readRepoJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  const readTeamJson = (name) => JSON.parse(readFileSync(join(TEAM_DASHBOARD, 'data', name), 'utf8'));
  const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

  const snap = buildSnapshot({
    weekId, today,
    collectors: {
      outputSchema: () => collectOutputSchema({ readJson: readRepoJson }),
      aiActions: () => collectAiActions({ readJson: readRepoJson }),
      testing: () => collectTesting({ window, gh }),
      tickets: () => collectTickets({
        window, weekId, readJson: readTeamJson,
        linearRefreshPending: existsSync(join(TEAM_DASHBOARD, 'NEEDS-LINEAR-REFRESH')),
      }),
    },
  });

  writeArchive(ARCHIVE, appendWeek(readArchive(ARCHIVE), snap, { force }));
  const degraded = WORKSTREAMS.filter((k) => snap[k].status === 'no-data');
  console.log(`✓ snapshot ${weekId} (${snap.start}→${snap.end}) appended`);
  if (degraded.length) console.warn(`⚠ degraded: ${degraded.join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-snapshot.test.mjs`
Expected: PASS — 6 tests

- [ ] **Step 5: Dry-run against real local data**

Run:
```bash
npm run fetch && npm run build
node weekly/snapshot.mjs --today=2026-08-01
cat weekly/data/weeks.json
```
Expected: `✓ snapshot 2026-W31 (2026-07-25→2026-07-31) appended`, and `weeks.json` holds one snapshot. If `tickets` is `no-data` with "Linear refresh pending", that is correct behaviour — the internal dashboard has not been refreshed yet.

Then confirm immutability:
```bash
node weekly/snapshot.mjs --today=2026-08-01          # expect: throws "already exists"
node weekly/snapshot.mjs --today=2026-08-01 --force-week   # expect: succeeds
```

- [ ] **Step 6: Commit**

```bash
git add weekly/snapshot.mjs weekly/data/weeks.json test/weekly-snapshot.test.mjs
git commit -m "feat(weekly): local snapshot CLI with immutable append"
```

---

### Task 8: View model

**Files:**
- Create: `weekly/lib/view.mjs`
- Test: `test/weekly-view.test.mjs`

**Interfaces:**
- Consumes: `lib/isoweek.mjs` (`latestCompleteWeek`), `weekly/lib/deltas.mjs` (`pick`, `deltaFor`, `seriesFor`), `weekly/collect/testing.mjs` (`TESTING_NOTE`).
- Produces:
  - `buildView(archive: {weeks}, opts?: {weekId?: string, today?: string}): object`

```javascript
{
  week: '2026-W31', start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  label: 'Week 31 · Jul 25 – Jul 31, 2026',
  weeks: ['2026-W31', '2026-W30'],                 // newest first, for the picker
  tiles: [ { key: 'outputSchema', title: 'outputSchema', status: 'ok',
             value: 9, unit: 'of 756 live', delta: 2, note: '6 merged, awaiting cloud release',
             spark: [{week, value}] } ],           // always 4 tiles, in fixed order
  people: [ { key: 'kishan', name: 'Kishan', tickets: 5, prsMerged: 3, reviews: 12 } ],
  shipped: { tickets: [...], testing: [...] },
  decisions: [...],
}
```
  - Tile order is fixed: `outputSchema`, `aiActions`, `testing`, `tickets`.
  - A `no-data` workstream yields `{status: 'no-data', reason, value: null, delta: null, spark: []}`.
  - `buildView` on an empty archive returns `{empty: true, weeks: []}`.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-view.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../weekly/lib/view.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [{ number: 5, title: 't', url: 'u' }] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 },
             shipped: [{ id: 'PIE-101', title: 'x', assignee: 'kishan', team: 'Pieces' }] },
  decisions: ['6 outputSchema pieces merged but not cloud-live'],
  ...over,
});

const archive = { weeks: [snap('2026-W30', { outputSchema: { status: 'ok', live: 7, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 } }), snap('2026-W31')] };

test('defaults to the newest week in the archive', () =>
  assert.equal(buildView(archive).week, '2026-W31'));

test('an explicit weekId wins', () =>
  assert.equal(buildView(archive, { weekId: '2026-W30' }).week, '2026-W30'));

test('an unknown weekId falls back to the newest', () =>
  assert.equal(buildView(archive, { weekId: '1999-W01' }).week, '2026-W31'));

test('an empty archive is flagged rather than crashing', () =>
  assert.deepEqual(buildView({ weeks: [] }), { empty: true, weeks: [] }));

test('picker lists weeks newest first', () =>
  assert.deepEqual(buildView(archive).weeks, ['2026-W31', '2026-W30']));

test('always four tiles in fixed order', () =>
  assert.deepEqual(buildView(archive).tiles.map((t) => t.key),
    ['outputSchema', 'aiActions', 'testing', 'tickets']));

test('outputSchema tile carries value, delta and sparkline', () => {
  const tile = buildView(archive).tiles[0];
  assert.equal(tile.value, 9);
  assert.equal(tile.delta, 2);
  assert.deepEqual(tile.spark, [{ week: '2026-W30', value: 7 }, { week: '2026-W31', value: 9 }]);
});

test('a no-data workstream produces a no-data tile, not a zero', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear pending' } })] };
  const tile = buildView(a).tiles.find((t) => t.key === 'tickets');
  assert.equal(tile.status, 'no-data');
  assert.equal(tile.value, null);
  assert.equal(tile.delta, null);
  assert.deepEqual(tile.spark, []);
  assert.match(tile.reason, /Linear pending/);
});

test('the testing tile carries the build-progress caveat', () =>
  assert.match(buildView(archive).tiles.find((t) => t.key === 'testing').note, /health/i));

test('people rows come from the tickets workstream', () =>
  assert.deepEqual(buildView(archive).people, [
    { key: 'kishan', name: 'Kishan', tickets: 5, prsMerged: 3, reviews: 12 },
    { key: 'sanket', name: 'Sanket', tickets: 6, prsMerged: 4, reviews: 9 },
  ]));

test('people is empty when tickets is no-data', () => {
  const a = { weeks: [snap('2026-W31', { tickets: { status: 'no-data', reason: 'x' } })] };
  assert.deepEqual(buildView(a).people, []);
});

test('label reads as a human date range', () =>
  assert.equal(buildView(archive).label, 'Week 31 · Jul 25 – Jul 31, 2026'));

test('shipped is split by source', () => {
  const v = buildView(archive);
  assert.equal(v.shipped.tickets.length, 1);
  assert.equal(v.shipped.testing.length, 1);
});

test('decisions pass through', () =>
  assert.match(buildView(archive).decisions[0], /cloud-live/));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-view.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/lib/view.mjs'`

- [ ] **Step 3: Write minimal implementation**

```javascript
// weekly/lib/view.mjs
// Pure: archive + selected week → everything the template renders. No I/O, so
// the whole page shape is unit-testable.
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

export function buildView(archive, { weekId, today } = {}) {
  const weeks = archive?.weeks ?? [];
  if (!weeks.length) return { empty: true, weeks: [] };

  const selected = weeks.find((w) => w.week === weekId) ?? weeks[weeks.length - 1];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/weekly-view.test.mjs`
Expected: PASS — 14 tests

- [ ] **Step 5: Commit**

```bash
git add weekly/lib/view.mjs test/weekly-view.test.mjs
git commit -m "feat(weekly): render view model with no-data-safe tiles"
```

---

### Task 9: Template and render build

**Files:**
- Create: `weekly/template.html`
- Create: `weekly/build.mjs`
- Test: `test/weekly-render.test.mjs`

**Interfaces:**
- Consumes: `lib/render.mjs` (`renderPage`), `weekly/lib/archive.mjs` (`readArchive`), `weekly/lib/view.mjs` (`buildView`), `shared/theme.css`.
- Produces: `dist/weekly/index.html` and `dist/weekly/summary.json`. Exports `buildAll({archiveDir, outDir}): {html: string}` for testability.

**REQUIRED SUB-SKILL for this task:** invoke the `dataviz` skill before writing any tile or sparkline styling. Do not pick chart colors freehand — reuse the CSS custom properties already in `shared/theme.css` (`--surface-1`, `--border`, `--text-primary`, `--text-secondary`, `--text-muted`, `--good-text`, `--sev-high`, `--s-live`, `--s-merged`, `--s-review`, `--s-todo`, `--st-assigned`, `--grid`, `--baseline`, `--page`).

**Template contract:** `renderPage` throws unless the template contains BOTH `/*__THEME__*/` and `/*__DATA__*/null`. The whole archive is embedded so week switching is client-side; the page re-renders from `WEEKS` on hashchange.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-render.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAll } from '../weekly/build.mjs';

const snap = (week, over = {}) => ({
  week, start: '2026-07-25', end: '2026-07-31', builtAt: '2026-08-01',
  outputSchema: { status: 'ok', live: 9, mergedNotLive: 6, review: 8, todo: 733, totalPieces: 756 },
  aiActions: { status: 'ok', merged: 2, prOpen: 24, assigned: 0, held: 2, totalPieces: 28, blockersOpen: 30 },
  testing: { status: 'ok', prsMerged: 1, commits: 4, shipped: [] },
  tickets: { status: 'ok', total: 11, byPerson: { kishan: 5, sanket: 6 },
             prsMerged: { kishan: 3, sanket: 4 }, reviews: { kishan: 12, sanket: 9 }, shipped: [] },
  decisions: [], ...over,
});

function render(weeks) {
  const dir = mkdtempSync(join(tmpdir(), 'weekly-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data/weeks.json'), JSON.stringify({ weeks }));
  const outDir = join(dir, 'out');
  const { html } = buildAll({ archiveDir: join(dir, 'data'), outDir });
  return { html, outDir };
}

test('renders an HTML document', () => {
  const { html } = render([snap('2026-W31')]);
  assert.match(html, /<!doctype html>/i);
});

test('inlines the theme — no unresolved markers survive', () => {
  const { html } = render([snap('2026-W31')]);
  assert.doesNotMatch(html, /__THEME__/);
  assert.doesNotMatch(html, /__DATA__/);
});

test('embeds every week so switching needs no network', () => {
  const { html } = render([snap('2026-W30'), snap('2026-W31')]);
  assert.match(html, /2026-W30/);
  assert.match(html, /2026-W31/);
});

test('writes summary.json for the selected week', () => {
  const { outDir } = render([snap('2026-W31')]);
  const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf8'));
  assert.equal(summary.week, '2026-W31');
  assert.equal(summary.tiles.length, 4);
});

test('an empty archive renders a placeholder rather than throwing', () => {
  const { html } = render([]);
  assert.match(html, /No weeks recorded yet/i);
});

test('a no-data tile renders its reason text', () => {
  const { html } = render([snap('2026-W31', { tickets: { status: 'no-data', reason: 'Linear refresh pending' } })]);
  assert.match(html, /Linear refresh pending/);
});

test('decisions render when present', () => {
  const { html } = render([snap('2026-W31', { decisions: ['6 pieces await a cloud release'] })]);
  assert.match(html, /6 pieces await a cloud release/);
});

test('script-closing sequences in data cannot break out of the script tag', () => {
  const { html } = render([snap('2026-W31', { decisions: ['</script><img onerror=x>'] })]);
  assert.doesNotMatch(html, /<\/script><img/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-render.test.mjs`
Expected: FAIL — `Cannot find module '../weekly/build.mjs'`

- [ ] **Step 3: Write the template**

```html
<!-- weekly/template.html -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pieces Team — Weekly Progress</title>
<style>/*__THEME__*/</style>
<style>
  body { background: var(--page); color: var(--text-primary); margin: 0;
         font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif; }
  .wrap { max-width: 940px; margin: 0 auto; padding: 32px 20px 64px; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--text-secondary); font-size: 13px; }
  .nav { display: flex; gap: 6px; align-items: center; }
  .nav button, .nav select { background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 6px; padding: 4px 9px; font: inherit; font-size: 13px; cursor: pointer; }
  .nav button[disabled] { opacity: .4; cursor: default; }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 22px 0; }
  @media (max-width: 640px) { .tiles { grid-template-columns: 1fr; } }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; }
  .tile h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
             color: var(--text-muted); margin: 0 0 10px; font-weight: 600; }
  .big { font-size: 34px; font-weight: 650; line-height: 1; letter-spacing: -0.02em; }
  .unit { color: var(--text-secondary); font-size: 13px; margin-left: 6px; }
  .delta { font-size: 12px; font-weight: 600; padding: 2px 7px; border-radius: 999px;
           border: 1px solid var(--border); margin-left: 8px; vertical-align: 3px; }
  .delta.up { color: var(--good-text); } .delta.down { color: var(--sev-high); }
  .delta.flat { color: var(--text-muted); }
  .note { color: var(--text-secondary); font-size: 12.5px; margin-top: 10px; }
  .nodata { color: var(--text-muted); font-size: 13px; font-style: italic; }
  svg.spark { display: block; margin-top: 12px; overflow: visible; }
  .band { border: 1px solid var(--sev-high); border-radius: 10px; padding: 14px 18px; margin: 22px 0; }
  .band h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin: 0 0 8px; color: var(--sev-high); }
  .band ul { margin: 0; padding-left: 18px; } .band li { margin: 3px 0; font-size: 13.5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 13.5px; }
  th { text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em;
       color: var(--text-muted); font-weight: 600; padding: 6px 10px 6px 0; border-bottom: 1px solid var(--border); }
  td { padding: 7px 10px 7px 0; border-bottom: 1px solid var(--border); }
  td.n { font-variant-numeric: tabular-nums; }
  section h2.sec { font-size: 12px; text-transform: uppercase; letter-spacing: .06em;
                   color: var(--text-muted); margin: 26px 0 0; font-weight: 600; }
  a { color: inherit; }
  footer { margin-top: 34px; font-size: 12.5px; color: var(--text-muted); }
</style>
</head>
<body>
<div class="wrap" id="app"></div>
<script>
const ARCHIVE = /*__DATA__*/null;
</script>
<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function sparkSvg(points) {
  const vals = points.map((p) => p.value).filter((v) => typeof v === 'number');
  if (vals.length < 2) return '';
  const w = 132, h = 30, min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = points.map((p, i) => [i * step, p.value === null ? null : h - ((p.value - min) / span) * h]);
  let d = '', open = false;
  for (const [x, y] of xy) {
    if (y === null) { open = false; continue; }
    d += `${open ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    open = true;
  }
  const last = xy.filter(([, y]) => y !== null).pop();
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path d="${d.trim()}" fill="none" stroke="var(--s-live)" stroke-width="1.75"
          stroke-linecap="round" stroke-linejoin="round"/>
    ${last ? `<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="var(--s-live)"/>` : ''}
  </svg>`;
}

function deltaHtml(d) {
  if (d === null || d === undefined) return '<span class="delta flat" title="no prior week to compare">—</span>';
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const sign = d > 0 ? '+' : '';
  return `<span class="delta ${cls}">${sign}${d} vs prior week</span>`;
}

function tileHtml(t) {
  if (t.status !== 'ok') {
    return `<div class="tile"><h2>${esc(t.title)}</h2>
      <div class="nodata">No data — ${esc(t.reason)}</div></div>`;
  }
  return `<div class="tile"><h2>${esc(t.title)}</h2>
    <div><span class="big">${t.value}</span><span class="unit">${esc(t.unit)}</span>${deltaHtml(t.delta)}</div>
    ${sparkSvg(t.spark)}
    <div class="note">${esc(t.note)}</div></div>`;
}

function render(view) {
  const app = document.getElementById('app');
  if (view.empty) {
    app.innerHTML = '<h1>Pieces Team — Weekly Progress</h1><p class="sub">No weeks recorded yet.</p>';
    return;
  }
  const idx = view.weeks.indexOf(view.week);
  const options = view.weeks.map((w) => `<option value="${w}"${w === view.week ? ' selected' : ''}>${w}</option>`).join('');
  app.innerHTML = `
    <header>
      <div><h1>Pieces Team — Weekly Progress</h1>
        <div class="sub">${esc(view.label)} · 7 days ending Friday · built ${esc(view.builtAt)}</div></div>
      <div class="nav">
        <button id="prev" ${idx === view.weeks.length - 1 ? 'disabled' : ''} aria-label="Previous week">←</button>
        <select id="pick" aria-label="Select week">${options}</select>
        <button id="next" ${idx === 0 ? 'disabled' : ''} aria-label="Next week">→</button>
      </div>
    </header>
    <div class="tiles">${view.tiles.map(tileHtml).join('')}</div>
    ${view.decisions.length ? `<div class="band"><h2>Needs a decision</h2><ul>${
      view.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>` : ''}
    ${view.people.length ? `<section><h2 class="sec">Per person</h2><table>
      <tr><th>Engineer</th><th>Tickets</th><th>PRs merged</th><th>Reviews</th></tr>
      ${view.people.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.tickets}</td>
        <td class="n">${p.prsMerged}</td><td class="n">${p.reviews}</td></tr>`).join('')}
      </table></section>` : ''}
    ${(view.shipped.tickets.length || view.shipped.testing.length) ? `<section><h2 class="sec">Shipped this week</h2><table>
      ${view.shipped.tickets.map((i) => `<tr><td>${esc(i.id)}</td><td>${esc(i.title)}</td>
        <td>${esc(i.assignee ?? '')}</td></tr>`).join('')}
      ${view.shipped.testing.map((i) => `<tr><td>tester #${i.number}</td>
        <td><a href="${esc(i.url)}">${esc(i.title)}</a></td><td></td></tr>`).join('')}
      </table></section>` : ''}
    <footer>Full detail: <a href="../output-schema/">outputSchema</a> ·
      <a href="../ai-actions/">AI-actions</a> · <a href="../">overview</a></footer>`;

  document.getElementById('pick').onchange = (e) => { location.hash = e.target.value; };
  document.getElementById('prev').onclick = () => { location.hash = view.weeks[idx + 1]; };
  document.getElementById('next').onclick = () => { location.hash = view.weeks[idx - 1]; };
}

// The view is precomputed server-side per week, so switching is a lookup.
const draw = () => render(ARCHIVE.views[location.hash.slice(1)] ?? ARCHIVE.views[ARCHIVE.default]);
addEventListener('hashchange', draw);
draw();
</script>
</body>
</html>
```

- [ ] **Step 4: Write the build script**

```javascript
#!/usr/bin/env node
// weekly/build.mjs
// CI-safe: pure render of the committed archive. Fetches nothing and never
// writes weeks.json — snapshots are appended locally by weekly/snapshot.mjs.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../lib/render.mjs';
import { readArchive } from './lib/archive.mjs';
import { buildView } from './lib/view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function buildAll({ archiveDir = join(HERE, 'data'), outDir = join(HERE, '../dist/weekly') } = {}) {
  const archive = readArchive(join(archiveDir, 'weeks.json'));
  // Precompute one view per week so the client only ever does a lookup.
  const views = {};
  for (const w of archive.weeks) views[w.week] = buildView(archive, { weekId: w.week });
  const latest = archive.weeks.at(-1)?.week ?? null;
  const data = latest ? { views, default: latest } : { views: {}, default: null };

  const html = renderPage({
    templatePath: join(HERE, 'template.html'),
    themePath: join(HERE, '../shared/theme.css'),
    data,
    outPath: join(outDir, 'index.html'),
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'),
    `${JSON.stringify(latest ? views[latest] : { empty: true, weeks: [] }, null, 2)}\n`);
  return { html, views, latest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { latest } = buildAll();
  console.log(`✓ weekly built${latest ? ` (default ${latest})` : ' (empty archive)'}`);
}
```

> The empty-archive path must still satisfy the test `'an empty archive renders a placeholder'`. `buildView({weeks: []})` returns `{empty: true}`, and the template's `draw()` falls back to `ARCHIVE.views[null]` → `undefined`. Fix by making `draw()` resolve to `{empty: true, weeks: []}` when the lookup misses:
> ```javascript
> const draw = () => render(ARCHIVE.views[location.hash.slice(1)] ?? ARCHIVE.views[ARCHIVE.default] ?? { empty: true, weeks: [] });
> ```
> Apply that line in the template before running the tests.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/weekly-render.test.mjs`
Expected: PASS — 8 tests

- [ ] **Step 6: Eyeball the real page**

Run:
```bash
node weekly/build.mjs && python3 -m http.server 8765 --directory dist
```
Open `http://localhost:8765/weekly/`. Confirm: tiles legible at a glance, deltas readable, week picker switches without a reload, `#2026-W31` deep-link works, layout collapses to one column under 640px. Kill the server when done.

- [ ] **Step 7: Commit**

```bash
git add weekly/template.html weekly/build.mjs test/weekly-render.test.mjs
git commit -m "feat(weekly): weekly page template + CI render"
```

---

### Task 10: Wire into the repo build and navigation

**Files:**
- Modify: `package.json` (the `scripts` block)
- Modify: `site/template.html` (add a nav link to `weekly/`)
- Modify: `README.md` (document the weekly page + the local/CI split)
- Test: `test/weekly-wiring.test.mjs`

**Interfaces:**
- Consumes: `weekly/build.mjs` (`buildAll`).
- Produces: `npm run build` also builds `dist/weekly/`; `npm run snapshot` runs the local CLI.

**Note:** `.github/workflows/deploy.yml` needs **no change** — it already runs `npm test` then `npm run build` then uploads `dist/`. Adding `weekly/build.mjs` to the `build` script is sufficient. Do not add a fetch step for the weekly page; it must stay a pure render.

- [ ] **Step 1: Write the failing test**

```javascript
// test/weekly-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('npm run build builds the weekly page last', () => {
  assert.match(pkg.scripts.build, /weekly\/build\.mjs/);
  assert.ok(pkg.scripts.build.indexOf('site/build.mjs') < pkg.scripts.build.indexOf('weekly/build.mjs'),
    'weekly must build after site so dist/ layout is settled');
});

test('a snapshot script exists for the local job', () =>
  assert.match(pkg.scripts.snapshot, /weekly\/snapshot\.mjs/));

test('the build script never invokes snapshot.mjs — CI must not mutate history', () =>
  assert.doesNotMatch(pkg.scripts.build, /snapshot/));

test('the landing page links to the weekly page', () => {
  const tpl = readFileSync(new URL('../site/template.html', import.meta.url), 'utf8');
  assert.match(tpl, /weekly\//);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/weekly-wiring.test.mjs`
Expected: FAIL — `pkg.scripts.build` has no `weekly/build.mjs`

- [ ] **Step 3: Update package.json**

Replace the `scripts` block with:

```json
  "scripts": {
    "fetch": "bash scripts/fetch-cloud.sh && node scripts/fetch-pr-states.mjs",
    "fetch:prs": "node scripts/fetch-pr-states.mjs",
    "test": "node --test",
    "build": "node output-schema/build.mjs && node ai-actions/build.mjs && node site/build.mjs && node weekly/build.mjs",
    "snapshot": "node weekly/snapshot.mjs"
  },
```

- [ ] **Step 4: Add the landing-page link**

In `site/template.html`, add a link to the weekly page alongside the existing workstream links. Read the file first and match its existing markup and class names exactly — do not introduce new styling. The link target is `weekly/` and the label is `Weekly progress`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/weekly-wiring.test.mjs`
Expected: PASS — 4 tests

- [ ] **Step 6: Run the whole suite and a full build**

Run: `npm test && npm run build`
Expected: all tests pass; `dist/weekly/index.html` and `dist/weekly/summary.json` exist.

- [ ] **Step 7: Document it in README.md**

Add a section stating: the weekly page lives at `/weekly/`; snapshots are appended **locally** by `npm run snapshot` (Saturday job) and committed; CI only renders; `weeks.json` is append-only and past weeks are immutable without `--force-week`; the week window is the 7 days ending Friday.

- [ ] **Step 8: Commit**

```bash
git add package.json site/template.html README.md test/weekly-wiring.test.mjs
git commit -m "feat(weekly): wire weekly page into build, nav and docs"
```

---

### Task 11: The Saturday job

**Files:**
- Create: `refresh-weekly.sh`
- Test: manual (documented below) — a shell orchestration script, exercised end to end rather than unit-tested

**Interfaces:**
- Consumes: `npm run fetch`, `npm run build`, `npm run snapshot`, the internal dashboard's `refresh.sh`.
- Produces: an appended + committed + pushed snapshot; CI deploys from the push.

**Context:** this replaces the existing Monday 09:00 internal-dashboard cron. One schedule, one pipeline. The internal refresh must run first because the tickets collector reads its output.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# refresh-weekly.sh — the single Saturday job (09:00 +03).
#
# Order matters: the tickets collector reads the internal dashboard's data
# files, and the outputSchema/AI-actions collectors read dist/, which is
# gitignored and therefore absent until a local build runs.
set -euo pipefail

DASHBOARD="${PIECES_TEAM_DASHBOARD:-/home/ibrahim/AP_work/Activepieces_v/pieces-team/dashboard}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TODAY="$(date +%F)"

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

log "1/4 internal dashboard refresh (Linear + GitHub)"
# Non-fatal: if the Linear half fails it writes NEEDS-LINEAR-REFRESH, and the
# tickets collector degrades to no-data rather than reporting a false zero.
bash "$DASHBOARD/refresh.sh" || log "WARN internal refresh failed — tickets will degrade to no-data"

log "2/4 fetch + build this repo (populates dist/*/summary.json)"
cd "$REPO"
npm run fetch
npm run build

log "3/4 append the completed week"
node weekly/snapshot.mjs --today="$TODAY"

log "4/4 commit + push (CI renders and deploys)"
if git diff --quiet -- weekly/data/weeks.json; then
  log "no archive change — nothing to push"
else
  git add weekly/data/weeks.json
  git commit -m "chore(weekly): snapshot week ending $TODAY"
  git push
  log "pushed — GitHub Pages deploy will pick it up"
fi
```

- [ ] **Step 2: Make it executable and dry-run it**

Run:
```bash
chmod +x refresh-weekly.sh
./refresh-weekly.sh
```
Expected: four log stages, a new week in `weekly/data/weeks.json`, one commit, one push. If the week already exists it fails at stage 3 with "already exists" — that is correct; use `node weekly/snapshot.mjs --force-week` deliberately if you meant to replace it.

- [ ] **Step 3: Verify it is idempotent within a week**

Run: `./refresh-weekly.sh`
Expected: stage 3 fails with `already exists`. Confirm `weeks.json` is unchanged and no second commit was made.

- [ ] **Step 4: Install the cron, retiring the Monday job**

Run `crontab -l` first and record the existing Monday entry. Then replace it so only the Saturday job remains:

```cron
0 9 * * 6 cd /home/ibrahim/AP_work/Activepieces_v/pieces-dashboard && ./refresh-weekly.sh >> refresh-weekly.log 2>&1
```

Confirm with `crontab -l` that the old Monday `pieces-team/dashboard` entry is gone and the Saturday entry is present.

- [ ] **Step 5: Add the log to .gitignore**

Append `refresh-weekly.log` to `.gitignore`.

- [ ] **Step 6: Commit**

```bash
git add refresh-weekly.sh .gitignore
git commit -m "feat(weekly): Saturday refresh job, replacing the Monday cron"
```

- [ ] **Step 7: Confirm the deploy**

Run: `gh run list --limit 3`
Expected: a `Refresh & deploy` run triggered by the push, concluding `success`. Then open
`https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/` and confirm the live page shows the week.

---

## Self-Review

**Spec coverage**

| Spec requirement | Task |
|---|---|
| One permalink, defaults to newest completed week | 8 (`buildView` default), 9 (template) |
| Week navigation + deep-link `#2026-W31` | 9 |
| Snapshot write local / render in CI | 7 (snapshot), 9 (build), 10 (wiring guard test) |
| Frozen snapshots, immutability, `--force-week` | 2, 7 |
| outputSchema + AI-actions collectors | 4 |
| Testing collector (build progress + caveat) | 5 |
| Tickets from internal dashboard, incl. `NEEDS-LINEAR-REFRESH` | 6 |
| Four tiles, Δ badge, 6-week sparkline, so-what line | 8, 9 |
| "Needs a decision" band, renders only when non-empty | 7 (`deriveDecisions`), 9 |
| Per-person strip (published, per decision) | 6, 8, 9 |
| "Shipped this week" with links | 6, 5, 9 |
| Failed collector → "no data" + reason, never a zero | 2, 4, 5, 6, 7, 8, 9 |
| Deltas only with a prior snapshot | 3 |
| Schema-validated, fail loud | 2 |
| `renderPage` + `shared/theme.css` | 9 |
| `dataviz` skill for tiles/sparklines | 9 (required sub-skill) |
| Saturday job replacing Monday cron | 11 |
| `dist/` gitignored → build before snapshot | 7 (step 5), 11 (stage 2) |

**Deviation from the spec, deliberate:** the spec says the window is Mon–Fri. A strict Mon–Fri window silently drops all weekend activity from every week, which contradicts the spec's own "never a silent zero" rule; a Mon–Sun window is not closed when the Saturday job runs. The plan uses a **7-day window ending Friday** (Sat→Fri) — lossless, no overlap, closed at build time — and labels it with its literal date range. Update the spec to match.

**Placeholder scan:** no TBD/TODO; every code step carries real code; no "similar to Task N" references. Task 10 step 4 intentionally says "read the file first and match existing markup" because `site/template.html` was not read while planning — that is a read-then-edit instruction with an exact target and label, not a placeholder.

**Type consistency:** `status` is `'ok'|'no-data'` everywhere. Person keys `kishan`/`sanket` in tasks 6, 8. `{start, end}` window object in 1, 5, 6, 7. `mergedNotLive` (camel) maps from `'merged-not-live'` (hyphen) only in task 4, and is camel thereafter. `pick`/`deltaFor`/`seriesFor` signatures identical in 3 and 8. `TESTING_NOTE` exported in 5, imported in 8, asserted in 8 and 9. `buildAll({archiveDir, outDir})` defined in 9, asserted in 9's tests only. `readArchive` returns `{weeks: []}` in 2, relied on in 7 and 9.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-01-weekly-progress-page.md`.
