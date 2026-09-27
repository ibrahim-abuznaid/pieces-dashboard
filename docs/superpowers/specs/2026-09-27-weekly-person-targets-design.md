# Weekly page: per-person weekly targets

**Date:** 2026-09-27 · **Requested by:** Ibrahim · **Status:** approved by Ibrahim (design B, "inside each tile")

## What and why

Ibrahim set weekly per-person targets for the team and wants them tracked on the
public weekly page (`/weekly/`), inside the tile each target belongs to:

| Tile (archive key) | Person | Target / week | Counts |
|---|---|---|---|
| AI-actions (`aiActions`) | Kishan | 20 | pieces |
| AI-actions (`aiActions`) | Odai | 20 | pieces |
| UI improvements (`uiImprovements`) | Talal | 15 | pieces |
| Piece testing (`testing`) | Sanket | 70 | pieces added to the tester |
| Tickets solved (`tickets`) | Kishan | 5 | tickets |
| Tickets solved (`tickets`) | Odai | 5 | tickets |

"Ahmad" in the request is **Odai Ahmad Thalji** (`OdaiAhmed99`), confirmed by Ibrahim.
Named targets go on the **public** page, confirmed by Ibrahim.

## Counting rules

Every piece workstream counts the way the tile's "Done this week" strip already
counts: a piece counts for the week when it is DONE in this week's snapshot and was
NOT done in the immediately-preceding snapshot (same `priorRoster` gap guard, same
folder-then-name identity as `alreadyDone`). Only the credit rule differs.

