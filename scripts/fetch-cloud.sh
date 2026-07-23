#!/usr/bin/env bash
# Refetches all data sources into output-schema/data/.
# Needs: curl, jq, gh (authed). Takes ~2-3 min (756 metadata fetches).
set -euo pipefail
cd "$(dirname "$0")/../output-schema"

echo "1/3 cloud catalog…"
curl -sf "https://cloud.activepieces.com/api/v1/pieces" > data/cloud-catalog.json
echo "  $(jq length data/cloud-catalog.json) pieces"

echo "2/3 per-piece cloud metadata (outputSchema coverage)…"
# Piece name is passed as a positional param ($1) — NOT xargs -I{}, which would
# also substitute the name into every {} inside the jq program below.
jq -r '.[].name' data/cloud-catalog.json | xargs -P10 -n1 sh -c '
  n="$1"
  m=$(curl -sf --max-time 30 "https://cloud.activepieces.com/api/v1/pieces/$n" || echo "")
  if [ -z "$m" ]; then m=$(curl -sf --max-time 30 "https://cloud.activepieces.com/api/v1/pieces/$n" || echo ""); fi
  if [ -z "$m" ]; then printf "{\"name\":\"%s\",\"error\":true}\n" "$n"; else
    # printf, not echo: dash echo mangles the \n escapes inside JSON strings
    printf "%s" "$m" | jq -c "{name:.name, version:.version,
      totalActions: ((.actions // {})|length), totalTriggers: ((.triggers // {})|length),
      actionsWithSchema: ([(.actions // {})|to_entries[]|select(.value.outputSchema != null)]|length),
      triggersWithSchema: ([(.triggers // {})|to_entries[]|select(.value.outputSchema != null)]|length)}"
  fi' _ > data/.coverage.jsonl
jq -s '.' data/.coverage.jsonl > data/cloud-coverage.json && rm data/.coverage.jsonl
echo "  $(jq length data/cloud-coverage.json) fetched, $(jq '[.[]|select(.error)]|length' data/cloud-coverage.json) errors"
ERRS=$(jq '[.[]|select(.error)]|length' data/cloud-coverage.json)
if [ "$ERRS" -gt 0 ]; then
  echo "✗ $ERRS piece metadata fetches failed — aborting (fail-loud: partial coverage would silently demote live pieces)" >&2
  exit 1
fi

echo "3/3 upstream repo tree (pieces + output-schemas.ts files)…"
gh api "repos/activepieces/activepieces/git/trees/main?recursive=1" --paginate \
  | jq -r '.tree[].path' > data/.tree.txt
grep -E '^packages/pieces/community/[^/]+$' data/.tree.txt \
  | sed 's|packages/pieces/community/||' | jq -R -s 'split("\n")|map(select(length>0))' > data/repo-pieces.json
echo "  $(jq length data/repo-pieces.json) repo pieces"
SCHEMA_PIECES=$(grep -E '^packages/pieces/community/[^/]+/src/lib/output-schemas\.ts$' data/.tree.txt \
  | sed -E 's|packages/pieces/community/([^/]+)/.*|\1|' | sort)
rm data/.tree.txt
echo "  pieces with output-schemas.ts in repo:"; echo "$SCHEMA_PIECES" | sed 's/^/    /'
for p in $SCHEMA_PIECES; do
  if ! jq -e --arg p "$p" '.pieces[$p]' data/repo-schemas.json > /dev/null; then
    echo "  ⚠ NEW schema piece not in data/repo-schemas.json: $p — add it (repoVersion + wiredRepo) so merged-not-live detection stays correct"
  fi
done
