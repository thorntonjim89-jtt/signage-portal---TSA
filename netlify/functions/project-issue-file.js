const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');
const { serveFile } = require('./utils/fileServing');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const id = getIdFromPath(event, 'project-issue-file');
  if (!id) return { statusCode: 400, body: 'Missing issue id' };

  const issueResult = await query('SELECT * FROM project_issues WHERE id = $1', [id]);
  const issue = issueResult.rows[0];
  if (!issue || !issue.file_data) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [issue.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };

  const allowed =
    user.role === 'team' ||
    (user.role === 'client' && issue.source === 'client' && project.client_id === user.id) ||
    (user.role === 'supplier' && issue.source === 'supplier' && project.supplier_id === user.id);
  if (!allowed) return { statusCode: 403, body: 'Forbidden' };

  const part = event.queryStringParameters && event.queryStringParameters.part;
  return serveFile(issue, part);
});
