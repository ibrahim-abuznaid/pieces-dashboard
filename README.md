# Pieces Team — Dashboards

Live site: **https://ibrahim-abuznaid.github.io/pieces-dashboard/**

| Page | Tracks |
|---|---|
| [/](https://ibrahim-abuznaid.github.io/pieces-dashboard/) | Combined KPIs + stage funnels |
| [/output-schema/](https://ibrahim-abuznaid.github.io/pieces-dashboard/output-schema/) | `outputSchema` rollout across the published piece catalog (computed from the cloud API + upstream repo) |
| [/ai-actions/](https://ibrahim-abuznaid.github.io/pieces-dashboard/ai-actions/) | `audience:'ai'` agent-atomics coverage + blockers |
| [/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) | One week of team progress across all four workstreams, with an archive of past weeks |

## How it stays fresh

Every push to `main` and a daily 06:00 UTC cron run [deploy.yml](.github/workflows/deploy.yml):
fetch live data (Activepieces cloud API, upstream repo tree, GitHub PR states) → tests → build → GitHub Pages.
**Generated files are never committed** — `dist/` is build output only.

## Weekly progress page

[/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) shows one week of team progress
across the four workstreams. The counting window is the **7 days ending Friday** (Sat 00:00 → Fri 23:59 UTC).

Snapshots are appended **locally, never in CI**: the Saturday job runs `npm run snapshot`, which writes one
week into `weekly/data/weeks.json` — and that file **is** committed. CI only renders what is already
committed (`npm run build` → `dist/weekly/`); it runs daily, so a CI-computed snapshot would recompute and
rewrite past weeks every morning.

`weeks.json` is append-only and past weeks are immutable — re-snapshotting an existing week fails unless you
pass `--force-week`.

### Verification

Neither job ends at "I pushed it". After the push, `refresh-weekly.sh` waits for the **Refresh & deploy** run
for that exact commit (filtered by workflow name *and* SHA — "Claim bot" also runs here) and then reads the
live page back, so a red run or a deploy that never landed exits non-zero and cron mails it.

`verify-weekly.sh` is the same assertion on a **daily** cron, read-only: live page reachable and rendering,
its default week equal to the newest committed week, every archived week passing `validateSnapshot`, and the
newest snapshot no older than 8 days (a missed Saturday blanks the *following* week's deltas too). Run it any
time; `--url=` points it at another build. Schedule it well away from the Saturday 09:00 +03 job — a run
inside that window would see the new commit before the deploy finishes and report a false mismatch.

Both read the page the way a reader gets it: the DOM is built client-side from an embedded `const ARCHIVE`
blob, so grepping the served HTML for a week id proves nothing. `verify-weekly.mjs` parses that blob and
executes the page's scripts in a `node:vm` sandbox.

The page is written for a **project manager**: the week, four numbers, the pieces behind each number, and
anything that needs a decision. Closed tickets and shipped PRs render as chips that **link to the artifact
itself** (the ticket in Linear, the PR on GitHub). Every strip opens at 5 chips so the landing view fits one
screen; **"+N more" is a button** that expands the full list in place (the whole roster is in the page,
hidden). Engineering caveats are recorded here rather than on the page.

### Curated week notes

`weekly/data/notes.json` maps *week → workstream → one short sentence* rendered under that tile's number —
the "what actually happened" no derived count can say. It is display layer, **not** the archive: weeks.json
stays immutable, while a note can be written (or fixed) after the week is sealed with one edit and a push.
The view collapses a note to a single line; write one sentence, not a paragraph.

### UI improvements band

`weekly/data/updates.json` maps *week → `{ note, items: [{label, href}] }`* and renders as a full-width
"UI improvements" band under the tiles: pieces-related UI work shipped that week — the piece-selector
descriptions project, builder fixes around pieces — with each item a chip linking to its PR or ticket.
**Curated, not derived**: what counts as "pieces-related UI work" is the team's judgment and much of it
ships from outside the team's own handles, so no collector could classify it honestly. Same rules as
notes.json — display layer, weeks.json untouched, editable after the week is sealed with one edit and a
push. A week with no entry renders no band. The band opens at 3 chips ("+N more" expands in place) so the
landing view keeps fitting one screen.

### Piece testing — coverage when reachable, build progress otherwise

When a snapshot is taken with **`PIECE_TESTER_URL`** set, the collector reads the running tester's
`/api/coverage` and the box leads with **pieces covered** — pieces with at least one test plan — listing them
as chips, with build progress (PRs merged, commits) on the note line. The address is deployment detail and
stays out of this public repo: put it in the gitignored `.env.local` (sourced by `refresh-weekly.sh`), e.g.
`export PIECE_TESTER_URL=http://<tester-host>:4000`. Snapshots only ever run locally, so CI never needs it.

Without the URL — every older week, and any week the server is unreachable — the box counts
**merged PRs on `piece-tester-web`** with their titles as chips: build progress, exactly as before. A
coverage miss is recorded as `coverageError` in the snapshot and warned at snapshot time, never rendered.

Neither headline is piece **health**: pass/fail run results are still not collected, and unlocking them needs
a **stats endpoint** read the same way (the coverage endpoint already reports per-piece health — rendering it
is a deliberate later step, not a data gap). Do not read that box as "pieces passing" — see
`weekly/collect/testing.mjs`.

## Claiming work (the 3-stage model)

Stages are **derived, never hand-edited**: assignee only → `assigned` · open PR → `PR open` · merged PR → `merged`.
To claim a piece or record a PR you edit ONE json file and push — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Local dev

```bash
npm run fetch    # needs curl, jq, gh (authed); ~3 min
npm test
npm run build    # writes dist/ — open dist/index.html
```

## Layout

- `shared/theme.css` — one palette/light+dark theme, inlined into every page at build
- `lib/` — render + stage derivation (unit-tested)
- `scripts/` — data fetchers (also run in CI)
- `output-schema/`, `ai-actions/`, `site/` — one build.mjs + template.html each
- Manual state lives ONLY in `output-schema/overrides.json`, `ai-actions/overrides.json`, and the curated `ai-actions/{pieces,blockers}.json`

## Public-data policy

This repo is public. Never commit real names/locations, bounty or velocity data, or secrets.
The ceiling is: GitHub handles, bare ticket ids (`PIE-###`), and **ticket titles** — which the weekly page
shows shortened of their routing tags, each linking to the ticket in Linear (where the detail stays, behind
Linear's own login). Ids and titles were raised to the ceiling deliberately in Aug 2026 so the "Tickets
solved" box is a clickable list rather than a bare count. Nothing beyond an id and a title lands here — no
descriptions, no comments, no customer data — and a title that itself names a customer or a person must be
reworded in Linear before the Saturday snapshot (or hand-dropped from `weeks.json`).
