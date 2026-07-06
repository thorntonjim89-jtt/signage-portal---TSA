const { query } = require('./utils/db');
const { getUserFromEvent, json, withErrorHandling } = require('./utils/auth');

// Comfortably under Netlify's ~6MB per-request ceiling even after base64
// inflation (~33%) and JSON overhead.
const MAX_CHUNK_BYTES = 2.5 * 1024 * 1024;
// A generous ceiling for a whole assembled file (design packs, presentations),
// well beyond anything this app expects, just to stop a runaway upload.
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { uploadId, chunkIndex, dataBase64 } = data;
  if (!uploadId || typeof uploadId !== 'string' || uploadId.length > 100) {
    return json(400, { error: 'uploadId is required' });
  }
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
    return json(400, { error: 'chunkIndex must be a non-negative integer' });
  }
  if (!dataBase64) {
    return json(400, { error: 'dataBase64 is required' });
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length > MAX_CHUNK_BYTES) {
    return json(413, { error: 'Chunk too large' });
  }

  // Only the session's own uploader can add chunks to it, and the running
  // total (across all chunks seen so far, from any previous request) is
  // enforced here rather than only at finalize time, so an oversized upload
  // fails fast instead of silently accumulating rows.
  const existing = await query(
    'SELECT uploaded_by, COALESCE(SUM(LENGTH(chunk_data)), 0) AS total_bytes FROM upload_chunks WHERE upload_id = $1 GROUP BY uploaded_by',
    [uploadId]
  );
  if (existing.rows.length && existing.rows[0].uploaded_by !== user.id) {
    return json(403, { error: 'Forbidden' });
  }
  const totalSoFar = existing.rows.length ? Number(existing.rows[0].total_bytes) : 0;
  if (totalSoFar + buffer.length > MAX_TOTAL_BYTES) {
    return json(413, { error: `File exceeds the ${MAX_TOTAL_BYTES / (1024 * 1024)}MB upload limit` });
  }

  await query(
    `INSERT INTO upload_chunks (upload_id, uploaded_by, chunk_index, chunk_data)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (upload_id, chunk_index) DO UPDATE SET chunk_data = EXCLUDED.chunk_data`,
    [uploadId, user.id, chunkIndex, buffer]
  );

  return json(201, { ok: true });
});
