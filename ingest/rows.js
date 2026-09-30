/**
 * Turns a sheet's values (header row first) into one object per row, keyed by header.
 * Keeps v1's row rules: blank rows are skipped, columns with no header are dropped, and
 * empty cells are left out, while 0 and false are kept. The Sheets API omits trailing
 * empty cells, so undefined counts as empty. Values are returned unchanged; unlike v1,
 * dates are never flattened to text here.
 *
 * @param {Array<Array<any>>} values
 * @returns {Array<Record<string, any>>}
 */
export function rowsToRecords(values) {
  const [headers = [], ...rows] = values ?? [];
  const seen = new Set();
  for (const h of headers) {
    if (!h) continue;
    if (seen.has(h)) throw new Error(`Duplicate column header "${h}"`);
    seen.add(h);
  }

  const records = [];
  for (const row of rows) {
    const record = {};
    headers.forEach((header, j) => {
      const cell = row?.[j];
      if (header && !isEmpty(cell)) record[header] = cell;
    });
    if (Object.keys(record).length) records.push(record);
  }
  return records;
}

const isEmpty = (cell) => cell === '' || cell === null || cell === undefined;
