// Read the first sheet of an .xlsx or .csv file in the browser, no dependencies.
// Returns an array of rows (arrays of cell values: string, number, boolean or null).
// Old .xls files (binary Excel 97-2003) are not supported: save them as .xlsx or CSV first.

export async function readSheet(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt') || file.type === 'text/csv') return parseCsv(await file.text());
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    const e = new Error('xls'); e.code = 'unsupported'; throw e;
  }
  const zip = await unzip(buf);
  const text = (p) => (zip[p] ? new TextDecoder().decode(zip[p]) : null);
  const xml = (p) => { const s = text(p); return s ? new DOMParser().parseFromString(s, 'application/xml') : null; };

  // First sheet in the workbook
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = xml('xl/workbook.xml'); const rels = xml('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = wb.getElementsByTagName('sheet')[0];
    const rid = first && (first.getAttribute('r:id') || first.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'));
    const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
    if (rel) {
      const target = rel.getAttribute('Target').replace(/^\//, '');
      sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
    }
  }
  const shared = [];
  const ss = xml('xl/sharedStrings.xml');
  if (ss) for (const si of ss.getElementsByTagName('si')) shared.push([...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));

  const sheet = xml(sheetPath);
  if (!sheet) return [];
  const rows = [];
  for (const row of sheet.getElementsByTagName('row')) {
    const r = Number(row.getAttribute('r')) - 1;
    const out = [];
    let next = 0;
    for (const c of row.getElementsByTagName('c')) {
      const ref = c.getAttribute('r');
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = c.getAttribute('t');
      const v = c.getElementsByTagName('v')[0];
      let val = null;
      if (type === 's') val = v ? shared[Number(v.textContent)] ?? null : null;
      else if (type === 'inlineStr') val = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      else if (type === 'str') val = v ? v.textContent : null;
      else if (type === 'b') val = v ? v.textContent === '1' : null;
      else if (v) { const n = Number(v.textContent); val = Number.isFinite(n) ? n : v.textContent; }
      out[col] = val;
    }
    rows[Number.isFinite(r) && r >= 0 ? r : rows.length] = Array.from(out, (x) => (x === undefined ? null : x));
  }
  return Array.from(rows, (x) => x || []);
}

function colIndex(ref) {
  const letters = ref.match(/^[A-Z]+/i)[0].toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = [';', '\t', ','].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => (c.trim() === '' ? null : c.trim())));
}

// ------------------------------------------------------------------ unzip (stored + deflate)
async function inflateRaw(data) {
  const ds = new DecompressionStream('deflate-raw');
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

async function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid Excel file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = {};
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true); const xlen = dv.getUint16(p + 30, true); const clen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (!/^(xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/.test(name)) continue;
    const lnlen = dv.getUint16(off + 26, true); const lxlen = dv.getUint16(off + 28, true);
    const data = buf.subarray(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    files[name] = method === 0 ? data : method === 8 ? await inflateRaw(data) : null;
  }
  return files;
}
