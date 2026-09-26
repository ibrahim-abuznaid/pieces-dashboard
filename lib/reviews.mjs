// Is an open PR approved? Read off GitHub's review list, never typed in.
//
// An APPROVED PR is finished work waiting on a merge button. The team lead
// approves and merges piece PRs himself, often a day apart, and the weekly page
// counts the approval as the work being done (lib/ai-roster.mjs, the `approved`
// stage) -- so this has to be exactly the answer GitHub's own merge box gives.
//
// Each human reviewer's LATEST verdict counts: APPROVED or CHANGES_REQUESTED,
// with DISMISSED withdrawing it. A COMMENTED review is not a verdict, so a
// comment after an approval does not undo it. Any outstanding change request
// outweighs every approval. Bots (Greptile comments on every PR) are never
// reviewers here.
//
// PURE: handed the REST `pulls/N/reviews` array, in the order GitHub returns it.
const isBot = (u) => u?.type === 'Bot' || /\[bot\]$/.test(u?.login ?? '');

export function reviewVerdict(reviews = []) {
  const latest = new Map();
  for (const rv of reviews) {
    const who = rv?.user?.login;
    if (!who || isBot(rv.user)) continue;
    if (rv.state === 'APPROVED' || rv.state === 'CHANGES_REQUESTED') latest.set(who, rv);
    else if (rv.state === 'DISMISSED') latest.delete(who);
  }
  const verdicts = [...latest.values()];
  const approvals = verdicts.filter((rv) => rv.state === 'APPROVED');
  const approved = approvals.length > 0 && !verdicts.some((rv) => rv.state === 'CHANGES_REQUESTED');
  const approvedAt = approved
    ? approvals.map((rv) => rv.submitted_at).filter(Boolean).sort().at(-1) ?? null
    : null;
  return { approved, approvedAt };
}
