const { getStore } = require('@netlify/blobs');
const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath } = require('./utils/auth');

exports.handler = async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const blobKey = getIdFromPath(event, 'photo-file');
  if (!blobKey) return { statusCode: 400, body: 'Missing photo key' };

  const photoResult = await query('SELECT * FROM photos WHERE blob_key = $1', [blobKey]);
  const photo = photoResult.rows[0];
  if (!photo) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [photo.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };
  if (user.role === 'client' && project.client_id !== user.id) return { statusCode: 403, body: 'Forbidden' };
  if (user.role === 'supplier') return { statusCode: 403, body: 'Forbidden' };

  const store = getStore('project-photos');
  const blob = await store.get(blobKey, { type: 'arrayBuffer' });
  if (!blob) return { statusCode: 404, body: 'Not found' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': photo.content_type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
    body: Buffer.from(blob).toString('base64'),
    isBase64Encoded: true,
  };
};
