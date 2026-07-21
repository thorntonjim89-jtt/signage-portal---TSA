const ExcelJS = require('exceljs');

function cellText(cell) {
  const v = cell ? cell.value : null;
  if (v == null) return '';
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if (typeof v.text === 'string') return v.text;
    if (v.result !== undefined) return v.result;
    return '';
  }
  return v;
}

// Reads whichever sheet looks like the install tracker (falls back to the
// first sheet so a slightly renamed tab still works) and pulls out every
// row that has both a label and a numeric quantity — no hardcoded row
// range, so this keeps working as the tracker grows or gets reordered.
// Column layout (B = description, C = quantity, E = status) matches the
// client's own tracker template; a row explicitly marked EXCLUDED is
// dropped, everything else with a positive quantity is a real candidate.
async function parseTrackerBuffer(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.worksheets.find((s) => /install.*track/i.test(s.name)) || workbook.worksheets[0];
  if (!sheet) return [];

  const rows = [];
  sheet.eachRow((row) => {
    const label = String(cellText(row.getCell(2)) || '').trim();
    const quantity = Number(cellText(row.getCell(3)));
    const status = String(cellText(row.getCell(5)) || '').trim();
    if (!label || !Number.isInteger(quantity) || quantity <= 0) return;
    if (/excluded/i.test(status)) return;
    rows.push({ label, quantity });
  });
  return rows;
}

module.exports = { parseTrackerBuffer };
