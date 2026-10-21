// lib/ai-rollout.mjs
// Merged → on npm → served on Cloud, per AI piece, and the counts the page
// shows (council C §4.1 stages 1, 2 and 4; METHODOLOGY.md K3).
//
// PURE: handed what scripts/fetch-ai-rollout.mjs fetched, never a network.
//
// "Merged" is not "live". A piece merges, the publish job puts it on npm, and
// only after Cloud ingests that version does an agent see its AI actions. Each
// stage is its own column, and none is ever added to another.
//
// "Not measured" is null, never false: a Cloud call that failed three times
// says nothing about the piece, so it leaves the denominator instead of
// counting as "not served".
import { compareSemver } from './ai-checks.mjs';

const MIN = 60_000;
const DAY_MS = 24 * 60 * MIN;
const ms = (iso) => (typeof iso === 'string' && !Number.isNaN(Date.parse(iso)) ? Date.parse(iso) : null);

// Where a stage stands for one piece.
//   piece   { slug, version, aiActions[] } from the audit's roster
//   npm     { latest, publishedAt } (publishedAt = time[main version]) or { error }
//   cloud   { version, aiActions[] } | { missing: true } (404) | { error }
//   mergedAt  the main commit that last bumped the piece's version, or null
export function pieceRollout({ piece, npm, cloud, mergedAt, now }) {
  const npmOk = npm && !npm.error;
  const cloudOk = cloud && !cloud.error;
  const merged = ms(mergedAt);
  const published = npmOk ? ms(npm.publishedAt) : null;
  // Negative lag is the collision signature: npm had this version number
  // before main merged it, so the merge never published (council C §4.1).
  const lagMin = merged != null && published != null ? Math.round((published - merged) / MIN) : null;
  // Not on npm at all is a reading: behind main.
  const npmVsMain = npmOk ? (npm.latest ? compareSemver(npm.latest, piece.version) : -1) : null;
  const cloudVsMain = cloudOk && !cloud.missing ? compareSemver(cloud.version, piece.version) : null;
  const served = cloudOk ? (cloud.missing ? false : cloudVsMain != null && cloudVsMain >= 0) : null;
  const onCloud = new Set(cloudOk && !cloud.missing ? cloud.aiActions ?? [] : []);
  const missingAi = cloudOk ? piece.aiActions.filter((n) => !onCloud.has(n)) : null;
  const servedWithAi = served == null ? null : served && missingAi.length === 0;
  return {
    slug: piece.slug,
    mainVersion: piece.version,
    mergedAt: mergedAt ?? null,
    npmLatest: npmOk ? npm.latest ?? null : null,
    npmAtMain: npmVsMain == null ? null : npmVsMain === 0,
    npmBehind: npmVsMain == null ? null : npmVsMain < 0,
    npmPublishedAt: npmOk ? npm.publishedAt ?? null : null,
    lagMin,
    collision: lagMin == null ? null : lagMin < 0,
    cloudVersion: cloudOk && !cloud.missing ? cloud.version ?? null : null,
    cloudRegistered: cloudOk ? !cloud.missing : null,
    served,
    servedWithAi,
    missingAi,
    // Merged a day ago and still not serving its AI actions: the tripwire.
    // Unknown when either the merge time or the Cloud state is.
    stuck24h: servedWithAi == null || merged == null ? null : !servedWithAi && now - merged > DAY_MS,
  };
}

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

// The public counts. Each stage reports how many pieces it could measure, and
// a stage that measured none is null throughout -- a gap on the page, not 0%.
export function summarizeRollout(rows, { commit = null, fetched = null } = {}) {
  const measured = (key) => rows.filter((r) => r[key] != null);
  const count = (key) => rows.filter((r) => r[key] === true).length;
  const npmN = measured('npmAtMain').length;
  const cloudN = measured('served').length;
  const lags = rows.map((r) => r.lagMin).filter((x) => x != null && x >= 0);
  const stuckN = measured('stuck24h').length;
  return {
    commit, fetched, measured: true,
    pieces: rows.length,
    npm: npmN
      ? { measured: npmN, atMain: count('npmAtMain'), atMainPct: pct(count('npmAtMain'), npmN), behind: count('npmBehind'),
        lagMinutes: lags.length ? { n: lags.length, median: median(lags), p90: quantile(lags, 0.9), max: Math.max(...lags) } : null,
        collisions: count('collision') }
      : null,
    cloud: cloudN
      ? { measured: cloudN, registered: count('cloudRegistered'), served: count('served'), servedPct: pct(count('served'), cloudN),
        servedWithAi: count('servedWithAi'), servedWithAiPct: pct(count('servedWithAi'), cloudN) }
      : null,
    stuck24h: stuckN ? { measured: stuckN, count: count('stuck24h') } : null,
  };
}
