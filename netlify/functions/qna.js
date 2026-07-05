const { query } = require('./utils/db');
const { getUserFromEvent, json } = require('./utils/auth');

async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listMessages(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `SELECT qm.id, qm.project_id, qm.message, qm.created_at, qm.sender_id, u.name AS sender_name, u.role AS sender_role
     FROM qna_messages qm
     JOIN users u ON u.id = qm.sender_id
     WHERE qm.project_id = $1
     ORDER BY qm.created_at ASC`,
    [projectId]
  );
  return json(200, { messages: result.rows });
}

async function postMessage(user, event) {
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, message } = data;
  if (!projectId || !message || !message.trim()) {
    return json(400, { error: 'projectId and message are required' });
  }

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO qna_messages (project_id, sender_id, message) VALUES ($1, $2, $3)
     RETURNING id, project_id, sender_id, message, created_at`,
    [projectId, user.id, message.trim()]
  );

  return json(201, { message: { ...result.rows[0], sender_name: user.name, sender_role: user.role } });
}

exports.handler = async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listMessages(user, event);
  if (event.httpMethod === 'POST') return postMessage(user, event);

  return json(405, { error: 'Method not allowed' });
};
