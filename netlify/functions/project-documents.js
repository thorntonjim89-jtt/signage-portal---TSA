const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Uploads themselves go through upload-chunk.js + upload-finalize.js (kind:
// 'project-document') so a large file doesn't have to fit in a single
// function request. This endpoint only lists existing documents.

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listDocuments(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `SELECT pd.id, pd.project_id, pd.uploaded_by, u.name AS uploaded_by_name, u.role AS uploaded_by_role,
            pd.filename, pd.content_type, pd.created_at
     FROM project_documents pd
     JOIN users u ON u.id = pd.uploaded_by
     WHERE pd.project_id = $1
     ORDER BY pd.created_at DESC`,
    [projectId]
  );
  return json(200, { files: result.rows });
}

async function deleteDocument(user, id) {
  if (user.role === 'supplier') return json(403, { error: 'Forbidden' });

  const result = await query('SELECT * FROM project_documents WHERE id = $1', [id]);
  const doc = result.rows[0];
  if (!doc) return json(404, { error: 'Document not found' });
  if (user.role !== 'team' && doc.uploaded_by !== user.id) {
    return json(403, { error: 'You can only delete documents you uploaded' });
  }

  await query('DELETE FROM project_documents WHERE id = $1', [id]);
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'project-documents');

  if (event.httpMethod === 'GET' && !id) return listDocuments(user, event);
  if (event.httpMethod === 'DELETE' && id) return deleteDocument(user, id);

  return json(405, { error: 'Method not allowed' });
});
