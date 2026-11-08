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
- `backfill-qa-sweeps.mjs` — run 2026-11-08, adding the `qaSweeps` block to every archived week (see
  *QA sweeps* below).
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

**After the machine was off.** Cron has no memory: a 09/13/17/21h slot the machine was off or asleep for is
skipped, and a daily 20:00 verify is skipped the same way. `catchup-weekly.sh` closes that gap. A systemd
user timer (`~/.config/systemd/user/pieces-weekly-catchup.timer`, `Persistent=true`) runs it 4 minutes after
every boot and 30 minutes after each cron slot — so a slot the machine slept through is replayed as soon as it
is awake. It waits for the network, runs `refresh-weekly.sh` (whose guard decides in 54 ms whether the latest
sealed week is already complete, and collects it when it is missing), then runs `verify-weekly.sh`, and writes
one verdict line to `catchup-weekly.log` and `~/.cache/pieces-dashboard/last-catchup`. It speaks up (Discord
via Alicent) only when it had to collect a missing week, or when the verify is red afterwards; a quiet boot
stays quiet. `refresh-weekly.sh` holds a non-blocking lock (`~/.cache/pieces-dashboard/refresh-weekly.lock`)
so the cron run and a catch-up can never overlap; a catch-up that finds the lock held exits without running
the verify either, because mid-refresh the committed archive is ahead of the deployed page by design.

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
**merged PRs on `pieces-tester`**: build progress, exactly as before. A coverage miss is recorded as
`coverageError` in the snapshot and warned at snapshot time, never rendered.

**Counts only from the repo.** `activepieces/pieces-tester` went private on 2026-10-19 and this dashboard is
public, so the collector stores how many PRs merged and how many commits landed, and nothing else: no PR
title, commit message, number or URL. The weeks archived before then had their `testing.shipped` list
scrubbed from `weekly/data/weeks.json` (git history still holds it), and the page ignores one if it turns up.

Neither headline is piece **health**: pass/fail run results are still not collected, and unlocking them needs
a **stats endpoint** read the same way (the coverage endpoint already reports per-piece health — rendering it
is a deliberate later step, not a data gap). Do not read that box as "pieces passing" — see
`weekly/collect/testing.mjs`.

### QA sweeps — the bug tickets, linked by keyword

A wide tile under the small grid, since 2026-11-08. The automated QA sweeps file their findings as Linear
tickets inside **projects** — `qa sweep 3`, `QA Sweep 3: Triggers`, `QA Sweep 2`, `QA Sweep 1` so far —
and the tile is linked to Linear by **keyword, not by project id**: every project whose name contains `qa`
(case-insensitive) is a sweep, so the next one lands on the page without an edit. Design:
`docs/superpowers/specs/2026-11-08-weekly-qa-sweeps-tile-design.md`.

**Scope** is the Pieces team's tickets: team **Pieces**, or assigned to someone on the roster. Three of the
four sweeps are Engineering projects whose tickets are not this team's work (604 tickets across the four,
149 in scope on the day it shipped, all from `qa sweep 3`).

**What it shows.** The number is tickets **fixed** (Linear `completed`), a running total, with the same
week-over-week pill as the rollouts; "+N in review" is the queue behind it; canceled and duplicate tickets
are outside the total. One line links each sweep in Linear with its own `fixed/total`. The per-person rows
read `Odai 0/49 fixed · 1 in review` — the denominator is the **assignment**, a fact the board records, not
a target this page invents; they draw only on weeks that read the board. The chips are the **ids** of the
tickets fixed this week, linking to Linear, and **never their titles**: these are bug reports, several
labelled `security`, and this repo is public.

**How the data gets here.** The internal dashboard's refresh runs `refresh-qa.sh` (headless Claude + the
Linear MCP: `list_projects(query:"qa")` → name test → `list_issues` per project → scope → `validate-qa.mjs`
→ `dashboard/data/qa.json`). It is a non-fatal step with its own marker, `NEEDS-QA-REFRESH`, so a failed QA
fetch degrades this tile alone and never the ticket counts. The collector (`weekly/collect/qa-sweeps.mjs`)
reads that file, re-applies the scope rule, and refuses a file stamped before the week's end.

