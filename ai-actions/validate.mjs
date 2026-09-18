// Pure validation of the curated AI-actions data. Returns problem strings (empty = valid).
export function validateAiData({ pieces = [], categories = [], blockers = [], prStates = {} }) {
  const problems = [];
  const catIds = new Set(categories.map((c) => c.id));
  if (catIds.size !== categories.length) problems.push('duplicate category id');

  const slugs = new Set();
  pieces.forEach((p, i) => {
    const at = `pieces[${i}]${p.slug ? ` (${p.slug})` : ''}`;
    for (const k of ['slug', 'atomics']) if (p[k] === undefined) problems.push(`${at} missing "${k}"`);
    if (p.pr == null && !p.held) problems.push(`${at} has no pr and no held reason`);
    // A claim pointing at a PR that closed WITHOUT merging is never a valid
    // resting state, and it is the one shape that fails silently everywhere
    // else: the number still resolves, so data/pr-states.json stays fresh while
    // the pointer rots, and deriveStage() falls back to the closed PR's own
    // assignees — reporting finished work as `assigned`. Three pieces sat that
    // way for six weeks. Either the work was superseded (point at the merged
    // PR) or abandoned (give it a `held` reason); both are one edit a human
    // makes. Empty prStates (the pure unit tests) skips the check.
    if (p.pr != null && prStates[p.pr]?.state === 'CLOSED') {
      problems.push(`${at} pr #${p.pr} closed without merging — point it at the superseding PR, or give it a held reason`);
    }
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
