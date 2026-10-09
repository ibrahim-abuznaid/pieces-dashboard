// lib/connection-identifier.mjs
// Which pieces label a new connection with the account it belongs to — the
// email or name shown under a connection on the Connections page and in the
// builder's connection picker. PURE: the build hands it the claims file, the
// cloud fetch and the PR states, and gets rows and a summary back.
//
// A piece gets there by one of two roads, and only one of them is visible on
// cloud:
//
//   · HOOK  — the piece's auth defines `getConnectionIdentifier`. The framework
//     publishes `hasConnectionIdentifier: true` on that auth, so the cloud
//     catalog says it outright (scripts/fetch-cloud.sh records it as
//     `connIdHook`). Measured, never curated.
//   · TOKEN — the OAuth provider returns the email in its token response or an
//     OIDC `id_token`, and the server reads it with no piece code at all
//     (Google's `email` scope, Microsoft's `openid email profile`). Nothing on
//     the piece says so: the scope is the only trace, and scopes such as
//     Outlook's `{accessMode}` resolve at runtime. So these rows are curated in
//     connection-identifier/pieces.json, and count as live once their PR merged
//     and the piece is on cloud — the one place this workstream takes a merge
//     on trust, for at most one release train.
//
// The denominator is every OAuth2 piece on cloud, minus the pieces whose
// provider exposes no identity at all (the claims file's `none` list). It
// grows by itself when a new OAuth2 piece ships, so the gap it opens is the
// rollout's real remaining work rather than a list someone has to remember.
import { deriveStage, assigneesOf } from './stages.mjs';
import { claimedPr } from './discover.mjs';
import { authorOf } from './credit.mjs';

export const ROADS = ['hook', 'token'];
const LANDED = ['live', 'merged'];

const folderOf = (npmName) => npmName.replace('@activepieces/piece-', '');

export function validateClaims(file) {
  const pieces = file?.pieces;
  const none = file?.none;
  if (!Array.isArray(pieces)) throw new Error('connection-identifier/pieces.json: `pieces` must be an array');
  if (!Array.isArray(none)) throw new Error('connection-identifier/pieces.json: `none` must be an array');
  const seen = new Set();
  for (const [i, c] of pieces.entries()) {
    const at = `pieces[${i}]`;
    if (typeof c?.slug !== 'string' || !c.slug) throw new Error(`${at}.slug must be a non-empty string`);
    if (!ROADS.includes(c.road)) throw new Error(`${at} (${c.slug}): road must be one of ${ROADS.join(', ')}, got ${JSON.stringify(c.road)}`);
    if (c.pr != null && !Number.isInteger(c.pr)) throw new Error(`${at} (${c.slug}): pr must be an integer`);
    if (seen.has(c.slug)) throw new Error(`${c.slug} is listed twice in pieces`);
    seen.add(c.slug);
  }
  for (const [i, n] of none.entries()) {
    const at = `none[${i}]`;
    if (typeof n?.slug !== 'string' || !n.slug) throw new Error(`${at}.slug must be a non-empty string`);
    if (typeof n.reason !== 'string' || !n.reason) throw new Error(`${at} (${n.slug}): every no-identity piece needs its reason`);
    if (seen.has(n.slug)) throw new Error(`${n.slug} is in both pieces and none — it either has an identifier road or it has none`);
  }
}

// `measured` is whether the coverage file carries the two fields at all. A file
// fetched before they existed has neither, and reading it as "no piece has a
// hook" would publish a false 0 and a false "merged but not live" ask for every
// hook piece — so an unmeasured file claims nothing about cloud.
function stageOf(claim, { hookLive, onCloud, measured }, prs) {
  if (measured && hookLive) return 'live';
  const derived = deriveStage(claim, prs);
  if (derived === 'merged') return claim.road === 'token' && measured && onCloud ? 'live' : 'merged';
  if (derived === 'pr-open') return 'review';
  if (derived === 'assigned') return 'assigned';
  return 'planned';
}

