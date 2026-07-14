const { query } = require('./utils/db');
const { getUserFromEvent, getIdFromPath, withErrorHandling } = require('./utils/auth');
const { serveFile } = require('./utils/fileServing');

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return { statusCode: 401, body: 'Not authenticated' };

  const id = getIdFromPath(event, 'project-document-file');
  if (!id) return { statusCode: 400, body: 'Missing file id' };

  const fileResult = await query('SELECT * FROM project_documents WHERE id = $1', [id]);
  const file = fileResult.rows[0];
  if (!file) return { statusCode: 404, body: 'Not found' };

  const projectResult = await query('SELECT * FROM projects WHERE id = $1', [file.project_id]);
  const project = projectResult.rows[0];
  if (!project) return { statusCode: 404, body: 'Not found' };
  if (user.role === 'client' && project.client_id !== user.id) return { statusCode: 403, body: 'Forbidden' };
  if (user.role === 'supplier') return { statusCode: 403, body: 'Forbidden' };

  const part = event.queryStringParameters && event.queryStringParameters.part;
  return serveFile(file, part);
});
