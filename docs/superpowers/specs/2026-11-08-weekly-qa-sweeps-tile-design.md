# Weekly page: QA sweeps tile — design

Date: 2026-11-08 · Decided in session; the lead asked for every decision to be made without questions.

## Goal

Track the QA sweeps on the weekly page: the bug tickets the automated QA sweeps file in Linear and the
Pieces team works through. Linked to Linear by **keyword**: every Linear project whose name contains `qa`
(case-insensitive) is a sweep, today and for the next one.

## Decisions

| Question | Decision |
|---|---|
| Source | Linear projects whose name contains `qa` — found by `list_projects(query)`, kept by the name test. Four today (`qa sweep 3`, `QA Sweep 3: Triggers`, `QA Sweep 2`, `QA Sweep 1`). |
| Scope | A ticket counts when it is the Pieces team's: team **Pieces**, or assigned to someone on the roster. The Engineering sweeps' own tickets are not this team's work (149 of the 604 tickets qualify today, all from `qa sweep 3`). |
| Fetch | The internal dashboard's refresh (`pieces-team/dashboard/refresh-qa.sh`): headless Claude + Linear MCP, validated by `validate-qa.mjs`, installed as `data/qa.json`, marker `NEEDS-QA-REFRESH` on failure. Non-fatal step of `refresh.sh`, so a QA failure never costs the ticket counts. |
| Headline | Running total: **tickets fixed** of the tickets in scope (canceled and duplicate excluded from both). Delta pill = fixed this week. "+N in review" pill. |
| Per person | Rows with a bar, like the AI-actions target rows, but the denominator is the **assignment** (tickets assigned to the person), not a target: `Odai 0/49 fixed · 1 in review`. A target would be a management decision; the assignment is a fact. Rows only on weeks that read the board (`assigned` present); a backfilled week shows the plain per-person line of fixes. |
| Projects | One line under the headline naming each sweep with `fixed/total`, each linking to the project in Linear. |
| Chips | Ids of the tickets fixed this week, linking to the ticket. **Ids only, never titles**: these are bug reports, several labelled `security`, and this repo is public. |
| Layout | Wide, first of the wide tiles — directly under the small grid, above the two rollouts. A ninth small tile would leave a hole in the two-column grid. |
| Archive | `qaSweeps` is a required workstream: `total`, `fixed`, `fixedThisWeek` required; `inReview`, `inProgress`, `open`, `canceled` and the per-person `assigned`/`inReview`/`inProgress` only on weeks that read the board. Every number is auditable from the block: people + others + unassigned add up to `fixed` and `fixedThisWeek`, projects add up to the totals, `fixedIds` has exactly `fixedThisWeek` ids. |
| Backfill | `scripts/backfill-qa-sweeps.mjs` restates W31–W45 from `createdAt`/`completedAt`/`canceledAt` (what the dates decide); W45, the latest sealed week, carries the board state read on 2026-11-08, as a heal would. |

## Counting

- `fixed` = statusType `completed` · `inReview` = started with status name `In Review` · `inProgress` = every other
  started state (Blocked included) · `open` = triage, backlog, unstarted · `canceled` = canceled or duplicate,
  outside `total`.
- `fixedThisWeek` = `completedAt` inside the Sat→Fri window, by the ticket's current assignee.
- Dates-only (backfill): a ticket exists from `createdAt`; it is fixed from `completedAt`, canceled from
  `canceledAt`; no board state is claimed for a past week.
