const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Only client/supplier accounts go through approval; team accounts are
// inserted directly against the database and are never listed or modified
// through this endpoint.
const MANAGEABLE_ROLES = ['client', 'supplier'];

async function listUsers(event) {
  const status = event.queryStringParameters && event.queryStringParameters.status;
  const result = status
    ? await query(
        'SELECT id, email, name, role, company_name, status, created_at FROM users WHERE role = ANY($1) AND status = $2 ORDER BY created_at DESC',
        [MANAGEABLE_ROLES, status]
      )
    : await query(
        'SELECT id, email, name, role, company_name, status, created_at FROM users WHERE role = ANY($1) ORDER BY created_at DESC',
        [MANAGEABLE_ROLES]
      );
  return json(200, { users: result.rows });
}

async function updateUserStatus(id, event) {
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { status } = data;
  if (!['approved', 'rejected', 'pending'].includes(status)) {
    return json(400, { error: 'status must be one of: approved, rejected, pending' });
  }

  const result = await query(
    'UPDATE users SET status = $1 WHERE id = $2 AND role = ANY($3) RETURNING id, email, name, role, company_name, status, created_at',
    [status, id, MANAGEABLE_ROLES]
  );
  if (!result.rows.length) return json(404, { error: 'User not found' });

  return json(200, { user: result.rows[0] });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (user.role !== 'team') return json(403, { error: 'Forbidden' });

  const id = getIdFromPath(event, 'users');

  if (event.httpMethod === 'GET' && !id) return listUsers(event);
  if (event.httpMethod === 'PATCH' && id) return updateUserStatus(id, event);

  return json(405, { error: 'Method not allowed' });
});
