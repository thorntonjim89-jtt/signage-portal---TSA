const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const id = getIdFromPath(event, 'photo-file');
  if (!id) return { statusCode: 400, body: 'Missing photo id' };

  const photoResult = await query('SELECT * FROM photos WHERE id = $1', [id]);
  const photo = photoResult.rows[0];
  if (!photo) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [photo.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };
  if (user.role === 'client' && project.client_id !== user.id) return { statusCode: 403, body: 'Forbidden' };
  if (user.role === 'supplier') return { statusCode: 403, body: 'Forbidden' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': photo.content_type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
    body: Buffer.from(photo.file_data).toString('base64'),
    isBase64Encoded: true,
  };
});
