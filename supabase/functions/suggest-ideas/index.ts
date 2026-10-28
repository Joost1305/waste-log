// AI ideas for one suggested intervention (Interventions page, "Ask AI for ideas").
// - The numbers never come from the browser: the function asks the database for the suggestions as the signed-in
//   user (Row Level Security decides what they see) and picks the one that was asked for.
// - Claude gets those numbers, the reason, the examples that worked elsewhere and up to 2 recent photos,
//   and writes 2 or 3 concrete ideas. It may not invent figures; ideas with digits that are not in the data are dropped.
// - Without ANTHROPIC_API_KEY it answers { available: false } and the page simply hides the button's result.
// - Managers and up.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { admin, caller, cors, fail, json } from '../_shared/common.ts';

const env = () => ({ KEY: Deno.env.get('ANTHROPIC_API_KEY') || '', MODEL: Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5' });

function toBase64(buf: ArrayBuffer) {
  let s = ''; const b = new Uint8Array(buf);
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (!me) return fail(401, 'Not signed in');
  if (me.rank < 30) return fail(403, 'Not allowed');
  const { KEY, MODEL } = env();
  if (!KEY) return json({ ok: true, data: { available: false } });

  let body: { organization_id?: number; restaurant_id?: number; rule?: string; subject?: string; lang?: string };
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const lang = body.lang === 'nl' ? 'nl' : 'en';
  const rid = Number(body.restaurant_id) || null;
  if (!rid || !body.rule) return fail(400, 'restaurant_id and rule are required');

  // The suggestion itself, computed by the database as this user
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') || '' } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: list, error } = await user.rpc('intervention_suggestions',
    { p_org: me.role === 'super_admin' ? Number(body.organization_id) || null : null, p_restaurant: rid, p_days: 28, p_lang: lang });
  if (error) return fail(403, error.message);
  const subj = (s: any) => String(s.rule === 'plate' ? s.menu_item : s.rule === 'weekday' ? s.dow : s.product_name);
  const s = (list || []).find((x: any) => x.rule === body.rule && subj(x) === String(body.subject ?? ''));
  if (!s) return fail(404, 'Suggestion not found');

  // Up to 2 recent photos of the same product or dish, from this organization's folder only
  const rest = (await sb.from('restaurants').select('organization_id, name').eq('id', rid).single()).data;
  let photoQ = sb.from('waste_records').select('photo_path').eq('restaurant_id', rid).is('deleted_at', null)
    .not('photo_path', 'is', null).gte('recorded_at', new Date(Date.now() - 28 * 86400000).toISOString())
    .order('weight_kg', { ascending: false }).limit(2);
  if (s.rule === 'plate') photoQ = photoQ.eq('menu_item_id', s.menu_item_id);
  else if (s.product_name) photoQ = photoQ.eq('product_name', s.product_name);
  else photoQ = photoQ.eq('reason_id', s.reason_id);
  const { data: photos } = await photoQ;
  const images: unknown[] = [];
  for (const p of photos || []) {
    if (!rest || !String(p.photo_path).startsWith(`org-${rest.organization_id}/`)) continue;
    const { data: file } = await sb.storage.from('waste-photos').download(p.photo_path);
    if (!file || file.size > 4_500_000) continue;
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ? file.type : 'image/jpeg';
    images.push({ type: 'image', source: { type: 'base64', media_type: mime, data: toBase64(await file.arrayBuffer()) } });
  }

  const what = s.rule === 'plate' ? `the dish "${s.menu_item}"` : s.rule === 'weekday' ? `weekday number ${s.dow} (1 = Monday)` : `the product "${s.product_name}"`;
  const facts = [
    `Restaurant: ${rest?.name || ''}. Period: last ${s.period_days} days, avoidable waste only.`,
    `Pattern (${s.rule}): ${what}. Most common reason: ${s.reason || s.reason_code}.`,
    `Facts: ${s.kg} kg, €${s.value}` + (s.share_pct != null ? `, ${s.share_pct}% of the restaurant's avoidable ${s.rule === 'costly' ? 'euros' : 'kilos'}` : '')
      + (s.records != null ? `, ${s.records} registrations` : '') + (s.days != null ? ` on ${s.days} days` : '')
      + (s.base_kg != null ? `; ${s.kg} kg per day on that weekday against ${s.base_kg} kg on other open days` : '') + '.',
    s.rule === 'early' ? 'This is an early signal based on very few registrations: suggest light, low-effort things to try and to watch.' : '',
    (s.examples || []).length ? `Examples that worked elsewhere: ${s.examples.map((e: any) => `${e.title}${e.who ? ` (${e.who})` : ''}`).join('; ')}.` : '',
  ].filter(Boolean).join('\n');
  const allowedNumbers = new Set((facts.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', '.')));

  const prompt = [
    'You advise the chef of a professional kitchen (a hotel school restaurant) on reducing food waste.',
    facts,
    images.length ? 'The photos show recent registrations of this waste.' : '',
    `Write 2 or 3 different, concrete interventions the team can start this week. Language: ${lang === 'nl' ? 'Dutch' : 'English'}, plain kitchen language, no jargon.`,
    'title: an imperative of at most 10 words, usable as the name of the intervention.',
    'how: one or two sentences: exactly what changes in the kitchen, who does it and when.',
    'Never blame people. Do not invent numbers, percentages, prices or results; only use numbers from the facts above, or none.',
    'Answer by calling the give_ideas tool.',
  ].filter(Boolean).join('\n');

  const tool = {
    name: 'give_ideas',
    description: 'Give 2 or 3 interventions to try.',
    input_schema: {
      type: 'object',
      properties: { ideas: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, how: { type: 'string' } }, required: ['title', 'how'] } } },
      required: ['ideas'],
    },
  };

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 900, tools: [tool], tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: [...images, { type: 'text', text: prompt }] }],
      }),
    });
    if (!res.ok) {
      console.error(`suggest-ideas: AI provider HTTP ${res.status} model=${MODEL} ${(await res.text()).slice(0, 300)}`);
      return json({ ok: true, data: { available: true, ideas: [], error: `AI provider HTTP ${res.status}` } });
    }
    const out = await res.json();
    let raw: any = (out.content || []).find((c: any) => c.type === 'tool_use')?.input;
    if (!raw) {
      const text = (out.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
      const m = text.match(/\{[\s\S]*\}/);
      try { raw = m ? JSON.parse(m[0]) : null; } catch { raw = null; }
    }
    // Validate: short strings, at most 3, and no figures that are not in the facts
    const ideas = (Array.isArray(raw?.ideas) ? raw.ideas : [])
      .map((i: any) => ({ title: clean(i?.title, 90), how: clean(i?.how, 320) }))
      .filter((i: any) => i.title && i.how)
      // clock times (12:30, 14u) and small counts (two batches, 3 pans) are fine
      .filter((i: any) => ((i.title + ' ' + i.how).replace(/\b\d{1,2}[:u]\d{0,2}\b/g, ' ').match(/\d+(?:[.,]\d+)?/g) || [])
        .every((n: string) => allowedNumbers.has(n.replace(',', '.')) || Number(n) <= 3))
      .slice(0, 3);
    return json({ ok: true, data: { available: true, ideas, photos: images.length } });
  } catch (e) {
    console.error('suggest-ideas:', e);
    return json({ ok: true, data: { available: true, ideas: [], error: 'AI did not answer in time' } });
  }
});
