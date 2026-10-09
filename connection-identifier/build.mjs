#!/usr/bin/env node
// Joins the curated claims + live PR states + the cloud fetch into
// dist/connection-identifier/. No page of its own, like UI improvements: the
// weekly snapshot is this workstream's only reader. Refresh the inputs with
// `npm run fetch` first. The counting rules live in lib/connection-identifier.mjs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConnectionIdentifier, validateClaims } from '../lib/connection-identifier.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
// Optional for the same reason as in ui-improvements/build.mjs: a checkout that
// has not fetched yet builds on the curated claims alone.
const readOptional = (p) => { try { return read(p); } catch { return {}; } };

const claimsFile = read('pieces.json');
validateClaims(claimsFile);
const prData = read('../data/pr-states.json');

const { rows, summary, warnings, measured } = buildConnectionIdentifier({
  claims: claimsFile.pieces,
  none: claimsFile.none,
  coverage: read('../output-schema/data/cloud-coverage.json'),
  catalog: read('../output-schema/data/cloud-catalog.json'),
  prs: prData.prs,
  discovered: readOptional('../data/discovered-claims.json').connectionIdentifier ?? {},
  landings: readOptional('../data/landings.json'),
});

for (const w of warnings) console.warn(w);
if (!measured) {
  console.warn('WARN output-schema/data/cloud-coverage.json carries no oauth2/connIdHook — run `npm run fetch` (scripts/fetch-cloud.sh computes them). Publishing no live count and no denominator, so the weekly tile reads as not measured.');
}

const generated = new Date().toISOString().slice(0, 10);
const DIST = join(ROOT, '../dist/connection-identifier');
mkdirSync(DIST, { recursive: true });
writeFileSync(join(DIST, 'summary.json'), `${JSON.stringify({ generated, prFetched: prData.fetched, ...summary }, null, 2)}\n`);
writeFileSync(join(DIST, 'pieces.json'), `${JSON.stringify({ generated, pieces: rows }, null, 2)}\n`);
console.log(`✓ connection-identifier: ${summary.merged} of ${summary.totals.pieces ?? '?'} pieces label the account (${
  measured ? `${summary.status.live} live on cloud` : 'cloud state not measured'}; ${summary.roads.hook} hook / ${
  summary.roads.token} token) · ${summary.status.review} in review`);
