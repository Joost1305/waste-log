// Read a supplier invoice (PDF, photo, or a table from Excel/CSV) and suggest the lines.
// - Managers and up only; files only from the caller's own organization folder in the "invoices" bucket.
// - Without ANTHROPIC_API_KEY it answers { available: false } and the app falls back to typing the lines.
// - Always a suggestion: the manager checks every line before anything is saved (save_invoice).
import { admin, caller, cors, fail, json } from '../_shared/common.ts';

const env = () => ({ KEY: Deno.env.get('ANTHROPIC_API_KEY') || '', MODEL: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5' });

function toBase64(buf: ArrayBuffer) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
const num = (v: unknown) => {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') { const n = Number(v.replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : null; }
  return null;
};
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (!me) return fail(401, 'Not signed in');
  if (me.rank < 30) return fail(403, 'Not allowed');
  const { KEY, MODEL } = env();
  if (!KEY) return json({ ok: true, data: { available: false } });

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const orgId: number | null = me.role === 'super_admin' ? (Number(body.organization_id) || me.organization_id) : me.organization_id;
  if (!orgId) return fail(400, 'No organization');

  // The document: a stored file (PDF or photo) or a table as text (read from Excel/CSV in the browser)
  let docBlock: Record<string, unknown> | null = null;
  const path = String(body.path || '');
  if (path) {
    if (!path.startsWith(`org-${orgId}/`) || path.includes('..')) return fail(404, 'File not found');
    const { data: file, error } = await sb.storage.from('invoices').download(path);
    if (error || !file) return fail(404, 'File not found');
    const buf = await file.arrayBuffer();
    const isPdf = file.type === 'application/pdf' || path.toLowerCase().endsWith('.pdf');
    docBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: toBase64(buf) } }
      : { type: 'image', source: { type: 'base64', media_type: ['image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg', data: toBase64(buf) } };
  } else if (typeof body.table_text === 'string' && body.table_text.trim()) {
    docBlock = { type: 'text', text: `Invoice as a table (tab separated, from a spreadsheet):\n${body.table_text.slice(0, 60000)}` };
  } else return fail(400, 'No invoice');

  const [{ data: prods }, { data: sups }, { data: cats }] = await Promise.all([
    sb.from('products').select('id, name, name_en, waste_category_id').eq('organization_id', orgId).eq('is_active', true).is('deleted_at', null).limit(2000),
    sb.from('suppliers').select('id, name').eq('organization_id', orgId).is('deleted_at', null).limit(500),
    sb.from('waste_categories').select('id, code'),
  ]);
  const products = prods || [];
  const catCode = new Map((cats || []).map((c: any) => [c.id, c.code]));
  const productList = products.map((p: any) => `${p.id} | ${p.name}${p.name_en ? ` / ${p.name_en}` : ''} | ${catCode.get(p.waste_category_id) || ''}`).join('\n');

  const prompt = [
    'You read a supplier invoice for a professional kitchen in the Netherlands. Extract the header and every product line.',
    'For each line give: the description as printed, quantity and unit as printed, unit_price, line_total (excluding VAT if both are shown), and quantity_kg.',
    'quantity_kg is the total net weight in kilograms for the whole line. Work it out from the description and quantity: "Uien 10 kg" with quantity 2 is 20; "Kipfilet 2,5kg" x 4 is 10; 500 gr x 6 is 3.',
    'For liquids such as milk, cream, juice, oil or soup, 1 litre counts as 1 kg. If the weight cannot be worked out (pieces without a weight, bunches, trays), use null. Never guess wildly.',
    'is_food: false for deposit (statiegeld), crates, delivery costs, discounts, packaging, cleaning products and other non-food lines.',
    'product_id: the id of the matching product from the kitchen list below, only if the line is clearly the same kind of food (e.g. "Tomaat tros" is Tomaten). Use null if unsure.',
    'confidence: your honest probability (0-1) that product_id and quantity_kg are right.',
    'Dates as YYYY-MM-DD. Amounts as numbers with a dot for decimals.',
    `Known suppliers: ${(sups || []).map((s: any) => s.name).join('; ') || 'none yet'}. Use the supplier name as printed on the invoice.`,
    'Kitchen products (id | name | category):',
    productList || '(none)',
    'Answer by calling the read_invoice tool.',
  ].join('\n');

  const tool = {
    name: 'read_invoice',
    description: 'The invoice header and lines.',
    input_schema: {
      type: 'object',
      properties: {
        supplier_name: { type: ['string', 'null'] },
        invoice_number: { type: ['string', 'null'] },
        invoice_date: { type: ['string', 'null'] },
        total_amount: { type: ['number', 'null'], description: 'Total excluding VAT if shown, else the total' },
        lines: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: ['number', 'null'] },
              unit: { type: ['string', 'null'] },
              unit_price: { type: ['number', 'null'] },
              line_total: { type: ['number', 'null'] },
              quantity_kg: { type: ['number', 'null'] },
              is_food: { type: 'boolean' },
              product_id: { type: ['integer', 'null'] },
              confidence: { type: 'number' },
            },
            required: ['description', 'line_total', 'quantity_kg', 'is_food', 'product_id', 'confidence'],
          },
        },
      },
      required: ['supplier_name', 'invoice_date', 'lines'],
    },
  };

  let out: any;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 16000,
        tools: [tool], tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: [docBlock, { type: 'text', text: prompt }] }],
      }),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`read-invoice: AI provider HTTP ${res.status} model=${MODEL} ${detail}`);
      return json({ ok: true, data: { available: true, ok: false, error: `AI provider HTTP ${res.status}` } });
    }
    out = await res.json();
  } catch (e) {
    console.error('read-invoice: request failed', String(e));
    return json({ ok: true, data: { available: true, ok: false, error: 'timeout' } });
  }

  let s: any = (out.content || []).find((c: any) => c.type === 'tool_use')?.input;
  if (!s) {
    const text = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    try { s = m ? JSON.parse(m[0]) : null; } catch { s = null; }
  }
  if (!s || !Array.isArray(s.lines)) return json({ ok: true, data: { available: true, ok: false, error: 'invalid_ai_output' } });

  const ids = new Set(products.map((p: any) => p.id));
  const date = str(s.invoice_date, 10);
  const lines = s.lines.slice(0, 400).map((l: any) => {
    const kg = num(l.quantity_kg);
    const pid = Number(l.product_id);
    return {
      description: str(l.description, 300) || '',
      quantity: num(l.quantity), unit: str(l.unit, 20), unit_price: num(l.unit_price), line_total: num(l.line_total),
      quantity_kg: kg != null && kg > 0 && kg < 100000 ? Math.round(kg * 1000) / 1000 : null,
      is_food: l.is_food !== false,
      product_id: ids.has(pid) ? pid : null,
      confidence: Math.min(1, Math.max(0, num(l.confidence) ?? 0.5)),
    };
  }).filter((l: any) => l.description || l.line_total != null);
  const supplier = str(s.supplier_name, 120);
  const known = supplier ? (sups || []).find((x: any) => x.name.toLowerCase() === supplier.toLowerCase()
    || supplier.toLowerCase().includes(x.name.toLowerCase()) || x.name.toLowerCase().includes(supplier.toLowerCase())) : null;

  return json({ ok: true, data: {
    available: true, ok: true,
    supplier_name: supplier, supplier_id: known ? known.id : null,
    invoice_number: str(s.invoice_number, 60),
    invoice_date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    total_amount: num(s.total_amount),
    lines,
    usage: out.usage || null,
  } });
});
