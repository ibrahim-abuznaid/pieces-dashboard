#!/usr/bin/env bash
# Counts the agent atomics on upstream main, per piece → data/repo-ai-actions.json.
# Needs: git, jq. ~10 s (a 24 MB sparse, shallow, blobless clone).
#
# This is the MERGED half of the AI-actions rollout, read off the code. It used
# to be read off ai-actions/pieces.json, a curated list, so a piece nobody wrote
# down had no AI actions as far as the page knew: W39 reported +1 in a week the
# team shipped 23. See lib/ai-roster.mjs for how the build uses this.
#
# Why a clone and not the cloud catalog: the catalog does not publish
# audience:'ai' actions at all — Gmail has 26 on main and cloud lists 11
# actions, none of them 'ai'. And not GitHub code search: it caps, lags the
# index, and cannot be asked an exact question, so the number would not be
# auditable.
#
# The pattern is AI_AUDIENCE in lib/discover.mjs, which classifies open PRs by
# the same rule, and it is anchored to the start of the line for the same
# reason: the team comments these actions with the same phrase, and 16 of 1576
# matches on main were comments. test/ai-pattern.test.mjs holds the copies to
# one answer. Change one, change all.
set -euo pipefail
cd "$(dirname "$0")/.."

PATTERN="^[[:space:]]*audience[[:space:]]*:[[:space:]]*['\"]ai['\"]"
REPO_URL="https://github.com/activepieces/activepieces.git"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "1/1 upstream main (audience:'ai' actions per piece)…"
# Retried for the reason every other network call in this repo is: one blip
# with `set -e` and no retry cost a whole week once (see fetch-cloud.sh).
for attempt in 1 2 3; do
  rm -rf "$TMP/ap"
  if git clone --quiet --depth 1 --filter=blob:none --sparse --no-checkout "$REPO_URL" "$TMP/ap" \
    && git -C "$TMP/ap" sparse-checkout set --no-cone '/packages/pieces/community/*/src/' \
    && git -C "$TMP/ap" checkout --quiet main; then
    break
  fi
  echo "  clone attempt $attempt failed — retrying" >&2; sleep 3
done
# Fail-loud, like the coverage fetch: an empty reading would demote every
# landed piece to whatever the curated file happens to say.
[ -d "$TMP/ap/packages/pieces/community" ] || { echo "✗ upstream clone failed after 3 attempts" >&2; exit 1; }

COMMIT="$(git -C "$TMP/ap" rev-parse HEAD)"
COMMITTED_AT="$(git -C "$TMP/ap" log -1 --format=%cI)"
# git grep exits 1 on no match, which is a reading (zero), not a failure. Any
# other status is a failure, and must not publish a partial count.
#
# The count is the LAST `:N` on the line (greedy `.*`), so a path that contains
# a colon still parses, and quotePath=false stops git quoting a non-ASCII path
# into a shape the sed below would pass through untouched.
{ git -C "$TMP/ap" -c core.quotePath=false grep --no-color -c -E "$PATTERN" -- 'packages/pieces/community/*/src/**' \
    || [ $? -eq 1 ]; } \
  | sed -E 's#^packages/pieces/community/([^/]+)/.*:([0-9]+)$#\1 \2#' \
  | jq -R -s --arg commit "$COMMIT" --arg at "$COMMITTED_AT" --arg day "$(date -u +%F)" '
      split("\n") | map(select(length > 0) | split(" ") | {k: .[0], v: (.[1] | tonumber)})
      | group_by(.k) | map({key: .[0].k, value: (map(.v) | add)}) | from_entries
      | {fetched: $day, commit: $commit, committedAt: $at, pieces: .}' \
  > "$TMP/repo-ai-actions.json"

N="$(jq '.pieces | length' "$TMP/repo-ai-actions.json")"
# A zero is not a plausible reading of a catalog with 52 such pieces on the day
# this was written; it is a broken pattern or a changed directory layout.
[ "$N" -gt 0 ] || { echo "✗ no audience:'ai' actions found on main — the pattern or the layout changed" >&2; exit 1; }
mv "$TMP/repo-ai-actions.json" data/repo-ai-actions.json
echo "  $N pieces with agent atomics on main @ ${COMMIT:0:11} ($COMMITTED_AT), $(jq '[.pieces[]] | add' data/repo-ai-actions.json) atomics"
