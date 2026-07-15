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

function parseQuantity(value) {
  const qty = Number(value);
  return Number.isInteger(qty) && qty >= 1 ? qty : null;
}

async function listScheduledWork(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    'SELECT id, project_id, description, quantity, scheduled_date, status, completed_at, created_at FROM scheduled_work WHERE project_id = $1 ORDER BY scheduled_date ASC',
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
  const quantity = data.quantity === undefined ? 1 : parseQuantity(data.quantity);
  if (quantity === null) return json(400, { error: 'quantity must be a whole number of 1 or more' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO scheduled_work (project_id, description, quantity, scheduled_date, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, description, quantity, scheduled_date, status, completed_at, created_at`,
    [projectId, description.trim(), quantity, scheduledDate, user.id]
  );
  return json(201, { item: result.rows[0] });
}

async function updateScheduledWork(user, id, data) {
  if (user.role !== 'team') return json(403, { error: 'Only team can update scheduled work' });

  // A plain status toggle stamps completed_at as "now" for the common case;
  // "edit" is the full item editor (description, quantity, both dates) — the
  // same fields shown pre-filled together, so a mis-entered quantity or a
  // typo doesn't require a separate action from correcting a date.
  if (data.action === 'edit') {
    const { description, scheduledDate, completedAt } = data;
    if (!description || !description.trim()) return json(400, { error: 'description is required' });
    const quantity = parseQuantity(data.quantity);
    if (quantity === null) return json(400, { error: 'quantity must be a whole number of 1 or more' });
    if (!scheduledDate || Number.isNaN(new Date(scheduledDate).getTime())) {
      return json(400, { error: 'scheduledDate must be a valid date' });
    }
    let completed = null;
    if (completedAt) {
      completed = new Date(completedAt);
      if (Number.isNaN(completed.getTime())) return json(400, { error: 'completedAt must be a valid date' });
    }
    const status = completed ? 'complete' : 'scheduled';
    const result = await query(
      `UPDATE scheduled_work SET description = $1, quantity = $2, scheduled_date = $3, completed_at = $4, status = $5
       WHERE id = $6
       RETURNING id, project_id, description, quantity, scheduled_date, status, completed_at, created_at`,
      [description.trim(), quantity, scheduledDate, completed, status, id]
    );
    if (!result.rows.length) return json(404, { error: 'Scheduled work item not found' });
    return json(200, { item: result.rows[0] });
  }

  const { status } = data;
  if (!['scheduled', 'complete'].includes(status)) {
    return json(400, { error: 'status must be one of: scheduled, complete' });
  }

  const setClause = status === 'complete' ? 'status = $1, completed_at = now()' : 'status = $1, completed_at = NULL';
  const result = await query(
    `UPDATE scheduled_work SET ${setClause} WHERE id = $2
     RETURNING id, project_id, description, quantity, scheduled_date, status, completed_at, created_at`,
    [status, id]
  );
  if (!result.rows.length) return json(404, { error: 'Scheduled work item not found' });
  return json(200, { item: result.rows[0] });
}

async function deleteScheduledWork(user, id) {
  if (user.role !== 'team') return json(403, { error: 'Only team can delete scheduled work' });

  const result = await query('DELETE FROM scheduled_work WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return json(404, { error: 'Scheduled work item not found' });
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'scheduled-work');

  if (event.httpMethod === 'GET' && !id) return listScheduledWork(user, event);
  if (event.httpMethod === 'POST' && !id) return createScheduledWork(user, event);
  if (event.httpMethod === 'PATCH' && id) {
    let data;
    try {
      data = JSON.parse(event.body || '{}');
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
    return updateScheduledWork(user, id, data);
  }
  if (event.httpMethod === 'DELETE' && id) return deleteScheduledWork(user, id);

  return json(405, { error: 'Method not allowed' });
});
