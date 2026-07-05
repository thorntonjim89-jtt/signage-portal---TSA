const { json, clearSessionCookie } = require('./utils/auth');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
    body: JSON.stringify({ ok: true }),
  };
};
