const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

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
    `SELECT qa.id, qa.quote_id, qa.uploaded_by, u.name AS uploaded_by_name, u.role AS uploaded_by_role,
            qa.filename, qa.content_type, qa.created_at
     FROM quote_attachments qa
     JOIN users u ON u.id = qa.uploaded_by
     WHERE qa.quote_id = $1
     ORDER BY qa.created_at DESC`,
    [quoteId]
  );
  return json(200, { files: result.rows });
}

async function deleteFile(user, id) {
  if (user.role === 'supplier') return json(403, { error: 'Forbidden' });

  const result = await query('SELECT * FROM quote_attachments WHERE id = $1', [id]);
  const file = result.rows[0];
  if (!file) return json(404, { error: 'File not found' });
  if (user.role !== 'team' && file.uploaded_by !== user.id) {
    return json(403, { error: 'You can only delete files you uploaded' });
  }

  await query('DELETE FROM quote_attachments WHERE id = $1', [id]);
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'quote-files');

  if (event.httpMethod === 'GET' && !id) return listFiles(user, event);
  if (event.httpMethod === 'DELETE' && id) return deleteFile(user, id);

  return json(405, { error: 'Method not allowed' });
});