export function buildConnectionIdentifier({
  claims, none = [], coverage, catalog, prs = {}, discovered = {}, landings = {},
}) {
  const covByFolder = new Map(coverage.map((c) => [folderOf(c.name), c]));
  const catByFolder = new Map(catalog.map((p) => [folderOf(p.name), p]));
  const measured = coverage.some((c) => typeof c?.connIdHook === 'boolean');
  const noneSlugs = new Set(none.map((n) => n.slug));
  const warnings = [];

  const rowFor = (claim) => {
    const c = covByFolder.get(claim.slug);
    const cat = catByFolder.get(claim.slug);
    const pr = claim.pr ?? null;
    const stage = stageOf(claim, { hookLive: c?.connIdHook === true, onCloud: Boolean(c), measured }, prs);
    return {
      folder: claim.slug,
      displayName: cat?.displayName || claim.slug,
      logoUrl: cat?.logoUrl ?? null,
      steps: (c?.totalActions ?? 0) + (c?.totalTriggers ?? 0),
      road: claim.road,
      stage,
      pr,
      prState: pr != null ? (prs[pr]?.state ?? null) : null,
      mergedAt: pr != null ? (prs[pr]?.mergedAt ?? null) : null,
      assignees: assigneesOf({ assignee: claim.assignee ?? null, pr }, prs),
      author: authorOf({ slug: claim.slug, pr, stage }, 'connectionIdentifier', prs, landings),
      note: claim.note ?? null,
    };
  };

  const rows = claims.map((c) => rowFor({ ...c, pr: claimedPr(c.pr ?? null, discovered, c.slug) }));
  const listed = new Set(rows.map((r) => r.folder));

  // A hook PR nobody claimed. Discovery reads only `getConnectionIdentifier`
  // (lib/discover.mjs), so whatever it finds is the hook road.
  for (const [slug, pr] of Object.entries(discovered)) {
    if (listed.has(slug)) continue;
    rows.push(rowFor({ slug, road: 'hook', pr }));
    listed.add(slug);
  }

  // A hook that reached cloud without passing through the claims file. The
  // cloud flag is the measurement, so it counts; the WARN names the piece so
  // the row (and the PR that dates it) is a copy-paste away.
  if (measured) {
    for (const [slug, c] of covByFolder) {
      if (listed.has(slug) || c.connIdHook !== true) continue;
      warnings.push(`WARN ${slug} publishes a connection-identifier hook but has no row in connection-identifier/pieces.json — add it (slug + road + pr) so the week it landed can be attributed`);
      rows.push(rowFor({ slug, road: 'hook' }));
      listed.add(slug);
    }
  }

  const landed = rows.filter((r) => LANDED.includes(r.stage));
  for (const r of landed) {
    if (noneSlugs.has(r.folder)) {
      warnings.push(`WARN ${r.folder} is listed under none in connection-identifier/pieces.json but now labels its connections — move it to pieces`);
    }
  }

  // A set, so a piece is counted once however many reasons put it in: OAuth2 on
  // cloud, a hook on any auth, or landed outright. The last keeps the headline
  // inside its own denominator when a claim precedes the piece reaching cloud.
  let denominator = null;
  if (measured) {
    const eligible = new Set();
    for (const [slug, c] of covByFolder) if (c.oauth2 === true || c.connIdHook === true) eligible.add(slug);
    for (const r of landed) eligible.add(r.folder);
    const landedSlugs = new Set(landed.map((r) => r.folder));
    for (const slug of noneSlugs) if (!landedSlugs.has(slug)) eligible.delete(slug);
    denominator = eligible.size;
  }

  rows.sort((a, b) => b.steps - a.steps || a.folder.localeCompare(b.folder));

  const count = (s) => rows.filter((r) => r.stage === s).length;
  const status = {
    ...(measured ? { live: count('live') } : {}),
    merged: count('merged'),
    review: count('review'),
    assigned: count('assigned'),
    planned: count('planned'),
  };
  const summary = {
    totals: {
      pieces: denominator,
      oauth2: measured ? [...covByFolder.values()].filter((c) => c.oauth2 === true).length : null,
      noIdentity: noneSlugs.size,
      claimed: rows.length,
    },
    status,
    merged: (status.live ?? 0) + status.merged,
    roads: Object.fromEntries(ROADS.map((road) => [road, landed.filter((r) => r.road === road).length])),
  };
  return { rows, summary, warnings, measured };
}

// ── a past week ─────────────────────────────────────────────────────────────
// The block a week archived before this workstream existed should have had,
// rebuilt from the two timestamps GitHub keeps per PR. `merged` and nothing
// narrower: whether a piece was live on cloud that week is in no timestamp we
// hold, so no row is ever written as `live` and the block carries no `live`
// count — the same shape the archive accepts from the UI-improvements backfill.
//
// `rowsNow` supplies only display detail (name, logo, size), taken from today's
// build. `totalPieces` is today's denominator for the same reason the
// UI-improvements backfill uses today's catalog: the past week's catalog was
// never recorded.
const onOrBefore = (iso, end) => typeof iso === 'string' && iso.slice(0, 10) <= end;

export function blockAt({ claims, prs, rowsNow, totalPieces, end }) {
  const byFolder = new Map(rowsNow.map((r) => [r.folder, r]));
  const roster = [];
  for (const claim of claims) {
    const pr = claim.pr != null ? prs[claim.pr] : null;
    if (!pr) continue;
    let stage = null;
    if (onOrBefore(pr.mergedAt, end)) stage = 'merged';
    else if (onOrBefore(pr.createdAt, end)) stage = 'review';
    if (!stage) continue;
    const now = byFolder.get(claim.slug);
    roster.push({
      folder: claim.slug,
      name: claim.slug,
      displayName: now?.displayName ?? null,
      actions: now?.steps ?? 0,
      stage,
      logo: now?.logoUrl ?? null,
      ...(typeof pr.author === 'string' && pr.author ? { author: pr.author } : {}),
    });
  }
  roster.sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  const count = (s) => roster.filter((r) => r.stage === s).length;
  return {
    status: 'ok',
    merged: count('merged'),
    review: count('review'),
    assigned: 0,
    totalPieces,
    roster,
  };
}
