// A small, strict .xlsx reader and writer on Node's own zlib, for the Excel Workout Log (no dependency). Uploaded files
// are untrusted, so the reader enforces every limit itself: a real zip read from its central directory (never trusting
// local headers), no encryption or zip64, safe entry names, inflation capped per entry and in total (zip bombs), only a
// spreadsheetml workbook (no legacy .xls, no macros, no external links or embedded objects), XML without DOCTYPE or
// ENTITY (no XXE, no entity bombs), and caps on sheets, rows, columns and cell text. Formulas are never evaluated: a
// formula cell gives its cached value. Values come back as Google Sheets gives them unformatted: numbers (dates as
// serial numbers), strings, booleans, '' for an empty cell.
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const LIMITS = { entries: 200, entryBytes: 10 * 1024 * 1024, totalBytes: 40 * 1024 * 1024, ratio: 200, sheets: 50, rows: 20000, columns: 60, cellChars: 2000 };

export class XlsxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XlsxError';
  }
}
const fail = (message) => { throw new XlsxError(message); };

// ---------------- zip ----------------
const SIG = { local: 0x04034b50, central: 0x02014b50, end: 0x06054b50 };

/** The zip's entries from its central directory: Map name -> { method, compSize, size, dataStart }. */
function zipEntries(buf, limits) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) fail('This is an old Excel file (.xls). In Excel choose Save As, Excel Workbook (.xlsx), then upload that.');
  if (buf.length < 22 || buf.readUInt32LE(0) !== SIG.local) fail('This is not an Excel workbook (.xlsx).');
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === SIG.end) { end = i; break; }
  }
  if (end < 0) fail('This is not an Excel workbook (.xlsx): the file is damaged.');
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  const cdOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('This workbook is too large.');
  if (count > limits.entries) fail('This workbook has too many parts.');
  if (cdOffset + cdSize > end) fail('This is not an Excel workbook (.xlsx): the file is damaged.');
  const entries = new Map();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG.central) fail('This is not an Excel workbook (.xlsx): the file is damaged.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 0x1) fail('This workbook is password protected. Remove the password in Excel, save, and upload again.');
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) fail('This workbook is too large.');
    if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..') || /[\0:]/.test(name)) fail('This workbook has a part with an unsafe name.');
    if (method !== 0 && method !== 8) fail('This workbook uses a compression Health Review does not read.');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== SIG.local) fail('This is not an Excel workbook (.xlsx): the file is damaged.');
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (dataStart + compSize > buf.length) fail('This is not an Excel workbook (.xlsx): the file is damaged.');
    entries.set(name, { method, compSize, size, dataStart });
  }
  return entries;
}

/** Reads entries on demand, capping each and all of them together (a small file that inflates hugely is refused). */
function zipReader(buf, limits) {
  const entries = zipEntries(buf, limits);
  let total = 0;
  return {
    names: [...entries.keys()],
    has: (name) => entries.has(name),
    text(name) {
      const e = entries.get(name);
      if (!e) return null;
      const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
      let out;
      if (e.method === 0) out = raw;
      else {
        try { out = inflateRawSync(raw, { maxOutputLength: limits.entryBytes }); } catch { fail('This workbook is too large or damaged to read.'); }
      }
      if (out.length > limits.entryBytes) fail('This workbook is too large to read.');
      if (e.compSize > 0 && out.length > 1024 * 1024 && out.length / e.compSize > limits.ratio) fail('This workbook is too large to read.');
      total += out.length;
      if (total > limits.totalBytes) fail('This workbook is too large to read.');
      return out.toString('utf8');
    },
  };
}

// ---------------- xml ----------------
function safeXml(text, part) {
  if (text === null) return null;
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail(`This workbook has a part (${part}) Health Review will not read.`);
  return text;
}
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (m, k) => {
    if (k[0] !== '#') return ENTITIES[k];
    const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}
