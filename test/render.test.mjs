import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderPage } from '../lib/render.mjs';

function setup(tpl) {
  const dir = mkdtempSync(join(tmpdir(), 'render-'));
  writeFileSync(join(dir, 't.html'), tpl);
  writeFileSync(join(dir, 'theme.css'), 'body{color:red}');
  return dir;
}
const TPL = '<style>/*__THEME__*/</style><script>const D=/*__DATA__*/null;</script>';

test('injects theme and data', () => {
  const dir = setup(TPL);
  const out = join(dir, 'sub/out.html'); // also proves mkdir -p
  renderPage({ templatePath: join(dir, 't.html'), themePath: join(dir, 'theme.css'), data: { a: 1 }, outPath: out });
  const html = readFileSync(out, 'utf8');
  assert.ok(html.includes('body{color:red}'));
  assert.ok(html.includes('const D={"a":1};'));
});

test('escapes closing script tags in data', () => {
  const dir = setup(TPL);
  const out = join(dir, 'out.html');
  renderPage({ templatePath: join(dir, 't.html'), themePath: join(dir, 'theme.css'), data: { s: '</script><b>' }, outPath: out });
  assert.ok(!readFileSync(out, 'utf8').includes('</script><b>'));
});

test('throws when a marker is missing', () => {
  const dir = setup('<style></style>');
  assert.throws(() => renderPage({ templatePath: join(dir, 't.html'), themePath: join(dir, 'theme.css'), data: {}, outPath: join(dir, 'o.html') }), /missing/);
});

test('data with replacement patterns like $& survives literally', () => {
  const dir = setup(TPL);
  const out = join(dir, 'out.html');
  renderPage({ templatePath: join(dir, 't.html'), themePath: join(dir, 'theme.css'), data: { s: '$&' }, outPath: out });
  const html = readFileSync(out, 'utf8');
  assert.ok(html.includes('{"s":"$&"}'));
});

test('throws when data marker is missing even if theme marker present', () => {
  const dir = setup('<style>/*__THEME__*/</style>');
  assert.throws(() => renderPage({ templatePath: join(dir, 't.html'), themePath: join(dir, 'theme.css'), data: {}, outPath: join(dir, 'o.html') }), /missing/);
});
