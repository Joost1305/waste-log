// AI photo recognition for waste registration (AIService.identifyFood).
// - Works only on photos in the caller's own organization folder.
// - Without ANTHROPIC_API_KEY it answers { available: false } and the app continues manually.
// - Output is validated and mapped onto the organization's own categories and products.
// - Always a suggestion: the user confirms or corrects in the app.
// - Weight: read from a visible scale display (weight_source "scale") or estimated ("estimate").
import { admin, caller, cors, fail, json } from '../_shared/common.ts';

// Secrets are read per request, so a newly added key works without redeploying.
const env = () => ({ KEY: Deno.env.get('ANTHROPIC_API_KEY') || '', MODEL: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5' });

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').trim();
}

type Product = { id: number; name: string; name_en?: string | null; waste_category_id: number; is_quick_pick?: boolean };

// Rank the kitchen's products against the AI's names (Dutch and English). Whole-word matches count more
// than partial ones, short plain names beat long ones ("Tomaten" before "Tomatenblokjes"),
// and products the kitchen registers often or has as quick button get a small boost.
function rankProducts(names: string[], products: Product[], uses: Map<number, number>) {
  const queries = names.map(norm).filter(Boolean).map((n) => n.split(/\s+/).filter((t) => t.length > 1));
  if (!queries.length) return [];
  const scored: { p: Product; score: number }[] = [];
  for (const p of products) {
    let best = 0;
    // match against the Dutch and the English product name, keep the best
    for (const pn of [p.name, p.name_en].filter(Boolean).map((x) => norm(x as string))) {
    const pt = pn.split(/\s+/).filter(Boolean);
    for (const q of queries) {
      if (pn === q.join(' ')) { best = Math.max(best, 2); continue; }
      let hit = 0;
      for (const qt of q) {
        if (pt.includes(qt)) hit += 1;
        else if (qt.length > 3 && pt.some((t) => t.startsWith(qt) || qt.startsWith(t))) {
          // stem match (tomaat / tomaten / tomatoes) counts almost fully when the lengths are close
          const t = pt.find((x) => x.startsWith(qt) || qt.startsWith(x))!;
          hit += Math.abs(t.length - qt.length) <= 2 ? 0.9 : 0.5;
        } else if (qt.length > 4 && pt.some((t) => t.slice(0, 5) === qt.slice(0, 5))) hit += 0.6;
        // Dutch compounds: ijsbergsla ends in sla, kipborstfilet ends in filet
        else if (pt.some((t) => t.length > 2 && qt.length > t.length + 2 && qt.endsWith(t))) hit += 0.7;
      }
      if (!hit) continue;
      const coverage = hit / q.length;                 // how much of the AI name is found
      const precision = hit / Math.max(pt.length, 1);   // how little else the product name contains
      best = Math.max(best, coverage * 0.65 + precision * 0.35);
    }
    }
    if (best < 0.42) continue;
    const n = uses.get(p.id) || 0;
    best += (n ? Math.min(0.2, 0.05 + Math.log10(1 + n) * 0.06) : 0) + (p.is_quick_pick ? 0.05 : 0);
    scored.push({ p, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.length - b.p.name.length);
  return scored.slice(0, 6);
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
  if (!me) return fail(401, 'Not signed in');
  const { KEY, MODEL } = env();
  if (!KEY) return json({ ok: true, data: { ok: false, available: false } });

  let body: { photo_path?: string; lang?: string };
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const path = String(body.photo_path || '');
  // The organization comes from the user; a super admin (no organization of their own) works in the photo's organization
  const pathOrg = Number((/^org-(\d+)\//.exec(path) || [])[1]) || null;
  const orgId = me.role === 'super_admin' ? pathOrg : me.organization_id;
  if (!orgId || pathOrg !== orgId || path.includes('..')) return fail(404, 'Photo not found');

  const { data: file, error } = await sb.storage.from('waste-photos').download(path);
  if (error || !file) return fail(404, 'Photo not found');
  const mime = file.type && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg';

  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const [{ data: cats }, { data: recent }] = await Promise.all([
    sb.from('waste_categories').select('id, code').or(`organization_id.is.null,organization_id.eq.${orgId}`).eq('is_active', true),
    sb.from('waste_records').select('product_id').eq('organization_id', orgId).not('product_id', 'is', null)
      .is('deleted_at', null).gte('recorded_at', since).limit(5000),
  ]);
  // All active products (paged: Supabase returns at most 1000 rows per request), used to match the AI's answer
  const products: Product[] = [];
  for (let from = 0; from < 20000; from += 1000) {
    const { data: page } = await sb.from('products').select('id, name, name_en, waste_category_id, is_quick_pick')
      .eq('organization_id', orgId).eq('is_active', true).is('deleted_at', null).order('id').range(from, from + 999);
    products.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  const categories = cats || [];
  // The prompt names the kitchen's most relevant products: quick buttons first, then the most registered in 90 days
  const uses = new Map<number, number>();
  for (const r of recent || []) uses.set(r.product_id, (uses.get(r.product_id) || 0) + 1);
  const promptProducts = [...products].filter((p) => p.is_quick_pick || uses.has(p.id))
    .sort((a, b) => Number(b.is_quick_pick) - Number(a.is_quick_pick) || (uses.get(b.id) || 0) - (uses.get(a.id) || 0)).slice(0, 250);

  const prompt = [
    'You help a professional kitchen register food waste. Look at the photo and identify the main food that is being thrown away.',
    `Choose category_code from exactly this list: ${categories.map((c) => c.code).join(', ')}.`,
    promptProducts.length ? `If it clearly matches one of the kitchen's most used products, use that product name: ${promptProducts.map((p) => p.name).join('; ')}.` : 'Name the product in plain words.',
    'Write the product name the way a Dutch professional kitchen lists it (in Dutch, e.g. "Tomaten", "Kipdijfilet", "Stokbrood"), so it can be matched to the kitchen\'s product list.',
    'Weight: if a scale display is visible, read it, convert to kg and set weight_source to "scale".',
    'Otherwise estimate the weight of the wasted food in kg from its size, the container and any reference objects, and set weight_source to "estimate".',
    'Only use null for suggested_weight_kg if there is no visible food at all.',
    'confidence is your honest probability (0-1) that product and category are right.',
    'Also give product_en: the same product in plain English (e.g. "Tomatoes").',
    'Answer with ONLY a JSON object: {"product": string, "product_en": string, "category_code": string, "subcategory": string|null, "confidence": number, "suggested_weight_kg": number|null, "weight_source": "scale"|"estimate"|null}',
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
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      console.error(`identify-food: AI provider HTTP ${res.status} model=${MODEL} ${detail}`);
      return json({ ok: true, data: { ok: false, available: true, error: `AI provider HTTP ${res.status}` } });
    }
    const out = await res.json();
    const text = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { console.error('identify-food: no JSON in AI answer', text.slice(0, 200)); return json({ ok: true, data: { ok: false, available: true, error: 'invalid_ai_output' } }); }
    const s = JSON.parse(m[0]);
    // Validate
    const valid = typeof s.product === 'string' && s.product.length > 0 && s.product.length <= 80 &&
      typeof s.category_code === 'string' && typeof s.confidence === 'number' && s.confidence >= 0 && s.confidence <= 1 &&
      (s.suggested_weight_kg == null || (typeof s.suggested_weight_kg === 'number' && s.suggested_weight_kg > 0 && s.suggested_weight_kg <= 200)) &&
      (s.weight_source == null || s.weight_source === 'scale' || s.weight_source === 'estimate');
    if (!valid) { console.error('identify-food: AI answer failed validation', m[0].slice(0, 200)); return json({ ok: true, data: { ok: false, available: true, error: 'invalid_ai_output' } }); }
    const cat = categories.find((c) => c.code === s.category_code) || null;
    const ranked = rankProducts([s.product, typeof s.product_en === 'string' ? s.product_en.slice(0, 80) : ''], products, uses);
    const product = ranked.length ? ranked[0].p : null;
    return json({ ok: true, data: { ok: true, available: true, suggestion: {
      product_text: s.product,
      product_id: product ? product.id : null,
      product_name: product ? product.name : s.product,
      waste_category_id: product?.waste_category_id ?? cat?.id ?? null,
      category_code: cat?.code ?? null,
      subcategory: typeof s.subcategory === 'string' ? s.subcategory.slice(0, 80) : null,
      confidence: Math.round(s.confidence * 100) / 100,
      suggested_weight_kg: s.suggested_weight_kg != null ? Math.round(s.suggested_weight_kg * 1000) / 1000 : null,
      weight_source: s.suggested_weight_kg != null ? (s.weight_source === 'scale' ? 'scale' : 'estimate') : null,
      // other likely products, shown as tiles so the user can switch with one tap
      candidates: ranked.map((r) => ({ id: r.p.id, name: r.p.name, waste_category_id: r.p.waste_category_id })),
      provider: 'anthropic',
    } } });
  } catch (e) {
    console.error('identify-food: error', String((e as Error).message || e));
    return json({ ok: true, data: { ok: false, available: true, error: String((e as Error).message || e) } });
  }
});
