const bcrypt = require('bcryptjs');
const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { currentPassword, newPassword } = data;
  if (!currentPassword || !newPassword) {
    return json(400, { error: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return json(400, { error: 'New password must be at least 8 characters' });
  }

  const result = await query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  const row = result.rows[0];
  if (!row) return json(404, { error: 'Account not found' });

  const ok = await bcrypt.compare(currentPassword, row.password_hash);
  if (!ok) return json(401, { error: 'Current password is incorrect' });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);

  return json(200, { ok: true });
});
