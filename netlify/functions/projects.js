const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

const STAGE_NAMES = [
  'Order Confirmed',
  'Design & Proofing',
  'Client Approval',
  'Production',
  'Quality Check',
  'Shipping',
  'Installed & Complete',
];

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listProjects(user) {
  if (user.role === 'supplier') {
    return json(200, { projects: [] });
  }
  const result =
    user.role === 'client'
      ? await query('SELECT * FROM projects WHERE client_id = $1 ORDER BY created_at DESC', [user.id])
      : await query('SELECT * FROM projects ORDER BY created_at DESC');
  return json(200, { projects: result.rows });
}

async function getProject(user, id) {
  const project = await assertProjectAccess(user, id);
  if (!project) return json(404, { error: 'Project not found' });

  const stagesResult = await query(
    'SELECT stage_number, name, status, started_at, completed_at FROM project_stages WHERE project_id = $1 ORDER BY stage_number',
    [id]
  );
  const quoteResult = await query('SELECT client_price FROM quotes WHERE id = $1', [project.quote_id]);

  return json(200, {
    project: {
      ...project,
      client_price: quoteResult.rows[0] ? quoteResult.rows[0].client_price : null,
      stages: stagesResult.rows,
    },
  });
}

async function convertQuoteToProject(user, event) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can convert a quote into a project' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { quoteId } = data;
  if (!quoteId) return json(400, { error: 'quoteId is required' });

  const quoteResult = await query('SELECT * FROM quotes WHERE id = $1', [quoteId]);
  const quote = quoteResult.rows[0];
  if (!quote) return json(404, { error: 'Quote not found' });
  if (quote.status !== 'accepted') {
    return json(409, { error: 'Quote must be accepted by the client before it can become a project' });
  }

  const existing = await query('SELECT id FROM projects WHERE quote_id = $1', [quoteId]);
  if (existing.rows.length) {
    return json(409, { error: 'This quote has already been converted into a project' });
  }

  const projectResult = await query(
    `INSERT INTO projects (quote_id, client_id, title) VALUES ($1, $2, $3) RETURNING *`,
    [quoteId, quote.client_id, quote.title]
  );
  const project = projectResult.rows[0];

  for (let i = 0; i < STAGE_NAMES.length; i += 1) {
    const stageNumber = i + 1;
    await query(
      `INSERT INTO project_stages (project_id, stage_number, name, status, started_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [project.id, stageNumber, STAGE_NAMES[i], stageNumber === 1 ? 'in_progress' : 'pending', stageNumber === 1 ? new Date() : null]
    );
  }

  await query("UPDATE quotes SET status = 'converted', updated_at = now() WHERE id = $1", [quoteId]);

  return json(201, { project });
}

async function updateStage(user, id, event) {
  if (user.role !== 'team') {
    return json(403, { error: 'Only team members can update project stages' });
  }

  const project = await assertProjectAccess(user, id);
  if (!project) return json(404, { error: 'Project not found' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const stageNumber = Number(data.stageNumber);
  const status = data.status;
  if (!Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 7) {
    return json(400, { error: 'stageNumber must be an integer between 1 and 7' });
  }
  if (!['pending', 'in_progress', 'complete'].includes(status)) {
    return json(400, { error: 'status must be one of pending, in_progress, complete' });
  }

  const timestampCol = status === 'in_progress' ? 'started_at' : status === 'complete' ? 'completed_at' : null;
  const setClause = timestampCol ? `status = $1, ${timestampCol} = now()` : 'status = $1';

  const result = await query(
    `UPDATE project_stages SET ${setClause} WHERE project_id = $2 AND stage_number = $3 RETURNING *`,
    [status, id, stageNumber]
  );
  if (!result.rows.length) return json(404, { error: 'Stage not found' });

  if (status !== 'pending') {
    await query('UPDATE projects SET current_stage = GREATEST(current_stage, $1) WHERE id = $2', [stageNumber, id]);
  }

  return json(200, { stage: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'projects');

  if (event.httpMethod === 'GET' && !id) return listProjects(user);
  if (event.httpMethod === 'GET' && id) return getProject(user, id);
  if (event.httpMethod === 'POST' && !id) return convertQuoteToProject(user, event);
  if (event.httpMethod === 'PATCH' && id) return updateStage(user, id, event);

  return json(405, { error: 'Method not allowed' });
});
