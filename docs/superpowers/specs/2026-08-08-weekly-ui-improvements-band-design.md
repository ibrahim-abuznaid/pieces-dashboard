# Weekly page: "UI improvements" band

**Date:** 2026-08-08 · **Requested by:** Kareem (via Ibrahim) · **Status:** approved by Ibrahim

## What and why

The weekly page reports four workstreams. The team also ships (and benefits from)
pieces-related **UI work** — the piece-selector action/trigger descriptions project
(PR #14437, live on cloud Aug 4), builder fixes like the Call Flow dropdown fix, piece
visibility fixes — and none of it is visible on the page. Kareem asked for those updates
to appear alongside the four workstreams.

Scope confirmed with Ibrahim: **all pieces-related UI work** (not just the piece-selector
project, and regardless of author — Ahmad Tash is not in the tickets collector's people
list), as a **recurring section**, not a one-off mention.

## Design

**Curated, not derived.** "Pieces-related UI work" is a judgment call; a GitHub-derived
collector would misclassify, miss non-team authors, and could only enter data at the
Saturday snapshot. So the band follows the `notes.json` precedent exactly: display layer,
editable after a week is sealed, one JSON edit + push. `weeks.json` stays immutable and
untouched.

### Data — `weekly/data/updates.json`

```json
{
  "2026-W32": {
    "note": "Piece-selector action/trigger descriptions went live on cloud.",
    "items": [
      { "label": "#14657 disabled pieces hidden from the AI & Agents builder tab",
        "href": "https://github.com/activepieces/activepieces/pull/14657" }
    ]
  }
}
```

Week → `{ note?, items?: [{label, href?}] }`. Missing file → no bands anywhere.
Malformed JSON fails the build loudly (same rule as notes.json). Shape errors degrade
per-entry: an item without a usable `label` is dropped; a week with neither a usable
note nor any usable item renders no band.

### View — `weekly/lib/view.mjs`

`buildView(archive, { weekId, notes, updates })` gains `updates`; the view gains
`uiUpdates: { note, strip } | null`. Items map to the existing chip shape
(`{ name, href? }`, kind `updates` — no icon), through the existing `capped()` split so
"+N more" works unchanged. The band's open cap is **3** (not the tiles' 5): the band is
full-width and the half-row chip clamp guarantees ≥2 chips per row, so 3 + "+N more" is
at most 2 rows — the band stays ~100px and the landing view keeps (approximately) the
one-screen budget the page was tuned to. Notes and labels are collapsed to one line like
curated tile notes.

### Template — `weekly/template.html`

A full-width band rendered **after "Needs you"**, before the footer:

```html
<div class="band plain"><h2>UI improvements</h2>
  <div class="note">…</div>
  <ul class="strip">…chips…</ul></div>
```

Rationale for the ordering (a deliberate refinement of the approved mockup, which drew it
above "Needs you"): the page's own rule is that the one block that asks for an action is
the last thing allowed to fall below the fold, so on an overflowing week the new band
gives way to the asks, not the other way round.

`.band` today is styled urgent (sev-high red) because only asks landed there. The new
`plain` modifier keeps the band shape with neutral border and heading color. Chips reuse
`ul.strip` unchanged; existing one-line/half-row clamps and XSS escaping apply.

### Docs

README gets a short "UI improvements band" subsection next to "Curated week notes"
documenting the file, the shape, and that curation is the team's judgment of
"pieces-related UI work" regardless of author.

## Launch content

- **2026-W31** — note: piece selector now shows action/trigger descriptions;
  chip: PR #14437 (merged Jul 27).
- **2026-W32** — note: descriptions went live on cloud (project → "On Cloud + Marketing",
  Aug 4); chips: PR #14657 (disabled pieces hidden from AI & Agents tab), PR #14666
  (piece-set pagination in Platform Admin).

## Testing

- **View:** updates threading; null on weeks without entries; malformed entry/items/label
  handling; the 3-chip cap split; note collapsed to one line.
- **Render:** band renders with heading/note/linked chips; absent without an entry;
  script tags in note/labels are escaped; `.band.plain` is the neutral variant;
  band cap arithmetic stays within a 2-row budget.
- **Wiring:** `buildAll` reads `updates.json`; malformed JSON fails the build.

## Non-goals

- No fifth tile, no delta, no weekly count — there is no honest derived number here.
- No snapshot/collector changes; `snapshot.mjs`, `weeks.json`, and `verify-weekly` are
  untouched.
