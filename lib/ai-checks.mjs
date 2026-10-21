// lib/ai-checks.mjs
// The static checks' catalogue -- id, severity, what each catches -- and the
// version math they share. Its own module, free of the TypeScript compiler, so
// the page build and the rollout can name a check or compare versions without
// loading what lib/ai-audit.mjs needs to parse code.
//
// Severity is the council's (C §3.2): P1 only where a real failure stands
// behind the rule; P2 is shown without a target, because a target on a style
// check gets satisfied by pasting the regex's favourite words (trap T18).

// The engine where AI actions stop showing in the human step picker. A piece
// with AI actions and a floor under it shows them to humans on older engines.
export const CANVAS_FLOOR = '0.86.4';

export const CHECKS = {
  S1: { severity: 'P1', title: 'optional Checkbox on an AI update action (saved state)' },
  S1b: { severity: 'P2', title: 'optional Array or dynamic props on an AI update action' },
  S2: { severity: 'P1', title: 'demoted both/unset → human with no breaking-changes entry' },
  S3: { severity: 'P1', title: `minimumSupportedRelease below ${CANVAS_FLOOR} on a piece with AI actions` },
  S4: { severity: 'P1', title: 'minimumSupportedRelease above the latest release' },
  S5: { severity: 'P2', title: 'same intent shown to agents twice (AI action + visible twin)' },
  S6: { severity: 'P1', title: 'AI action never referenced outside its own file' },
  S7: { severity: 'P1', title: 'duplicate action name in a piece' },
  S8: { severity: 'P2', title: 'AI action without outputSchema (deletes exempt)' },
  S9: { severity: 'P2', title: 'AI action without classification' },
};

const parse = (s) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s ?? '');
  return m ? m.slice(1).map(Number) : null;
};

// x.y.z ordering: -1, 0 or 1, and null when either side is not a version.
// Pre-release suffixes are ignored; piece versions and AP releases have none.
export function compareSemver(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
