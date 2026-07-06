const { getStore } = require('@netlify/blobs');
const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const blobKey = getIdFromPath(event, 'quote-file');
  if (!blobKey) return { statusCode: 400, body: 'Missing file key' };

  const fileResult = await query('SELECT * FROM quote_attachments WHERE blob_key = $1', [blobKey]);
  const file = fileResult.rows[0];
  if (!file) return { statusCode: 404, body: 'Not found' };

  const quoteResult = await query('SELECT * FROM quotes WHERE id = $1', [file.quote_id]);
  const quote = quoteResult.rows[0];
  if (!quote) return { statusCode: 404, body: 'Not found' };
  if (user.role === 'client' && quote.client_id !== user.id) return { statusCode: 403, body: 'Forbidden' };
  if (user.role === 'supplier') {
    const access = await query(
      'SELECT 1 FROM supplier_requests WHERE quote_id = $1 AND supplier_id = $2',
      [file.quote_id, user.id]
    );
    if (!access.rows.length) return { statusCode: 403, body: 'Forbidden' };
  }

  const store = getStore('quote-attachments');
  const blob = await store.get(blobKey, { type: 'arrayBuffer' });
  if (!blob) return { statusCode: 404, body: 'Not found' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': file.content_type || 'application/octet-stream',
      'Content-Disposition': `inline; filename="${file.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=3600',
    },
    body: Buffer.from(blob).toString('base64'),
    isBase64Encoded: true,
  };
});
