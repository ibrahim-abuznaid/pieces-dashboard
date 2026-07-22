import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const THEME_MARKER = '/*__THEME__*/';

// Every page is built through this: theme CSS inlined, data injected as a
// script-safe JSON literal. Throws (fails the build) if a marker is absent.
export function renderPage({ templatePath, themePath, marker = '/*__DATA__*/null', data, outPath }) {
  let html = readFileSync(templatePath, 'utf8');
  if (!html.includes(THEME_MARKER)) throw new Error(`${templatePath} is missing ${THEME_MARKER}`);
  if (!html.includes(marker)) throw new Error(`${templatePath} is missing ${marker}`);
  html = html.replace(THEME_MARKER, readFileSync(themePath, 'utf8'));
  const json = JSON.stringify(data).replace(/<\/(script)/gi, '<\\/$1');
  html = html.replace(marker, json);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);
  return html;
}
