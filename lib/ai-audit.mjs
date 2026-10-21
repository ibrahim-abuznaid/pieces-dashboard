// lib/ai-audit.mjs
// The static audit of the AI actions on upstream main: what every
// `createAction({...})` declares, and the checks that have a real failure
// behind them (council C §3.2, METHODOLOGY.md L1).
//
// A port of the council's throwaway extract.cjs + analyze.py, which measured
// main @ 6d93dbc on 2026-10-20 and are this module's regression oracle
// (4,005 AI actions; S1 58/27 in total and 21/13 on saved state; S3 13/4).
//
// PURE like the rest of lib/: handed file texts, never a clone or a network.
// The only import is the TypeScript compiler, because a regex cannot see which
// props an action really has once they come from a spread or a same-file const.
//
// Two outputs, and the split is the point. `counts` is aggregate numbers only and
// is what the public repo carries (data/ai-audit.json). `findings` names the
// piece, the action and the file:line, and only ever goes to the private report:
// a public list of agent actions that silently rewrite saved settings would be
// a bug bounty for anyone but us. test/ai-audit.test.mjs and
// test/ai-audit-wiring.test.mjs fail if a name reaches `counts`.
import ts from 'typescript';
import { CANVAS_FLOOR, CHECKS, compareSemver } from './ai-checks.mjs';

export { CANVAS_FLOOR, CHECKS };

// ── extraction ──────────────────────────────────────────────────────────────
// Tests and generated declarations are not piece code; i18n holds JSON.
const SKIP_DIRS = new Set(['node_modules', 'i18n', 'test', 'tests', '__tests__']);
export function isPieceSource(path) {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((d) => SKIP_DIRS.has(d))) return false;
  const f = parts.at(-1);
  return f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts');
}

const keyOf = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) ? n.text : undefined);

function prop(lit, name) {
  if (!lit || !ts.isObjectLiteralExpression(lit)) return undefined;
  for (const p of lit.properties) {
    if (ts.isPropertyAssignment(p) && keyOf(p.name) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (ts.isMethodDeclaration(p) && keyOf(p.name) === name) return p;
  }
  return undefined;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

function fileConsts(sf) {
  const m = new Map();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) m.set(d.name.text, d.initializer);
  }
  return m;
}

// A string the code spells out: literals, templates (holes become `{…}`),
// `+` concatenation, `[...].join()` and same-file consts. Anything else is
// undefined rather than a guess.
function strOf(node, consts, depth = 0) {
  if (!node || depth > 6) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const sp of node.templateSpans) s += '{…}' + sp.literal.text;
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = strOf(node.left, consts, depth + 1);
    const r = strOf(node.right, consts, depth + 1);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return strOf(node.expression, consts, depth + 1);
  if (ts.isIdentifier(node) && consts.has(node.text)) return strOf(consts.get(node.text), consts, depth + 1);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join'
    && ts.isArrayLiteralExpression(node.expression.expression)) {
    const parts = node.expression.expression.elements.map((e) => strOf(e, consts, depth + 1));
    if (parts.every((p) => p !== undefined)) {
      const sep = node.arguments[0] ? strOf(node.arguments[0], consts, depth + 1) ?? ',' : ',';
      return parts.join(sep);
    }
  }
  return undefined;
}

// true / false, or 'expr' for anything the code computes.
function literalKind(node, consts) {
  if (!node) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node) && consts.has(node.text)) return literalKind(consts.get(node.text), consts);
  return 'expr';
}

// A defaultValue as the agent path would see it: the literal, or 'expr'.
function defaultOf(node, consts) {
  if (!node) return undefined;
  const k = literalKind(node, consts);
  if (k !== 'expr') return k;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  const s = strOf(node, consts);
  return s !== undefined ? s : 'expr';
}

function resolveObj(node, consts, depth = 0) {
  if (!node || depth > 4) return undefined;
  if (ts.isObjectLiteralExpression(node)) return node;
  if (ts.isIdentifier(node) && consts.has(node.text)) return resolveObj(consts.get(node.text), consts, depth + 1);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) {
    return resolveObj(node.expression, consts, depth + 1);
  }
  return undefined;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

