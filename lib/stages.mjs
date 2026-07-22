// Work-in-flight stage for one tracked item: manual claim + live GitHub PR state.
// Nobody edits "stage" by hand — it is always derived here.
export function deriveStage({ assignee = null, pr = null } = {}, prStates = {}) {
  const st = pr != null ? prStates[pr] : null;
  if (st?.state === 'MERGED') return 'merged';
  if (st?.state === 'OPEN') return 'pr-open';
  // PR closed-unmerged, or number not fetched → fall back to the claim
  const claimed = assignee || (st?.assignees?.length ? st.assignees[0] : null);
  return claimed ? 'assigned' : null;
}

export function assigneesOf({ assignee = null, pr = null } = {}, prStates = {}) {
  const fromPr = pr != null ? (prStates[pr]?.assignees ?? []) : [];
  return [...new Set([assignee, ...fromPr].filter(Boolean))];
}
