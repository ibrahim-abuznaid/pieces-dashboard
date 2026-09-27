# Weekly per-person targets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each person's weekly target (actual / target bar) inside the AI-actions, UI improvements, Piece testing and Tickets tiles of the weekly page, from W40 on.

**Architecture:** Credit is resolved at the SOURCE (PR author on each dist roster row, plus a landing scan for rows done without a PR pointer), carried onto the archived roster rows as a GitHub login, and turned into per-person counts at RENDER by re-using the tile's own "done this week" diff. Targets live in a curated `weekly/data/targets.json` and are copied into each snapshot from `from` on, so history keeps the targets it had.

**Tech Stack:** Node ESM (`.mjs`), `node:test` + `node:assert/strict`, `gh` CLI for GitHub. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-weekly-person-targets-design.md`

## Global Constraints

- Repo: `/home/ibrahim/AP_work/Activepieces_v/pieces-dashboard`, branch `feat/weekly-person-targets`. Commit per task. NEVER push.
- Run tests with `node --test` from the repo root (613 pass on the base commit). Every task ends with the WHOLE suite green.
- Comment style: this repo explains non-obvious decisions in `//` prose above the code (see any file in `weekly/`). Match that density for new code. (The no-comments rule is for the activepieces repo, not this one.)
- Unknown renders as "not measured", never as 0.
- Credit = PR author GitHub login (`user.login`), NEVER assignee.
- Person keys: `kishan`, `sanket`, `odai`, `talal`. GitHub logins: `kishanprmr`, `sanket-a11y`, `OdaiAhmed99`, `Talaljaber`.
- Target workstream keys: `aiActions`, `uiImprovements`, `testing`, `tickets`.
- Targets start `2026-W40`: `{ aiActions: { kishan: 20, odai: 20 }, uiImprovements: { talal: 15 }, testing: { sanket: 70 }, tickets: { kishan: 5, odai: 5 } }`.
- Tests and dry runs must NEVER write the committed `weekly/data/weeks.json`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A GitHub login arriving in a different case (`odaiahmed99`) must still credit Odai — pinned in Task 1.
2. One PR that ships two pieces credits its author with BOTH pieces — pinned in Task 4.
3. A piece done via an APPROVED-but-open PR counts for its author the week it was approved, and not again when it merges — pinned in Task 4.
4. A gap in the archive (or a missing/empty prior roster) yields "not measured" rows, never zeros — pinned in Task 4.
5. A typo in `targets.json` (unknown person, unknown workstream, `"20"` as a string) stops the snapshot with a message naming the bad key — pinned in Task 3.

---

### Task 1: Credit primitives — handle map, author resolution, landing discovery

**Files:**
- Modify: `weekly/collect/people.mjs`
- Create: `lib/credit.mjs`
- Modify: `lib/discover.mjs` (add `discoverLandings`, after `discoverClaims`)
- Test: `test/credit.test.mjs` (new)

**Interfaces:**
- Produces: `GITHUB: Record<personKey, login>`, `personOf(login: string|null): personKey|null` (case-insensitive) in `weekly/collect/people.mjs`.
- Produces: `authorOf({ slug: string, pr?: number|null }, rollout: 'aiActions'|'uiImprovements', prStates: object, landings: object): string|null` in `lib/credit.mjs`.
- Produces: `discoverLandings(prs: Array<{ number, mergedAt: string, base?: string|null, author?: string|null, files: Array<{ filename, patch }> }>): { outputSchema: {}, uiImprovements: { [slug]: { pr, author, mergedAt } }, aiActions: { [slug]: { pr, author, mergedAt } } }` in `lib/discover.mjs`.

- [ ] **Step 1: Write the failing tests** — create `test/credit.test.mjs`:

```js
// test/credit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GITHUB, PEOPLE, personOf } from '../weekly/collect/people.mjs';
import { authorOf } from '../lib/credit.mjs';
import { discoverLandings } from '../lib/discover.mjs';

test('every person on the roster has a GitHub handle', () =>
  assert.deepEqual(Object.keys(GITHUB).sort(), [...PEOPLE].sort()));

test('personOf maps a login to the person key', () => {
  assert.equal(personOf('kishanprmr'), 'kishan');
  assert.equal(personOf('OdaiAhmed99'), 'odai');
});

test('personOf ignores case — GitHub logins are case-insensitive', () =>
  assert.equal(personOf('odaiahmed99'), 'odai'));

test('personOf is null for anyone off the team, and for no login', () => {
  assert.equal(personOf('ibrahim-abuznaid'), null);
  assert.equal(personOf(null), null);
  assert.equal(personOf(''), null);
});

const prStates = { 101: { author: 'kishanprmr' }, 102: { author: null }, 103: {} };
const landings = { aiActions: { gmail: { pr: 200, author: 'OdaiAhmed99', mergedAt: '2026-09-20T10:00:00Z' } } };

test('authorOf prefers the author of the row\'s own PR', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: 101 }, 'aiActions', prStates, landings), 'kishanprmr'));

test('authorOf falls back to the landing PR when the pointer has no author', () => {
  assert.equal(authorOf({ slug: 'gmail', pr: 102 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: 103 }, 'aiActions', prStates, landings), 'OdaiAhmed99');
  assert.equal(authorOf({ slug: 'gmail', pr: null }, 'aiActions', prStates, landings), 'OdaiAhmed99');
});

test('authorOf never borrows another rollout\'s landing', () =>
  assert.equal(authorOf({ slug: 'gmail', pr: null }, 'uiImprovements', prStates, landings), null));

test('authorOf is null when nothing names an author', () =>
  assert.equal(authorOf({ slug: 'slack' }, 'aiActions', {}, {}), null));

const aiFile = (slug) => ({ filename: `packages/pieces/community/${slug}/src/lib/actions/a.ts`,
  patch: "@@ -1 +1,2 @@\n+  audience: 'ai',\n" });
const uiFile = (slug) => ({ filename: `packages/pieces/community/${slug}/src/lib/actions/b.ts`,
  patch: '@@ -1 +1,2 @@\n+  propertyGroups: [],\n' });

test('discoverLandings records the PR, author and merge time per slug and rollout', () => {
  const out = discoverLandings([
    { number: 10, mergedAt: '2026-09-20T10:00:00Z', base: 'main', author: 'kishanprmr', files: [aiFile('asana'), uiFile('slack')] },
  ]);
  assert.deepEqual(out.aiActions.asana, { pr: 10, author: 'kishanprmr', mergedAt: '2026-09-20T10:00:00Z' });
  assert.deepEqual(out.uiImprovements.slack, { pr: 10, author: 'kishanprmr', mergedAt: '2026-09-20T10:00:00Z' });
  assert.deepEqual(out.outputSchema, {});
});

test('discoverLandings keeps the EARLIEST merged PR — the one that made the piece done', () => {
  const out = discoverLandings([
    { number: 30, mergedAt: '2026-09-24T10:00:00Z', base: 'main', author: 'Talaljaber', files: [aiFile('asana')] },
    { number: 20, mergedAt: '2026-09-21T10:00:00Z', base: 'main', author: 'kishanprmr', files: [aiFile('asana')] },
  ]);
  assert.equal(out.aiActions.asana.pr, 20);
  assert.equal(out.aiActions.asana.author, 'kishanprmr');
});

test('discoverLandings ignores PRs that did not merge into main', () => {
  const out = discoverLandings([
    { number: 40, mergedAt: '2026-09-21T10:00:00Z', base: 'feat/asana-ai-actions-a', author: 'kishanprmr', files: [aiFile('asana')] },
    { number: 41, mergedAt: null, base: 'main', author: 'kishanprmr', files: [aiFile('gmail')] },
  ]);
  assert.deepEqual(out.aiActions, {});
});

test('discoverLandings keeps a missing author as null rather than dropping the landing', () => {
  const out = discoverLandings([{ number: 50, mergedAt: '2026-09-21T10:00:00Z', base: 'main', files: [aiFile('asana')] }]);
  assert.deepEqual(out.aiActions.asana, { pr: 50, author: null, mergedAt: '2026-09-21T10:00:00Z' });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/credit.test.mjs`
