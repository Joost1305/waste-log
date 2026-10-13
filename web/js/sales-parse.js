// Reads a till "turnover group report" into lines, from rows of cells (Excel/CSV) or lines of text (PDF).
// No DOM here, so it is tested in Node against real reports.
//
// The report lists items, and after each run of items a group line with their sum:
//   Cappuccino          4    6    13.20   12.12   13.20      <- item: name, till ID, quantity, incl. VAT, excl. VAT (after discount), incl. VAT (after discount)
//   Hot Drinks          2   56   101.70   93.25  101.70      <- group: quantity and amount equal the sum of the items above
// The period comes from "Start date: 10-11-2024 06:00" / "End date: 16-11-2024 00:00".

const isNum = (s) => typeof s === 'number' || /^-?(\d{1,3}([.,]\d{3})*|\d+)([.,]\d+)?$/.test(String(s).trim());

export function toNumber(v) {
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/\s/g, '');
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = /,\d{3}$/.test(s) && !/^-?0,/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "10-11-2024 06:00" (or 10/11/2024, 2024-11-10) -> { date: '2024-11-10', hour, minute }
function readDateTime(s) {
  let m = String(s).match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (m) return { date: `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`, hour: Number(m[4] || 0), minute: Number(m[5] || 0) };
  m = String(s).match(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, hour: Number(m[4] || 0), minute: Number(m[5] || 0) };
  return null;
}
const minusDay = (iso) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

// Excel stores dates as serial numbers
function excelDate(n) {
  if (typeof n !== 'number' || n < 30000 || n > 80000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
  const frac = n - Math.floor(n);
  return { date: d.toISOString().slice(0, 10), hour: Math.floor(frac * 24 + 1e-6), minute: Math.round((frac * 24 - Math.floor(frac * 24 + 1e-6)) * 60) };
}

function findPeriod(rows) {
  let start = null; let end = null;
  for (const cells of rows) {
    const text = cells.map((c) => (c == null ? '' : String(c))).join(' ');
    const pick = (label) => {
      const i = cells.findIndex((c) => new RegExp(label, 'i').test(String(c ?? '')));
      if (i < 0) return null;
      const inCell = readDateTime(String(cells[i]).replace(new RegExp(`.*${label}`, 'i'), ''));
      if (inCell) return inCell;
      for (const c of cells.slice(i + 1)) { const d = typeof c === 'number' ? excelDate(c) : readDateTime(c); if (d) return d; }
      return null;
    };
    if (!start && /start\s*date|startdatum|van\b|from\b/i.test(text)) start = pick('start\\s*date|startdatum');
    if (!end && /end\s*date|einddatum|tot\b|until\b/i.test(text)) end = pick('end\\s*date|einddatum');
  }
  if (!start) return null;
  let to = end ? end.date : start.date;
  // A report that ends at midnight (or before the morning start) does not include that day
  if (end && end.date > start.date && end.hour * 60 + end.minute <= start.hour * 60 + start.minute) to = minusDay(end.date);
  return { from: start.date, to: to < start.date ? start.date : to };
}

// One row of cells -> { name, code, qty, incl, excl } or null
function readLine(cells) {
  // Split text into words (PDF pieces can hold several numbers); keep real numbers as they are
  const parts = [];
  for (const c of cells) {
    if (c == null || c === '') continue;
    if (typeof c === 'number') parts.push(c);
    else parts.push(...String(c).trim().split(/\s+/).filter(Boolean));
  }
  if (!parts.length) return null;
  // The last five values are: till ID, quantity, incl. VAT, excl. VAT, incl. VAT after discount.
  // Everything before them is the name, even when it ends in a number ("Beverage 4.50").
  let k = parts.length;
  while (k > 0 && isNum(parts[k - 1])) k--;
  const trailing = parts.length - k;
  const n = trailing >= 5 ? 5 : trailing === 4 ? 4 : 0;
  if (!n) return { name: parts.join(' '), text: true };
  const nums = parts.slice(parts.length - n).map(toNumber);
  const name = parts.slice(0, parts.length - n).join(' ').replace(/\s+/g, ' ').trim();
  if (n === 5) return { name, code: String(nums[0]), qty: nums[1], gross: nums[2], excl: nums[3], incl: nums[4] };
  return { name, code: null, qty: nums[0], gross: nums[1], excl: nums[2], incl: nums[3] };
}

const NOISE = /^(turnover group report|this overview|name\b|excl\.|page \d|(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|start date|end date)/i;

// rows: arrays of cells (Excel/CSV) or of text pieces (PDF lines). Returns { period, lines, total, warnings }
export function parseTurnoverRows(rows) {
  const period = findPeriod(rows);
  const read = rows.map(readLine).filter(Boolean);
  // A long name the till printed on two lines, with the numbers in between and no name on that line
  const rowsOut = [];
  for (let i = 0; i < read.length; i++) {
    const r = read[i];
    if (r.text) continue;
    if (!r.name) {
      const before = read[i - 1] && read[i - 1].text && !NOISE.test(read[i - 1].name) ? read[i - 1].name : '';
      const after = read[i + 1] && read[i + 1].text && !NOISE.test(read[i + 1].name) ? read[i + 1].name : '';
      r.name = `${before} ${after}`.trim();
    }
    if (!r.name || NOISE.test(r.name)) continue;
    rowsOut.push(r);
  }
  const lines = []; const warnings = [];
  let pending = []; let total = null;
  const close = (a, b) => Math.abs(a - b) <= 0.05 + Math.abs(b) * 0.0005;
  for (const r of rowsOut) {
    if (/^(total|totaal)$/i.test(r.name)) { total = r; continue; }
    const sumQty = pending.reduce((s, x) => s + x.qty, 0);
    const sumGross = pending.reduce((s, x) => s + x.gross, 0);
    if (pending.length && close(r.qty, sumQty) && close(r.gross, sumGross)) {
      pending.forEach((x) => lines.push({ group_name: r.name, group_code: r.code, item_name: x.name, item_code: x.code, qty: x.qty, incl: x.incl, excl: x.excl }));
      pending = [];
    } else pending.push(r);
  }
  if (pending.length) {
    warnings.push(`${pending.length} line(s) without a group`);
    pending.forEach((x) => lines.push({ group_name: '', group_code: null, item_name: x.name, item_code: x.code, qty: x.qty, incl: x.incl, excl: x.excl }));
  }
  if (total) {
    const q = lines.reduce((s, x) => s + x.qty, 0); const v = lines.reduce((s, x) => s + x.incl, 0);
    if (!close(q, total.qty) || !close(v, total.incl)) warnings.push(`lines add up to ${q} items / ${v.toFixed(2)}, the report total says ${total.qty} / ${total.incl.toFixed(2)}`);
  }
  return { period, lines, total: total ? { qty: total.qty, incl: total.incl, excl: total.excl } : null, warnings };
}

// PDF text items (from pdf.js: str, transform[4]=x, transform[5]=y) -> rows of text pieces, top to bottom
export function pdfItemsToRows(pages) {
  const rows = [];
  for (const items of pages) {
    const byY = [];
    for (const it of items) {
      const s = String(it.str || '').trim();
      if (!s) continue;
      const y = it.transform[5]; const x = it.transform[4];
      let row = byY.find((r) => Math.abs(r.y - y) <= 2.5);
      if (!row) { row = { y, cells: [] }; byY.push(row); }
      row.cells.push({ x, s });
    }
    byY.sort((a, b) => b.y - a.y);
    for (const r of byY) rows.push(r.cells.sort((a, b) => a.x - b.x).map((c) => c.s));
  }
  return rows;
}
