// tools/xlsx.js: the strict .xlsx reader and writer. A workbook saved by Excel itself (made-up rows, personal information
// removed) reads correctly; every hostile or wrong file is refused with a message fit to show. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readXlsx, writeXlsx, workbookParts, zipParts, XlsxError, LIMITS } from '../tools/xlsx.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/excel/${name}`, import.meta.url));
const refused = (buf, pattern) => assert.throws(() => readXlsx(buf), (err) => err instanceof XlsxError && pattern.test(err.message), String(pattern));
const parts = (sheets = [{ name: '2026', rows: [['Date', 'Exercise'], [46090, 'Squat']] }]) => workbookParts(sheets);
const withPart = (name, text, base = parts()) => zipParts([...base.filter(([n]) => n !== name), [name, text]]);

test('round trip: what writeXlsx makes reads back exactly', () => {
  const rows = [['Date', 'Workout', 'Exercise', 'Weight 1', 'Set 1'], [46083, 'A & B <c> "d"', 'Squat', 185, '5'], [], ['', '', 'Pullups', 'BW', 8]];
  const book = readXlsx(writeXlsx([{ name: '2026', rows, boldFirstRow: true, freezeFirstRow: true, widths: [12], dateColumn: 0 }, { name: 'How to use', rows: [['x']] }]));
  assert.deepEqual(book.sheets.map((s) => s.name), ['2026', 'How to use']);
  assert.deepEqual(book.sheets[0].rows, [rows[0], rows[1], [], rows[3]]);
  assert.equal(book.date1904, false);
});

test('a workbook saved by Excel: shared strings, numbers, a typed date as its serial, a formula as its cached value', () => {
  const [tab] = readXlsx(fixture('excel-saved.xlsx')).sheets;
  assert.equal(tab.name, '2026');
  assert.deepEqual(tab.rows[0], ['Date', 'Workout', 'Exercise', 'Weight 1', 'Set 1']);
  assert.deepEqual(tab.rows[2], [46090, 'Plan Phase 1 A', 'Barbell Squat', 190, 5, 200, 5], '3/9/2026 is serial 46090; =D3+10 is 200, never evaluated here');
  assert.deepEqual(tab.rows[3], ['', '', 'Pullups', 'BW', 8]);
});

test('other cell kinds: rich text, inline strings, booleans, errors, ISO dates, entities; 1904 workbooks are flagged', () => {
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>in&amp;line</t></is></c><c r="D1" t="b"><v>1</v></c><c r="E1" t="e"><v>#DIV/0!</v></c></row>
    <row r="3"><c r="A3" t="d"><v>2026-03-09T00:00:00</v></c><c r="B3" t="str"><f>A1</f><v>&#x41;&#66;</v></c><c r="C3"><v>1.5</v></c></row></sheetData></worksheet>`;
  const base = parts();
  const book = readXlsx(zipParts([...base.filter(([n]) => !n.startsWith('xl/worksheets/') && n !== 'xl/workbook.xml'),
    ['xl/workbook.xml', '<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="2026" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/sharedStrings.xml', '<sst><si><r><t>Ri</t></r><r><t xml:space="preserve">ch</t></r><rPh><t>ignored</t></rPh></si></sst>']]));
  assert.equal(book.date1904, true);
  assert.deepEqual(book.sheets[0].rows, [['Rich', '', 'in&line', true, ''], [], [46090, 'AB', 1.5]]);
});

test('refused: not a zip, a legacy .xls, a CSV renamed .xlsx, a damaged zip', () => {
  refused(Buffer.from('Date,Workout,Exercise\n3/2/2026,A,Squat\n'), /not an Excel workbook/);
  refused(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(512)]), /old Excel file \(\.xls\)/);
  refused(Buffer.from('PK\u0003\u0004 not really a zip at all, just text'), /not an Excel workbook/);
  refused(writeXlsx([{ name: '2026', rows: [['a']] }]).subarray(0, 300), /damaged|not an Excel/);
});

test('refused: macros (a real .xlsm from Excel, or a vbaProject part), external links, embedded objects', () => {
  refused(fixture('macro-enabled.xlsm'), /macros/);
  refused(withPart('xl/vbaProject.bin', 'x'), /macros/);
  refused(withPart('xl/externalLinks/externalLink1.xml', '<x/>'), /links to other files/);
  refused(withPart('xl/embeddings/oleObject1.bin', 'x'), /embedded objects/);
});

test('refused: DOCTYPE or ENTITY anywhere it reads (XXE, entity bombs), and a workbook with no workbook part', () => {
  const lol = '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><workbook><sheets><sheet name="2026" r:id="rId1"/></sheets></workbook>';
  refused(withPart('xl/workbook.xml', lol), /will not read/);
  refused(withPart('xl/sharedStrings.xml', '<!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><sst><si><t>&xxe;</t></si></sst>'), /will not read/);
  refused(zipParts(parts().filter(([n]) => n !== 'xl/workbook.xml')), /no workbook part/);
  refused(withPart('[Content_Types].xml', '<Types/>'), /not an Excel workbook/);
});

test('refused: encryption, unsafe part names, too many parts', () => {
  const ok = writeXlsx([{ name: '2026', rows: [['a']] }]);
  const encrypted = Buffer.from(ok);
  const cd = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(encrypted.readUInt16LE(cd + 8) | 1, cd + 8);
  refused(encrypted, /password protected/);
  refused(zipParts([...parts(), ['../evil.xml', 'x']]), /unsafe name/);
  refused(zipParts([...parts(), ['/abs.xml', 'x']]), /unsafe name/);
  refused(zipParts([...parts(), ...Array.from({ length: LIMITS.entries }, (_, i) => [`xl/media/p${i}.xml`, 'x'])]), /too many parts/);
});

test('refused: zip bombs (a part that inflates past the cap, or at an extreme ratio), and too many rows', () => {
  refused(withPart('xl/sharedStrings.xml', `<sst><si><t>${'a'.repeat(LIMITS.entryBytes + 10)}</t></si></sst>`), /too large/);
  refused(withPart('xl/sharedStrings.xml', `<sst><si><t>${'\u0000'.repeat(3 * 1024 * 1024)}</t></si></sst>`), /too large/);
  const rows = Array.from({ length: LIMITS.rows + 2 }, (_, i) => [i]);
  refused(writeXlsx([{ name: '2026', rows }]), /more than 20000 rows/);
  // Columns past the limit are ignored, and long text is cut to the cell limit.
  const wide = readXlsx(writeXlsx([{ name: '2026', rows: [[...Array(LIMITS.columns).fill('x'), 'past the limit', ], ['y'.repeat(LIMITS.cellChars + 50)]] }]));
  assert.equal(wide.sheets[0].rows[0].length, LIMITS.columns);
  assert.equal(wide.sheets[0].rows[1][0].length, LIMITS.cellChars);
});
