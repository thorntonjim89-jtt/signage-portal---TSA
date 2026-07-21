const { getPool } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Generic enough words that matching on them alone would pair up unrelated
// rows (nearly every sign is "signage" and gets "installed"). Deliberately
// NOT stripping single-letter words like "a"/"b" — that's exactly what
// distinguishes "Hearing Assistance Option A" from "...Option B", and a
// pure-noise single letter is harmless to keep (it just doesn't help or
// hurt any other pairing).
const STOPWORDS = new Set([
  'the', 'and', 'or', 'of', 'to', 'for', 'on', 'in', 'at',
  'install', 'installation', 'installed', 'supply', 'signage', 'sign', 'signs',
  'panel', 'panels', 'ref', 'reference', 'quantity',
]);

// `code`, when known, is excluded from the word list — it's already
// enforced separately as a hard gate below, so leaving it in here would let
// two rows that merely share a code (e.g. "ID11 - SES Office ID" and
// "ID11 - Spares" — same code, nothing else in common) trivially score 1
// on the code token alone and pass as a "match" with zero real content
// overlap.
function significantWords(normalized, code) {
  const codeNorm = code ? code.toLowerCase() : null;
  return normalized.split(' ').filter((w) => w.length > 0 && !STOPWORDS.has(w) && w !== codeNorm);
}

// Both the tracker's own labels ("ID02 - stairwell level ID") and this
// app's scheduled_work descriptions ("ID02 — stairwell level ID") lead with
// a short all-caps/alnum sign-type code — a plain word like "Remake" never
// matches this shape, so it's a safe, cheap first-pass anchor without
// needing a hand-maintained list of real codes.
function leadingCode(rawText) {
  const firstToken = String(rawText || '').trim().split(/\s+/)[0] || '';
  return /^[A-Z0-9]{2,8}$/.test(firstToken) ? firstToken : null;
}

// Matches each tracker row (already extracted from the uploaded file by
// upload-finalize.js) to at most one scheduled_work row: a leading code
// must agree when both sides have one (cheap, high-confidence), then the
// candidate with the most shared significant words wins. Ties are broken
// by lowest id rather than rejected outright — the tracker routinely
// repeats the exact same line twice (two separate ID11 spares deliveries,
// two identical restroom paddle rows), and those really are
// interchangeable: whichever tied candidate this row claims, the other
// tracker row with the same wording will claim whatever's left on its own
// turn. A row that still finds no positive-scoring candidate at all is
// left untouched — the caller can always reach that item's real Edit form
// to sort it out by hand.
function matchTrackerToProject(scheduledRows, trackerRows) {
  const pool = scheduledRows.map((r) => {
    const code = leadingCode(r.description);
    return { ...r, code, words: significantWords(normalize(r.description), code) };
  });
  const claimed = new Set();
  const changes = [];

  for (const item of trackerRows) {
    const itemCode = leadingCode(item.label);
    const itemWords = significantWords(normalize(item.label), itemCode);

    const candidates = pool.filter((r) => !claimed.has(r.id) && (!itemCode || !r.code || itemCode === r.code));
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      const score = c.words.filter((w) => itemWords.includes(w)).length;
      if (score > bestScore || (score === bestScore && score > 0 && best && c.id < best.id)) {
        best = c;
        bestScore = score;
      }
    }
    if (!best || bestScore === 0) continue;

    claimed.add(best.id);
    if (best.quantity !== item.quantity) {
      changes.push({ id: best.id, description: best.description, oldQuantity: best.quantity, newQuantity: item.quantity });
    }
  }

  return { changes, matchedRows: claimed.size, untouchedRows: scheduledRows.length - claimed.size, totalRows: scheduledRows.length };
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

    let plan;
    if (apply) {
      // Re-uses the change list the preview step already computed and the
      // team member already reviewed, rather than re-matching — the
      // uploaded file isn't guaranteed to still be around by the time
      // Apply is clicked.
      const { changes } = data;
      if (!Array.isArray(changes)) return json(400, { error: 'changes is required to apply' });
      plan = { changes, matchedRows: 0, untouchedRows: 0, totalRows: 0 };
    } else {
      // trackerItems is already parsed out of the uploaded .xlsx by
      // upload-finalize.js (kind: 'tracker') — this endpoint only matches
      // it against the project, it never touches the raw file.
      const { trackerItems } = data;
      if (!Array.isArray(trackerItems)) return json(400, { error: 'trackerItems is required for a preview' });
      const result = await client.query(
        'SELECT id, description, quantity FROM scheduled_work WHERE project_id = $1 ORDER BY id ASC',
        [projectId]
      );
      plan = matchTrackerToProject(result.rows, trackerItems);
    }

    if (apply && plan.changes.length) {
      await client.query('BEGIN');
      try {
        for (const change of plan.changes) {
          // Raising or lowering quantity can strand completed_quantity above
          // the new total (which the DB's CHECK constraint would reject) or
          // leave status/completed_at claiming "complete" when only part of
          // the corrected total is actually done — clamp and recompute both
          // in the same statement instead of just overwriting quantity.
          await client.query(
            `UPDATE scheduled_work
             SET quantity = $1,
                 completed_quantity = LEAST(completed_quantity, $1),
                 status = CASE
                   WHEN LEAST(completed_quantity, $1) <= 0 THEN 'scheduled'
                   WHEN LEAST(completed_quantity, $1) >= $1 THEN 'complete'
                   ELSE 'in_progress'
                 END,
                 completed_at = CASE WHEN LEAST(completed_quantity, $1) >= $1 THEN completed_at ELSE NULL END
             WHERE id = $2 AND project_id = $3`,
            [change.newQuantity, change.id, projectId]
          );
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
