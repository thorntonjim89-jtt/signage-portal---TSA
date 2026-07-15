const { getPool } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

// Ground truth for the ATO Sydney job, taken from the client's own
// Manufacturing & Installation Tracker (not the architect's design pack —
// the tracker reflects what was actually manufactured, including
// exclusions and later variations, which the original design intent
// doesn't capture). Quantity `null` means "don't touch": either the
// tracker has no confirmed count yet (a variation still being priced) or
// the item is excluded/on hold/superseded, so any scheduled_work row that
// matches it is one of the team's ad-hoc "extras" and must stay as-is.
//
// `occurrences` handles the tracker listing the same line twice (e.g. two
// separate ID11 spares deliveries) — that many scheduled_work rows will be
// matched and each gets `quantity`, oldest id first. If more rows match
// than the tracker has occurrences, none of them are touched — that's an
// ambiguity for a human to resolve, not a guess worth making automatically.
const TRACKER_ITEMS = [
  { code: 'id02', keywords: ['stairwell'], quantity: 8 },
  { code: 'id06', keywords: ['minor', 'room'], quantity: 37 },
  { code: 'id07', keywords: ['major', 'room'], quantity: 87 },
  { code: 'id11', keywords: ['ses', 'office'], quantity: 46 },
  { code: 'id11', keywords: ['spare'], quantity: 5, occurrences: 2 },
  { code: 'id11', keywords: ['sav', 'return'], quantity: null }, // variation, qty TBC
  { code: 'in01', keywords: ['ceiling', 'hung'], quantity: 31 },
  { code: 'in01', keywords: ['ceiling', 'support'], quantity: 31 },
  { code: 'st02', keywords: ['hearing', 'option a'], quantity: 4 },
  { code: 'st02', keywords: ['hearing', 'option b'], quantity: 4 },
  { code: 'dr02', keywords: ['lobby', 'signage'], quantity: 1 },
  { code: 'dr02', keywords: ['lobby', 'joinery'], quantity: 1 },
  { code: 'rr', keywords: ['restroom', 'tactile'], quantity: 25 },
  { code: 'rp', keywords: ['restroom', 'paddle'], quantity: 24, occurrences: 2 },
  { code: 'wp', keywords: ['wall', 'paddle'], quantity: 4 },
  { code: 'ps', keywords: ['a4', 'pocket'], quantity: 34 },
  { code: 'ps', keywords: ['a3', 'pocket'], quantity: 16 },
  { code: 'nb1', keywords: ['notice', 'board'], quantity: 8 },
  { code: 'pm01', keywords: ['workplace', 'joinery'], quantity: 1 },
  { code: null, keywords: ['remake', 'ccv'], quantity: 28 },
  { code: 'us001', keywords: ['emergency', 'door'], quantity: 18 },
  { code: 'us002', keywords: ['collection', 'point'], quantity: 8 },
  { code: 'us003', keywords: ['security', 'notice'], quantity: 30 },
  { code: 'us004', keywords: ['trespassing'], quantity: 30 },
  { code: 'us005', keywords: ['unauthorised', 'entry'], quantity: 30 },
  { code: 'us006', keywords: ['tailgating'], quantity: 30 }, // merged US006/US007 sign
  { code: 'us008', keywords: ['restricted', 'area'], quantity: 5 },
  { code: 'us009', keywords: ['recording'], quantity: 5 },
  { code: 'us010', keywords: ['leave', 'bags'], quantity: 1 },
  { code: 'us011', keywords: ['devices', 'cameras'], quantity: 1 },
  // Excluded / on hold / removed / superseded in the tracker — never touch:
  { code: 'us006', keywords: ['door hold'], quantity: null },
  { code: 'us007', keywords: [], quantity: null },
  { code: 'fp01', keywords: [], quantity: null },
  { code: 'wa01', keywords: [], quantity: null },
  { code: 'aed', keywords: [], quantity: null },
  { code: 'fd01', keywords: [], quantity: null },
];

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Matches a scheduled_work row's description against a tracker item: the
// leading sign-type code must agree (when the tracker item specifies one),
// and every keyword phrase must appear somewhere in the description.
function matchesItem(normalizedDescription, item) {
  if (item.code && !normalizedDescription.startsWith(item.code)) return false;
  return item.keywords.every((kw) => normalizedDescription.includes(kw));
}

async function planBackfill(client, projectId) {
  const result = await client.query(
    'SELECT id, description, quantity FROM scheduled_work WHERE project_id = $1 ORDER BY id ASC',
    [projectId]
  );
  const rows = result.rows.map((r) => ({ ...r, normalized: normalize(r.description) }));
  const claimed = new Set();
  const changes = [];

  // A row that matches more than one tracker item (e.g. a description that
  // mentions both "A4" and "A3" pocket signs, combining two line items into
  // one already-adjusted row) can't be attributed to either with confidence
  // — silently picking the first match would risk clobbering a value a
  // person already reviewed. Those rows are excluded up front rather than
  // resolved by match order.
  const itemsByRow = new Map();
  for (const row of rows) {
    const matchingItems = TRACKER_ITEMS.filter((item) => item.quantity !== null && matchesItem(row.normalized, item));
    if (matchingItems.length === 1) itemsByRow.set(row.id, matchingItems[0]);
  }

  for (const item of TRACKER_ITEMS) {
    if (item.quantity === null) continue; // deliberately left alone
    const occurrences = item.occurrences || 1;
    const matches = rows.filter((r) => !claimed.has(r.id) && itemsByRow.get(r.id) === item);
    if (matches.length !== occurrences) continue; // ambiguous or no match — skip, don't guess
    for (const row of matches) {
      claimed.add(row.id);
      if (row.quantity !== item.quantity) {
        changes.push({
          id: row.id,
          description: row.description,
          oldQuantity: row.quantity,
          newQuantity: item.quantity,
        });
      }
    }
  }

  const untouched = rows.filter((r) => !claimed.has(r.id)).length;
  return { changes, matchedRows: claimed.size, untouchedRows: untouched, totalRows: rows.length };
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (user.role !== 'team') return json(403, { error: 'Only team can run this' });
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, apply } = data;
  if (!projectId) return json(400, { error: 'projectId is required' });

  const pool = getPool();
  const client = await pool.connect();
  try {
    const projectResult = await client.query('SELECT id FROM projects WHERE id = $1', [projectId]);
    if (!projectResult.rows.length) return json(404, { error: 'Project not found' });

    const plan = await planBackfill(client, projectId);

    if (apply && plan.changes.length) {
      await client.query('BEGIN');
      try {
        for (const change of plan.changes) {
          await client.query('UPDATE scheduled_work SET quantity = $1 WHERE id = $2', [change.newQuantity, change.id]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    return json(200, { ...plan, applied: Boolean(apply) });
  } finally {
    client.release();
  }
});
