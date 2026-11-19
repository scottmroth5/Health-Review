/**
 * Turns a sheet's values (header row first) into one object per row, keyed by header.
 * Keeps v1's row rules: blank rows are skipped, columns with no header are dropped, and
 * empty cells are left out, while 0 and false are kept. The Sheets API omits trailing
 * empty cells, so undefined counts as empty. Values are returned unchanged; unlike v1,
 * dates are never flattened to text here.
 */
export function rowsToRecords(values: any[][] | null | undefined): Record<string, any>[] {
  const [headers = [], ...rows] = values ?? [];
  const seen = new Set<any>();
  for (const h of headers) {
    if (!h) continue;
    if (seen.has(h)) throw new Error(`Duplicate column header "${h}"`);
    seen.add(h);
  }

  const records: Record<string, any>[] = [];
  for (const row of rows) {
    const record: Record<string, any> = {};
    headers.forEach((header: any, j: number) => {
      const cell = row?.[j];
      if (header && !isEmpty(cell)) record[header] = cell;
    });
    if (Object.keys(record).length) records.push(record);
  }
  return records;
}

const isEmpty = (cell: unknown): boolean => cell === '' || cell === null || cell === undefined;
