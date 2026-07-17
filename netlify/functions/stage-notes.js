const { query } = require('./utils/db');
const { getUserFromEvent, json, getIdFromPath, withErrorHandling } = require('./utils/auth');

// Only client and team see the program — a supplier's own project view
// only ever deals with manufacturing defects, not the client's install
// schedule (matches scheduled-work.js's access rule).
async function assertProjectAccess(user, projectId) {
  const result = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = result.rows[0];
  if (!project) return null;
  if (user.role === 'client' && project.client_id !== user.id) return null;
  if (user.role === 'supplier') return null;
  return project;
}

async function listStageNotes(user, event) {
  const projectId = event.queryStringParameters && event.queryStringParameters.projectId;
  if (!projectId) return json(400, { error: 'projectId query parameter is required' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `SELECT sn.id, sn.project_id, sn.stage_number, sn.entry_date, sn.note, sn.created_at, u.name AS created_by_name
     FROM stage_notes sn JOIN users u ON u.id = sn.created_by
     WHERE sn.project_id = $1 ORDER BY sn.entry_date ASC, sn.id ASC`,
    [projectId]
  );
  return json(200, { notes: result.rows });
}

async function createStageNote(user, event) {
  if (user.role !== 'team') return json(403, { error: 'Only team can add program notes' });

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const { projectId, note } = data;
  const stageNumber = Number(data.stageNumber);
  if (!projectId || !Number.isInteger(stageNumber) || stageNumber < 1 || stageNumber > 7) {
    return json(400, { error: 'projectId and a stageNumber between 1 and 7 are required' });
  }
  if (!note || !note.trim()) return json(400, { error: 'note is required' });
  const entryDate = data.entryDate || new Date().toISOString().slice(0, 10);
  if (Number.isNaN(new Date(entryDate).getTime())) return json(400, { error: 'entryDate must be a valid date' });

  const project = await assertProjectAccess(user, projectId);
  if (!project) return json(403, { error: 'Forbidden' });

  const result = await query(
    `INSERT INTO stage_notes (project_id, stage_number, entry_date, note, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, stage_number, entry_date, note, created_at`,
    [projectId, stageNumber, entryDate, note.trim(), user.id]
  );
  return json(201, { note: { ...result.rows[0], created_by_name: user.name } });
}

async function deleteStageNote(user, id) {
  if (user.role !== 'team') return json(403, { error: 'Only team can delete program notes' });

  const result = await query('DELETE FROM stage_notes WHERE id = $1 RETURNING id', [id]);
  if (!result.rows.length) return json(404, { error: 'Note not found' });
  return json(200, { ok: true });
}

exports.handler = withErrorHandling(async (event) => {
  const user = getUserFromEvent(event);
  if (!user) return json(401, { error: 'Not authenticated' });

  const id = getIdFromPath(event, 'stage-notes');

  if (event.httpMethod === 'GET' && !id) return listStageNotes(user, event);
  if (event.httpMethod === 'POST' && !id) return createStageNote(user, event);
  if (event.httpMethod === 'DELETE' && id) return deleteStageNote(user, id);

  return json(405, { error: 'Method not allowed' });
});
