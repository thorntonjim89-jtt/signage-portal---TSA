const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

// Netlify Functions cap the incoming request body at ~6MB, and base64
// encoding inflates a file by ~33% before it ever reaches this code. Staying
// well under that means an oversized file gets our own clear 413 message
// instead of an opaque platform-level failure.
const MAX_BYTES = 4 * 1024 * 1024;

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

async function uploadFile(user, event) {
  // Suppliers price a quote from its description; they don't attach files to it.
  if (user.role === 'supplier') return json(403, { error: 'Forbidden' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { quoteId, filename, contentType, dataBase64 } = data;
  if (!quoteId || !filename || !contentType || !dataBase64) {
    return json(400, { error: 'quoteId, filename, contentType and dataBase64 are required' });
  }

  const quote = await assertQuoteAccess(user, quoteId);
  if (!quote) return json(403, { error: 'Forbidden' });

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length > MAX_BYTES) {
    return json(413, { error: 'File exceeds the 4MB upload limit' });
  }

  const result = await query(
    `INSERT INTO quote_attachments (quote_id, uploaded_by, file_data, filename, content_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, quote_id, uploaded_by, filename, content_type, created_at`,
    [quoteId, user.id, buffer, filename, contentType]
  );

  return json(201, { file: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listFiles(user, event);
  if (event.httpMethod === 'POST') return uploadFile(user, event);

  return json(405, { error: 'Method not allowed' });
});