// Uploaded XML is read with linear scans (indexOf), never backtracking regular expressions, so a crafted file cannot
// make reading it slow; attribute names go into a Map, never onto an object (no prototype tampering).
const SPACE = new Set([' ', '\t', '\r', '\n']);
const NAME_CHAR = /[\w:.-]/;
/** A tag's attributes: Map name -> decoded value. */
function attrs(text) {
  const out = new Map();
  const n = text.length;
  let i = 0;
  while (i < n) {
    while (i < n && SPACE.has(text[i])) i += 1;
    const start = i;
    while (i < n && NAME_CHAR.test(text[i])) i += 1;
    if (i === start) { i += 1; continue; }
    const name = text.slice(start, i);
    while (i < n && SPACE.has(text[i])) i += 1;
    if (text[i] !== '=') continue;
    i += 1;
    while (i < n && SPACE.has(text[i])) i += 1;
    const quote = text[i];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, i + 1);
    if (end < 0) break;
    out.set(name, decode(text.slice(i + 1, end)));
    i = end + 1;
  }
  return out;
}
/** Each <name ...>inner</name> or <name .../> in order: { attrs: the tag's attribute text, inner: text or null }. */
function* elements(xml, name) {
  const open = `<${name}`;
  const close = `</${name}>`;
  let i = 0;
  while ((i = xml.indexOf(open, i)) !== -1) {
    const after = xml[i + open.length];
    if (after !== undefined && !SPACE.has(after) && after !== '/' && after !== '>') { i += open.length; continue; }
    const gt = xml.indexOf('>', i + open.length);
    if (gt < 0) return;
    const head = xml.slice(i + open.length, gt);
    if (head.endsWith('/')) { yield { attrs: head.slice(0, -1), inner: null }; i = gt + 1; continue; }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) { yield { attrs: head, inner: xml.slice(gt + 1) }; return; }
    yield { attrs: head, inner: xml.slice(gt + 1, end) };
    i = end + close.length;
  }
}
const first = (xml, name) => elements(xml, name).next().value ?? null;
/** The text of a string item: its <t> runs joined, leaving out phonetic guides (<rPh>). */
function textOf(xml) {
  let plain = '';
  let i = 0;
  for (let at; (at = xml.indexOf('<rPh', i)) !== -1;) {
    plain += xml.slice(i, at);
    const end = xml.indexOf('</rPh>', at);
    if (end < 0) { i = xml.length; break; }
    i = end + 6;
  }
  plain += xml.slice(i);
  return [...elements(plain, 't')].map((e) => decode(e.inner ?? '')).join('');
}
const colIndex = (ref) => {
  const letters = /^([A-Z]{1,3})\d*$/.exec(ref ?? '')?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/**
 * Reads an .xlsx workbook's sheets: [{ name, rows }], each row an array of values (numbers, strings, booleans, '').
 * date1904 says the workbook counts dates from 1904 (the caller shifts its date columns by 1462 days).
 * Throws XlsxError with a message fit to show the user.
 */
export function readXlsx(buf, limits = LIMITS) {
  const zip = zipReader(buf, limits);
  const lower = zip.names.map((n) => n.toLowerCase());
  if (lower.some((n) => n.endsWith('vbaproject.bin'))) fail('This workbook has macros (.xlsm). Save it as an Excel Workbook (.xlsx) without macros, then upload that.');
  if (lower.some((n) => n.startsWith('xl/externallinks/') || n.startsWith('xl/embeddings/') || n.startsWith('xl/activex/'))) {
    fail('This workbook links to other files or has embedded objects. Copy the log into a plain workbook, then upload that.');
  }
  const types = safeXml(zip.text('[Content_Types].xml'), 'content types') ?? fail('This is not an Excel workbook (.xlsx).');
  if (/macroEnabled/i.test(types)) fail('This workbook has macros (.xlsm). Save it as an Excel Workbook (.xlsx) without macros, then upload that.');
  if (!/spreadsheetml\.(sheet|template)\.main\+xml/.test(types)) fail('This is not an Excel workbook (.xlsx).');
  const workbook = safeXml(zip.text('xl/workbook.xml'), 'workbook') ?? fail('This is not an Excel workbook (.xlsx): it has no workbook part.');
  const rels = safeXml(zip.text('xl/_rels/workbook.xml.rels'), 'workbook links') ?? fail('This is not an Excel workbook (.xlsx): the file is damaged.');
  const date1904 = ['1', 'true'].includes(String(attrs(first(workbook, 'workbookPr')?.attrs ?? '').get('date1904') ?? '').toLowerCase());
  const targets = new Map();
  for (const rel of elements(rels, 'Relationship')) {
    const a = attrs(rel.attrs);
    if (a.get('TargetMode') === 'External') continue;
    const t = String(a.get('Target') ?? '');
    const path = t.startsWith('/') ? t.slice(1) : `xl/${t}`;
    if (path.split('/').includes('..')) fail('This workbook has a part with an unsafe name.');
    targets.set(a.get('Id'), path);
  }
  const shared = [];
  const sst = safeXml(zip.text('xl/sharedStrings.xml'), 'shared strings');
  if (sst) for (const si of elements(sst, 'si')) shared.push(textOf(si.inner ?? ''));
  const sheetTags = [...elements(workbook, 'sheet')].map((e) => attrs(e.attrs));
  if (sheetTags.length > limits.sheets) fail(`This workbook has more than ${limits.sheets} tabs.`);
  const cut = (s) => (s.length > limits.cellChars ? s.slice(0, limits.cellChars) : s);
  const sheets = sheetTags.map((a) => {
    const name = a.get('name') ?? '';
    const rid = [...a].find(([k]) => k === 'r:id' || k.endsWith(':id'))?.[1];
    const xml = safeXml(zip.text(targets.get(rid) ?? ''), `tab ${name}`);
    if (xml === null) return { name, rows: [] };
    const rows = [];
    let nextRow = 0;
    for (const rm of elements(xml, 'row')) {
      const r = Number(attrs(rm.attrs).get('r'));
      const at = Number.isInteger(r) && r > 0 ? r - 1 : nextRow;
      nextRow = at + 1;
      if (!rm.inner) continue;
      if (at >= limits.rows + 1) fail(`Tab ${name} has more than ${limits.rows} rows.`);
      const row = [];
      let nextCol = 0;
      for (const cm of elements(rm.inner, 'c')) {
        const ca = attrs(cm.attrs);
        const col = colIndex(ca.get('r')) ?? nextCol;
        nextCol = col + 1;
        if (col >= limits.columns) continue;
        const inner = cm.inner ?? '';
        const v = first(inner, 'v')?.inner ?? undefined;
        let value = '';
        switch (ca.get('t')) {
          case 's': value = shared[Number(v)] ?? ''; break;
          case 'inlineStr': value = textOf(first(inner, 'is')?.inner ?? ''); break;
          case 'str': value = v === undefined ? '' : decode(v); break;
          case 'b': value = v === '1' || v === 'true'; break;
          case 'e': value = ''; break;
          case 'd': {
            // An ISO date cell is wall-clock time with no zone: read it as UTC, never the host's zone.
            const iso = decode(v ?? '').trim();
            const t = Date.parse(/(Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : iso.includes('T') ? `${iso}Z` : `${iso}T00:00:00Z`);
            value = Number.isNaN(t) ? '' : (t - EXCEL_EPOCH) / 86_400_000;
            break;
          }
          default: value = v === undefined || v === '' ? '' : Number(v); if (Number.isNaN(value)) value = '';
        }
        if (typeof value === 'string') value = cut(value);
        while (row.length < col) row.push('');
        row[col] = value;
      }
      while (rows.length < at) rows.push([]);
      rows[at] = row;
    }
    if (rows.length > limits.rows + 1) fail(`Tab ${name} has more than ${limits.rows} rows.`);
    return { name, rows };
  });
  return { sheets, date1904 };
}

// ---------------- writing ----------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
const colName = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** A zip of [name, text] parts, deflated (exported for tests that build hostile files). */
export function zipParts(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(SIG.local, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(0, 10); head.writeUInt16LE(0x21, 12); head.writeUInt32LE(crc32(data), 14);
    head.writeUInt32LE(comp.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(SIG.central, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc32(data), 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(head, nameBuf, comp);
    centrals.push(cen, nameBuf);
    offset += head.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(SIG.end, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/**
 * A workbook from sheets: [{ name, rows: [[string|number]], boldFirstRow?, freezeFirstRow?, widths?: number[] (characters),
 * dateColumn?: number (0-based; that column's cells below row 1 show as m/d/yyyy) }]. Strings are inline strings.
 */
export function writeXlsx(sheets) {
  return zipParts(workbookParts(sheets));
}

/** The workbook's parts as [name, text] (writeXlsx zips them). */
export function workbookParts(sheets) {
  const sheetXml = (s) => {
    const cols = (s.widths ?? []).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"${i === s.dateColumn ? ' style="2"' : ''}/>`).join('');
    const rows = s.rows.map((row, r) => `<row r="${r + 1}">${row.map((v, c) => {
      if (v === '' || v === null || v === undefined) return '';
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 && s.boldFirstRow ? ' s="1"' : r > 0 && c === s.dateColumn && typeof v === 'number' ? ' s="2"' : '';
      return typeof v === 'number' ? `<c r="${ref}"${style}><v>${v}</v></c>` : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
    const pane = s.freezeFirstRow ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${rows}</sheetData></worksheet>`;
  };
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="m/d/yyyy"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
  ];
  return files;
}
