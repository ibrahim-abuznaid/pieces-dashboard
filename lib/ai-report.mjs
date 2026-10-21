// lib/ai-report.mjs
// The PRIVATE weekly report: every finding by piece, with file:line and a
// one-line why, then the rollout pieces that are stuck. It names pieces and
// actions, so it is only ever written outside this repo (the --private dir of
// scripts/fetch-ai-audit.mjs) -- never to dist/, data/ or stdout.
//
// PURE: handed the audit's { counts, findings, tooling } and the rollout's
// { rows } (or null when the funnel did not run), returns markdown.
const CODE = 'https://github.com/activepieces/activepieces/blob';
const P2 = ['S1b', 'S5', 'S8', 'S9'];
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const show = (c) => (c?.actions == null ? 'not measured' : `${c.actions} actions / ${c.pieces} pieces`);

export function renderReport({ audit, rollout = null }) {
  const { counts, findings, tooling = [] } = audit;
  const sha = counts.commit ?? 'main';
  const at = (f, line = f.line) => (f.file ? `[${f.file.split('/').slice(4).join('/') || f.file}${line ? `:${line}` : ''}](${CODE}/${sha}/${f.file}${line ? `#L${line}` : ''})` : '');
  const L = [];
  L.push(`# AI actions audit — main ${String(counts.commit ?? '').slice(0, 7)} (${counts.committedAt ?? '?'})`, '');
  L.push(`PRIVATE. Names pieces and actions; never commit or paste it into the public dashboard repo. Generated ${counts.fetched ?? ''}.`, '');
  L.push(`- ${counts.ai.pieces} AI pieces, ${counts.ai.actions} AI actions; ${counts.ai.unresolvedProps} have a prop the audit could not type (S1/S1b are a floor).`);
  L.push(`- K4: ${counts.k4.p1PassPct}% of AI actions pass every P1; ${counts.k4.piecesCleanOfP1} of ${counts.ai.pieces} pieces clean of P1`
    + (counts.k4.piecesCleanIncludingS2 == null ? '.' : `, ${counts.k4.piecesCleanIncludingS2} also clean of undeclared demotions.`));
  for (const k of ['S1', 'S2', 'S3', 'S4', 'S6', 'S7', ...P2]) L.push(`- ${k} (${counts.checks[k].severity}): ${show(counts.checks[k])}`);
  if (counts.checks.S2.demoted) L.push(`- Demoted both → human since baseline ${String(counts.baseline?.commit ?? '').slice(0, 7)}: ${show(counts.checks.S2.demoted)} (S2 is the part with no breaking-changes entry).`);
  L.push('');

  const p1 = findings.filter((f) => f.severity === 'P1');
  L.push(`## P1 findings — ${p1.length} across ${new Set(p1.map((f) => f.piece)).size} pieces`, '');
  if (!p1.length) L.push('None.', '');
  const byPiece = new Map();
  for (const f of p1) byPiece.set(f.piece, [...(byPiece.get(f.piece) ?? []), f]);
  for (const [piece, list] of [...byPiece].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    L.push(`### ${piece} (${list.length})`, '');
    for (const f of list.sort((a, b) => a.check.localeCompare(b.check) || String(a.action).localeCompare(String(b.action)))) {
      const what = f.action ? `\`${f.action}\`${f.displayName ? ` (${f.displayName})` : ''}` : 'piece';
      const where = f.props?.length ? f.props.map((p) => at(f, p.line)).join(', ') : at(f);
      L.push(`- **${f.check}** ${what} — ${where} — ${f.why}${f.actions?.length ? `: ${f.actions.map((a) => `\`${a}\``).join(', ')}` : ''}`);
    }
    L.push('');
  }

  const p2 = findings.filter((f) => P2.includes(f.check));
  L.push(`## P2 counts per piece — ${p2.length} findings`, '', `| piece | ${P2.join(' | ')} | total |`, `|---|${P2.map(() => '---:').join('|')}|---:|`);
  const p2By = new Map();
  for (const f of p2) {
    const row = p2By.get(f.piece) ?? Object.fromEntries(P2.map((k) => [k, 0]));
    row[f.check]++;
    p2By.set(f.piece, row);
  }
  const total = (r) => P2.reduce((s, k) => s + r[k], 0);
  for (const [piece, r] of [...p2By].sort((a, b) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]))) {
    L.push(`| ${cell(piece)} | ${P2.map((k) => r[k] || '').join(' | ')} | ${total(r)} |`);
  }
  L.push('');

  L.push('## Rollout', '');
  if (!rollout?.rows) {
    L.push('Not measured this run.', '');
  } else {
    const n = rollout.npm;
    const c = rollout.cloud;
    L.push(`- npm at main: ${n ? `${n.atMain}/${n.measured}` : 'not measured'}; merge → npm minutes median ${n?.lagMinutes?.median ?? '—'}, p90 ${n?.lagMinutes?.p90 ?? '—'}, max ${n?.lagMinutes?.max ?? '—'}; collisions ${n?.collisions ?? '—'}.`);
    L.push(`- Cloud serving main's version: ${c ? `${c.served}/${c.measured}` : 'not measured'}; with every AI action: ${c ? `${c.servedWithAi}/${c.measured}` : '—'}.`, '');
    const stuck = rollout.rows.filter((r) => r.stuck24h || r.collision || r.npmBehind);
    L.push(`### Stuck, collided or behind — ${stuck.length}`, '');
    if (!stuck.length) L.push('None.', '');
    else {
      L.push('| piece | main | npm latest | Cloud | merged | why |', '|---|---|---|---|---|---|');
      for (const r of stuck.sort((a, b) => a.slug.localeCompare(b.slug))) {
        const why = [
          r.collision && `npm had ${r.mainVersion} ${-r.lagMin} min before the merge (version collision?)`,
          r.npmBehind && 'npm latest is behind main',
          r.stuck24h && (r.cloudRegistered === false ? 'not on Cloud' : r.served ? `Cloud is missing ${r.missingAi.length} AI action(s)` : 'Cloud serves an older version'),
        ].filter(Boolean).join('; ');
        L.push(`| ${cell(r.slug)} | ${cell(r.mainVersion)} | ${cell(r.npmLatest ?? '—')} | ${cell(r.cloudVersion ?? '—')} | ${cell(r.mergedAt?.slice(0, 16) ?? '—')} | ${cell(why)} |`);
      }
      L.push('');
    }
    const waiting = rollout.rows.filter((r) => r.servedWithAi === false && !r.stuck24h);
    if (waiting.length) {
      L.push(`### Not serving main yet, merged under 24 h ago — ${waiting.length}`, '', '| piece | main | npm latest | Cloud | merged |', '|---|---|---|---|---|');
      for (const r of waiting.sort((a, b) => a.slug.localeCompare(b.slug))) {
        L.push(`| ${cell(r.slug)} | ${cell(r.mainVersion)} | ${cell(r.npmLatest ?? '—')} | ${cell(r.cloudVersion ?? '—')} | ${cell(r.mergedAt?.slice(0, 16) ?? '—')} |`);
      }
      L.push('');
    }
    const gaps = rollout.rows.filter((r) => r.served == null || r.npmAtMain == null || r.mergedAt == null);
    if (gaps.length) L.push(`Unmeasured (a call failed 3 times): ${gaps.map((r) => r.slug).join(', ')}.`, '');
  }

  if (tooling.length) {
    L.push('## Tooling', '', 'Files the walker could not read (the audit skipped them):', '');
    for (const t of tooling) L.push(`- ${t.piece}: ${t.file} — ${cell(t.error)}`);
    L.push('');
  }
  return L.join('\n');
}
