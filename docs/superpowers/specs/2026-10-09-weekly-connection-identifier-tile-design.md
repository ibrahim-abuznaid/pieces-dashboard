# Weekly page: connection-identifier tile — design

Date: 2026-10-09 · Approved in session by the team lead.

## Goal

Put the connection-identifier rollout on the weekly page as a measured tile, the same way UI improvements
went on: pieces that label a **new** connection with its account (email or name under the connection),
how many landed this week, and what is in review.

## Decisions

| Question | Decision |
|---|---|
| Placement | A tile on `/weekly/` only. No page of its own, no landing-page card. |
| Headline | All coverage, both roads (hook + token), out of every OAuth2 piece on cloud minus the no-identity list. 58 of 111 on the day it shipped. |
| Targets | Credit wired (PR author, open PRs from W41), no target set. |
| Layout | Full width, last, under UI improvements. |

## Counting

- **Hook road**: `hasConnectionIdentifier: true` on any auth in the cloud piece API → `connIdHook` in
  `output-schema/data/cloud-coverage.json` (`scripts/fetch-cloud.sh`). Live when flagged, whatever any claim says.
- **Token road**: curated rows in `connection-identifier/pieces.json` (the 26 Google/Microsoft pieces of #14403 and
  the six that already asked for `openid`/`email`, dated by #14402). Live once the PR merged and the piece is on
  cloud — accepted overstatement of at most one release train, since no scope on cloud can be read reliably
  (Outlook's is `{accessMode}`).
- **Stages**: `live` · `merged` (hook PR merged, flag not on cloud yet → the "needs a cloud release" ask) ·
  `review` (open PR) · `assigned` · `planned`.
- **Denominator**: cloud pieces with OAuth2 or a hook, plus anything landed, minus the `none` list (ten pieces).
- **Discovery**: `getConnectionIdentifier` added at the start of a `src/` line marks an open PR as the
  `connectionIdentifier` rollout; the landing scan credits merged ones.

## Archive

`connectionIdentifier` is a required workstream: `merged`, `review`, `assigned`, `totalPieces` required, `live`
optional. `scripts/backfill-connection-identifier.mjs` rebuilt the nine weeks archived before it from PR
timestamps, without `live`, so the first live snapshot (W41) has a W40 roster to diff against.

## Known cost

A second full-width tile adds ~100–150px to a page that already scrolled ~100px past one 1366x768 screen.
Pairing the two rollout tiles as half-width boxes would avoid the extra row; not done, because it changes the UI
improvements tile that was deliberately given the full width.
