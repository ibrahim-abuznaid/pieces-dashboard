#!/usr/bin/env node
// Landing page: composes the two workstream summaries. Run AFTER the other builds.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage } from '../lib/render.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

renderPage({
  templatePath: join(ROOT, 'template.html'),
  themePath: join(ROOT, '../shared/theme.css'),
  data: { os: read('../dist/output-schema/summary.json'), ai: read('../dist/ai-actions/summary.json') },
  outPath: join(ROOT, '../dist/index.html'),
});
console.log('✓ landing built');
