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

// Mirrors fileServing.js on the server: a file at or under its safe size
// comes back as a normal binary response (X-File-Chunked: false or absent).
// A larger file instead requires fetching a small JSON manifest first, then
// each part in turn, reassembled here into one Blob — see serveFile() in
// netlify/functions/utils/fileServing.js for why this exists (Netlify
// Functions cap a response at 6MB, which base64 inflation eats into fast).
async function fetchFileBlob(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('Failed to load file (' + res.status + ')');
  if (res.headers.get('X-File-Chunked') !== 'true') return res.blob();

  const manifest = await res.json();
  const sep = url.includes('?') ? '&' : '?';
  const buffers = [];
  for (let i = 0; i < manifest.totalParts; i += 1) {
    const partRes = await fetch(`${url}${sep}part=${i}`, { credentials: 'include' });
    if (!partRes.ok) throw new Error('Failed to load file (' + partRes.status + ')');
    buffers.push(await partRes.arrayBuffer());
  }
  return new Blob(buffers, { type: manifest.contentType });
}

async function openFile(url) {
  const blob = await fetchFileBlob(url);
  window.open(URL.createObjectURL(blob), '_blank');
}

// Wires up every `[data-file-url]` element within `container`: an `<img
// data-src>` nested inside one gets its src lazily populated from the fetched
// blob, and clicking the element itself opens the file via openFile() instead
// of relying on a plain <a href> (which can't work once a file needs
// chunked fetching). Call this once after inserting markup built from
// photos/design packs/documents/quote files/issue photos.
function wireFileLinks(container) {
  container.querySelectorAll('[data-file-url]').forEach((el) => {
    const url = el.dataset.fileUrl;
    const img = el.querySelector && el.querySelector('img[data-src]');
    if (img) {
      fetchFileBlob(url).then((blob) => { img.src = URL.createObjectURL(blob); }).catch(() => {});
    }
    el.addEventListener('click', (e) => {
      e.preventDefault();
      openFile(url);
    });
  });
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

function fmtDateShort(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
