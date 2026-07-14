const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Uploads themselves go through upload-chunk.js + upload-finalize.js (kind:
// 'design-pack') so a large file doesn't have to fit in a single function
// request. This endpoint only lists existing design packs.

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listDesignPacks(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    'SELECT id, project_id, uploaded_by, filename, content_type, created_at FROM design_packs WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return json(200, { files: result.rows });
}

async function deleteDesignPack(user, id) {
  if (user.role !== 'team') return json(403, { error: 'Only team can delete a design pack' });

  const result = await query('DELETE FROM design_packs WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return json(404, { error: 'Design pack not found' });
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'design-packs');

  if (event.httpMethod === 'GET' && !id) return listDesignPacks(user, event);
  if (event.httpMethod === 'DELETE' && id) return deleteDesignPack(user, id);

  return json(405, { error: 'Method not allowed' });
});
