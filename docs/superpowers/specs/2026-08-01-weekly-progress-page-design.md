# Weekly progress page — design

**Date:** 2026-08-01
**Author:** Ibrahim (with Claude)
**Status:** approved, pending implementation plan

## Problem

The Pieces team's progress is spread across four workstreams with no single readable
view: **outputSchema rollout**, **AI-actions coverage**, **piece testing**
(`piece-tester-web`), and **tickets solved**. Leadership has no reliable way to see
what moved in a given week.

Two dashboards exist today and neither answers the question:

- `pieces-dashboard` (this repo, public, GitHub Pages) — outputSchema + AI-actions, but
  it shows *current state*, not *what changed this week*, and has no testing or ticket data.
- `pieces-team/dashboard` (local only) — Linear + GitHub over a rolling 4-month window,
  per-person. Rich, but local, and framed as a trend view rather than a weekly report.

## Audience and delivery model

**Reader:** leadership / founders. Skims in ~30 seconds. Wants headline numbers,
week-over-week movement, and blockers that need a decision. Not a drill-down tool.

**Delivery:** one permanent link, always current. No announcement message, no email.
The page opens on the most recently completed week; the reader can navigate back.
Timeliness is guaranteed by the page being reliably fresh, not by a notification.

**Work week is Monday–Friday. The page updates Saturday.**
Saturday 09:00 +03 is after Friday close in both India (+05:30) and Indonesia (+07/+08).

**Counting window: the 7 days ending Friday** (Sat 00:00 → Fri 23:59), labelled with its
literal date range. A strict Mon–Fri window would silently drop all weekend activity from
every week — contradicting the "never a silent zero" rule below — and a Mon–Sun window is
not yet closed when the Saturday job runs. Sat→Fri is lossless: every day belongs to exactly
one week, and the window is complete at build time. Week id is the ISO week of the ending
Friday, so `2026-W31` covers Jul 25 → Jul 31.

**Data exposure:** per-person numbers are published. This is a deliberate decision —
the page is on a public, Google-indexed URL, and Kishan and Sanket are named on it.
Ibrahim to give them a heads-up before first publish.

## Architecture

### The key constraint

CI (`.github/workflows/deploy.yml`) already runs on push, on `workflow_dispatch`, **and
daily at 06:00 UTC**, regenerating everything from live sources. So the weekly snapshot
archive cannot be computed in CI — a daily rebuild would recompute and mutate past weeks,
destroying the frozen-snapshot guarantee.

This forces a clean split:

| | Where it runs | What it does |
|---|---|---|
| **Snapshot write** | Local, Saturday cron (this machine) | Computes the week that just ended, **appends** to `weekly/data/weeks.json`, commits, pushes |
| **Render** | CI, every run | Reads committed `weeks.json`, emits `dist/weekly/index.html`. Pure and deterministic — fetches nothing, mutates nothing |

A second reason this split is right: the tickets collector reads
`pieces-team/dashboard/data/*.json`, which is outside this repo and unavailable in CI.
Local-only snapshot writing makes that a non-issue rather than a workaround.

### Data sources

| Workstream | Source | Metric |
|---|---|---|
| outputSchema | `dist/output-schema/summary.json` (build output — see Scheduling step 2) | merged / cloud-live / blocked, + Δ vs prior week |
| AI-actions | `dist/ai-actions/summary.json` (build output — see Scheduling step 2) | stage counts (assigned → PR open → merged), + Δ |
| Testing | `gh` on `ibrahim-abuznaid/piece-tester-web` | PRs merged this week, features shipped |
| Tickets solved | `pieces-team/dashboard/data/linear.json` + `github.json` | completed per person, PRs merged, reviews given |

**Tickets reuse the existing internal pipeline rather than querying Linear directly.**
The Linear MCP is not reachable headless; `pieces-team/dashboard/refresh.sh` already
solves this with headless Claude plus a `NEEDS-LINEAR-REFRESH` fallback marker.
Reusing it means one Linear pipeline instead of two that drift.

Consequence: **the weekly snapshot must run after the internal refresh**, on this machine.
Both belong in one Saturday job (see Scheduling).

**Testing metric is build progress, not health.** `piece-tester-web` keeps run results in
a local SQLite DB (`data/piece-tester.db`); `scripts/export-data.cjs` dumps only config
tables (`piece_connections`, `test_plans`, `schedules`, `piece_lessons`), not results. The
useful metric — "47 pieces green, 12 need attention" — needs either a `GET /api/stats`
endpoint on the existing server or a committed `health.json`. **File as a PIE ticket.**
Until then the tile reports merged PRs and shipped features, and says so.

