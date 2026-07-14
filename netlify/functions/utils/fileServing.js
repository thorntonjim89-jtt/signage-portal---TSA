// Netlify Functions (AWS Lambda under the hood) cap a synchronous response
// body at 6MB, and base64 encoding (~33% inflation) eats into that fast —
// files at or above roughly 4.5MB raw crash the function outright with
// "ResponseSizeTooLarge" before our own error handling ever runs.
//
// Files at or under SAFE_BYTES are served directly, exactly as before. A
// larger file requires the client to first fetch a small JSON manifest (no
// `part` query param), then fetch each part in turn and reassemble them into
// a Blob — see fetchFileBlob() in public/js/api.js for the client side.

const SAFE_BYTES = 4 * 1024 * 1024; // 4MB raw ≈ 5.3MB base64, safely under the 6MB cap
const PART_BYTES = SAFE_BYTES;

function serveFile(file, part) {
  const data = Buffer.isBuffer(file.file_data) ? file.file_data : Buffer.from(file.file_data);
  const contentType = file.content_type || 'application/octet-stream';
  const filename = (file.filename || 'file').replace(/"/g, '');

  if (data.length <= SAFE_BYTES) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, max-age=3600',
        'X-File-Chunked': 'false',
      },
      body: data.toString('base64'),
      isBase64Encoded: true,
    };
  }

  const totalParts = Math.ceil(data.length / PART_BYTES);

  if (part === undefined || part === null || part === '') {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'private, max-age=3600',
        'X-File-Chunked': 'true',
      },
      body: JSON.stringify({ totalParts, contentType, filename }),
    };
  }

  const partNumber = parseInt(part, 10);
  if (!Number.isInteger(partNumber) || partNumber < 0 || partNumber >= totalParts) {
    return { statusCode: 400, body: 'Invalid part' };
  }
  const start = partNumber * PART_BYTES;
  const slice = data.subarray(start, start + PART_BYTES);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
    body: slice.toString('base64'),
    isBase64Encoded: true,
  };
}

module.exports = { serveFile };