// One prop: `Property.X({...})` read off the AST, or a piece helper that
// returns one (`commonProps.board(...)`), read off the helper's text. A helper
// imported from outside the piece cannot be resolved and says so (`via`), which
// is why the Checkbox counts are a floor.
function readPropEntry({ key, init, line, sf, consts, pieceHelpers }) {
  let node = init;
  for (let i = 0; i < 4 && node && ts.isIdentifier(node) && consts.has(node.text); i++) node = consts.get(node.text);
  if (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  if (node && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Property') {
    const cfg = node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0] : undefined;
    const dflt = prop(cfg, 'defaultValue');
    return { key, line, type: node.expression.name.text, required: literalKind(prop(cfg, 'required'), consts),
      hasDefault: dflt !== undefined, defaultValue: defaultOf(dflt, consts), via: 'direct' };
  }
  const fromHelper = (helperText, callText, callee) => {
    const m = helperText.match(/Property\.([A-Za-z]+)\s*\(/);
    const r = (callText ?? '').match(/required\s*:\s*(true|false)/) ?? helperText.match(/required\s*:\s*(true|false)/);
    const d = helperText.match(/defaultValue\s*:\s*(true|false)\b/);
    return { key, line, type: m ? m[1] : 'helper', required: r ? r[1] === 'true' : 'expr',
      hasDefault: /defaultValue\s*:/.test(helperText), defaultValue: d ? d[1] === 'true' : undefined, via: 'helper', callee };
  };
  if (node && ts.isCallExpression(node)) {
    const callee = node.expression.getText(sf);
    const helperText = pieceHelpers.get(callee) ?? pieceHelpers.get(callee.split('.').pop());
    if (helperText) return fromHelper(helperText, node.getText(sf), callee);
    return { key, line, type: 'helper', required: undefined, via: 'unresolved', callee };
  }
  if (node && ts.isPropertyAccessExpression(node)) {
    const t = node.getText(sf);
    const helperText = pieceHelpers.get(t) ?? pieceHelpers.get(node.name.text);
    if (helperText) return fromHelper(helperText, null, t);
  }
  return { key, line, type: 'unresolved', required: undefined, via: 'unresolved' };
}

function readProps({ node, sf, consts, pieceHelpers }) {
  const lit = resolveObj(node, consts);
  if (!lit) return { props: [], unresolved: true };
  const props = [];
  let unresolved = false;
  for (const p of lit.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = resolveObj(p.expression, consts);
      if (inner) {
        const sub = readProps({ node: inner, sf, consts, pieceHelpers });
        props.push(...sub.props);
        unresolved = unresolved || sub.unresolved;
      } else unresolved = true;
      continue;
    }
    if (ts.isPropertyAssignment(p)) {
      props.push(readPropEntry({ key: keyOf(p.name) ?? p.name.getText(sf), init: p.initializer, line: lineOf(sf, p), sf, consts, pieceHelpers }));
    } else if (ts.isShorthandPropertyAssignment(p)) {
      props.push(readPropEntry({ key: p.name.text, init: p.name, line: lineOf(sf, p), sf, consts, pieceHelpers }));
    }
  }
  return { props, unresolved };
}

// Every top-level declaration in the piece, by name, so a prop built by a
// helper in another file of the same piece can still be typed.
function helpersOf(parsed) {
  const helpers = new Map();
  for (const { sf } of parsed) {
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.initializer) continue;
          helpers.set(d.name.text, d.initializer.getText(sf));
          if (!ts.isObjectLiteralExpression(d.initializer)) continue;
          for (const p of d.initializer.properties) {
            const k = p.name ? keyOf(p.name) : undefined;
            if (!k) continue;
            helpers.set(`${d.name.text}.${k}`, p.getText(sf));
            if (!helpers.has(k)) helpers.set(k, p.getText(sf));
          }
        }
      } else if (ts.isFunctionDeclaration(st) && st.name) helpers.set(st.name.text, st.getText(sf));
    }
  }
  return helpers;
}