**Archive.** `qaSweeps` is a required workstream: `total`, `fixed`, `fixedThisWeek`; the board-state counts
(`inReview`, `inProgress`, `open`, `canceled`, and the per-person `assigned`) only on weeks that read the
board. Every number is auditable from the block alone — people + others + unassigned add up to `fixed` and
`fixedThisWeek`, the projects add up to the totals, `fixedIds` lists exactly `fixedThisWeek` ids.
`scripts/backfill-qa-sweeps.mjs` restated W31–W45 on 2026-11-08 from `createdAt`/`completedAt`/`canceledAt`
alone (dates-only, no board state), and W45 — the latest sealed week — from the board as read that day, as
a heal of the week would have. W31–W43 hold no ticket of this team's (the Engineering sweeps existed, ours
did not) and read "none for the team yet".

## AI actions — quality & rollout (counts only)

The AI-actions page's **Quality & rollout** section answers "is it going as planned" with four of the
methodology's KPIs (`pieces-team/ai-actions-eval/METHODOLOGY.md` §4): **K1** pieces gained per week,
merged only, against the 40/week target (week-over-week `aiActions.merged` in the weekly archive; approved
on its own line, because the weekly targets count approved and open PRs by design); **K3** on npm at main's
version, served on Cloud, merge → npm lag; **K4** the share of AI actions passing every P1 check; **K9**
actions demoted `both` → `human` with no breaking-changes entry.

`scripts/fetch-ai-audit.mjs` (last step of `npm run fetch`) clones upstream main sparse and shallow, parses
every `createAction` with the TypeScript compiler (`lib/ai-audit.mjs`, pinned `typescript` 5.9.3; the script
runs `npm ci` itself if `node_modules` is missing or stale) and runs the council's checks: P1 = S1 optional
Checkbox on an AI update action (behaviour flags such as `clear_*` excluded), S2 undeclared demotion, S3/S4
floor outside 0.86.4…latest release, S6 unregistered, S7 duplicate name; P2 = S1b optional Array/dynamic
props on an update, S5 the same intent twice, S8 no `outputSchema`, S9 no `classification`. P2s carry no
target. It then runs `scripts/fetch-ai-rollout.mjs` for the same commit against npm and
`cloud.activepieces.com/api/v1/pieces/<name>?audience=all&cb=<ts>` — the default audience is human and hides
every AI action, and Cloudflare caches. No credentials anywhere.

**Counts only, by rule.** This repo is public and a finding names an agent action that does damage, so
`data/ai-audit.json` and `data/ai-rollout.json` hold aggregate numbers plus the commit and date, and
`test/ai-audit-wiring.test.mjs` fails on any key or string that could be a name. The per-piece findings
(file:line and a one-line why) exist only with `--private <dir>`, which `refresh-weekly.sh` passes once per ISO
week to `pieces-team/ai-actions-eval/audit/` (override with `AI_AUDIT_PRIVATE_DIR`, `""` turns it off). A
private run writes nothing inside the repo and refuses a dir that is; a failure there is a WARN line, never
the week.

