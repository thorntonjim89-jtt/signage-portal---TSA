const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

const STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix'];

// An issue reported with a photo goes through upload-chunk.js +
// upload-finalize.js (kind: 'issue-photo') instead of this endpoint, so a
// large photo doesn't have to fit in a single function request. createIssue
// here only ever handles the text-only case. Likewise a response with a
// photo goes through upload-finalize.js (kind: 'issue-response-photo').

// Client and supplier issues used to be siloed by source; now every issue on
// a project is a single shared punch list visible to team, the project's
// client, and the project's assigned supplier.
async function assertProjectVisibility(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'team') return project;
  if (user.role === 'client') return project.client_id === user.id ? project : null;
  if (user.role === 'supplier') return project.supplier_id === user.id ? project : null;
  return null;
}

async function listIssues(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectVisibility(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  // file_data excluded from both queries — fetched separately per
  // issue/response via project-issue-file.js / project-issue-response-file.js
  // so this response stays small.
  const issuesResult = await query(
    `SELECT pi.id, pi.project_id, pi.source, pi.reported_by, u.name AS reported_by_name, pi.description,
            pi.status, (pi.file_data IS NOT NULL) AS has_photo, pi.created_at, pi.resolved_at
     FROM project_issues pi
     JOIN users u ON u.id = pi.reported_by
     WHERE pi.project_id = $1
     ORDER BY pi.created_at DESC`,
    [projectId]
  );

  const issueIds = issuesResult.rows.map((row) => row.id);
  let responsesByIssue = new Map();
  if (issueIds.length) {
    const responsesResult = await query(
      `SELECT pir.id, pir.issue_id, pir.responder_id, u.name AS responder_name, u.role AS responder_role,
              pir.status, pir.description, (pir.file_data IS NOT NULL) AS has_photo, pir.created_at
       FROM project_issue_responses pir
       JOIN users u ON u.id = pir.responder_id
       WHERE pir.issue_id = ANY($1::int[])
       ORDER BY pir.created_at ASC`,
      [issueIds]
    );
    responsesByIssue = responsesResult.rows.reduce((map, row) => {
      if (!map.has(row.issue_id)) map.set(row.issue_id, []);
      map.get(row.issue_id).push(row);
      return map;
    }, new Map());
  }

  const issues = issuesResult.rows.map((row) => ({ ...row, responses: responsesByIssue.get(row.id) || [] }));
  return json(200, { issues });
}

async function createIssue(user, event) {
  if (!['client', 'supplier', 'team'].includes(user.role)) {
    return json(403, { error: 'Forbidden' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, description } = data;
  if (!projectId || !description || !description.trim()) {
    return json(400, { error: 'projectId and description are required' });
  }

  // The reporting role is recorded as context; it can't be spoofed via the body.
  const source = user.role;
  const project = await assertProjectVisibility(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO project_issues (project_id, source, reported_by, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [projectId, source, user.id, description.trim()]
  );

  return json(201, { issue: { ...result.rows[0], reported_by_name: user.name, responses: [] } });
}

async function addResponse(user, id, data) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can respond to an issue' });
  }

  const { status, description } = data;
  if (!STATUSES.includes(status)) {
    return json(400, { error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const issueResult = await query('SELECT * FROM project_issues WHERE id = $1', [id]);
  if (!issueResult.rows.length) return json(404, { error: 'Issue not found' });

  const responseResult = await query(
    `INSERT INTO project_issue_responses (issue_id, responder_id, status, description)
     VALUES ($1, $2, $3, $4)
     RETURNING id, issue_id, responder_id, status, description, (file_data IS NOT NULL) AS has_photo, created_at`,
    [id, user.id, status, (description && description.trim()) || null]
  );

  const issueUpdate = await query(
    `UPDATE project_issues
     SET status = $1, resolved_at = CASE WHEN $1 = 'resolved' THEN now() ELSE NULL END
     WHERE id = $2
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [status, id]
  );

  return json(200, {
    issue: issueUpdate.rows[0],
    response: { ...responseResult.rows[0], responder_name: user.name, responder_role: user.role },
  });
}

async function clearPhoto(user, id) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can remove an issue photo' });
  }

  const result = await query(
    `UPDATE project_issues SET file_data = NULL, content_type = NULL WHERE id = $1
     RETURNING id, project_id, source, reported_by, description, status, (file_data IS NOT NULL) AS has_photo, created_at, resolved_at`,
    [id]
  );
  if (!result.rows.length) return json(404, { error: 'Issue not found' });
  return json(200, { issue: result.rows[0] });
}

async function deleteIssue(user, id) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can delete an issue' });
  }
  const result = await query('DELETE FROM project_issues WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return json(404, { error: 'Issue not found' });
  return json(200, { success: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'project-issues');

  if (event.httpMethod === 'GET' && !id) return listIssues(user, event);
  if (event.httpMethod === 'POST' && !id) return createIssue(user, event);
  if (event.httpMethod === 'PATCH' && id) {
    let data;
    try {
      data = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
    if (data.action === 'clearPhoto') return clearPhoto(user, id);
    return addResponse(user, id, data);
  }
  if (event.httpMethod === 'DELETE' && id) return deleteIssue(user, id);

  return json(405, { error: 'Method not allowed' });
});
