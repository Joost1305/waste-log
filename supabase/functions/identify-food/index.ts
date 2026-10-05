// AI photo recognition for waste registration (AIService.identifyFood).
// - Works only on photos in the caller's own organization folder.
// - Without ANTHROPIC_API_KEY it answers { available: false } and the app continues manually.
// - Output is validated and mapped onto the organization's own categories and products.
// - Always a suggestion: the user confirms or corrects in the app.
import { admin, caller, cors, fail, json } from '../_shared/common.ts';

// Secrets are read per request, so a newly added key works without redeploying.
const env = () => ({ KEY: Deno.env.get('ANTHROPIC_API_KEY') || '', MODEL: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5' });

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
}

function matchProduct(name: string, products: { id: number; name: string; waste_category_id: number }[]) {
  const n = norm(name); if (!n) return null;
  const tokens = new Set(n.split(/\s+/));
  let best = null; let bestScore = 0;
  for (const p of products) {
    const pn = norm(p.name);
    if (pn === n) return p;
    const pt = pn.split(/\s+/);
    const overlap = pt.filter((t) => tokens.has(t) || [...tokens].some((x) => x.length > 3 && (t.startsWith(x) || x.startsWith(t)))).length;
    const score = overlap / Math.max(pt.length, tokens.size);
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return bestScore >= 0.5 ? best : null;
}

function toBase64(buf: ArrayBuffer) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (!me || !me.organization_id) return fail(401, 'Not signed in');
  const { KEY, MODEL } = env();
  if (!KEY) return json({ ok: true, data: { ok: false, available: false } });

  let body: { photo_path?: string; lang?: string };
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const path = String(body.photo_path || '');
  if (!path.startsWith(`org-${me.organization_id}/`) || path.includes('..')) return fail(404, 'Photo not found');

  const { data: file, error } = await sb.storage.from('waste-photos').download(path);
  if (error || !file) return fail(404, 'Photo not found');
  const mime = file.type && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg';

  const [{ data: cats }, { data: prods }] = await Promise.all([
    sb.from('waste_categories').select('id, code').or(`organization_id.is.null,organization_id.eq.${me.organization_id}`).eq('is_active', true),
    sb.from('products').select('id, name, waste_category_id').eq('organization_id', me.organization_id).eq('is_active', true).is('deleted_at', null),
  ]);
  const categories = cats || []; const products = prods || [];

  const prompt = [
    'You help a professional kitchen register food waste. Look at the photo and identify the main food that is being thrown away.',
    `Choose category_code from exactly this list: ${categories.map((c) => c.code).join(', ')}.`,
    `If it clearly matches one of the kitchen's own products, use that product name: ${products.slice(0, 80).map((p) => p.name).join('; ')}.`,
    'Only estimate suggested_weight_kg if a scale display or a clear reference makes it reliable; otherwise null.',
    'confidence is your honest probability (0-1) that product and category are right.',
    'Answer with ONLY a JSON object: {"product": string, "category_code": string, "subcategory": string|null, "confidence": number, "suggested_weight_kg": number|null}',
  ].join('\n');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: toBase64(await file.arrayBuffer()) } },
          { type: 'text', text: prompt },
        ] }],
      }),
    });
    if (!res.ok) return json({ ok: true, data: { ok: false, available: true, error: `AI provider HTTP ${res.status}` } });
    const out = await res.json();
    const text = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ ok: true, data: { ok: false, available: true, error: 'invalid_ai_output' } });
    const s = JSON.parse(m[0]);
    // Validate
    const valid = typeof s.product === 'string' && s.product.length > 0 && s.product.length <= 80 &&
      typeof s.category_code === 'string' && typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1 &&
      (s.suggested_weight_kg == null || (typeof s.suggested_weight_kg === 'number' && s.suggested_weight_kg > 0 && s.suggested_weight_kg <= 200));
    if (!valid) return json({ ok: true, data: { ok: false, available: true, error: 'invalid_ai_output' } });
    const cat = categories.find((c) => c.code === s.category_code) || null;
    const product = matchProduct(s.product, products);
    return json({ ok: true, data: { ok: true, available: true, suggestion: {
      product_text: s.product,
      product_id: product ? product.id : null,
      product_name: product ? product.name : s.product,
      waste_category_id: product?.waste_category_id ?? cat?.id ?? null,
      category_code: cat?.code ?? null,
      subcategory: typeof s.subcategory === 'string' ? s.subcategory.slice(0, 80) : null,
      confidence: Math.round(s.confidence * 100) / 100,
      suggested_weight_kg: s.suggested_weight_kg ?? null,
      provider: 'anthropic',
    } } });
  } catch (e) {
    return json({ ok: true, data: { ok: false, available: true, error: String((e as Error).message || e) } });
  }
});
