const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'session';

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is not set.');
  }
  return secret;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    getSecret(),
    { expiresIn: '7d' }
  );
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getUserFromEvent(event) {
  const header = event.headers.cookie || event.headers.Cookie;
  const token = parseCookies(header)[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, getSecret());
    return { id: payload.sub, role: payload.role, email: payload.email, name: payload.name };
  } catch {
    return null;
  }
}

function setSessionCookie(token) {
  const secure = process.env.CONTEXT === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax${secure}`;
}

function clearSessionCookie() {
  const secure = process.env.CONTEXT === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(body),
  };
}

function getIdFromPath(event, functionName) {
  const parts = event.path.split('/').filter(Boolean);
  const idx = parts.indexOf(functionName);
  const rest = idx === -1 ? [] : parts.slice(idx + 1);
  return rest.length ? decodeURIComponent(rest.join('/')) : null;
}

// Without this, an unhandled rejection (e.g. a bad DATABASE_URL, a dropped
// DB connection) crashes the Lambda invocation and Netlify's proxy returns
// an opaque 502 with no indication of what actually went wrong. Wrapping
// every handler turns that into a normal JSON 500 with the real message.
function withErrorHandling(handler) {
  return async (event, context) => {
    try {
      return await handler(event, context);
    } catch (error) {
      console.error(error);
      return json(500, { error: error.message || 'Internal server error' });
    }
  };
}

module.exports = {
  COOKIE_NAME,
  signToken,
  getUserFromEvent,
  setSessionCookie,
  clearSessionCookie,
  json,
  getIdFromPath,
  withErrorHandling,
};
