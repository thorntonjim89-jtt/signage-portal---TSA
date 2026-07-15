const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');
const { serveFile } = require('./utils/fileServing');

async function assertProjectVisibility(user, project) {
  if (user.role === 'team') return true;
  if (user.role === 'client') return project.client_id === user.id;
  if (user.role === 'supplier') return project.supplier_id === user.id;
  return false;
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const id = getIdFromPath(event, 'project-issue-response-file');
  if (!id) return { statusCode: 400, body: 'Missing response id' };

  const responseResult = await query('SELECT * FROM project_issue_responses WHERE id = $1', [id]);
  const response = responseResult.rows[0];
  if (!response || !response.file_data) return { statusCode: 404, body: 'Not found' };

  const issueResult = await query('SELECT project_id FROM project_issues WHERE id = $1', [response.issue_id]);
  const issue = issueResult.rows[0];
  if (!issue) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [issue.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };

  if (!(await assertProjectVisibility(user, project))) return { statusCode: 403, body: 'Forbidden' };

  const part = event.queryStringParameters && event.queryStringParameters.part;
  return serveFile(response, part);
});