Expected: FAIL — `GITHUB`/`personOf` not exported, `lib/credit.mjs` not found.

- [ ] **Step 3: Implement.** Append to `weekly/collect/people.mjs` (after `displayName`):

```js
// Each person's GitHub login, keyed like PEOPLE. The same handles the internal
// dashboard's pull-github.mjs uses (PEOPLE[].gh) — the weekly targets credit a
// piece to the AUTHOR of the PR that shipped it, and the archive stores that
// login as a fact, so this is where a login becomes a person. Never an
// assignee: assignees and `git -S` both credit the wrong person.
export const GITHUB = {
  kishan: 'kishanprmr',
  sanket: 'sanket-a11y',
  odai: 'OdaiAhmed99',
  talal: 'Talaljaber',
};

// GitHub treats logins case-insensitively and so do its APIs' answers, so a
// login is matched the same way. Null for anyone off the team — the caller
// decides whether that is "others" or "not credited".
export function personOf(login) {
  if (typeof login !== 'string' || !login) return null;
  const want = login.toLowerCase();
  return PEOPLE.find((p) => GITHUB[p]?.toLowerCase() === want) ?? null;
}
```

Create `lib/credit.mjs`:

```js
// lib/credit.mjs
// Who shipped a piece's rollout work — the one credit rule the weekly targets
// use, resolved where the builds join their data so every dist row carries it.
//
// The row's own PR pointer wins: it is the claim a human curated or discovery
// found. A row done WITHOUT a pointer — the builds find most finished pieces on
// main, not in a claim — falls back to the landing scan (data/landings.json,
// written by scripts/fetch-pr-states.mjs): the earliest merged PR that added the
// rollout's lines to that piece. Anything else is null, which renders as "not
// credited". A guess would put a number next to a person's name that nobody can
// check.
const usable = (v) => (typeof v === 'string' && v ? v : null);

export function authorOf({ slug, pr = null }, rollout, prStates = {}, landings = {}) {
  return usable(pr != null ? prStates?.[pr]?.author : null)
    ?? usable(landings?.[rollout]?.[slug]?.author)
    ?? null;
}
```

Append to `lib/discover.mjs` (after `discoverClaims`, before `claimedPr`):

```js
// The PR that LANDED a rollout's lines on main, per piece. discoverClaims asks
// which OPEN PR is carrying a piece's work; this asks which MERGED one made the
// piece done, so the weekly targets can credit its author. Same classifier, so
// "this PR ships AI actions for asana" means one thing in both places.
//
// EARLIEST merge wins. A piece is done the week its first qualifying PR lands;
// a later PR adding three more AI actions to an already-done piece changes
// nothing the targets count. Ties on the merge instant go to the lower number.
// Only PRs merged into main count — a stacked PR merged into its parent branch
// has shipped nothing (see lib/ai-roster.mjs).
export function discoverLandings(prs) {
  const out = Object.fromEntries(ROLLOUTS.map((r) => [r, {}]));
  const earlier = (a, b) => a.mergedAt < b.mergedAt || (a.mergedAt === b.mergedAt && a.pr < b.pr);
  for (const pr of prs ?? []) {
    const n = Number(pr?.number);
    if (!Number.isInteger(n) || typeof pr.mergedAt !== 'string' || !pr.mergedAt || !intoMain(pr)) continue;
    const hit = { pr: n, author: typeof pr.author === 'string' && pr.author ? pr.author : null, mergedAt: pr.mergedAt };
    for (const [slug, rollouts] of classifyFiles(pr.files)) {
      for (const rollout of rollouts) {
        const seen = out[rollout][slug];
        if (!seen || earlier(hit, seen)) out[rollout][slug] = hit;
      }
    }
  }
  return out;
}
```

(`intoMain`, `classifyFiles` and `ROLLOUTS` already exist in `lib/discover.mjs`; `intoMain` is declared with `const` ABOVE `discoverClaims`, so placing this function after `discoverClaims` is safe.)

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `node --test test/credit.test.mjs && node --test`
Expected: PASS; whole suite 613 + new tests, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add weekly/collect/people.mjs lib/credit.mjs lib/discover.mjs test/credit.test.mjs
git commit -m "feat(credit): resolve who shipped a piece — PR author, then its landing PR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Publish the author — fetch, builds, weekly collectors, archive

**Files:**
- Modify: `scripts/fetch-pr-states.mjs` (PR record gains `author`; new landing scan writes `data/landings.json`)
- Modify: `ai-actions/build.mjs` (dist `pieces.json` rows gain `author`)
- Modify: `ui-improvements/build.mjs` (`rowFor` gains `author`)
- Modify: `weekly/collect/ai-actions.mjs`, `weekly/collect/ui-improvements.mjs` (roster rows carry `author`)
- Modify: `weekly/lib/archive.mjs` (`validateRoster`: optional non-empty string `author`)
- Test: `test/weekly-collect-dashboards.test.mjs`, `test/weekly-archive.test.mjs`

**Interfaces:**
- Consumes: `authorOf`, `discoverLandings` (Task 1).
- Produces: dist rows `{ ..., author: string|null }` in `dist/ai-actions/pieces.json` and `dist/ui-improvements/pieces.json`; archived roster rows `{ name, actions, ..., author?: string }` (key ABSENT when unknown, never null or empty); `data/landings.json` shaped `{ fetched: 'YYYY-MM-DD', since: 'YYYY-MM-DD', outputSchema: {}, uiImprovements: {...}, aiActions: {...} }`.

- [ ] **Step 1: Write the failing tests.** In `test/weekly-collect-dashboards.test.mjs`, add at the end (the file already defines `reader`, `aiRead`, `uiRead`, `AI_PIECES`, `UI_PIECES`, `UI_SUMMARY`; reuse them):

