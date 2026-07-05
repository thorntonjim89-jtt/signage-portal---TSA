const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// SECURITY: this is a whitelist, not a blacklist. A supplier's cost price
// (internal_cost) and the markup applied on top of it (internal_markup_percent)
// must never reach the client role. Whitelisting the fields a client is allowed
// to see means a new column added later is excluded by default instead of
// leaking until someone remembers to blacklist it.
function sanitizeQuote(row, role) {
  const base = {
    id: row.id,
    title: row.title,
    description: row.description,
    quantity: row.quantity,
    specs: row.specs,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (role === 'client') {
    return { ...base, client_price: row.client_price };
  }

  if (role === 'supplier') {
    // Suppliers price the job; they never see the client-facing price or
    // any other supplier's cost, only what's needed to quote it.
    return base;
  }

  // role === 'team'
  return {
    ...base,
    client_id: row.client_id,
    internal_cost: row.internal_cost,
    internal_markup_percent: row.internal_markup_percent,
    client_price: row.client_price,
    priced_by: row.priced_by,
  };
}

async function listQuotes(user) {
  let result;
  if (user.role === 'client') {
    result = await query('SELECT * FROM quotes WHERE client_id = $1 ORDER BY created_at DESC', [user.id]);
  } else if (user.role === 'team') {
    result = await query('SELECT * FROM quotes ORDER BY created_at DESC');
  } else {
    result = await query(
      `SELECT DISTINCT q.* FROM quotes q
       JOIN supplier_requests sr ON sr.quote_id = q.id
       WHERE sr.supplier_id = $1
       ORDER BY q.created_at DESC`,
      [user.id]
    );
  }
  return json(200, { quotes: result.rows.map((row) => sanitizeQuote(row, user.role)) });
}

async function loadAccessibleQuote(user, id) {
  const result = await query('SELECT * FROM quotes WHERE id = $1', [id]);
  const quote = result.rows[0];
  if (!quote) return { quote: null };

  if (user.role === 'client' && quote.client_id !== user.id) {
    return { quote: null };
  }
  if (user.role === 'supplier') {
    const access = await query(
      'SELECT 1 FROM supplier_requests WHERE quote_id = $1 AND supplier_id = $2',
      [id, user.id]
    );
    if (!access.rows.length) return { quote: null };
  }
  return { quote };
}

async function getQuote(user, id) {
  const { quote } = await loadAccessibleQuote(user, id);
  if (!quote) return json(404, { error: 'Quote not found' });
  return json(200, { quote: sanitizeQuote(quote, user.role) });
}

async function createQuote(user, event) {
  if (user.role !== 'client') {
    return json(403, { error: 'Only clients can submit a quote request' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { title, description, quantity, specs } = data;
  if (!title) {
    return json(400, { error: 'title is required' });
  }

  const result = await query(
    `INSERT INTO quotes (client_id, title, description, quantity, specs)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [user.id, title, description || null, quantity || 1, specs ? JSON.stringify(specs) : null]
  );

  return json(201, { quote: sanitizeQuote(result.rows[0], user.role) });
}

async function updateQuote(user, id, event) {
  const { quote } = await loadAccessibleQuote(user, id);
  if (!quote) return json(404, { error: 'Quote not found' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { action } = data;

  if (user.role === 'supplier') {
    return json(403, { error: 'Suppliers respond via /api/supplier-requests, not /api/quotes' });
  }

  if (user.role === 'client') {
    if (!['accept', 'decline'].includes(action)) {
      return json(400, { error: 'Clients may only accept or decline a priced quote' });
    }
    if (quote.status !== 'priced') {
      return json(409, { error: `Quote must be priced before it can be ${action}ed` });
    }
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    const result = await query(
      `UPDATE quotes SET status = $1, updated_at = now() WHERE id = $2 RETURNING *`,
      [newStatus, id]
    );
    return json(200, { quote: sanitizeQuote(result.rows[0], user.role) });
  }

  // role === 'team'
  if (action === 'price') {
    const { internalCost, markupPercent } = data;
    const cost = Number(internalCost);
    const markup = Number(markupPercent);
    if (!Number.isFinite(cost) || cost < 0) {
      return json(400, { error: 'internalCost must be a non-negative number' });
    }
    if (!Number.isFinite(markup) || markup < 0) {
      return json(400, { error: 'markupPercent must be a non-negative number' });
    }
    const clientPrice = Math.round(cost * (1 + markup / 100) * 100) / 100;
    const result = await query(
      `UPDATE quotes
       SET internal_cost = $1, internal_markup_percent = $2, client_price = $3,
           status = 'priced', priced_by = $4, updated_at = now()
       WHERE id = $5
       RETURNING *`,
      [cost, markup, clientPrice, user.id, id]
    );
    return json(200, { quote: sanitizeQuote(result.rows[0], user.role) });
  }

  return json(400, { error: 'Unsupported action' });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'quotes');

  if (event.httpMethod === 'GET' && !id) return listQuotes(user);
  if (event.httpMethod === 'GET' && id) return getQuote(user, id);
  if (event.httpMethod === 'POST' && !id) return createQuote(user, event);
  if (event.httpMethod === 'PATCH' && id) return updateQuote(user, id, event);

  return json(405, { error: 'Method not allowed' });
});
