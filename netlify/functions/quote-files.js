const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

// Uploads themselves go through upload-chunk.js + upload-finalize.js (kind:
// 'quote-file') so a large document doesn't have to fit in a single function
// request. This endpoint only lists existing attachments.

async function assertQuoteAccess(user, quoteId) {
  const result = await query('SELECT * FROM quotes WHERE id = $1', [quoteId]);
  const quote = result.rows[0];
  if (!quote) return null;
  if (user.role === 'client' && quote.client_id !== user.id) return null;
  if (user.role === 'supplier') {
    const access = await query(
      'SELECT 1 FROM supplier_requests WHERE quote_id = $1 AND supplier_id = $2',
      [quoteId, user.id]
    );
    if (!access.rows.length) return null;
  }
  return quote;
}

async function listFiles(user, event) {
  const quoteId = event.queryStringParameters && event.queryStringParameters.quoteId;
  if (!quoteId) return json(400, { error: 'quoteId query parameter is required' });

  const quote = await assertQuoteAccess(user, quoteId);
  if (!quote) return json(403, { error: 'Forbidden' });

  const result = await query(
    'SELECT id, quote_id, uploaded_by, filename, content_type, created_at FROM quote_attachments WHERE quote_id = $1 ORDER BY created_at DESC',
    [quoteId]
  );
  return json(200, { files: result.rows });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listFiles(user, event);

  return json(405, { error: 'Method not allowed' });
});