```js
// ── who shipped it ──────────────────────────────────────────────────────────
// The weekly targets credit a finished piece to the author of the PR that
// shipped it. The builds resolve that login; the collectors only carry it onto
// the archived row — spread, so an unknown author leaves no key at all.
test('the AI-actions roster carries the author a build resolved', () => {
  const out = collectAiActions({ readJson: aiRead({ 'dist/ai-actions/pieces.json': { pieces: [
    { slug: 'google-docs', atomics: 37, stage: 'merged', pr: 13926, prState: 'MERGED', author: 'kishanprmr' },
    { slug: 'airtable', atomics: 19, stage: 'merged', pr: null, prState: null, author: null },
  ] } }) });
  const byName = Object.fromEntries(out.roster.map((r) => [r.name, r]));
  assert.equal(byName['google-docs'].author, 'kishanprmr');
  assert.equal('author' in byName.airtable, false, 'an unknown author must leave no key, not a null');
});

test('the UI-improvements roster carries the author a build resolved', () => {
  const pieces = UI_PIECES.pieces.map((p) => (p.folder === 'whatsscale' ? { ...p, author: 'OdaiAhmed99' } : p));
  const out = collectUiImprovements({ readJson: uiRead({ 'dist/ui-improvements/pieces.json': { ...UI_PIECES, pieces } }) });
  const byFolder = Object.fromEntries(out.roster.map((r) => [r.folder, r]));
  assert.equal(byFolder.whatsscale.author, 'OdaiAhmed99');
  assert.equal('author' in byFolder['google-sheets'], false);
});
```

In `test/weekly-archive.test.mjs`, add (the file's valid-snapshot fixture is `ok(over)`, defined at its top):

```js
test('a roster row may carry an author login', () => {
  const s = ok();
  s.aiActions = { ...s.aiActions, roster: [{ name: 'gmail', actions: 3, stage: 'merged', author: 'kishanprmr' }] };
  assert.doesNotThrow(() => validateSnapshot(s));
});

test('a roster author must be a non-empty string when present', () => {
  for (const bad of ['', null, 42]) {
    const s = ok();
    s.aiActions = { ...s.aiActions, roster: [{ name: 'gmail', actions: 3, stage: 'merged', author: bad }] };
    assert.throws(() => validateSnapshot(s), /aiActions\.roster\[0\]\.author/);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/weekly-collect-dashboards.test.mjs test/weekly-archive.test.mjs`
Expected: FAIL — author not carried; archive accepts a bad author.

- [ ] **Step 3: Implement.**

`weekly/lib/archive.mjs`, in `validateRoster`, after the `displayName` line:

```js
    // The PR author credited with the piece (weekly/lib/targets.mjs). A login is
    // a fact or it is absent — the collectors spread it, so null never lands here.
    optionalString(at, 'author', row.author, { nullable: false });
```

`weekly/collect/ai-actions.mjs`, inside `readRoster`'s returned object, after the `displayName` spread:

```js
          ...(typeof p.author === 'string' && p.author ? { author: p.author } : {}),
```

`weekly/collect/ui-improvements.mjs`, inside `readRoster`'s returned object, after `logo`:

```js
        ...(typeof p.author === 'string' && p.author ? { author: p.author } : {}),
```

`ai-actions/build.mjs`: add `import { authorOf } from '../lib/credit.mjs';` with the other imports; after the `repoAi` line add

```js
const landings = (() => { try { return read('../data/landings.json'); } catch { return {}; } })();
```

and change the `pieces.json` writer's map to

```js
  pieces: enriched.map(({ slug, atomics, stage, pr, prState }) => ({
    slug, atomics, stage, pr, prState, author: authorOf({ slug, pr }, 'aiActions', prData.prs, landings),
  })),
```

`ui-improvements/build.mjs`: add `import { authorOf } from '../lib/credit.mjs';`; after the `discovered` line add the same `landings` reader (`read('../data/landings.json')`, `{}` on failure); in `rowFor`, after `assignees: ...`, add

```js
    author: authorOf({ slug: claim.slug, pr }, 'uiImprovements', prData.prs, landings),
```

`scripts/fetch-pr-states.mjs`:
1. Import: change `import { discoverClaims, ROLLOUTS } from '../lib/discover.mjs';` to `import { discoverClaims, discoverLandings, ROLLOUTS } from '../lib/discover.mjs';`.
2. In the `prs[n] = { ... }` record, after `url: pr.html_url,` add:

```js
    // Who wrote it — the weekly targets credit a finished piece to this login,
    // never to an assignee (lib/credit.mjs).
    author: pr.user?.login ?? null,
```

3. After the `discovered-claims.json` write and BEFORE the `for (const rollout of ROLLOUTS)` loop, add the landing scan:

```js
// Which merged PR LANDED each piece's rollout work, for the pieces the builds
// find done on main with no PR pointer (22 of 58 AI pieces and 15 of 22 UI
// pieces on 2026-09-27). The weekly targets credit its author. 21 days covers
// the week being snapshotted with two to spare; a piece that went done longer
// ago than that is not this week's work, so it needs no landing.
//
// Best-effort, unlike the PR-state fetch below: a failed scan costs credit —
// visible on the page as "not credited" — while a failed fetch costs the deploy.
const LANDING_DAYS = 21;
function landings() {
  const since = new Date(Date.now() - LANDING_DAYS * 864e5).toISOString().slice(0, 10);
  let merged = [];
  try {
    merged = gh(['pr', 'list', '--repo', REPO, '--state', 'merged', '--search', `merged:>=${since} base:main`,
      '--limit', '1000', '--json', 'number,files,author,mergedAt,baseRefName']);
  } catch (e) {
    console.warn(`⚠ landing scan skipped (${e.message}) — pieces done without a PR pointer stay uncredited`);
    return { since, ...Object.fromEntries(ROLLOUTS.map((r) => [r, {}])) };
  }
  const withPatches = [];
  for (const pr of merged.filter((p) => (p.files ?? []).some((f) => f.path?.startsWith('packages/pieces/community/')))) {
    try {
      const files = gh(['api', '--paginate', `repos/${REPO}/pulls/${pr.number}/files?per_page=100`]);
      withPatches.push({ number: pr.number, base: pr.baseRefName ?? null, mergedAt: pr.mergedAt,
        author: pr.author?.login ?? null, files });
    } catch (e) {
      console.warn(`⚠ PR #${pr.number}: files unavailable (${e.message}) — its landings are not credited`);
    }
  }
  const found = discoverLandings(withPatches);
  const total = ROLLOUTS.reduce((a, r) => a + Object.keys(found[r]).length, 0);
  console.log(`✓ found ${total} landings across ${withPatches.length} piece PRs merged since ${since}`);
  return { since, ...found };
}

writeFileSync(join(ROOT, 'data/landings.json'),
  JSON.stringify({ fetched: new Date().toISOString().slice(0, 10), ...landings() }, null, 2) + '\n');
