const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Uploads themselves go through upload-chunk.js + upload-finalize.js (kind:
// 'photo') so a large photo doesn't have to fit in a single function
// request. This endpoint only lists existing photos.

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listPhotos(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  // file_data is deliberately excluded here — this is a list of metadata,
  // not the multi-megabyte contents of every photo. Bytes are fetched one
  // at a time via photo-file.js.
  const result = await query(
    'SELECT id, project_id, uploaded_by, content_type, caption, created_at FROM photos WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return json(200, { photos: result.rows });
}

async function deletePhoto(user, id) {
  if (user.role !== 'team') return json(403, { error: 'Only team can delete a photo' });

  const result = await query('DELETE FROM photos WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return json(404, { error: 'Photo not found' });
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'photos');

  if (event.httpMethod === 'GET' && !id) return listPhotos(user, event);
  if (event.httpMethod === 'DELETE' && id) return deletePhoto(user, id);

  return json(405, { error: 'Method not allowed' });
});
