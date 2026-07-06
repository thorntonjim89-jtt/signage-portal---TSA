const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// SECURITY: cost prices live only in this endpoint and are only ever
// returned to 'team' (who sets the markup) or the owning 'supplier' (their
// own cost). Clients are blocked outright, at the top of the handler, so a
// bug in any one branch below can't accidentally leak a cost price to them.

function sanitizeRequest(row, user) {
  const base = {
    id: row.id,
    quote_id: row.quote_id,
    status: row.status,
    message: row.message,
    requested_at: row.requested_at,
    responded_at: row.responded_at,
  };
  if (user.role === 'team') {
    return {
      ...base,
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      supplier_email: row.supplier_email,
      cost_price: row.cost_price,
      notes: row.notes,
    };
  }
  if (user.role === 'supplier' && row.supplier_id === user.id) {
    return { ...base, supplier_id: row.supplier_id, cost_price: row.cost_price, notes: row.notes };
  }
  return base;
}

async function listRequests(user, event) {
  const quoteId = event.queryStringParameters && event.queryStringParameters.quoteId;

  if (user.role === 'team') {
    const result = quoteId
      ? await query(
          `SELECT sr.*, u.name AS supplier_name, u.email AS supplier_email
           FROM supplier_requests sr JOIN users u ON u.id = sr.supplier_id
           WHERE sr.quote_id = $1 ORDER BY sr.requested_at DESC`,
          [quoteId]
        )
      : await query(
          `SELECT sr.*, u.name AS supplier_name, u.email AS supplier_email
           FROM supplier_requests sr JOIN users u ON u.id = sr.supplier_id
           ORDER BY sr.requested_at DESC`
        );
    return json(200, { requests: result.rows.map((row) => sanitizeRequest(row, user)) });
  }

  // supplier: only their own requests
  const result = quoteId
    ? await query(
        'SELECT * FROM supplier_requests WHERE supplier_id = $1 AND quote_id = $2 ORDER BY requested_at DESC',
        [user.id, quoteId]
      )
    : await query('SELECT * FROM supplier_requests WHERE supplier_id = $1 ORDER BY requested_at DESC', [user.id]);
  return json(200, { requests: result.rows.map((row) => sanitizeRequest(row, user)) });
}

async function createRequest(user, event) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can request supplier pricing' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { quoteId, supplierId, supplierEmail, message } = data;
  if (!quoteId || (!supplierId && !supplierEmail)) {
    return json(400, { error: 'quoteId and either supplierId or supplierEmail are required' });
  }

  const quoteResult = await query('SELECT id FROM quotes WHERE id = $1', [quoteId]);
  if (!quoteResult.rows.length) return json(404, { error: 'Quote not found' });

  const supplierResult = supplierId
    ? await query("SELECT id FROM users WHERE id = $1 AND role = 'supplier' AND status = 'approved'", [supplierId])
    : await query(
        "SELECT id FROM users WHERE email = $1 AND role = 'supplier' AND status = 'approved'",
        [supplierEmail.toLowerCase().trim()]
      );
  if (!supplierResult.rows.length) {
    return json(400, { error: 'No approved supplier account found for that email' });
  }
  const resolvedSupplierId = supplierResult.rows[0].id;

  const result = await query(
    `INSERT INTO supplier_requests (quote_id, supplier_id, message)
     VALUES ($1, $2, $3) RETURNING *`,
    [quoteId, resolvedSupplierId, message || null]
  );

  await query("UPDATE quotes SET status = 'pricing', updated_at = now() WHERE id = $1 AND status = 'submitted'", [
    quoteId,
  ]);

  return json(201, { request: sanitizeRequest(result.rows[0], user) });
}

async function respondToRequest(user, id, event) {
  if (user.role !== 'supplier') {
    return json(403, { error: 'Only the requested supplier can respond to a pricing request' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { action, costPrice, notes } = data;
  const existing = await query('SELECT * FROM supplier_requests WHERE id = $1 AND supplier_id = $2', [id, user.id]);
  if (!existing.rows.length) return json(404, { error: 'Request not found' });

  if (action === 'decline') {
    const result = await query(
      `UPDATE supplier_requests SET status = 'declined', notes = $1, responded_at = now() WHERE id = $2 RETURNING *`,
      [notes || null, id]
    );
    return json(200, { request: sanitizeRequest(result.rows[0], user) });
  }

  const cost = Number(costPrice);
  if (!Number.isFinite(cost) || cost < 0) {
    return json(400, { error: 'costPrice must be a non-negative number' });
  }

  const result = await query(
    `UPDATE supplier_requests
     SET status = 'submitted', cost_price = $1, notes = $2, responded_at = now()
     WHERE id = $3
     RETURNING *`,
    [cost, notes || null, id]
  );

  return json(200, { request: sanitizeRequest(result.rows[0], user) });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  // Entire endpoint is off-limits to clients: this is where cost prices and
  // markups live, and clients must never be able to reach them.
  if (user.role === 'client') {
    return json(403, { error: 'Forbidden' });
  }

  const id = getIdFromPath(event, 'supplier-requests');

  if (event.httpMethod === 'GET' && !id) return listRequests(user, event);
  if (event.httpMethod === 'POST' && !id) return createRequest(user, event);
  if (event.httpMethod === 'PATCH' && id) return respondToRequest(user, id, event);

  return json(405, { error: 'Method not allowed' });
});
