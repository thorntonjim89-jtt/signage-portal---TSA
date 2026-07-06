const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

// Netlify Functions cap the incoming request body at ~6MB, and base64
// encoding inflates a file by ~33% before it ever reaches this code. Staying
// well under that means an oversized file gets our own clear 413 message
// instead of an opaque platform-level failure.
const MAX_BYTES = 4 * 1024 * 1024;

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

async function uploadPhoto(user, event) {
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, contentType, dataBase64, caption } = data;
  if (!projectId || !contentType || !dataBase64) {
    return json(400, { error: 'projectId, contentType and dataBase64 are required' });
  }
  if (!contentType.startsWith('image/')) {
    return json(400, { error: 'Only image uploads are allowed' });
  }

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length > MAX_BYTES) {
    return json(413, { error: 'Photo exceeds the 4MB upload limit' });
  }

  const result = await query(
    `INSERT INTO photos (project_id, uploaded_by, file_data, content_type, caption)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, uploaded_by, content_type, caption, created_at`,
    [projectId, user.id, buffer, contentType, caption || null]
  );

  return json(201, { photo: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listPhotos(user, event);
  if (event.httpMethod === 'POST') return uploadPhoto(user, event);

  return json(405, { error: 'Method not allowed' });
});
