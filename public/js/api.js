async function api(path, options) {
  const opts = Object.assign({ credentials: 'include', headers: {} }, options || {});
  if (opts.body && typeof opts.body !== 'string') {
    opts.body = JSON.stringify(opts.body);
    opts.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch('/api' + path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

async function requireRole(allowedRoles) {
  let data;
  try {
    data = await api('/me');
  } catch {
    window.location.href = '/index.html';
    return null;
  }
  if (!allowedRoles.includes(data.user.role)) {
    window.location.href = homeFor(data.user.role);
    return null;
  }
  return data.user;
}

function homeFor(role) {
  if (role === 'client') return '/client/dashboard.html';
  if (role === 'team') return '/team/dashboard.html';
  if (role === 'supplier') return '/supplier/dashboard.html';
  return '/index.html';
}

function renderTopbar(user, title) {
  const el = document.getElementById('topbar');
  if (!el) return;
  el.innerHTML =
    '<a class="brand" href="' + homeFor(user.role) + '"><img src="/images/logo.png" alt="' + escapeHtml(title) + '"></a>' +
    '<div class="who"><span>' + escapeHtml(user.name) + ' &middot; ' + escapeHtml(user.role) + '</span>' +
    '<button class="btn secondary" id="logout-btn">Log out</button></div>';
  document.getElementById('logout-btn').addEventListener('click', async () => {
    await api('/auth-logout', { method: 'POST' });
    window.location.href = '/index.html';
  });
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function fmtMoney(value) {
  if (value === null || value === undefined) return '—';
  return '$' + Number(value).toFixed(2);
}

function fmtDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
