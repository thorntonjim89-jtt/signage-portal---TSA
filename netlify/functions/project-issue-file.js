const { getStore } = require('@netlify/blobs');
const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const blobKey = getIdFromPath(event, 'project-issue-file');
  if (!blobKey) return { statusCode: 400, body: 'Missing file key' };

  const issueResult = await query('SELECT * FROM project_issues WHERE blob_key = $1', [blobKey]);
  const issue = issueResult.rows[0];
  if (!issue) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [issue.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };

  const allowed =
    user.role === 'team' ||
    (user.role === 'client' && issue.source === 'client' && project.client_id === user.id) ||
    (user.role === 'supplier' && issue.source === 'supplier' && project.supplier_id === user.id);
  if (!allowed) return { statusCode: 403, body: 'Forbidden' };

  const store = getStore('project-issue-photos');
  const blob = await store.get(blobKey, { type: 'arrayBuffer' });
  if (!blob) return { statusCode: 404, body: 'Not found' };

  return {
    statusCode: 200,
    headers: {
      'Content-Type': issue.content_type || 'application/octet-stream',
      'Cache-Control': 'private, max-age=3600',
    },
    body: Buffer.from(blob).toString('base64'),
    isBase64Encoded: true,
  };
});
