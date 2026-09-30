/**
 * One record per key, where the last record in input order wins but keeps the position of
 * the first. Sheets are append-only, so later rows are newer exports. This fixes v1's
 * consolidation, which kept the first row and keyed health metrics on date plus the first
 * metric value, so a re-exported partial day stayed in the sheet twice.
 *
 * @template T
 * @param {T[]} records
 * @param {(record: T) => string} keyOf
 * @returns {T[]}
 */
export function latestByKey(records, keyOf) {
  const byKey = new Map();
  for (const record of records) byKey.set(keyOf(record), record);
  return [...byKey.values()];
}
