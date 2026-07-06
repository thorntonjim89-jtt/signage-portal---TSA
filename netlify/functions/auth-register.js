const bcrypt = require('bcryptjs');
const { query } = require('./utils/db');
const { json, withErrorHandling } = require('./utils/auth');

// Team/staff accounts are never self-registered — they're seeded directly in
// the database (see schema.sql) or created by an existing team member later.
const SELF_REGISTERABLE_ROLES = ['client', 'supplier'];

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

  const { email, password, name, role, companyName } = data;

  if (!email || !password || !name) {
    return json(400, { error: 'email, password and name are required' });
  }
  if (password.length < 8) {
    return json(400, { error: 'Password must be at least 8 characters' });
  }
  if (!SELF_REGISTERABLE_ROLES.includes(role)) {
    return json(400, { error: `role must be one of: ${SELF_REGISTERABLE_ROLES.join(', ')}` });
  }

  const normalizedEmail = email.toLowerCase().trim();

  const existing = await query('SELECT id FROM users WHERE email = $1', [normalizedEmail]);
  if (existing.rows.length) {
    return json(409, { error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await query(
    `INSERT INTO users (email, password_hash, name, role, company_name, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id, email, name, role, company_name, status, created_at`,
    [normalizedEmail, passwordHash, name, role, companyName || null]
  );

  return json(201, { user: result.rows[0] });
});
