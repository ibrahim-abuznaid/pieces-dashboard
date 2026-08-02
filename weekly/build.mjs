#!/usr/bin/env node
// weekly/build.mjs
// CI-safe: a PURE RENDER of the committed archive. It fetches nothing, shells
// out to nothing, and never writes weeks.json — snapshots are appended locally
// by weekly/snapshot.mjs. CI runs this daily, so a build that could mutate the
// archive would rewrite history every morning.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../lib/render.mjs';
import { readArchive } from './lib/archive.mjs';
import { buildView } from './lib/view.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function buildAll({ archiveDir = join(HERE, 'data'), outDir = join(HERE, '../dist/weekly') } = {}) {
  const archive = readArchive(join(archiveDir, 'weeks.json'));
  // Precompute one view per week so the client only ever does a lookup — no
  // view logic is duplicated in the template.
  const views = {};
  for (const w of archive.weeks) views[w.week] = buildView(archive, { weekId: w.week });
  const latest = archive.weeks.at(-1)?.week ?? null;
  const data = latest ? { views, default: latest } : { views: {}, default: null };

  const html = renderPage({
    templatePath: join(HERE, 'template.html'),
    themePath: join(HERE, '../shared/theme.css'),
    data,
    outPath: join(outDir, 'index.html'),
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'summary.json'),
    `${JSON.stringify(latest ? views[latest] : { empty: true, weeks: [] }, null, 2)}\n`);
  return { html, views, latest };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { latest } = buildAll();
  console.log(`✓ weekly built${latest ? ` (default ${latest})` : ' (empty archive)'}`);
}