| Tile | Done means | Credited to |
|---|---|---|
| `aiActions` | stage `merged` or `approved` (the tile's own rule) | author of the PR that shipped the `audience: 'ai'` lines |
| `uiImprovements` | stage `live` or `merged` (the tile's own rule) | author of the PR that shipped the property-UI change |
| `testing` | row present in the coverage roster (≥1 approved plan) | Sanket — the tester is his project and `piece-tester-web` records no per-plan author |
| `tickets` | Linear ticket closed in the window | assignee — `tickets.byPerson`, already recorded |

Consequences, all intended:

- The per-person counts plus the "also" line add up to exactly the pieces the
  tile's "Done this week" strip lists. One diff, one truth.
- A piece counts once, in the week it first became done. An approved PR that merges
  the following week does not count again (it was already done).
- Tester "added" is a SET difference, not a count difference, so the 09-22 reset
  (36 → 8 covered) cannot produce a negative number. A piece lost at a reset and
  re-added later counts again when it is re-added.

### Who wrote the PR

Credit is the PR **author** (GitHub `user.login`), never the assignee — the team's
own attribution rule (assignees and `git -S` both credit the wrong person).

- Rows that carry a `pr` pointer: the author comes from `data/pr-states.json`, which
  gains an `author` field.
- Rows done WITHOUT a pointer — 22 of 58 AI pieces and 15 of 22 UI pieces today,
  because the builds find them on `main`, not in a claim — get their author from a
  new landing scan: `data/landings.json`. `scripts/fetch-pr-states.mjs` lists PRs
  merged into `main` in the last 21 days that touch
  `packages/pieces/community/<slug>/` for exactly those slugs, reads their patches,
  and classifies them with the existing `classifyFiles` rule (lib/discover.mjs). The
  EARLIEST merged PR that adds the rollout's lines for a slug is its landing PR.
- Credit resolution per row: `prStates[row.pr].author` → `landings[rollout][slug].author`
  → none. A row with no author is **not credited**, never guessed.
- Login → person uses a `GITHUB` map in `weekly/collect/people.mjs`
  (`kishan: kishanprmr`, `sanket: sanket-a11y`, `odai: OdaiAhmed99`,
  `talal: Talaljaber` — the handles the internal dashboard's `pull-github.mjs` uses).
  A login outside that map is credited to "others".

The builds publish the resolved login as `author` on each row of
`dist/ai-actions/pieces.json` and `dist/ui-improvements/pieces.json`; the weekly
collectors copy it onto the archived roster row (spread only when present, like
`displayName`). The archive stores the LOGIN, a fact; mapping to a person happens
at render, so a handle fix re-maps history without rewriting it.

## Targets file

`weekly/data/targets.json`, curated, one edit + push:

```json
{
  "from": "2026-W40",
  "targets": {
    "aiActions":      { "kishan": 20, "odai": 20 },
    "uiImprovements": { "talal": 15 },
    "testing":        { "sanket": 70 },
    "tickets":        { "kishan": 5, "odai": 5 }
  }
}
```

- `weekly/snapshot.mjs` copies `targets` into the snapshot as `snap.targets` when the
  week is at or after `from`. The archive keeps the targets in force THAT week, so a
  later change never rewrites history, and no week before `from` ever shows a miss
  for a target that did not exist yet.
- Validated at snapshot time and by `validateSnapshot`: workstream keys must be one of
  the four above, person keys must be in `PEOPLE`, values positive integers. A typo
  stops the snapshot rather than silently dropping a row.
- A missing `targets.json` means no targets; a malformed one fails loudly.

## What the tile shows

Only on tiles whose workstream has targets in the selected snapshot. Between the
number line and the note line:

```
┌─ AI-ACTIONS ─────────────────────────┐
│ 58  of 764 have AI actions  ▲ +29    │
│ Kishan ████████████████░░░░  16/20   │
│ Odai   ███████░░░░░░░░░░░░░   7/20   │
│ also: Talal 2 · 3 others · 1 not credited
│ Done this week  [monday] [asana] …   │
└──────────────────────────────────────┘
```

- One row per targeted person, in `targets.json` order: name, bar, `actual/target`,
  ✓ when `actual >= target`. The bar fill is `min(actual/target, 1)`, so 11/5 is a
  full bar with ✓. Each row is one line, `nowrap`, fixed height — the page's height
  budget (test/weekly-render.test.mjs "one screen") depends on no block growing with
  content.
- The "also" line carries every credit not on a target row: non-targeted team
  members with ≥1 (`Talal 2`), then `N others` (logins outside the team), then
  `N not credited` (no author found). Omitted when empty. It is what makes the rows
  reconcile with the strip.
- On the tickets tile the target rows REPLACE the existing per-person text line, and
  the "also" line lists the remaining people with ≥1. The reconcile guarantee
  (rows + also = `tickets.total`) replaces the old "every person, zeros included"
  line: nothing can be hidden, because the sum is checked.
- **Not measured** — a row reads `Kishan  ░░░░  — / 20 · not measured`, never 0, when:
  there is no legitimate prior roster to diff against (first week, gap, empty or
  degraded prior); for `testing`, either week lacks a coverage roster; for `tickets`,
  `byPerson` is missing or fails the existing personLine sum check. No "also" line
  in that case.
- A degraded tile (status not `ok`) shows no target rows — it already says "not
  measured this week".
- Weeks before W40 carry no `targets` and render exactly as today.

## Components

| Unit | Change |
|---|---|
| `scripts/fetch-pr-states.mjs` | `author` on each PR record; landing scan → `data/landings.json` |
| `lib/discover.mjs` | `discoverLandings(prs)` — earliest-merged PR per slug per rollout, reusing `classifyFiles` |
| `lib/credit.mjs` (new) | `authorOf(row, rollout, prStates, landings)` — the one credit-resolution rule |
| `ai-actions/build.mjs`, `ui-improvements/build.mjs` | publish `author` on dist rows |
| `weekly/collect/ai-actions.mjs`, `ui-improvements.mjs` | carry `author` onto roster rows |
| `weekly/collect/people.mjs` | `GITHUB` handle map + `personOf(login)` |
| `weekly/data/targets.json` (new) | the targets, `from: 2026-W40` |
| `weekly/snapshot.mjs` | read, validate and attach `targets` |
| `weekly/lib/archive.mjs` | validate optional `targets` and optional roster `author` |
| `weekly/lib/landed.mjs` (new) | `priorRoster` / `alreadyDone` moved out of view.mjs + `landedRows()`; pieceStrip and targets share it |
| `weekly/lib/targets.mjs` (new) | pure: snapshot + archive → `{ rows, also }` per tile |
| `weekly/lib/view.mjs` | tiles gain a `targets` field |
| `weekly/template.html` | render rows + "also" line; CSS |

## Error handling

- Landing scan failure (gh down, rate limit): warn and write no landings — rows fall
  back to "not credited". It never fails the fetch, unlike the PR-state fetch, because
  a missing credit is visible on the page and a failed deploy is not.
- `author` absent on old archived rows: not credited. Old weeks have no targets anyway.
- Everything else follows the page's rule: unknown renders as "not measured", never 0.

## Testing

- Unit (node:test, beside the existing 613): `discoverLandings` (earliest wins, other
  rollouts ignored, non-main base ignored); `authorOf` (pointer → landing → none);
  `personOf`; targets validation (bad workstream, unknown person, non-integer, `from`
  gating); `landedRows` (same results pieceStrip had — the existing strip tests must
  pass unchanged); `targets.mjs` (hit, over-target cap, a PR covering two pieces,
  others / not-credited buckets, not-measured cases, rows+also reconcile with the
  strip, tickets reconcile with `total`); view and render tests for the new rows,
  one-line CSS, and no rows before `from`.
- End to end: real `npm run fetch && npm run build`, then a W40 dry-run snapshot into a
  scratch copy of the archive (never the committed `weeks.json`), `weekly/build.mjs`
  against it, and the page checked in the browser, height measured at 1366x768.

## Out of scope

History across weeks (design C). Any change to `piece-tester-web`. Fixing
piece-tester-web #45 (the tester sees 100 of 345 Cloud connections), which likely
caps Sanket's weekly adds regardless of effort — flagged to Ibrahim separately.
