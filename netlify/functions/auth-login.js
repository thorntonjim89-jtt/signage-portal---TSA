const bcrypt = require('bcryptjs');
const { query } = require('./utils/db');
const { json, signToken, setSessionCookie, withErrorHandling } = require('./utils/auth');

exports.handler = withErrorHandling(async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { email, password } = data;
  if (!email || !password) {
    return json(400, { error: 'email and password are required' });
  }

  const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
  const user = result.rows[0];
  if (!user) {
    return json(401, { error: 'Invalid email or password' });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return json(401, { error: 'Invalid email or password' });
  }

  const token = signToken(user);

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setSessionCookie(token),
    },
    body: JSON.stringify({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    }),
  };
});
