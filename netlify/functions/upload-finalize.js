const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

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

async function assertChannelAccess(user, projectId, source) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'team') return project;
  if (user.role === 'client') return source === 'client' && project.client_id === user.id ? project : null;
  if (user.role === 'supplier') return source === 'supplier' && project.supplier_id === user.id ? project : null;
  return null;
}

async function assembleChunks(uploadId, user) {
  const result = await query(
    'SELECT chunk_index, chunk_data, uploaded_by FROM upload_chunks WHERE upload_id = $1 ORDER BY chunk_index',
    [uploadId]
  );
  if (!result.rows.length) return { error: json(400, { error: 'No chunks found for this uploadId' }) };
  if (result.rows.some((row) => row.uploaded_by !== user.id)) {
    return { error: json(403, { error: 'Forbidden' }) };
  }
  for (let i = 0; i < result.rows.length; i += 1) {
    if (result.rows[i].chunk_index !== i) {
      return { error: json(400, { error: 'Upload is missing one or more chunks' }) };
    }
  }
  const buffer = Buffer.concat(result.rows.map((row) => row.chunk_data));
  return { buffer };
}

async function cleanupChunks(uploadId) {
  await query('DELETE FROM upload_chunks WHERE upload_id = $1', [uploadId]);
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { uploadId, kind } = data;
  if (!uploadId || !['photo', 'quote-file', 'issue-photo', 'design-pack'].includes(kind)) {
    return json(400, { error: 'uploadId and a valid kind are required' });
  }

  const { buffer, error } = await assembleChunks(uploadId, user);
  if (error) return error;

  if (kind === 'photo') {
    const { projectId, contentType, caption, takenAt } = data;
    if (!projectId || !contentType) return json(400, { error: 'projectId and contentType are required' });
    if (!contentType.startsWith('image/')) return json(400, { error: 'Only image uploads are allowed' });
    const project = await assertProjectAccess(user, projectId);
    if (!project) return json(403, { error: 'Forbidden' });

    // Only team can backdate a photo (e.g. bulk-importing site-visit photos
    // after the fact) — takenAt is silently ignored for any other role.
    let createdAt = null;
    if (takenAt && user.role === 'team') {
      const parsed = new Date(takenAt);
      if (Number.isNaN(parsed.getTime())) return json(400, { error: 'takenAt must be a valid date' });
      createdAt = parsed;
    }

    const result = await query(
      `INSERT INTO photos (project_id, uploaded_by, file_data, content_type, caption, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))
       RETURNING id, project_id, uploaded_by, content_type, caption, created_at`,
      [projectId, user.id, buffer, contentType, caption || null, createdAt]
    );
    await cleanupChunks(uploadId);
    return json(201, { photo: result.rows[0] });
  }

  if (kind === 'quote-file') {
    if (user.role === 'supplier') return json(403, { error: 'Forbidden' });
    const { quoteId, filename, contentType } = data;
    if (!quoteId || !filename || !contentType) {
      return json(400, { error: 'quoteId, filename and contentType are required' });
    }
    const quote = await assertQuoteAccess(user, quoteId);
    if (!quote) return json(403, { error: 'Forbidden' });

    const result = await query(
      `INSERT INTO quote_attachments (quote_id, uploaded_by, file_data, filename, content_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, quote_id, uploaded_by, filename, content_type, created_at`,
      [quoteId, user.id, buffer, filename, contentType]
    );
    await cleanupChunks(uploadId);
    return json(201, { file: result.rows[0] });
  }

  if (kind === 'design-pack') {
    if (user.role !== 'team') return json(403, { error: 'Only team can upload a design pack' });
    const { projectId, filename, contentType } = data;
    if (!projectId || !filename || !contentType) {
      return json(400, { error: 'projectId, filename and contentType are required' });
    }
    const project = await assertProjectAccess(user, projectId);
    if (!project) return json(403, { error: 'Forbidden' });

    const result = await query(
      `INSERT INTO design_packs (project_id, uploaded_by, file_data, filename, content_type)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, project_id, uploaded_by, filename, content_type, created_at`,
      [projectId, user.id, buffer, filename, contentType]
    );
    await cleanupChunks(uploadId);
    return json(201, { file: result.rows[0] });
  }

  // kind === 'issue-photo'
  if (user.role !== 'client' && user.role !== 'supplier') {
    return json(403, { error: 'Only a client or supplier can report an issue' });
  }
  const { projectId, description, contentType } = data;
  if (!projectId || !description || !description.trim() || !contentType) {
    return json(400, { error: 'projectId, description and contentType are required' });
  }
  const source = user.role;
  const project = await assertChannelAccess(user, projectId, source);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO project_issues (project_id, source, reported_by, description, file_data, content_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [projectId, source, user.id, description.trim(), buffer, contentType]
  );
  await cleanupChunks(uploadId);
  return json(201, { issue: { ...result.rows[0], reported_by_name: user.name } });
});
