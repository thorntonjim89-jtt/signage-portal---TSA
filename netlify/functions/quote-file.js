const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');
const { serveFile } = require('./utils/fileServing');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const id = getIdFromPath(event, 'quote-file');
  if (!id) return { statusCode: 400, body: 'Missing file id' };

  const fileResult = await query('SELECT * FROM quote_attachments WHERE id = $1', [id]);
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

  const part = event.queryStringParameters && event.queryStringParameters.part;
  return serveFile(file, part);
});
