// The team, in one place.
//
// It lived in two files as a two-name literal, and on 2026-09-19 both were two
// names out of date: Odai had 24 merged PRs in the dashboard's own window and
// Talal 7, a fifth of the team's output, and neither appeared anywhere on the
// page. Nobody had lied about it -- adding a person meant editing a literal in
// this repo AND two in the internal dashboard, and a change nobody can make in
// one place is a change nobody makes.
//
// These are the `key`s the internal dashboard's refresh writes into
// linear.json and github.json, NOT GitHub handles and not Linear display
// names. The mapping to those lives where each is fetched:
// dashboard/pull-github.mjs (PEOPLE[].gh) and dashboard/refresh-linear.sh
// (the assignee ids in the prompt). Those two and this one have to name the
// same people; the internal build validates every event row against its own
// roster, which is the guard that catches a half-done change.
export const PEOPLE = ['kishan', 'sanket', 'odai', 'talal'];

export const zeroed = () => Object.fromEntries(PEOPLE.map((p) => [p, 0]));

// Sum a per-person map over the roster, ignoring keys the roster does not
// name. A data file written before someone joined simply contributes nothing
// for them, which is the truth: they were not being counted yet.
export const sumOverPeople = (byPerson) =>
  PEOPLE.reduce((sum, p) => sum + (Number(byPerson?.[p]) || 0), 0);

// `kishan` -> `Kishan`. The per-person line is the one place a reader sees
// these keys, and a lowercase name reads like a database column.
export const displayName = (key) => key.charAt(0).toUpperCase() + key.slice(1);
