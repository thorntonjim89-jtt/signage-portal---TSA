// Matches the overall cap enforced server-side in upload-chunk.js — checked
// here too so a wildly oversized file fails instantly with a clear message
// instead of grinding through however many chunks before being rejected.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
// Per-chunk size: comfortably under Netlify's ~6MB per-request ceiling even
// after base64 inflation (~33%) and JSON overhead.
const UPLOAD_CHUNK_BYTES = 2 * 1024 * 1024;

function fileTooLarge(file) {
  return file.size > MAX_UPLOAD_BYTES;
}

function readBlobAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Splits a file into chunks small enough to fit in one function request,
// uploads them one at a time, then asks the server to assemble them into the
// real record (a photo, a quote document, or an issue photo — see `kind` in
// upload-finalize.js). This is how every file upload in the app works, no
// matter how small the file — one consistent path instead of a separate
// "small file" and "large file" mechanism.
async function uploadFileInChunks(file, finalizeBody) {
  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const totalChunks = Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_BYTES));
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * UPLOAD_CHUNK_BYTES;
    const chunk = file.slice(start, start + UPLOAD_CHUNK_BYTES);
    const dataBase64 = await readBlobAsBase64(chunk);
    await api('/upload-chunk', { method: 'POST', body: { uploadId, chunkIndex: i, dataBase64 } });
  }
  return api('/upload-finalize', { method: 'POST', body: { uploadId, ...finalizeBody } });
}

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
    '<div class="who-actions">' +
    '<a class="btn secondary" href="/account.html">Account</a>' +
    '<button class="btn secondary" id="logout-btn">Log out</button></div></div>';
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

function fmtDateOnly(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