### Snapshot immutability

Each Saturday appends one entry keyed by ISO week (e.g. `2026-W31` = Sat 2026-07-25 →
Fri 2026-07-31). Past entries are never recomputed. Deltas therefore stay honest even when
upstream sources shift under them — a piece that silently drops out of the cloud catalog
does not retroactively rewrite three weeks of history.

`build.mjs` refuses to overwrite an existing week unless `--force-week=<id>` is passed.

### Page structure

Single HTML file, every week embedded as JSON, switched client-side. No routing, no
per-week files, no Pages 404 config. ~2 KB/week → ~100 KB after a year.

- **Header** — `Week 31 · Jul 25 – Jul 31, 2026`, "7 days ending Friday", week dropdown, `←/→`, build timestamp
- **Four stat tiles** (2×2 desktop, 1-col mobile) — big number, Δ badge, 6-week sparkline, one line of so-what
- **Needs a decision** — renders only when non-empty (blockers, stalled PRs)
- **Per-person strip** — Kishan / Sanket: tickets done, PRs merged, reviews given
- **Shipped this week** — merged items with links
- **Footer** — links to the outputSchema and AI-actions pages

Deep-linkable per week via `#2026-W31`, so a single week can still be shared directly.

Built through the existing `lib/render.mjs` (`renderPage`) with `shared/theme.css`, matching
every other page in this repo. Also emits `dist/weekly/summary.json` for convention
consistency and possible future use by the landing page.

Charts and tiles to be designed with the `dataviz` skill rather than freehanded colors.

### Honesty rules

1. A failed collector renders its tile as **"no data" with the reason** — never a silent
   zero. Mirrors the existing `NEEDS-LINEAR-REFRESH` discipline.
2. Deltas render only when the prior week's snapshot exists. First week shows `—`.
3. Short weeks (holidays) still render; the caption states the actual date range.
4. `weeks.json` is schema-validated at build; the build fails loud on a bad field, as
   `output-schema/build.mjs` already does.

## Files

```
weekly/
  build.mjs                    # render only: weeks.json → dist/weekly/
  snapshot.mjs                 # local only: compute + append one week
  collect/
    output-schema.mjs
    ai-actions.mjs
    testing.mjs                # gh: piece-tester-web
    tickets.mjs                # reads ../../pieces-team/dashboard/data/
  data/weeks.json              # append-only archive, COMMITTED
  template.html
test/
  weekly-snapshot.test.mjs
  weekly-render.test.mjs
refresh-weekly.sh              # the single Saturday job
```

`package.json` — `build` gains `&& node weekly/build.mjs`; new `snapshot` script for the
local job. Tests follow the existing `test/*.test.mjs` + `node --test` convention.

## Scheduling

One Saturday 09:00 +03 local job (`refresh-weekly.sh`), replacing the current Monday 09:00
internal-dashboard cron. One schedule, one pipeline, no drift:

1. Internal refresh — `pieces-team/dashboard`: GitHub half, then headless-Claude Linear half
2. `npm run fetch && npm run build` in this repo (~3 min) — `dist/` is gitignored and built
   fresh in CI, so the outputSchema and AI-actions `summary.json` files the snapshot reads
   do not exist locally until this runs
3. `node weekly/snapshot.mjs` — append the completed week to `weeks.json`
4. Commit + push `pieces-dashboard` (`weekly/data/weeks.json` only; `dist/` stays ignored)
5. Existing CI renders and deploys

If step 1's Linear half fails, `NEEDS-LINEAR-REFRESH` is written; the snapshot still records
the three GitHub-derived workstreams and marks tickets as "no data — Linear refresh pending",
so the page ships without silently claiming zero tickets.

## Testing

`test/weekly-snapshot.test.mjs`
- Deltas computed correctly from two synthetic consecutive snapshots
- First-ever week yields `—`, not `+0`
- Appending an existing week throws without `--force-week`; succeeds with it
- A throwing collector produces `{status: 'no-data', reason}`, never `0`
- `weeks.json` schema violations fail the build

`test/weekly-render.test.mjs`
- Week picker lists every week in the archive, newest first
- Page opens on the newest completed week
- "Needs a decision" band absent when the list is empty
- "no data" tiles render the reason text
- Bad `#week` hash falls back to newest rather than rendering empty

## Out of scope

- Testing health numbers (blocked on `piece-tester-web` stats endpoint — separate ticket)
- Any Discord / email notification; the link is the delivery mechanism
- Changes to the internal `pieces-team/dashboard` beyond moving its cron to Saturday
- Retroactive backfill of weeks before the first snapshot. The archive starts empty and
  becomes useful from week two.