```

- [ ] **Step 4: Run tests, then the builds against the committed data**

Run: `node --test && node ai-actions/build.mjs && node ui-improvements/build.mjs`
Expected: suite green; both builds print their `✓` line (no `data/landings.json` yet → authors come from `pr-states.json` only, which has no `author` yet → `author: null` on every row). Then check:
`node -e "const p=require('./dist/ai-actions/pieces.json').pieces;console.log(p.length, p.every(r=>'author' in r))"` → prints `<n> true`.

Do NOT run `npm run fetch` here — Task 6 does the real fetch.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-pr-states.mjs ai-actions/build.mjs ui-improvements/build.mjs weekly/collect/ai-actions.mjs weekly/collect/ui-improvements.mjs weekly/lib/archive.mjs test/weekly-collect-dashboards.test.mjs test/weekly-archive.test.mjs
git commit -m "feat(weekly): carry the PR author onto every rollout roster row

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Targets file, validation, and the snapshot copying them in

**Files:**
- Create: `weekly/data/targets.json`
- Create: `weekly/lib/targets.mjs` (validation half; Task 4 adds the counting half)
- Modify: `weekly/lib/archive.mjs` (`validateSnapshot` validates optional `snap.targets`)
- Modify: `weekly/snapshot.mjs` (`buildSnapshot` accepts `targets`; `readTargets`; `main` passes it)
- Test: `test/weekly-targets.test.mjs` (new), `test/weekly-snapshot.test.mjs`

**Interfaces:**
- Consumes: `PEOPLE` from `weekly/collect/people.mjs`.
- Produces (in `weekly/lib/targets.mjs`): `TARGET_KEYS: string[]`; `validateTargets(targets, at = 'targets'): void` (throws); `validateTargetsFile(file): void` (throws); `targetsForWeek(file|null, weekId): object|null`.
- Produces (in `weekly/snapshot.mjs`): `buildSnapshot({ weekId, today, collectors, targets = null })` — `targets` is a VALIDATED targets FILE (`{ from, targets }`) or null; the snapshot gains `targets` (the inner map) when `weekId >= from`. `readTargets(path): file|null`.

- [ ] **Step 1: Write the failing tests** — create `test/weekly-targets.test.mjs`:

```js
// test/weekly-targets.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TARGET_KEYS, validateTargets, validateTargetsFile, targetsForWeek } from '../weekly/lib/targets.mjs';

const FILE = { from: '2026-W40', targets: { aiActions: { kishan: 20, odai: 20 }, tickets: { kishan: 5 } } };

