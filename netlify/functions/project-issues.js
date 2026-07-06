const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

const MAX_BYTES = 8 * 1024 * 1024;

// Client-reported install issues and supplier-reported manufacturing defects
// are two deliberately siloed channels on the same project: a client never
// sees a supplier flagged a defect, and a supplier never sees the client's
// side of things. Team sees both. This mirrors how quotes.js keeps price
// data siloed by role — access is enforced per source, not just per project.
async function assertChannelAccess(user, projectId, source) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'team') return project;
  if (user.role === 'client') return source === 'client' && project.client_id === user.id ? project : null;
  if (user.role === 'supplier') return source === 'supplier' && project.supplier_id === user.id ? project : null;
  return null;
}

async function listIssues(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  const source = event.queryStringParameters && event.queryStringParameters.source;
  if (!projectId || !['client', 'supplier'].includes(source)) {
    return json(400, { error: 'projectId and source (client or supplier) query parameters are required' });
  }

  const project = await assertChannelAccess(user, projectId, source);
  if (!project) return json(403, { error: 'Forbidden' });

  // file_data excluded from the list — fetched separately per issue via
  // project-issue-file.js so this response stays small.
  const result = await query(
    `SELECT pi.id, pi.project_id, pi.source, pi.reported_by, u.name AS reported_by_name, pi.description,
            pi.status, (pi.file_data IS NOT NULL) AS has_photo, pi.created_at, pi.resolved_at
     FROM project_issues pi
     JOIN users u ON u.id = pi.reported_by
     WHERE pi.project_id = $1 AND pi.source = $2
     ORDER BY pi.created_at DESC`,
    [projectId, source]
  );
  return json(200, { issues: result.rows });
}

async function createIssue(user, event) {
  if (user.role !== 'client' && user.role !== 'supplier') {
    return json(403, { error: 'Only a client or supplier can report an issue' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, description, contentType, dataBase64 } = data;
  if (!projectId || !description || !description.trim()) {
    return json(400, { error: 'projectId and description are required' });
  }

  // The reporting role determines the channel; it can't be spoofed via the body.
  const source = user.role;
  const project = await assertChannelAccess(user, projectId, source);
  if (!project) return json(403, { error: 'Forbidden' });

  let buffer = null;
  let storedContentType = null;
  if (dataBase64) {
    if (!contentType) {
      return json(400, { error: 'contentType is required when attaching a photo' });
    }
    buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > MAX_BYTES) {
      return json(413, { error: 'Photo exceeds the 8MB upload limit' });
    }
    storedContentType = contentType;
  }

  const result = await query(
    `INSERT INTO project_issues (project_id, source, reported_by, description, file_data, content_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [projectId, source, user.id, description.trim(), buffer, storedContentType]
  );

  return json(201, { issue: { ...result.rows[0], reported_by_name: user.name } });
}

async function updateIssue(user, id, event) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can update an issue\'s status' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { status } = data;
  if (!['open', 'resolved'].includes(status)) {
    return json(400, { error: 'status must be one of: open, resolved' });
  }

  const result = await query(
    `UPDATE project_issues
     SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END
     WHERE id = $2
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [status, id]
  );
  if (!result.rows.length) return json(404, { error: 'Issue not found' });

  return json(200, { issue: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'project-issues');

  if (event.httpMethod === 'GET' && !id) return listIssues(user, event);
  if (event.httpMethod === 'POST' && !id) return createIssue(user, event);
  if (event.httpMethod === 'PATCH' && id) return updateIssue(user, id, event);

  return json(405, { error: 'Method not allowed' });
});
