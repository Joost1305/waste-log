// Reads a till report file in the browser: Excel/CSV through the sheet reader, PDF through pdf.js
// (loaded only when a PDF is chosen). The layout itself is understood by sales-parse.js.
import { readSheet } from './xlsx-read.js';
import { parseTurnoverRows, pdfItemsToRows } from './sales-parse.js';

let pdfjs = null;
async function loadPdf() {
  if (!pdfjs) {
    pdfjs = await import('../vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjs;
}

export async function readSalesFile(file) {
  const name = (file.name || '').toLowerCase();
  let rows;
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    const lib = await loadPdf();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push((await (await doc.getPage(i)).getTextContent()).items);
    rows = pdfItemsToRows(pages);
  } else {
    rows = await readSheet(file);
  }
  return parseTurnoverRows(rows);
}
