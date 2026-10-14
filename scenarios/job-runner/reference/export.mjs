const cell = value => {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
export function exportCsv(rows) {
  return 'job_id,elapsed_ms,state\n' + rows.map(row => [row.id, row.elapsedMs, row.state].map(cell).join(',') + '\n').join('');
}
