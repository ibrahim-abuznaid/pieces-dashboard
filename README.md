# Pieces Team — Dashboards

Live site: **https://ibrahim-abuznaid.github.io/pieces-dashboard/**

| Page | Tracks |
|---|---|
| [/](https://ibrahim-abuznaid.github.io/pieces-dashboard/) | Combined KPIs + stage funnels |
| [/output-schema/](https://ibrahim-abuznaid.github.io/pieces-dashboard/output-schema/) | `outputSchema` rollout across the published piece catalog (computed from the cloud API + upstream repo) |
| [/ai-actions/](https://ibrahim-abuznaid.github.io/pieces-dashboard/ai-actions/) | `audience:'ai'` agent-atomics coverage + blockers |
| [/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) | One week of team progress across every workstream, with an archive of past weeks |

## How it stays fresh

Every push to `main` and a daily 06:00 UTC cron run [deploy.yml](.github/workflows/deploy.yml):
fetch live data (Activepieces cloud API, upstream repo tree, GitHub PR states) → tests → build → GitHub Pages.
**Generated files are never committed** — `dist/` is build output only.

## Weekly progress page

[/weekly/](https://ibrahim-abuznaid.github.io/pieces-dashboard/weekly/) shows one week of team progress
across every workstream. The counting window is the **7 days ending Friday** (Sat 00:00 → Fri 23:59 UTC).

Snapshots are appended **locally, never in CI**: the Saturday job runs `npm run snapshot`, which writes one
week into `weekly/data/weeks.json` — and that file **is** committed. CI only renders what is already
committed (`npm run build` → `dist/weekly/`); it runs daily, so a CI-computed snapshot would recompute and
rewrite past weeks every morning.

`weeks.json` is append-only and past weeks are immutable — re-snapshotting an existing week fails unless you
pass `--force-week`.

**Deliberate rewrites of archived weeks** are the one exception, and each is done by a script kept in
`scripts/` rather than by hand, restating only fields that permanent PR timestamps decide — never a count
that was only knowable at the time (`catalogPieces`, `blockersOpen`, cloud `live`, display fields):

- `backfill-ui-improvements.mjs` — added the `uiImprovements` block to the six weeks archived before that
  workstream existed.
- `backfill-ai-actions.mjs` — **run 2026-09-18, rewriting `aiActions` in W31–W37.** Three claims pointed at
  PRs that closed unmerged and were re-opened under new numbers (#13926→#14519, #13929→#14520,
  #13930→#14565). The recorded number still resolved, so the daily refresh stayed green while the *pointer*
  was stale and `deriveStage()` fell back to the closed PRs' assignees: W32–W37 each read `merged 23 /
  assigned 3` for six weeks when the true state was `merged 26 / assigned 0`, all three having merged by
  2026-08-03. The same pass corrected W31 (`merged 2` → `merged 14`), which was snapshotted on 2026-08-05
  off a `dist/` built from PR states fetched a week earlier. Two guards now make this loud rather than
  silent: `scripts/fetch-pr-states.mjs` warns on any claim whose PR closed unmerged and names the merged PR
  sharing its title, and `ai-actions/validate.mjs` fails the build outright — a closed PR is never a resting
  state, it is either superseded (repoint the claim) or abandoned (give it a `held` reason).

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

The page is written for a **project manager**: the week, a number per box, the pieces behind each number, and
anything that needs a decision. Closed tickets and shipped PRs render as chips that **link to the artifact
itself** (the ticket in Linear, the PR on GitHub). Every strip opens at 5 chips so the landing view fits one
screen; **"+N more" is a button** that expands the full list in place (the whole roster is in the page,
hidden). Engineering caveats are recorded here rather than on the page.

### Curated week notes

`weekly/data/notes.json` maps *week → workstream → one short sentence* rendered under that tile's number —
the "what actually happened" no derived count can say. It is display layer, **not** the archive: weeks.json
stays immutable, while a note can be written (or fixed) after the week is sealed with one edit and a push.
The view collapses a note to a single line; write one sentence, not a paragraph.

### UI improvements — the property-UI rollout

The fifth box counts pieces carrying the new step-settings UI (grouped props, the essential/Advanced split,
the widget set) against the **whole 765-piece catalog**. It is full width and sits last, where the curated
"UI improvements" band used to be; the band's prose lives on in `notes.json` as this tile's note line.

Two halves, and the difference matters:

- **merged** — the adoption landed in the repo. Derived from the claim's PR state, so it is true the moment
  a PR merges. This is the headline, for the same reason outputSchema's headline is merged work.
- **live** — the cloud catalog actually publishes the metadata, measured straight off it. Only true after a
  release train the team does not control, so it rides along as detail and drives the "merged but not live"
  ask. Cloud ingestion **does** carry `propertyGroups` and `advanced` (verified 2026-09-13 — it was an open
  question in the team's `ui-improvements/README.md`).

Claims live in `ui-improvements/pieces.json` (*slug + PR number*), one JSON edit and a push. The build counts a piece the cloud publishes even without a claim row, and prints
a `WARN` naming it so the list catches up. The shared **Custom API Call** action is excluded everywhere: one
generic form injected into ~500 pieces gained four `advanced` props in
[#15248](https://github.com/activepieces/activepieces/pull/15248), and counting it would report 10 pieces as
adopters of work nobody on the team did.

The six weeks archived before the workstream existed were reconstructed by `scripts/backfill-ui-improvements.mjs`
from PR `createdAt`/`mergedAt` — permanent timestamps, so "how many had merged by Friday 2026-09-04" has one
correct answer that does not drift. Those weeks record no `live`: cloud state is only ever knowable now, and
the archive makes the field optional so a reconstructed week can stay silent rather than guess.

### Connection identifier — pieces that label the account

The connection-identifier box counts pieces that label a **new** connection with the account it belongs to (the email or name
under a connection on the Connections page and in the builder's picker), out of every **OAuth2 piece on cloud
minus the ten whose provider exposes no identity** (111 when this shipped). Full width, under UI improvements.

A piece gets there by one of two roads, and the build treats them differently because only one is visible:

- **hook** — the piece's auth defines `getConnectionIdentifier`. The cloud API publishes
  `hasConnectionIdentifier: true` on that auth, so `scripts/fetch-cloud.sh` records it as `connIdHook` and the
  build counts it with no claim needed (and prints a `WARN` naming any hook without a row, so the week it landed
  can be attributed). Open hook PRs are discovered from their diff (`CONN_ID_HOOK` in `lib/discover.mjs`).
- **token** — the provider returns the email in the token response or an OIDC `id_token` (Google's `email` scope,
  Microsoft's `openid email profile`), with no piece code. Nothing on cloud says so, so these rows live only in
  `connection-identifier/pieces.json`, and count as live once their PR merged and the piece is on cloud. A
  token-road PR (a scope edit) is not discoverable: add its row by hand.

`connection-identifier/pieces.json` also carries the `none` list: OAuth2 pieces with no identity to show
(client-credentials tokens, tenant- or location-scoped grants). They leave the denominator; if one ever gains a
hook it counts again and the build warns that the listing is stale. The counting rules are pure and unit-tested in
`lib/connection-identifier.mjs`.

As on UI improvements, the headline is **merged** (live + merged-not-live), `live` is optional in the archive, and
`merged − live` becomes a "needs a cloud release" ask. The nine weeks archived before the box existed were rebuilt
by `scripts/backfill-connection-identifier.mjs` from PR timestamps, without `live`. Per-person credit is wired
(PR author, open PRs included from W41) but `targets.json` sets no target for it; adding one is a one-line edit.

The new box costs page height: a second full-width box adds ~100–150px to a page that already ran ~100px past
one 1366x768 screen (see the re-measurement note in `test/weekly-render.test.mjs`). Pairing it with UI improvements
as two half-width boxes would cost no extra row, at the price of UI improvements' full-width strip.

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
- `output-schema/`, `ai-actions/`, `site/` — one build.mjs + template.html each; `ui-improvements/` and `connection-identifier/` are build.mjs + a claims file (the weekly page is their only reader)
- Manual state lives ONLY in `output-schema/overrides.json`, `ai-actions/overrides.json`, the curated `ai-actions/{pieces,blockers}.json`, `ui-improvements/pieces.json` and `connection-identifier/pieces.json`
- AI-actions **merged** is read off upstream main, not the curated file: `scripts/fetch-repo-ai.sh` greps a sparse
  shallow clone for `audience: 'ai'` actions per piece → `data/repo-ai-actions.json`, and `lib/ai-roster.mjs`
  counts every piece found there whether or not it has a row. Open PRs are classified by the same rule
  (`AI_AUDIENCE` in `lib/discover.mjs`), catalog-wide, one row per piece a PR carries. Until 2026-09-26 the roster
  WAS the curated file, and W39 archived as +1 in a week the team shipped agent atomics to 23 pieces;
  `scripts/backfill-ai-actions-from-main.mjs` restated the archive from main's git history.

## Public-data policy

This repo is public. Never commit real names/locations, bounty or velocity data, or secrets.
The ceiling is: GitHub handles, bare ticket ids (`PIE-###`), and **ticket titles** — which the weekly page
shows shortened of their routing tags, each linking to the ticket in Linear (where the detail stays, behind
Linear's own login). Ids and titles were raised to the ceiling deliberately in Aug 2026 so the "Tickets
solved" box is a clickable list rather than a bare count. Nothing beyond an id and a title lands here — no
descriptions, no comments, no customer data — and a title that itself names a customer or a person must be
reworded in Linear before the Saturday snapshot (or hand-dropped from `weeks.json`).