test('the committed targets file is valid and starts at W40', () => {
  const file = JSON.parse(readFileSync(new URL('../weekly/data/targets.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => validateTargetsFile(file));
  assert.equal(file.from, '2026-W40');
  assert.deepEqual(file.targets, {
    aiActions: { kishan: 20, odai: 20 },
    uiImprovements: { talal: 15 },
    testing: { sanket: 70 },
    tickets: { kishan: 5, odai: 5 },
  });
});

test('only the four tiles that carry targets are accepted', () =>
  assert.deepEqual(TARGET_KEYS, ['aiActions', 'uiImprovements', 'testing', 'tickets']));

test('an unknown workstream is named in the error', () =>
  assert.throws(() => validateTargets({ aiAction: { kishan: 20 } }), /targets\.aiAction: no such workstream/));

test('a person off the roster is named in the error', () =>
  assert.throws(() => validateTargets({ tickets: { ahmad: 5 } }), /targets\.tickets\.ahmad: not on the team roster/));

test('a target must be a positive integer — a string, a zero or a fraction is a typo', () => {
  for (const bad of ['20', 0, -1, 2.5, null]) {
    assert.throws(() => validateTargets({ tickets: { kishan: bad } }), /targets\.tickets\.kishan must be a positive integer/);
  }
});

test('the file needs a real week id in `from`', () => {
  assert.throws(() => validateTargetsFile({ ...FILE, from: 'W40' }), /from must be YYYY-Wnn/);
  assert.throws(() => validateTargetsFile({ targets: FILE.targets }), /from must be YYYY-Wnn/);
});

test('targets apply from `from` on, and never to a week before it', () => {
  assert.equal(targetsForWeek(FILE, '2026-W39'), null);
  assert.deepEqual(targetsForWeek(FILE, '2026-W40'), FILE.targets);
  assert.deepEqual(targetsForWeek(FILE, '2027-W02'), FILE.targets);
  assert.equal(targetsForWeek(null, '2026-W40'), null);
});

test('the snapshot gets a COPY — editing the file later cannot reach into history', () => {
  const t = targetsForWeek(FILE, '2026-W40');
  t.aiActions.kishan = 1;
  assert.equal(FILE.targets.aiActions.kishan, 20);
});
```

In `test/weekly-snapshot.test.mjs`, add at the end (`collectors()`, `buildSnapshot` and `validateSnapshot` are already imported/defined there):

```js
const TARGETS_FILE = { from: '2026-W40', targets: { tickets: { kishan: 5, odai: 5 } } };

test('a snapshot at or after `from` records the targets in force that week', () => {
  const snap = buildSnapshot({ weekId: '2026-W40', today: '2026-10-03', collectors: collectors(), targets: TARGETS_FILE });
  assert.deepEqual(snap.targets, { tickets: { kishan: 5, odai: 5 } });
  assert.doesNotThrow(() => validateSnapshot(snap));
});

test('a snapshot before `from` carries no targets at all', () => {
  const snap = buildSnapshot({ weekId: '2026-W39', today: '2026-09-26', collectors: collectors(), targets: TARGETS_FILE });
  assert.equal('targets' in snap, false);
});

test('no targets file means no targets', () => {
  const snap = buildSnapshot({ weekId: '2026-W40', today: '2026-10-03', collectors: collectors() });
  assert.equal('targets' in snap, false);
});

test('the archive refuses a snapshot whose targets name someone off the roster', () => {
  const snap = buildSnapshot({ weekId: '2026-W40', today: '2026-10-03', collectors: collectors(), targets: TARGETS_FILE });
  snap.targets = { tickets: { ahmad: 5 } };
  assert.throws(() => validateSnapshot(snap), /not on the team roster/);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/weekly-targets.test.mjs test/weekly-snapshot.test.mjs`
Expected: FAIL — module / file not found; snapshot has no `targets`.

- [ ] **Step 3: Implement.**

Create `weekly/data/targets.json`:

```json
{
  "from": "2026-W40",
  "targets": {
    "aiActions": { "kishan": 20, "odai": 20 },
    "uiImprovements": { "talal": 15 },
    "testing": { "sanket": 70 },
    "tickets": { "kishan": 5, "odai": 5 }
  }
}
```

Create `weekly/lib/targets.mjs`:

```js
// weekly/lib/targets.mjs
// Per-person weekly targets: what the lead expects of each person in the tile
// that measures it, and — Task 4 — what they actually did.
//
// The targets are curated in weekly/data/targets.json and COPIED into each
// snapshot from `from` on (weekly/snapshot.mjs). The archive keeps the targets
// in force that week, so a later change never rewrites history, and no week
// before `from` can show a miss against a target that did not exist yet.
import { PEOPLE } from '../collect/people.mjs';

// The four tiles a target can sit in, by archive key. Anything else is a typo,
// and a typo here silently drops a person's row from the page — so it throws.
export const TARGET_KEYS = ['aiActions', 'uiImprovements', 'testing', 'tickets'];

const WEEK_RE = /^\d{4}-W\d{2}$/;
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

export function validateTargets(targets, at = 'targets') {
  if (!isObject(targets)) throw new Error(`${at} must be an object`);
  for (const [key, byPerson] of Object.entries(targets)) {
    if (!TARGET_KEYS.includes(key)) {
      throw new Error(`${at}.${key}: no such workstream — use one of ${TARGET_KEYS.join(', ')}`);
    }
    if (!isObject(byPerson)) throw new Error(`${at}.${key} must be an object of person → target`);
    for (const [person, n] of Object.entries(byPerson)) {
      if (!PEOPLE.includes(person)) {
        throw new Error(`${at}.${key}.${person}: not on the team roster (${PEOPLE.join(', ')})`);
      }
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${at}.${key}.${person} must be a positive integer, got ${JSON.stringify(n)}`);
      }
    }
  }
}

export function validateTargetsFile(file) {
  if (!isObject(file)) throw new Error('targets.json must be an object');
  if (!WEEK_RE.test(file.from ?? '')) {
    throw new Error(`targets.json from must be YYYY-Wnn, got ${JSON.stringify(file.from)}`);
  }
  validateTargets(file.targets, 'targets.json targets');
}

// Week ids are zero-padded `YYYY-Wnn`, so string order is week order.
export function targetsForWeek(file, weekId) {
  return file && weekId >= file.from ? structuredClone(file.targets) : null;
}
```

`weekly/lib/archive.mjs`: add `import { validateTargets } from './targets.mjs';` below the existing imports, and in `validateSnapshot`, right after the `decisions` check:

```js
  // Optional: every week before weekly/data/targets.json's `from` has none.
  if (snap.targets !== undefined) validateTargets(snap.targets);
```

`weekly/snapshot.mjs`:
1. Add `import { validateTargetsFile, targetsForWeek } from './lib/targets.mjs';` with the other imports, and `const TARGETS = join(ROOT, 'weekly/data/targets.json');` below `ARCHIVE`.
2. Change `buildSnapshot`'s signature to `export function buildSnapshot({ weekId, today, collectors, targets = null })` and insert, just before `snap.decisions = deriveDecisions(snap);`:

```js
  // The targets in force THIS week, copied in so the archive never depends on
  // today's targets.json to explain a past week. Absent before `from`.
  const inForce = targetsForWeek(targets, weekId);
  if (inForce) snap.targets = inForce;
```

3. Add, above `main`:

```js
// Curated like notes.json: absent means no targets, malformed fails loudly — a
// half-read targets file would publish some people's rows and not others'.
export function readTargets(path = TARGETS) {
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, 'utf8'));
  validateTargetsFile(file);
  return file;
}
```

4. In `main`, pass `targets: readTargets(),` into the `buildSnapshot({ weekId, today, ... })` call (next to `weekId, today,`).

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `node --test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add weekly/data/targets.json weekly/lib/targets.mjs weekly/lib/archive.mjs weekly/snapshot.mjs test/weekly-targets.test.mjs test/weekly-snapshot.test.mjs
git commit -m "feat(weekly): per-person targets file, copied into each snapshot from W40

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Count each person's week — shared diff, targets in the view model

**Files:**
- Create: `weekly/lib/landed.mjs` (MOVE `priorRoster`, `folderOf`, `alreadyDone` out of `weekly/lib/view.mjs`, with their comments; add `landedRows`)
- Modify: `weekly/lib/targets.mjs` (add `checkedByPerson`, `targetsFor`)
- Modify: `weekly/lib/view.mjs` (import from `landed.mjs`; `pieceStrip` uses `landedRows`; `personLine` uses `checkedByPerson`; every tile gains `targets`)
- Test: `test/weekly-targets.test.mjs`, `test/weekly-view.test.mjs`

**Interfaces:**
- Consumes: `personOf`, `displayName`, `PEOPLE` (people.mjs); `snap.targets` (Task 3); roster `author` (Task 2).
- Produces: `landedRows(weeks, selected, key, isDone): Row[]|null` — null when this week has no roster or there is no legitimate prior roster. `priorRoster(weeks, selected, key)`, `alreadyDone(priorDone)` exported from `landed.mjs`.
- Produces: `checkedByPerson(byPerson, total): object|null`; `targetsFor(spec: { key, ws?, done? }, weeks, selected): null | { rows: Array<{ person, name, actual: number|null, target: number, hit: boolean }>, also: string }`.
- Produces: every view tile has `targets` (`null` when none, including degraded tiles). When `targets` is non-null, `perPerson` is `''`.

- [ ] **Step 1: Write the failing tests.** Append to `test/weekly-targets.test.mjs`:

```js
import { targetsFor, checkedByPerson } from '../weekly/lib/targets.mjs';

const AI = { key: 'aiActions', done: ['merged', 'approved'] };
const UI = { key: 'uiImprovements', done: ['live', 'merged'] };
const TESTING = { key: 'testing' };
const TICKETS = { key: 'tickets' };

const row = (name, stage, author) => ({ name, actions: 1, stage, ...(author ? { author } : {}) });
const wk = (week, over = {}) => ({ week, start: '2026-09-26', end: '2026-10-02', builtAt: '2026-10-03', decisions: [], ...over });
const ok = (roster, more = {}) => ({ status: 'ok', roster, ...more });

const TARGETS = { aiActions: { kishan: 20, odai: 20 }, uiImprovements: { talal: 15 },
                  testing: { sanket: 70 }, tickets: { kishan: 5, odai: 5 } };

const W39 = wk('2026-W39', {
  aiActions: ok([row('gmail', 'merged', 'kishanprmr'), row('asana', 'pr-open', 'kishanprmr')]),
  uiImprovements: ok([row('slack', 'merged', 'Talaljaber')]),
  testing: ok([row('apify', 'covered')]),
});
const W40 = wk('2026-W40', {
  targets: TARGETS,
  aiActions: ok([
    row('gmail', 'merged', 'kishanprmr'),        // done last week — not this week's
    row('asana', 'approved', 'kishanprmr'),      // approved this week — counts now
    row('docs', 'merged', 'kishanprmr'),         // one PR, two pieces: both count
    row('sheets', 'merged', 'kishanprmr'),
    row('notion', 'merged', 'OdaiAhmed99'),
    row('hubspot', 'merged', 'Talaljaber'),      // on the team, no AI target
    row('stripe', 'merged', 'ibrahim-abuznaid'), // off the team
    row('mistral', 'merged'),                    // no author found
    row('zoom', 'pr-open', 'OdaiAhmed99'),       // not done
  ]),
  uiImprovements: ok([row('slack', 'live', 'Talaljaber'), row('gmail', 'merged', 'talaljaber')]),
  testing: ok([row('apify', 'covered'), row('slack', 'covered'), row('gmail', 'covered')]),
  tickets: { status: 'ok', total: 9, byPerson: { kishan: 6, sanket: 1, odai: 2, talal: 0 } },
});
const WEEKS = [W39, W40];

test('AI actions: newly done pieces credited to their PR author', () => {
  const t = targetsFor(AI, WEEKS, W40);
  assert.deepEqual(t.rows, [
    { person: 'kishan', name: 'Kishan', actual: 3, target: 20, hit: false },
    { person: 'odai', name: 'Odai', actual: 1, target: 20, hit: false },
  ]);
  assert.equal(t.also, 'Talal 1 · 1 other · 1 not credited');
});

test('the rows and the also line add up to every piece done this week', () => {
  const t = targetsFor(AI, WEEKS, W40);
  const alsoTotal = [...t.also.matchAll(/(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0);
  const rowsTotal = t.rows.reduce((s, r) => s + r.actual, 0);
  assert.equal(rowsTotal + alsoTotal, 7, 'asana, docs, sheets, notion, hubspot, stripe, mistral');
});

test('an approved piece that merges the next week does not count twice', () => {
  const W41 = wk('2026-W41', { targets: TARGETS,
    aiActions: ok(W40.aiActions.roster.map((r) => (r.name === 'asana' ? { ...r, stage: 'merged' } : r))) });
  const t = targetsFor(AI, [W39, W40, W41], W41);
  assert.equal(t.rows.find((r) => r.person === 'kishan').actual, 0);
});

test('UI improvements: live and merged both count, logins match case-insensitively', () => {
  const t = targetsFor(UI, WEEKS, W40);
  assert.deepEqual(t.rows, [{ person: 'talal', name: 'Talal', actual: 1, target: 15, hit: false }]);
  assert.equal(t.also, '');
});

test('piece testing: every newly covered piece is Sanket\'s — a set difference, never negative', () => {
  const t = targetsFor(TESTING, WEEKS, W40);
  assert.deepEqual(t.rows, [{ person: 'sanket', name: 'Sanket', actual: 2, target: 70, hit: false }]);
  const shrunk = wk('2026-W40', { targets: TARGETS, testing: ok([row('zendesk', 'covered')]) });
  assert.equal(targetsFor(TESTING, [W39, shrunk], shrunk).rows[0].actual, 1, 'a reset week still counts what it added');
});

test('tickets: read straight off byPerson, the rest of the team on the also line', () => {
  const t = targetsFor(TICKETS, WEEKS, W40);
  assert.deepEqual(t.rows, [
    { person: 'kishan', name: 'Kishan', actual: 6, target: 5, hit: true },
    { person: 'odai', name: 'Odai', actual: 2, target: 5, hit: false },
  ]);
  assert.equal(t.also, 'Sanket 1');
});

test('hitting the target exactly is a hit', () => {
  const exact = wk('2026-W40', { targets: { tickets: { kishan: 6 } }, tickets: W40.tickets });
  assert.equal(targetsFor(TICKETS, [exact], exact).rows[0].hit, true);
});

test('no prior week to diff against: not measured, never zero', () => {
  const t = targetsFor(AI, [W40], W40);
  assert.deepEqual(t.rows.map((r) => [r.actual, r.hit]), [[null, false], [null, false]]);
  assert.equal(t.also, '');
});

test('a gap in the archive is not measured either', () => {
  const W38 = { ...W39, week: '2026-W38' };
  assert.equal(targetsFor(AI, [W38, W40], W40).rows[0].actual, null);
});

test('tickets whose per-person counts do not add up are not measured', () => {
  const bad = wk('2026-W40', { targets: TARGETS, tickets: { status: 'ok', total: 99, byPerson: { kishan: 6 } } });
  assert.equal(targetsFor(TICKETS, [bad], bad).rows[0].actual, null);
});

test('a degraded workstream draws no target rows', () => {
  const down = wk('2026-W40', { targets: TARGETS, aiActions: { status: 'no-data', reason: 'x' } });
  assert.equal(targetsFor(AI, [W39, down], down), null);
});

test('a week with no targets, or none for this tile, has none', () => {
  assert.equal(targetsFor(AI, WEEKS, { ...W40, targets: undefined }), null);
  assert.equal(targetsFor(AI, WEEKS, { ...W40, targets: { tickets: { kishan: 5 } } }), null);
});

test('checkedByPerson refuses a map that does not sum to its total', () => {
  assert.deepEqual(checkedByPerson({ kishan: 2, odai: 3 }, 5), { kishan: 2, odai: 3 });
  assert.equal(checkedByPerson({ kishan: 2, odai: 3 }, 6), null);
  assert.equal(checkedByPerson({ kishan: '2' }, 2), null);
  assert.equal(checkedByPerson({}, 0), null);
  assert.equal(checkedByPerson(undefined, 0), null);
});
```

Append to `test/weekly-view.test.mjs` (uses that file's `snap`, `tileOf`, `buildView`):

```js
// ── per-person targets ──────────────────────────────────────────────────────
test('a week with targets puts them on their tile and drops the tickets name line', () => {
  const targets = { tickets: { kishan: 5 } };
  const v = buildView({ weeks: [snap('2026-W40', { targets })] });
  const t = tileOf(v, 'tickets');
  assert.deepEqual(t.targets.rows, [{ person: 'kishan', name: 'Kishan', actual: 5, target: 5, hit: true }]);
  assert.equal(t.targets.also, 'Sanket 6');
  assert.equal(t.perPerson, '', 'the rows replace the per-person line');
});

test('every tile without targets carries targets: null, and keeps its per-person line', () => {
  const v = buildView({ weeks: [snap('2026-W31')] });
  for (const t of v.tiles) assert.equal(t.targets, null, t.key);
  assert.equal(tileOf(v, 'tickets').perPerson, 'Kishan 5 · Sanket 6');
});

test('a degraded tile carries no targets', () => {
  const v = buildView({ weeks: [snap('2026-W40', { targets: { tickets: { kishan: 5 } },
    tickets: { status: 'no-data', reason: 'x' } })] });
  assert.equal(tileOf(v, 'tickets').targets, null);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/weekly-targets.test.mjs test/weekly-view.test.mjs`
Expected: FAIL — `targetsFor` not exported; tiles have no `targets`.

- [ ] **Step 3: Implement.**

Create `weekly/lib/landed.mjs`. MOVE (cut, do not copy) `priorRoster`, `folderOf` and `alreadyDone` from `weekly/lib/view.mjs` into it, each with the comment block that sits above it in view.mjs today, `export` on `priorRoster` and `alreadyDone`. Top of file:

```js
// weekly/lib/landed.mjs
// Which pieces crossed the line THIS week: done in the selected snapshot, not
// done in the immediately-preceding one. The pieces strip labels these "Done
// this week" and the per-person targets credit them, so both read ONE diff and
// can never disagree about what a week delivered.
import { previousWeekId } from '../../lib/isoweek.mjs';
```

and append:

```js
// Null when there is nothing honest to diff: this week recorded no roster, or
// there is no legitimate prior roster (first week, a gap, an empty or degraded
// prior — see priorRoster). The caller renders null as "not measured"; an empty
// array is a real answer, a week that finished nothing.
//
// `filter` copies: the collector's ordering is preserved and the snapshot's own
// roster is never sorted in place.
export function landedRows(weeks, selected, key, isDone) {
  const rows = selected?.[key]?.roster;
  if (!Array.isArray(rows)) return null;
  const prior = priorRoster(weeks, selected, key);
  if (!prior) return null;
  const before = alreadyDone(prior.filter(isDone));
  return rows.filter(isDone).filter((r) => !before(r));
}
```

In `weekly/lib/view.mjs`: remove the `previousWeekId` import if nothing else in view.mjs uses it (grep first), add `import { landedRows } from './landed.mjs';` and `import { targetsFor, checkedByPerson } from './targets.mjs';`, then replace `pieceStrip`'s body (keep its comment block) with:

```js
function pieceStrip(ws, spec, weeks, selected) {
  const rows = Array.isArray(ws.roster) ? ws.roster : [];
  if (!rows.length) return null;                  // no roster recorded: nothing to show
  const isDone = (r) => spec.done.includes(r.stage);
  const landed = landedRows(weeks, selected, spec.key, isDone);
  // With nothing to diff against, the tile's own number is the whole answer, so
  // a workstream with nothing finished yet carries no strip at all.
  if (!landed) {
    const done = rows.filter(isDone);
    return done.length ? capped('pieces', 'Done in total', done.map(toChip)) : null;
  }
  // A week that moved nothing has to say it out loud — silence reads as "not
  // measured".
  return landed.length
    ? capped('pieces', 'Done this week', [...landed].sort((a, b) => a.name.localeCompare(b.name)).map(toChip))
    : { kind: 'pieces', label: 'Nothing new this week', items: [], rest: [], more: 0 };
}
```

Replace `personLine`'s body (keep its comments) with:

```js
function personLine(byPerson, total) {
  const checked = checkedByPerson(byPerson, total);
  return checked ? Object.entries(checked).map(([key, n]) => `${titled(key)} ${n}`).join(' · ') : '';
}
```

In `buildView`, the degraded-tile return object gains `targets: null`. For an ok tile, compute `const targets = targetsFor(spec, weeks, selected);` before the return, change the `perPerson` line to `perPerson: targets ? '' : (spec.perPerson?.(ws) ?? ''),` and add `targets,` after it, with this comment above it:

```js
      // The lead's per-person targets for this tile, from the week's own
      // snapshot (weekly/lib/targets.mjs). They replace the tickets tile's name
      // line rather than repeating it: the rows plus their "also" line are
      // checked to add up to the same total, so nobody drops out of view.
```

Append to `weekly/lib/targets.mjs` (add `personOf, displayName` to its people.mjs import and `import { landedRows } from './landed.mjs';`):

```js
// ── what each person actually did ───────────────────────────────────────────
// A per-person map is only usable when it is all numbers AND adds up to the
// total it sits under — the check the tickets tile's name line has always made
// (view.mjs personLine now calls this). A map that disagrees with its own total
// is not a measurement.
export function checkedByPerson(byPerson, total) {
  const entries = Object.entries(byPerson ?? {});
  if (!entries.length) return null;
  if (entries.some(([, n]) => typeof n !== 'number' || !Number.isFinite(n))) return null;
  if (entries.reduce((sum, [, n]) => sum + n, 0) !== total) return null;
  return Object.fromEntries(entries);
}

// Credit for a piece that crossed the line this week. The rollouts credit the
// PR author the build resolved (lib/credit.mjs) — a login off the team is
// "others", no login is "not credited", never a guess. The tester is Sanket's
// project and piece-tester-web records no per-plan author, so every piece it
// newly covers is his.
const OTHERS = 'others';
const UNCREDITED = 'uncredited';
const byAuthor = (r) => (typeof r.author === 'string' && r.author ? (personOf(r.author) ?? OTHERS) : UNCREDITED);
const CREDIT = { aiActions: byAuthor, uiImprovements: byAuthor, testing: () => 'sanket' };

// Counts per credit key, or null when the week cannot be measured. Pieces use
// the tile's own "done this week" diff (landed.mjs), so the per-person numbers
// plus the "also" line are exactly the strip's pieces. `spec.done` absent means
// every roster row is done — the tester's roster lists only covered pieces.
function countsFor(spec, ws, weeks, selected) {
  if (spec.key === 'tickets') return checkedByPerson(ws.byPerson, ws.total);
  const credit = CREDIT[spec.key];
  if (!credit) return null;
  const isDone = spec.done ? (r) => spec.done.includes(r.stage) : () => true;
  const landed = landedRows(weeks, selected, spec.key, isDone);
  if (!landed) return null;
  const counts = {};
  for (const r of landed) {
    const who = credit(r);
    counts[who] = (counts[who] ?? 0) + 1;
  }
  return counts;
}

// Everything a target row does not show, so nothing done this week is hidden:
// team members without a target here, then people off the team, then pieces
// no author could be found for.
function alsoLine(counts, goals) {
  const parts = PEOPLE.filter((p) => !(p in goals) && counts[p] > 0).map((p) => `${displayName(p)} ${counts[p]}`);
  if (counts[OTHERS] > 0) parts.push(`${counts[OTHERS]} ${counts[OTHERS] === 1 ? 'other' : 'others'}`);
  if (counts[UNCREDITED] > 0) parts.push(`${counts[UNCREDITED]} not credited`);
  return parts.join(' · ');
}

// The target block for one tile, or null when the week set none for it or the
// tile is degraded (it already says "not measured this week"). Rows follow
// targets.json order. `actual` is null — "not measured" — whenever the counts
// are; the template never draws that as 0.
export function targetsFor(spec, weeks, selected) {
  const goals = selected?.targets?.[spec.key];
  if (!goals || !Object.keys(goals).length) return null;
  const ws = selected[spec.ws ?? spec.key];
  if (ws?.status !== 'ok') return null;
  const counts = countsFor(spec, ws, weeks, selected);
  const rows = Object.entries(goals).map(([person, target]) => {
    const actual = counts ? (counts[person] ?? 0) : null;
    return { person, name: displayName(person), actual, target, hit: actual !== null && actual >= target };
  });
  return { rows, also: counts ? alsoLine(counts, goals) : '' };
}
```

If an existing view test `deepEqual`s a whole tile object, add `targets: null` to its expected object — that is the only permitted change to existing tests in this task. All existing strip tests must pass UNCHANGED (they prove the move of `priorRoster`/`alreadyDone` preserved behaviour).

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `node --test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add weekly/lib/landed.mjs weekly/lib/targets.mjs weekly/lib/view.mjs test/weekly-targets.test.mjs test/weekly-view.test.mjs
git commit -m "feat(weekly): count each person's week off the tile's own done-this-week diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Draw the target rows

**Files:**
- Modify: `weekly/template.html` (CSS block + `targetsHtml` + `tileHtml`)
- Test: `test/weekly-render.test.mjs`

**Interfaces:**
- Consumes: tile `targets` (`null | { rows: [{ person, name, actual, target, hit }], also }`) from Task 4.
- Produces: markup `<ul class="targets">` of `<li class="target[ hit][ unmeasured]">` rows, each `<span class="who">`, `<span class="bar" aria-hidden="true"><span class="fill" style="width:N%"></span></span>`, `<span class="score">`; then an optional `<div class="note also">also: …</div>`.

- [ ] **Step 1: Write the failing tests.** Append to `test/weekly-render.test.mjs` (uses its `snap`, `render`, `renderDom`; `tileOf(dom, title)`, `pageCss(html)` and `declarationsFor(css, selector)` already exist there — read them before use):

```js
// ── per-person targets ──────────────────────────────────────────────────────
const TARGET_WEEK = snap('2026-W40', { targets: { tickets: { kishan: 5, odai: 5 } },
  tickets: { status: 'ok', total: 9, byPerson: { kishan: 6, sanket: 1, odai: 2, talal: 0 },
             prsMerged: { kishan: 0 }, reviews: { kishan: 0 }, shipped: [] } });

test('a tile with targets draws one row per person with actual/target', () => {
  const tile = tileOf(renderDom([TARGET_WEEK]), 'Tickets solved');
  assert.match(tile, /<ul class="targets"/);
  assert.match(tile, /<li class="target hit">[\s\S]*?Kishan[\s\S]*?6\/5[\s\S]*?✓/);
  assert.match(tile, /<li class="target">[\s\S]*?Odai[\s\S]*?2\/5/);
  assert.match(tile, /also: Sanket 1/);
  assert.doesNotMatch(tile, /Kishan 6 · Sanket 1/, 'the rows replace the per-person line');
});

test('the bar fills to the share of the target and never past full', () => {
  const tile = tileOf(renderDom([TARGET_WEEK]), 'Tickets solved');
  assert.match(tile, /Kishan[\s\S]*?class="fill" style="width:100%"/);
  assert.match(tile, /Odai[\s\S]*?class="fill" style="width:40%"/);
});

test('a row that could not be measured says so and draws no fill', () => {
  const w = snap('2026-W40', { targets: { aiActions: { kishan: 20 } },
    aiActions: { status: 'ok', merged: 2, prOpen: 0, assigned: 0, held: 0, totalPieces: 28, blockersOpen: 0,
                 roster: [{ name: 'gmail', actions: 1, stage: 'merged', author: 'kishanprmr' }] } });
  const tile = tileOf(renderDom([w]), 'AI-actions');
  assert.match(tile, /<li class="target unmeasured">[\s\S]*?— \/ 20 · not measured/);
  assert.match(tile, /class="fill" style="width:0%"/);
});

test('a week before the targets existed renders no target markup at all', () => {
  const dom = renderDom([snap('2026-W31')]);
  assert.doesNotMatch(dom, /class="targets"/);
});

test('a target row is one line, whatever the name — the page height budget', () => {
  const css = pageCss(render([TARGET_WEEK]).html);
  assert.equal(declarationsFor(css, 'ul.targets .target')['white-space'], 'nowrap');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/weekly-render.test.mjs`
Expected: FAIL — no `.targets` markup.

- [ ] **Step 3: Implement.** In `weekly/template.html`:

CSS — insert directly after the `.nodata b { ... }` rule:

```css
  /* Per-person weekly targets (weekly/data/targets.json): one row per person —
     name, a bar filled to their share of the target, actual/target, and a ✓
     when hit. Every row is ONE line at a fixed height, whatever the name, for the
     same reason a chip is: the page's height budget holds only while no block
     grows with its content. The ✓ and the dashed empty bar are the non-colour
     cues, as the delta's glyph and the degraded tile's dashed edge are. Hitting
     a target is a gain, so it is the one bar drawn in the live green. */
  ul.targets { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 4px; }
  ul.targets .target { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center;
                       gap: 8px; font-size: 12.5px; line-height: 18px; white-space: nowrap; }
  ul.targets .who { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
  ul.targets .bar { display: block; height: 6px; border-radius: 999px; background: var(--s-todo); overflow: hidden; }
  ul.targets .fill { display: block; height: 100%; background: var(--bar-hue); }
  ul.targets .hit .fill { background: var(--s-live); }
  ul.targets .unmeasured .bar { background: transparent; border: 1px dashed var(--border); }
  ul.targets .score { font-variant-numeric: tabular-nums; color: var(--text-primary); }
  ul.targets .unmeasured .score { color: var(--text-muted); }
```

JS — add above `function tileHtml(t)`:

```js
// The per-person target rows (see the CSS above). `actual` null means the week
// could not be measured, and that is said in words — never drawn as a 0 or an
// empty bar that reads like one. The bar is decorative: the score beside it is
// the accessible text.
function targetsHtml(tg) {
  if (!tg || !tg.rows.length) return '';
  const rows = tg.rows.map((r) => {
    const measured = typeof r.actual === 'number';
    const pct = measured ? Math.round(Math.min(r.actual / r.target, 1) * 100) : 0;
    const cls = `target${r.hit ? ' hit' : ''}${measured ? '' : ' unmeasured'}`;
    const score = measured
      ? `${num(r.actual)}/${num(r.target)}${r.hit ? ' <span class="tick" aria-label="target hit">✓</span>' : ''}`
      : `— / ${num(r.target)} · not measured`;
    return `<li class="${cls}"><span class="who">${esc(r.name)}</span><span class="bar" aria-hidden="true"><span class="fill" style="width:${pct}%"></span></span><span class="score">${score}</span></li>`;
  }).join('');
  return `<ul class="targets" aria-label="Weekly targets">${rows}</ul>${
    tg.also ? `<div class="note also">also: ${esc(tg.also)}</div>` : ''}`;
}
```

In `tileHtml`, in the ok-tile template, insert `${targetsHtml(t.targets)}` on its own line directly after the `<div><span class="big">…</div>` number line and before the `t.perPerson` line.

- [ ] **Step 4: Run to verify they pass, then the whole suite**

Run: `node --test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add weekly/template.html test/weekly-render.test.mjs
git commit -m "feat(weekly): draw per-person target rows inside their tiles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end on real data (scratch copy — never the committed archive)

**Files:** none committed except, if the real fetch changed them, the refreshed `data/*.json` files in ONE separate commit.

- [ ] **Step 1: Make a scratch copy** so no step can touch the committed archive:

```bash
rm -rf /tmp/pd-e2e && cp -r /home/ibrahim/AP_work/Activepieces_v/pieces-dashboard /tmp/pd-e2e && cd /tmp/pd-e2e
```

- [ ] **Step 2: Real fetch + build** (network only, ~3–4 min; light on memory):

```bash
npm run fetch && npm run build
```

Expected: `✓ found N landings across M piece PRs merged since …`, `data/landings.json` exists, and `node -e "const p=require('./dist/ai-actions/pieces.json').pieces.filter(r=>['merged','approved'].includes(r.stage));console.log(p.length, p.filter(r=>r.author).length)"` shows most done AI rows now have an author.

- [ ] **Step 3: Real per-person numbers for last week.** In the scratch copy, set `weekly/data/targets.json` `from` to `2026-W39`, load the tester env WITHOUT echoing it (`set -a; . ./.env.local; set +a`), and re-snapshot W39 into the SCRATCH archive: `node weekly/snapshot.mjs --week=2026-W39 --force-week && node weekly/build.mjs`. Print the four target blocks: `node -e "const v=require('./dist/weekly/summary.json');for(const t of v.tiles)if(t.targets)console.log(t.key,JSON.stringify(t.targets))"`. The roster is TODAY's state (09-27), diffed against the archived W38 — say so when reporting.

- [ ] **Step 4: Look at it.** Serve `/tmp/pd-e2e/dist` (`python3 -m http.server 8765 --directory /tmp/pd-e2e/dist`), open `http://localhost:8765/weekly/`, check the four tiles at 1366x768, and record the page height (`document.documentElement.scrollHeight`) against the committed W39 page's height. Stop the server after.

- [ ] **Step 5: Bring back only the refreshed data**, if Ibrahim's branch should carry it: copy `data/landings.json`, `data/pr-states.json`, `data/discovered-claims.json`, `data/repo-ai-actions.json` from the scratch copy into the repo, run `node --test`, and commit them as `chore(data): refresh PR states with authors, add landings`. Never copy `weekly/data/weeks.json` or the edited `targets.json` back.
