const { getStore } = require('@netlify/blobs');
const { randomUUID } = require('crypto');
const { query } = require('./utils/db');
const { getUserFromEvent, json } = require('./utils/auth');

const MAX_BYTES = 8 * 1024 * 1024;

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

  const result = await query(
    'SELECT id, project_id, uploaded_by, blob_key, content_type, caption, created_at FROM photos WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return json(200, { photos: result.rows });
}

async function uploadPhoto(user, event) {
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, filename, contentType, dataBase64, caption } = data;
  if (!projectId || !filename || !contentType || !dataBase64) {
    return json(400, { error: 'projectId, filename, contentType and dataBase64 are required' });
  }
  if (!contentType.startsWith('image/')) {
    return json(400, { error: 'Only image uploads are allowed' });
  }

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length > MAX_BYTES) {
    return json(413, { error: 'Photo exceeds the 8MB upload limit' });
  }

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const blobKey = `${projectId}/${randomUUID()}-${safeName}`;

  const store = getStore('project-photos');
  await store.set(blobKey, buffer);

  const result = await query(
    `INSERT INTO photos (project_id, uploaded_by, blob_key, content_type, caption)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, uploaded_by, blob_key, content_type, caption, created_at`,
    [projectId, user.id, blobKey, contentType, caption || null]
  );

  return json(201, { photo: result.rows[0] });
}

exports.handler = async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listPhotos(user, event);
  if (event.httpMethod === 'POST') return uploadPhoto(user, event);

  return json(405, { error: 'Method not allowed' });
};