const AI_LINE = /^\s*audience\s*:\s*['"]ai['"]/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Is this action wired into the piece? Its variable named in another file of
// the piece (the index's `actions: [...]` or a barrel), or the action written
// inline inside createPiece. `export default` actions are imported under any
// name, so for those the file's own module path is looked for instead. null
// when neither can be asked -- unchecked, not unregistered.
function registration({ varName, inline, file, files }) {
  if (inline) return true;
  const others = files.filter((f) => f.path !== file);
  if (varName) {
    const re = new RegExp(`\\b${escapeRe(varName)}\\b`);
    return others.some((f) => re.test(f.text));
  }
  const base = file.split('/').at(-1).replace(/\.ts$/, '');
  if (!base) return null;
  const re = new RegExp(`['"][^'"]*/${escapeRe(base)}(\\.js|\\.ts)?['"]`);
  return others.some((f) => re.test(f.text)) ? true : null;
}

// `files` is [{ path, text }] with paths relative to the repo root; non-source
// paths are ignored, so a caller can hand over everything under src/.
// `packageJson` is the piece's parsed package.json, or null.
export function extractPiece({ slug, files, packageJson = null }) {
  const src = files.filter((f) => isPieceSource(f.path));
  const parsed = src.map((f) => ({ ...f, sf: ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS) }));
  const pieceHelpers = helpersOf(parsed);
  const piece = {
    slug,
    npmName: typeof packageJson?.name === 'string' ? packageJson.name : null,
    version: typeof packageJson?.version === 'string' ? packageJson.version : null,
    displayName: undefined,
    minimumSupportedRelease: undefined,
    indexFile: undefined,
    actions: [],
    factoryCalls: 0,
    grepLines: 0,
    toolingErrors: [],
  };
  for (const { path, text, sf } of parsed) {
    for (const l of text.split('\n')) if (AI_LINE.test(l)) piece.grepLines++;
    try {
      const consts = fileConsts(sf);
      const pieceCalls = [];
      walk(sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
        if (n.expression.text === 'createPiece') {
          pieceCalls.push(n);
          const lit = n.arguments[0];
          if (lit && ts.isObjectLiteralExpression(lit)) {
            piece.minimumSupportedRelease = strOf(prop(lit, 'minimumSupportedRelease'), consts);
            piece.displayName = strOf(prop(lit, 'displayName'), consts)
              ?? /createPiece\(\{[\s\S]*?displayName:\s*['"`]([^'"`]+)['"`]/.exec(text)?.[1];
            piece.indexFile = path;
          }
          return;
        }
        if (n.expression.text !== 'createAction') return;
        const lit = n.arguments[0];
        const line = lineOf(sf, n);
        if (!lit || !ts.isObjectLiteralExpression(lit)) { piece.factoryCalls++; return; }
        let decl = n.parent;
        while (decl && !ts.isVariableDeclaration(decl) && !ts.isSourceFile(decl)) decl = decl.parent;
        const varName = decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
        const stmt = varName ? decl.parent?.parent : undefined;
        const exported = Boolean(stmt && ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
        const inline = pieceCalls.some((p) => n.pos >= p.pos && n.end <= p.end);
        const audNode = prop(lit, 'audience');
        const aiNode = prop(lit, 'aiMetadata');
        const aiLit = resolveObj(aiNode, consts);
        const propsNode = prop(lit, 'props');
        const { props, unresolved } = propsNode ? readProps({ node: propsNode, sf, consts, pieceHelpers }) : { props: [], unresolved: false };
        const classNode = prop(lit, 'classification');
        piece.actions.push({
          file: path, line, varName, exported, inline,
          name: strOf(prop(lit, 'name'), consts),
          displayName: strOf(prop(lit, 'displayName'), consts),
          description: strOf(prop(lit, 'description'), consts),
          // undefined = the key is absent (the framework default, `both`);
          // '<expr>' = present but computed.
          audience: audNode ? (strOf(audNode, consts) ?? '<expr>') : undefined,
          classification: classNode ? (strOf(classNode, consts) ?? '<expr>') : undefined,
          ai: aiNode
            ? { present: true, kind: aiLit ? 'literal' : 'ref',
              desc: aiLit ? strOf(prop(aiLit, 'description'), consts) : undefined,
              descPresent: aiLit ? prop(aiLit, 'description') !== undefined : undefined,
              idem: aiLit ? literalKind(prop(aiLit, 'idempotent'), consts) : undefined }
            : { present: false },
          hasOutputSchema: prop(lit, 'outputSchema') !== undefined,
          props,
          propsUnresolved: unresolved,
          propsTextHasCheckbox: propsNode ? /Property\.Checkbox\s*\(/.test(propsNode.getText(sf)) : false,
        });
      });
    } catch (err) {
      // A shape the walker cannot read costs that file, not the run: the count
      // is reported, and the file goes to the private report.
      piece.toolingErrors.push({ file: path, error: String(err?.message ?? err) });
    }
  }
  for (const a of piece.actions) a.registered = registration({ varName: a.varName, inline: a.inline, file: a.file, files: src });
  return piece;
}

// ── checks ──────────────────────────────────────────────────────────────────
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stripAgent = (s) => norm((s ?? '').replace(/\((agent|ai)\)/gi, ''));

// An update: the agent is asked to change some fields and leave the rest. The
// word list is the council's (configure/toggle included), and `-` counts as a
// separator because a few pieces name actions in kebab case.
const UPDATE_NAME = /(^|[_-])(update|modify|edit|patch|change|set|configure|toggle)([_-]|$)/;
export const isUpdateAction = (a) => UPDATE_NAME.test(a.name ?? '')
  || /^(update|edit|modify|set )/.test((a.displayName ?? '').toLowerCase());

// Optional Checkboxes whose `false` means "do not do the extra thing", so the
// agent path filling them with false (fillDefaultsForMissingOptionalProps in
// packages/server/api/src/app/mcp/tools/mcp-utils.ts) changes nothing saved.
// The council read all 58 hits on 6d93dbc by hand: these 37 are flags, the 21
// left each map to a field the vendor saves.
// Prefixes are matched at a word boundary so `clearance` or `disabled` -- a
// saved state -- still counts.
const BEHAVIOUR_FLAG = [
  /^clear(_|[A-Z]|$)/, /^notify(_|[A-Z]|$)/, /^skip(_|[A-Z]|$)/, /^disable(_|[A-Z]|$)/,
  /^create_\w+_if_missing$/, /^create\w*IfMissing$/, /^create_missing_/,
  /^(submit|as_string|all_slides|make_open_ended|end_sale|merge_line_items)$/,
];
export const isBehaviourFlag = (key) => BEHAVIOUR_FLAG.some((re) => re.test(key ?? ''));

const optional = (p) => p.required !== true;
const isAi = (a) => a.audience === 'ai';

// S1: the props that silently reset saved state when the agent omits them.
export function checkS1(a) {
  if (!isAi(a) || !isUpdateAction(a)) return null;
  const boxes = a.props.filter((p) => p.type === 'Checkbox' && optional(p));
  if (!boxes.length) return null;
  return { stateful: boxes.filter((p) => !isBehaviourFlag(p.key)), flags: boxes.filter((p) => isBehaviourFlag(p.key)) };
}

// S1b: the same fill for the other two types it touches -- optional arrays
// become [] and dynamic props {} -- which on an update can clear a list.
export function checkS1b(a) {
  if (!isAi(a) || !isUpdateAction(a)) return null;
  const hit = a.props.filter((p) => (p.type === 'Array' || p.type === 'DynamicProperties') && optional(p));
  return hit.length ? hit : null;
}

// S8 exemption: a delete has nothing to describe, so it needs no schema.
const isDelete = (a) => a.classification === 'DESTRUCTIVE' || /^(delete|remove|archive|trash|purge|clear)/.test(a.name ?? '');

// S2's mention test. Loose on purpose -- any appearance of the display name,
// the slug, or the slug with spaces counts -- so its count is a floor.
export function mentionedIn(piece, text) {
  const t = (text ?? '').toLowerCase();
  return [piece.displayName, piece.slug, piece.slug.replace(/-/g, ' ')]
    .filter(Boolean).some((c) => t.includes(c.toLowerCase()));
}

// Each action's audience at one commit, grouped so the committed file stays
// small and a diff of it reads per piece. Unnamed actions cannot be matched
// across commits, so they are left out.
export function audiencesOf(pieces) {
  const out = {};
  for (const p of [...pieces].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const g = { both: [], ai: [], human: [], unset: [], expr: [] };
    for (const a of p.actions) {
      if (!a.name) continue;
      const k = a.audience === undefined ? 'unset' : a.audience === '<expr>' ? 'expr' : a.audience;
      (g[k] ?? g.expr).push(a.name);
    }
    for (const k of Object.keys(g)) if (g[k].length) g[k].sort(); else delete g[k];
    if (Object.keys(g).length) out[p.slug] = g;
  }
  return out;
}

const audienceAt = (base, slug, name) => {
  const g = base?.[slug];
  if (!g) return null;
  for (const [k, names] of Object.entries(g)) if (names.includes(name)) return k;
  return null;
};

// What the rollout funnel needs per AI piece. Not a finding, but it names
// pieces, so it travels in a temp file and the private report only.
export function aiRoster(pieces) {
  return pieces
    .filter((p) => p.actions.some(isAi))
    .map((p) => ({ slug: p.slug, npmName: p.npmName, version: p.version, aiActions: p.actions.filter(isAi).map((a) => a.name).filter(Boolean).sort() }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
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

const names = (props) => props.map((p) => `\`${p.key}\``).join(', ');

// The whole catalog at one commit.
//   baseline       { commit, committedAt, pieces: audiencesOf(...) } or null
//   breakingChanges the two breaking-changes files concatenated, or null when
//                  main no longer has them (S2 is then not measured, not 0)
//   latestRelease  '0.92.3', or null when neither source answered (S4 likewise)
export function auditCatalog({ pieces, baseline = null, breakingChanges = null, latestRelease = null,
  commit = null, committedAt = null, fetched = null }) {
  const findings = [];
  const add = (check, piece, a, why, extra = {}) => findings.push({
    check, severity: CHECKS[check].severity, piece: piece.slug,
    ...(a ? { action: a.name ?? null, displayName: a.displayName ?? null, file: a.file, line: a.line } : { file: piece.indexFile ?? null }),
    why, ...extra,
  });

  const all = pieces.flatMap((p) => p.actions.map((a) => ({ p, a })));
  const ai = all.filter(({ a }) => isAi(a));
  const aiPieces = pieces.filter((p) => p.actions.some(isAi));
  // Actions failing a P1 check, by piece, so K4 can count each action once.
  const p1Actions = new Set();
  const p1Pieces = new Set();
  const markP1 = (p, a) => { p1Actions.add(a); p1Pieces.add(p.slug); };
  const tally = {};
  const bump = (check, p, n = 1) => {
    const t = (tally[check] ??= { actions: 0, pieces: new Set() });
    t.actions += n; t.pieces.add(p.slug);
  };
  const s1All = { actions: 0, pieces: new Set() };
  const s8Exempt = { actions: 0, pieces: new Set() };

  for (const { p, a } of ai) {
    const s1 = checkS1(a);
    if (s1) {
      s1All.actions++; s1All.pieces.add(p.slug);
      if (s1.stateful.length) {
        bump('S1', p); markP1(p, a);
        const filled = s1.stateful.some((x) => x.hasDefault) ? 'its defaultValue or false' : 'false';
        add('S1', p, a, `optional Checkbox ${names(s1.stateful)} on an update: the agent path fills an omitted one with ${filled}, so a partial update rewrites it`,
          { props: s1.stateful.map((x) => ({ key: x.key, line: x.line })) });
      }
    }
    const s1b = checkS1b(a);
    if (s1b) {
      bump('S1b', p);
      add('S1b', p, a, `optional ${[...new Set(s1b.map((x) => x.type))].join('/')} ${names(s1b)} on an update: the agent path fills an omitted one with []/{}`,
        { props: s1b.map((x) => ({ key: x.key, line: x.line })) });
    }
    if (!a.hasOutputSchema) {
      if (isDelete(a)) { s8Exempt.actions++; s8Exempt.pieces.add(p.slug); } else {
        bump('S8', p); add('S8', p, a, 'no outputSchema, so the agent cannot plan on the result');
      }
    }
    if (a.classification === undefined) { bump('S9', p); add('S9', p, a, 'no classification (READ/WRITE/SEARCH/DESTRUCTIVE)'); }
    if (a.registered === false) {
      bump('S6', p); markP1(p, a);
      add('S6', p, a, a.varName ? `\`${a.varName}\` is not referenced by any other file of the piece, so it is probably not registered` : 'default export not imported by any other file of the piece');
    }
  }

  for (const p of aiPieces) {
    const aiHere = p.actions.filter(isAi);
    const seen = new Map();
    for (const a of p.actions) if (a.name) seen.set(a.name, (seen.get(a.name) ?? 0) + 1);
    for (const a of p.actions) {
      if (!a.name || seen.get(a.name) < 2) continue;
      if (isAi(a)) markP1(p, a);
      bump('S7', p); add('S7', p, a, `action name \`${a.name}\` is declared ${seen.get(a.name)} times in the piece`);
    }
    const visible = new Map();
    for (const v of p.actions) {
      if (v.audience === 'both' || v.audience === undefined || v.audience === '<expr>') {
        const k = stripAgent(v.displayName);
        if (k && !visible.has(k)) visible.set(k, v);
      }
    }
    for (const a of aiHere) {
      const twin = visible.get(stripAgent(a.displayName));
      if (!twin) continue;
      bump('S5', p); add('S5', p, a, `the ${twin.audience ?? 'both (unset)'} action \`${twin.name}\` shows agents the same intent`);
    }
    const floor = p.minimumSupportedRelease;
    if (compareSemver(floor, CANVAS_FLOOR) === null || compareSemver(floor, CANVAS_FLOOR) < 0) {
      bump('S3', p, aiHere.length); for (const a of aiHere) markP1(p, a);
      add('S3', p, null, floor ? `minimumSupportedRelease ${floor} is below ${CANVAS_FLOOR}: older engines show its ${aiHere.length} AI actions in the human step picker`
        : `no minimumSupportedRelease the audit can read: older engines show its ${aiHere.length} AI actions in the human step picker`);
    } else if (latestRelease && compareSemver(floor, latestRelease) > 0) {
      bump('S4', p, aiHere.length); for (const a of aiHere) markP1(p, a);
      add('S4', p, null, `minimumSupportedRelease ${floor} is above the latest release ${latestRelease}: no released engine can install it`);
    }
  }

  // S2: what was visible to agents at the baseline and is human-only now. A
  // piece-level P1 -- the demoted actions are human, so they never enter K4's
  // per-AI-action rate, only its "pieces clean" line.
  let s2 = null;
  let demoted = null;
  const s2Pieces = new Set();
  if (baseline?.pieces && breakingChanges != null) {
    demoted = { actions: 0, pieces: new Set() };
    s2 = { actions: 0, pieces: new Set() };
    for (const p of pieces) {
      const lost = p.actions.filter((a) => a.name && a.audience === 'human'
        && ['both', 'unset'].includes(audienceAt(baseline.pieces, p.slug, a.name)));
      if (!lost.length) continue;
      demoted.actions += lost.length; demoted.pieces.add(p.slug);
      if (mentionedIn(p, breakingChanges)) continue;
      s2.actions += lost.length; s2.pieces.add(p.slug); s2Pieces.add(p.slug);
      add('S2', p, null, `${lost.length} action(s) moved both → human since ${String(baseline.commit ?? '').slice(0, 7)} and the piece is not named in either breaking-changes file`,
        { actions: lost.map((a) => a.name).sort() });
    }
  }

  const counted = (check) => {
    const t = tally[check];
    return { severity: CHECKS[check].severity, actions: t?.actions ?? 0, pieces: t?.pieces.size ?? 0 };
  };
  const audience = { both: 0, ai: 0, human: 0, unset: 0, expr: 0 };
  for (const { a } of all) {
    const k = a.audience === undefined ? 'unset' : a.audience === '<expr>' ? 'expr' : a.audience;
    audience[k in audience ? k : 'expr']++;
  }
  const descWords = ai.map(({ a }) => a.ai.desc).filter((d) => typeof d === 'string').map((d) => d.split(/\s+/).filter(Boolean).length);
  const propCounts = ai.map(({ a }) => a.props.length);
  const p1AiActions = [...p1Actions].filter(isAi).length;
  const cleanPieces = aiPieces.filter((p) => !p1Pieces.has(p.slug));

  const counts = {
    commit, committedAt, fetched,
    baseline: baseline ? { commit: baseline.commit ?? null, committedAt: baseline.committedAt ?? null } : null,
    latestRelease, canvasFloor: CANVAS_FLOOR,
    catalog: {
      pieces: pieces.length, actions: all.length, audience,
      factoryCalls: pieces.reduce((s, p) => s + p.factoryCalls, 0),
      toolingErrors: pieces.reduce((s, p) => s + p.toolingErrors.length, 0),
    },
    ai: {
      pieces: aiPieces.length, actions: ai.length,
      // The grep count of `audience: 'ai'` lines; equal to `actions` while no
      // AI action is built by a factory the AST cannot follow.
      grepLines: aiPieces.reduce((s, p) => s + p.grepLines, 0),
      // AI actions with a prop the audit could not type: the S1/S1b floor.
      unresolvedProps: ai.filter(({ a }) => a.propsUnresolved || a.props.some((x) => x.via === 'unresolved')).length,
      unregisteredUnchecked: ai.filter(({ a }) => a.registered === null).length,
    },
    checks: {
      S1: { ...counted('S1'), allOptionalCheckbox: { actions: s1All.actions, pieces: s1All.pieces.size } },
      S1b: counted('S1b'),
      S2: s2
        ? { severity: 'P1', actions: s2.actions, pieces: s2.pieces.size, demoted: { actions: demoted.actions, pieces: demoted.pieces.size } }
        : { severity: 'P1', actions: null, pieces: null, demoted: null, reason: baseline?.pieces ? 'no-breaking-changes-docs' : 'no-baseline' },
      S3: counted('S3'),
      S4: latestRelease ? counted('S4') : { severity: 'P1', actions: null, pieces: null, reason: 'no-latest-release' },
      S5: counted('S5'),
      S6: counted('S6'),
      S7: counted('S7'),
      S8: { ...counted('S8'), exempt: { actions: s8Exempt.actions, pieces: s8Exempt.pieces.size } },
      S9: counted('S9'),
    },
    k4: {
      p1Actions: p1AiActions,
      p1PassPct: pct(ai.length - p1AiActions, ai.length),
      piecesCleanOfP1: cleanPieces.length,
      piecesCleanIncludingS2: s2 ? cleanPieces.filter((p) => !s2Pieces.has(p.slug)).length : null,
    },
    soft: {
      descWords: { p10: quantile(descWords, 0.1), median: median(descWords), p90: quantile(descWords, 0.9) },
      props: { median: median(propCounts), p90: quantile(propCounts, 0.9), max: propCounts.length ? Math.max(...propCounts) : null },
    },
  };
  const tooling = pieces.flatMap((p) => p.toolingErrors.map((e) => ({ piece: p.slug, ...e })));
  return { counts, findings, tooling };
}
