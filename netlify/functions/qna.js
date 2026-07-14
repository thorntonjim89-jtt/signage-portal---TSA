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
  if (user.role === 'supplier') return null;
  return quote;
}

async function listMessages(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  const quoteId = event.queryStringParameters && event.queryStringParameters.quoteId;
  if (!projectId && !quoteId) return json(400, { error: 'projectId or quoteId query parameter is required' });

  let where;
  let param;
  if (projectId) {
    const project = await assertProjectAccess(user, projectId);
    if (!project) return json(403, { error: 'Forbidden' });
    where = 'qm.project_id = $1';
    param = projectId;
  } else {
    const quote = await assertQuoteAccess(user, quoteId);
    if (!quote) return json(403, { error: 'Forbidden' });
    where = 'qm.quote_id = $1';
    param = quoteId;
  }

  const result = await query(
    `SELECT qm.id, qm.project_id, qm.quote_id, qm.message, qm.created_at, qm.sender_id, u.name AS sender_name, u.role AS sender_role
     FROM qna_messages qm
     JOIN users u ON u.id = qm.sender_id
     WHERE ${where}
     ORDER BY qm.created_at ASC`,
    [param]
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

  const { projectId, quoteId, message } = data;
  if ((!projectId && !quoteId) || !message || !message.trim()) {
    return json(400, { error: 'projectId or quoteId, and message, are required' });
  }

  let result;
  if (projectId) {
    const project = await assertProjectAccess(user, projectId);
    if (!project) return json(403, { error: 'Forbidden' });
    result = await query(
      `INSERT INTO qna_messages (project_id, sender_id, message) VALUES ($1, $2, $3)
       RETURNING id, project_id, quote_id, sender_id, message, created_at`,
      [projectId, user.id, message.trim()]
    );
  } else {
    const quote = await assertQuoteAccess(user, quoteId);
    if (!quote) return json(403, { error: 'Forbidden' });
    result = await query(
      `INSERT INTO qna_messages (quote_id, sender_id, message) VALUES ($1, $2, $3)
       RETURNING id, project_id, quote_id, sender_id, message, created_at`,
      [quoteId, user.id, message.trim()]
    );
  }

  return json(201, { message: { ...result.rows[0], sender_name: user.name, sender_role: user.role } });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod === 'GET') return listMessages(user, event);
  if (event.httpMethod === 'POST') return postMessage(user, event);

  return json(405, { error: 'Method not allowed' });
});