S2 diffs against `data/ai-audit-baseline.json`: every action's audience at `9ed198f`, the last main commit
before the first AI-actions PR (#13952, merged 2026-07-22). Rebuild it only to move the baseline
(`scripts/build-ai-audit-baseline.mjs`). The mention test is loose, so S2 is a floor; S1/S1b are a floor too,
because props built by helpers imported from outside the piece cannot be typed.

Regression oracle: the council's throwaway scripts at main `6d93dbc` (2026-10-20). This port reproduces every
count they measured there — 132 pieces / 4,005 AI actions, S1 58/27 total and 21/13 on saved state, S3 13/4,
S5 11/2, S8 68/13 (39 deletes exempt), S9 25/3, S6/S7 0, and against their 09-11 baseline S2 433/81 demoted,
72 pieces undeclared. K4 reads 99.2% here against their 98.9% because they counted S5 as a P1.

Not done yet: the weekly archive does not record any of this (its format is untouched), so the page shows
the current reading only and K1 is the one number with history.

### AI actions landed, not just pieces

The weekly AI-actions tile counts **pieces** with at least one `audience: 'ai'` action, and credits a piece
to its author once, the week it first went done. Most of the work is now *more* actions on pieces that already
count — #17034 gave bexio 103 — and none of that moves a pieces number. And some of it is actions built once
for humans and agents alike (`audience: 'both'`, "no need to split them"): twitch's 51 in W45 carried not one
agent-only line, so neither the pieces count nor an agent-only count could see them.

So since W45 (backfilled to W39) each week records `aiActions.actionsLanded`, two counts off the same merged
PRs, per author and per piece, with the `prs` behind them so every number is auditable from `weeks.json`:

- **agent-only** (`total`, `byPerson`, `prs[].n`/`pieces`): net `audience: 'ai'` lines added — the agent
  atomics, the same rule the pieces count uses;
- **new actions** (`newActions.total`, `newActions.byPerson`, `prs[].nNew`/`newActions`): net `createAction(`
  calls added, whatever the audience — the count Odai's "I just increase the number of actions" work shows up in.
  `audience: 'both'` lines are deliberately not a measure of their own: a catalog-wide migration put them on 663
  pieces, and a PR that promotes a `both` action to an agent-only atomic would read as one fewer.

The page shows ONE number for the week, the actions created: a line under the headline ("7,155 agent actions
on main · +1,781 actions added this week") and one beside each person's pieces score ("12/20 pieces · +321
actions added"). The agent-only share and the share from people outside the team are in the hover tooltip of
each, not on the page — two numbers side by side read as a puzzle (Ibrahim, 2026-11-08). The "on main" count
is agent-only atomics, because that is the only stock the code can count honestly (see above).

**Decision, 2026-11-08:** the per-person target stays *pieces with at least one agent-only action*, the
program's own definition (`ai-actions-eval/METHODOLOGY.md`), and the actions count is shown, not targeted. A
piece built with `both` actions only therefore earns 0 toward the pieces target but all of its actions in the
actions count. The standard for the team: an action meant for agents is marked `audience: 'ai'`; an action
genuinely for both audiences is fine and counts as an action.

How it is measured: the same 21-day merged-PR scan that credits the pieces (`scripts/fetch-pr-states.mjs` →
`data/landings.json` `actionsLanded`, rule in `lib/discover.mjs` `discoverActionsLanded`), read off the diff:
added minus removed matching lines, piece `src/` files only, PRs into `main` only, in the window by the UTC day
of the merge. A file GitHub served without a patch (a diff too large to serve — twelve in W39–W45, all
generated) is rebuilt from its contents by `scripts/rebuild-patch.mjs`, and one that will not rebuild marks the
scan incomplete, which the Saturday job refuses (`LANDINGS_REQUIRED=1`). A week the scan cannot vouch for
records no field and the page draws nothing for it; a measured quiet week reads "+0". A scan row carrying one
count and not the other is an older scan, and the week is not measured rather than half so.

`scripts/backfill-ai-actions-landed.mjs` restated W39–W45 on 2026-11-08 from the same rule, one week at a time
(`--weeks 2026-W39..2026-W45 --apply`; dry run by default, `--verbose` lists the PRs). The agent-only count for
W41–W45 matches the week-over-week change in actions on main exactly. W39 and W40 do not, and both gaps are
accounted for piece by piece (verified 2026-11-08, nothing to fix):

- **206 across W39/W40, by decision.** Five of Odai's PRs (#15585 whatsapp 1, #15661 dropbox 26, #15696
  microsoft-outlook 45, #15725 mailer-lite 37 + pipedrive 32, #15757 asana 65) merged in W40's window, so the
  landed count puts them in W40 (+600 against +394 on main). W39's roster carries them as `merged` with those
  counts because the lead counted them done in W39, the week the work was finished and approved
  (`backfill-ai-actions-approved.mjs`), and the later main re-read filled their counts in. W39 therefore reads
  +740 landed against +973 on main.
- **27 in W39, by instrument.** W38's roster still carried the hand-kept, authored counts for six pieces that
  had landed earlier; W39 was the first week read off main, which had more: stripe 75→79, github 72→74,
  sendinblue 20→32, gmail 19→26, airtable 18→19, cody 18→19. None of them had a PR in W39's window, so the landed
  count does not see the +27 and the on-main delta does.

## Claiming work (the 3-stage model)

Stages are **derived, never hand-edited**: assignee only → `assigned` · open PR → `PR open` · merged PR → `merged`.
To claim a piece or record a PR you edit ONE json file and push — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Local dev

```bash
npm run fetch    # needs curl, jq, gh (authed); ~4 min
npm test
npm run build    # writes dist/ — open dist/index.html
```

## Layout

- `shared/theme.css` — one palette/light+dark theme, inlined into every page at build
- `lib/` — render + stage derivation (unit-tested)
- `scripts/` — data fetchers (also run in CI); `fetch-ai-audit.mjs` + `fetch-ai-rollout.mjs` write the AI-actions quality counts
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
