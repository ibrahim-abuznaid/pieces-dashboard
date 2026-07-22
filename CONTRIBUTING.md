# Updating the dashboards

Everything on the site is either **computed** (cloud API, upstream repo, GitHub PR states — hands off)
or **manual state in one of three JSON files**. You edit JSON, push to `main`, and Actions rebuilds
the site in ~2–3 minutes. Never edit `dist/` or any generated file.

## Claim a piece (stage → *assigned*)

**Output-schema work** — add your entry in `output-schema/overrides.json` under `pieces`:

```jsonc
"airtable": { "assignee": "kishanprmr" }
```

**AI-actions work** — only needed while there's no PR; add in `ai-actions/overrides.json` under `pieces`:

```jsonc
"resend": { "assignee": "sanket-a11y" }
```

## Record your PR (stage → *PR open*, then *merged* automatically)

Add the upstream PR number next to your claim:

```jsonc
"airtable": { "assignee": "kishanprmr", "pr": 14400 }
```

From here GitHub is the source of truth: when the PR merges, the nightly refresh (or any push)
flips the stage to **merged** — and for output-schema, to **live** once cloud serves the schema.
If you're on the PR as a GitHub assignee, the *assigned* stage is even picked up without an
overrides entry (AI-actions PRs already work this way).

## Curated AI-actions facts

Atomics counts, Tier-2 results, notes, held reasons → `ai-actions/pieces.json`.
Blockers → `ai-actions/blockers.json` (set `"done": true` when resolved).
`node --test` validates all of it — a typo fails CI, nothing breaks silently.

## Rules

- Stage is never written by hand — it is always derived.
- Public repo: GitHub handles only, bare `PIE-###` ids only, no Linear titles, no $ figures, no secrets.
- Check the Actions tab if your push doesn't appear on the site within ~5 minutes.
