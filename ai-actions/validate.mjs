// Pure validation of the curated AI-actions data. Returns problem strings (empty = valid).
export function validateAiData({ pieces = [], categories = [], blockers = [] }) {
  const problems = [];
  const catIds = new Set(categories.map((c) => c.id));
  if (catIds.size !== categories.length) problems.push('duplicate category id');

  const slugs = new Set();
  pieces.forEach((p, i) => {
    const at = `pieces[${i}]${p.slug ? ` (${p.slug})` : ''}`;
    for (const k of ['slug', 'atomics']) if (p[k] === undefined) problems.push(`${at} missing "${k}"`);
    if (p.pr == null && !p.held) problems.push(`${at} has no pr and no held reason`);
    if (!p.t2shared && (p.t2v === undefined || p.t2t === undefined)) problems.push(`${at} needs t2v+t2t (or t2shared)`);
    if (slugs.has(p.slug)) problems.push(`${at} duplicate slug`);
    slugs.add(p.slug);
  });

  const ids = new Set();
  blockers.forEach((b, i) => {
    const at = `blockers[${i}]${b.id ? ` (${b.id})` : ''}`;
    for (const k of ['id', 'cat', 'sev', 'title', 'why', 'fix']) if (!b[k]) problems.push(`${at} missing "${k}"`);
    if (ids.has(b.id)) problems.push(`${at} duplicate id`);
    ids.add(b.id);
    if (!catIds.has(b.cat)) problems.push(`${at} unknown cat "${b.cat}"`);
    if (!['high', 'med', 'low'].includes(b.sev)) problems.push(`${at} sev must be high|med|low`);
    if (!Array.isArray(b.pieces) || !b.pieces.length) problems.push(`${at} needs a non-empty pieces[]`);
  });
  return problems;
}
