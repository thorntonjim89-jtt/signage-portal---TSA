const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Only client and team see scheduled work — a supplier's own project view
// only ever deals with manufacturing defects, not the client's install
// schedule.
async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listScheduledWork(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    'SELECT id, project_id, description, scheduled_date, status, created_at FROM scheduled_work WHERE project_id = $1 ORDER BY scheduled_date ASC',
    [projectId]
  );
  return json(200, { items: result.rows });
}

async function createScheduledWork(user, event) {
  if (user.role !== 'team') return json(403, { error: 'Only team can schedule work' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, description, scheduledDate } = data;
  if (!projectId || !description || !description.trim() || !scheduledDate) {
    return json(400, { error: 'projectId, description and scheduledDate are required' });
  }
  if (Number.isNaN(new Date(scheduledDate).getTime())) {
    return json(400, { error: 'scheduledDate must be a valid date' });
  }

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO scheduled_work (project_id, description, scheduled_date, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, project_id, description, scheduled_date, status, created_at`,
    [projectId, description.trim(), scheduledDate, user.id]
  );
  return json(201, { item: result.rows[0] });
}

async function updateScheduledWork(user, id, event) {
  if (user.role !== 'team') return json(403, { error: 'Only team can update scheduled work' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { status } = data;
  if (!['scheduled', 'complete'].includes(status)) {
    return json(400, { error: 'status must be one of: scheduled, complete' });
  }

  const result = await query(
    `UPDATE scheduled_work SET status = $1 WHERE id = $2
     RETURNING id, project_id, description, scheduled_date, status, created_at`,
    [status, id]
  );
  if (!result.rows.length) return json(404, { error: 'Scheduled work item not found' });
  return json(200, { item: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'scheduled-work');

  if (event.httpMethod === 'GET' && !id) return listScheduledWork(user, event);
  if (event.httpMethod === 'POST' && !id) return createScheduledWork(user, event);
  if (event.httpMethod === 'PATCH' && id) return updateScheduledWork(user, id, event);

  return json(405, { error: 'Method not allowed' });
});
