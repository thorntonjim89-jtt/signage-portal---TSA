const { query } = require('./utils/db');
const { getUserFromEvent, json, signToken, setSessionCookie, withErrorHandling } = require('./utils/auth');

async function updateProfile(user, event) {
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { name, companyName, email } = data;
  if (!name || !name.trim()) {
    return json(400, { error: 'name is required' });
  }

  let normalizedEmail = user.email;
  if (email) {
    normalizedEmail = email.toLowerCase().trim();
    if (!normalizedEmail) return json(400, { error: 'email is required' });
    if (normalizedEmail !== user.email) {
      const existing = await query('SELECT id FROM users WHERE email = $1 AND id != $2', [normalizedEmail, user.id]);
      if (existing.rows.length) return json(409, { error: 'An account with this email already exists' });
    }
  }

  const result = await query(
    `UPDATE users SET name = $1, company_name = $2, email = $3 WHERE id = $4
     RETURNING id, email, name, role, company_name, status`,
    [name.trim(), companyName || null, normalizedEmail, user.id]
  );
  const updated = result.rows[0];

  // The session cookie carries name/email baked into the JWT, so without
  // reissuing it here the topbar (and anything else reading /api/me) would
  // keep showing the old values until the user logs out and back in.
  const token = signToken(updated);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token),
    },
    body: JSON.stringify({ user: updated }),
  };
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) {
    return json(401, { error: 'Not authenticated' });
  }

  if (event.httpMethod === 'GET') {
    // The JWT only carries id/role/email/name — fetch fresh for fields like
    // company_name that were never baked into the token, so account.html has
    // real current values to prefill the profile form with.
    const result = await query('SELECT id, email, name, role, company_name, status FROM users WHERE id = $1', [user.id]);
    return json(200, { user: result.rows[0] || user });
  }
  if (event.httpMethod === 'PATCH') return updateProfile(user, event);

  return json(405, { error: 'Method not allowed' });
});
