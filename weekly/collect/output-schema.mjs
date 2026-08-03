// weekly/collect/output-schema.mjs
// Reads the existing outputSchema build output. `dist/` is gitignored and built
// fresh, so a missing file means "npm run build hasn't run here" — that is a
// no-data reason, not a zero.
const BUILD_HINT = 'run `npm run fetch && npm run build` before snapshotting';

// Statuses that are NOT work in flight. Excluding rather than allow-listing
// keeps a newly-introduced in-flight status visible in the roster instead of
// silently vanishing from it. `todo` alone is 733 pieces — carrying those in
// every snapshot forever would bloat the archive for no signal.
const PARKED = new Set(['todo', 'skip']);

// This file is the piece CATALOG: it is the one build output that walks every
// piece, so it is also the only place a piece's real logo URL and published name
// are to be found, both keyed by `folder`. Both rosters resolve those out of it,
// which is why the lookup below lives in this module rather than in the collector
// that needs it.
const CATALOG = 'dist/output-schema/pieces.json';

// A logo is a recognition cue, not data: a row with no usable URL keeps its name
// and its count and records `logo: null`. `null` and NEVER a URL assembled from
// the folder — a guessed CDN path 200s for every piece whose folder matches its
// logo file name and silently 404s for the first one that does not, with no
// signal at snapshot time.
//
// An empty string is as unusable as no string at all: `<img src="">` re-requests
// the page itself and renders as a broken image.
const logoOf = (p) => (typeof p?.logoUrl === 'string' && p.logoUrl ? p.logoUrl : null);

// The piece's directory in the monorepo, and the only identity it keeps: the
// catalog is keyed by it, it is unique across all 756 rows, and it never changes.
// `displayName` is neither of those things — it is editorial (the cloud catalog
// renames pieces; 'Telegram Bot' and 'Google Gemini' are current examples) and
// two folders publish 'Cashfree Payments' today — so the week-over-week diff in
// view.mjs identifies a piece by this, not by its name.
//
// Spread rather than assigned, so a catalog row without one carries no key at
// all instead of a `folder: undefined` that JSON turns into a dead field. The
// diff falls back to the name for that row alone; like a logo, this is detail,
// and one junk row must not cost the other 755 pieces their roster.
const folderOf = (p) => (typeof p?.folder === 'string' && p.folder ? { folder: p.folder } : {});

// The piece's published name, or null when the catalog has none to publish. A
// LABEL, not an identity — see `folderOf` above — so it degrades exactly as a logo
// does: null, never a name assembled from the key it was looked up by. `Brevo` is
// what `sendinblue` publishes as and `SerpApi` is what `serp-api` publishes as, so
// a prettified slug is not a lesser version of this string, it is a wrong one.
const displayNameOf = (p) =>
  (typeof p?.displayName === 'string' && p.displayName ? p.displayName : null);

// `folder` → what the catalog knows about a piece that a roster keyed by slug
// cannot carry itself: its logo URL and its published name. One index and one
// read, because both come off the same row.
//
// EVERY keyable row is indexed, including the `todo`/`skip` pieces the outputSchema
// roster parks: the AI-actions initiative tracks pieces that have not started their
// outputSchema work, and those still have names and logos.
//
// OPTIONAL detail on the same terms as the rosters: a missing or malformed catalog
// yields an EMPTY index, never a throw. Every row then keeps its slug and its
// numbers — losing this file costs the decoration and nothing else. Rows the
// catalog cannot key are skipped individually so one junk entry cannot take the
// other 755 pieces' logos with it.
//
// One entry per folder, last row winning. A folder is a directory, so the catalog
// publishes each exactly once — 756 rows, 756 keys today — and two rows claiming
// one folder is a catalog bug to fix there, not a merge to attempt here.
export function readCatalogIndex(readJson) {
  const index = new Map();
  try {
    const { pieces } = readJson(CATALOG);
    if (!Array.isArray(pieces)) return index;
    for (const p of pieces) {
      if (typeof p?.folder !== 'string' || !p.folder) continue;
      index.set(p.folder, { displayName: displayNameOf(p), logo: logoOf(p) });
    }
  } catch {
    // Deliberately empty: an empty index IS the degraded answer.
  }
  return index;
}

// The roster is DETAIL behind the tile, so it degrades on its own: a missing or
// malformed pieces.json costs the per-piece list, never the headline numbers.
function readRoster(readJson) {
  try {
    const { pieces } = readJson(CATALOG);
    if (!Array.isArray(pieces)) throw new Error('pieces.json has no `pieces` array');
    return pieces
      .filter((p) => !PARKED.has(p?.status))
      .map((p) => {
        // typeof, not truthiness: a 0-action piece is a real row.
        if (typeof p.displayName !== 'string' || !p.displayName) throw new Error('a piece has no displayName');
        if (typeof p.actions !== 'number') throw new Error(`${p.displayName}: actions is not a number`);
        if (typeof p.triggers !== 'number') throw new Error(`${p.displayName}: triggers is not a number`);
        // These rows ARE catalog rows, so the folder and the URL are read
        // straight off them — no lookup needed, and neither shares the numeric
        // fields' all-or-nothing strictness.
        return { ...folderOf(p), name: p.displayName, actions: p.actions, triggers: p.triggers,
                 stage: p.status, tier: p.tier, logo: logoOf(p) };
      })
      .sort((a, b) => b.actions - a.actions || a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function collectOutputSchema({ readJson }) {
  try {
    const s = readJson('dist/output-schema/summary.json');
    if (!s?.status) throw new Error('summary.json has no `status` block');
    // typeof, not truthiness: every numeric field here follows the same
    // zero-survives rule, so a real 0 must never read as "missing".
    const num = (v, name) => {
      if (typeof v !== 'number') throw new Error(`summary.json ${name} is not a number`);
      return v;
    };
    return {
      status: 'ok',
      live: num(s.status.live, 'status.live'),
      mergedNotLive: num(s.status['merged-not-live'], 'status.merged-not-live'),
      review: num(s.status.review, 'status.review'),
      todo: num(s.status.todo, 'status.todo'),
      totalPieces: num(s.totals?.pieces, 'totals.pieces'),
      roster: readRoster(readJson),
    };
  } catch (err) {
    return { status: 'no-data', reason: `outputSchema summary unavailable (${err.message}) — ${BUILD_HINT}` };
  }
}
