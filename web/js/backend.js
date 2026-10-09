// Data layer: maps the app's API calls onto Supabase (database, auth, storage, edge functions).
// Pages call api('/path', { method, body, query }) and get { data, meta } back, as before.
// Security does not live here: Row Level Security and database triggers enforce every rule.
import { SUPABASE_URL, SUPABASE_KEY, PHOTO_BUCKET } from './config.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'wastelog-auth' },
});

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message || `Error ${status}`);
    this.status = status;
    this.body = { error: { message, details } };
  }
}

const ctx = { orgId: null, lang: 'en', profile: null };
export function setContext(c) { Object.assign(ctx, c); }

function check(res, notFoundIfEmpty = false) {
  if (res.error) {
    const e = res.error;
    const status = e.code === '42501' ? 403 : e.code === 'PGRST116' || e.code === 'P0002' ? 404 : (res.status || 400);
    throw new ApiError(status, e.message || 'Request failed', e.details ? [{ field: '', message: e.details }] : undefined);
  }
  if (notFoundIfEmpty && Array.isArray(res.data) && res.data.length === 0) throw new ApiError(404, 'Not found');
  return res.data;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
const softDelete = async (table, id) => {
  check(await sb.from(table).update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id'), true);
  return { deleted: true };
};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

async function profile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new ApiError(401, 'Not signed in');
  const p = check(await sb.from('users').select('id, name, email, role, language, organization_id').eq('id', session.user.id).maybeSingle());
  if (!p) { await sb.auth.signOut(); throw new ApiError(401, 'No access to this application'); }
  ctx.profile = p;
  return p;
}

async function invoke(fn, body) {
  const { data, error } = await sb.functions.invoke(fn, { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); msg = j.error?.message || msg; } catch { /* keep default */ }
    throw new ApiError(error.context?.status || 400, msg);
  }
  return data.data;
}

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), fn });

// auth
route('POST', '/auth/login', async ({ body }) => {
  const { error } = await sb.auth.signInWithPassword({ email: body.email, password: body.password });
  if (error) throw new ApiError(401, error.message === 'Invalid login credentials' ? 'Email or password is incorrect' : error.message);
  return { user: await profile() };
});
route('POST', '/auth/logout', async () => { await sb.auth.signOut(); return { signedOut: true }; });
route('GET', '/auth/me', async () => ({ user: await profile() }));
// Set a new password after following an invitation or reset link (the link itself signed the person in).
route('PATCH', '/auth/password', async ({ body }) => {
  if (!body.password || String(body.password).length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
  const { error } = await sb.auth.updateUser({ password: body.password });
  if (error) throw new ApiError(400, error.message);
  return { user: await profile() };
});
route('PATCH', '/auth/me', async ({ body }) => {
  if (body.new_password) {
    const p = ctx.profile || await profile();
    const { error } = await sb.auth.signInWithPassword({ email: p.email, password: body.current_password || '' });
    if (error) throw new ApiError(400, 'Current password is incorrect');
    const up = await sb.auth.updateUser({ password: body.new_password });
    if (up.error) throw new ApiError(400, up.error.message);
  }
  let user = ctx.profile;
  if (body.name || body.language) user = check(await sb.rpc('update_my_profile', { p_name: body.name ?? null, p_language: body.language ?? null }));
  return { user };
});

// meta
route('GET', '/meta', async () => check(await sb.rpc('app_meta', { p_org: ctx.orgId, p_lang: ctx.lang })));

// organizations
route('GET', '/organizations', async () => {
  const rows = check(await sb.from('organizations').select('id, name, slug, is_demo, default_value_per_kg, restaurants(count)').is('deleted_at', null).order('name'));
  return rows.map((o) => ({ ...o, restaurant_count: o.restaurants?.[0]?.count ?? 0 }));
});
route('POST', '/organizations', async ({ body }) => {
  const slug = String(body.name).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
  return check(await sb.from('organizations').insert({ name: body.name, slug, default_value_per_kg: body.default_value_per_kg || 6.5 }).select().single());
});
route('GET', '/organization', async () => check(await sb.from('organizations').select('*').eq('id', ctx.orgId).single()));
route('PATCH', '/organization', async ({ body }) =>
  check(await sb.from('organizations').update(pick(body, ['name', 'default_value_per_kg', 'default_language', 'currency', 'weather_enabled', 'leaderboard_enabled', 'leaderboard_prize', 'leaderboard_period', 'leaderboard_season_start'])).eq('id', ctx.orgId).select().single()));

// restaurants
route('GET', '/restaurants', async () => check(await sb.from('restaurants').select('*').eq('organization_id', ctx.orgId).is('deleted_at', null).order('name')));
route('POST', '/restaurants', async ({ body }) => {
  const slug = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36).slice(-4);
  return check(await sb.from('restaurants').insert({ ...pick(body, ['name', 'city', 'latitude', 'longitude', 'public_impact_enabled']), slug, organization_id: ctx.orgId }).select().single());
});
route('PATCH', '/restaurants/:id', async ({ p, body }) =>
  check(await sb.from('restaurants').update(pick(body, ['name', 'city', 'latitude', 'longitude', 'public_impact_enabled'])).eq('id', p.id).select(), true)[0]);
route('DELETE', '/restaurants/:id', async ({ p }) => softDelete('restaurants', p.id));

// users (writes via the admin-users edge function)
route('GET', '/users', async () => {
  const users = check(await sb.from('users').select('id, name, email, role, language, is_active, organization_id').eq('organization_id', ctx.orgId).is('deleted_at', null).order('name'));
  const links = check(await sb.from('user_restaurants').select('user_id, restaurant_id').in('user_id', users.map((u) => u.id)));
  // Last login and invitation status come from Supabase Auth (org admins only; others get an empty list)
  const logins = (await sb.rpc('user_logins', { p_org: ctx.orgId })).data || [];
  return users.map((u) => {
    const l = logins.find((x) => x.id === u.id) || {};
    return { ...u, last_login_at: l.last_sign_in_at || null, invite_pending: Boolean(l.invited_at && !l.last_sign_in_at),
      restaurant_ids: links.filter((x) => x.user_id === u.id).map((x) => x.restaurant_id) };
  });
});
const appUrl = () => `${location.origin}${location.pathname}`;
route('POST', '/users', async ({ body }) => invoke('admin-users', { action: 'create', organization_id: ctx.orgId, redirect_to: appUrl(), ...body }));
route('POST', '/users/:id/send-reset', async ({ p }) => invoke('admin-users', { action: 'send_reset', organization_id: ctx.orgId, id: p.id, redirect_to: appUrl() }));
route('PATCH', '/users/:id', async ({ p, body }) => invoke('admin-users', { action: 'update', organization_id: ctx.orgId, id: p.id, ...body }));
route('DELETE', '/users/:id', async ({ p }) => invoke('admin-users', { action: 'delete', organization_id: ctx.orgId, id: p.id }));

// audit
route('GET', '/audit', async ({ query }) => {
  const rows = check(await sb.from('audit_log').select('*').eq('organization_id', ctx.orgId).order('id', { ascending: false }).limit(Number(query.limit) || 100));
  const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))];
  const names = ids.length ? check(await sb.from('users').select('id, name').in('id', ids)) : [];
  return rows.map((r) => ({ ...r, details: r.details ? JSON.stringify(r.details) : '', user_name: (names.find((n) => n.id === r.user_id) || {}).name }));
});

// catalog: suppliers, products, menu items, targets
const catalog = {
  suppliers: { table: 'suppliers', select: '*', fields: ['name', 'contact'] },
  products: { table: 'products', select: '*, suppliers(name)', fields: ['name', 'name_en', 'waste_category_id', 'category_id', 'default_supplier_id', 'purchase_price_per_kg', 'price_estimated', 'sales_price_per_kg', 'co2e_per_kg', 'co2e_source', 'is_quick_pick', 'is_active'] },
  'menu-items': { table: 'menu_items', select: '*, restaurants(name)', fields: ['name', 'restaurant_id', 'portion_size_g', 'sales_price', 'cost_price', 'is_active'] },
  targets: { table: 'targets', select: '*, restaurants(name)', fields: ['name', 'restaurant_id', 'period', 'baseline_kg', 'target_kg', 'start_date', 'end_date'] },
};
const flat = (r) => ({ ...r, supplier_name: r.suppliers?.name, restaurant_name: r.restaurants?.name });
for (const [path, c] of Object.entries(catalog)) {
  route('GET', `/${path}`, async () => {
    // Supabase returns at most 1000 rows per request: page through long lists (e.g. thousands of products)
    const all = [];
    for (let from = 0; from < 50000; from += 1000) {
      const page = check(await sb.from(c.table).select(c.select).eq('organization_id', ctx.orgId).is('deleted_at', null)
        .order(path === 'targets' ? 'start_date' : 'name', { ascending: path !== 'targets' }).order('id').range(from, from + 999));
      all.push(...page);
      if (page.length < 1000) break;
    }
    return all.map(flat);
  });
  route('POST', `/${path}`, async ({ body }) => {
    const row = { ...pick(body, c.fields), organization_id: ctx.orgId };
    if (path === 'targets') row.created_by = (ctx.profile || await profile()).id;
    return check(await sb.from(c.table).insert(row).select().single());
  });
  route('PATCH', `/${path}/:id`, async ({ p, body }) => check(await sb.from(c.table).update(pick(body, c.fields)).eq('id', p.id).select(), true)[0]);
  route('DELETE', `/${path}/:id`, async ({ p }) => softDelete(c.table, p.id));
}

// Missing products: names typed in (or taken from the AI) that are not in the list yet
route('GET', '/products-missing', async ({ query }) => check(await sb.rpc('missing_products', { p_org: ctx.orgId, p_days: num(query.days) || 90 })));
route('POST', '/products-missing/link', async ({ body }) =>
  ({ linked: check(await sb.rpc('link_missing_product', { p_product: Number(body.product_id), p_name: body.name, p_org: ctx.orgId })) }));

// Product import from Excel: create missing suppliers, add new products, optionally update existing ones.
route('POST', '/products/import', async ({ body }) => {
  const norm = (x) => String(x ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const rows = (body.rows || []).filter((r) => r.name && String(r.name).trim()).slice(0, 15000);
  const price = (v) => (v == null || !Number.isFinite(Number(v)) || Number(v) < 0 ? null : Math.round(Number(v) * 100) / 100);
  // Supabase returns at most 1000 rows per request: page through existing products
  const products = [];
  for (let from = 0; ; from += 1000) {
    const page = check(await sb.from('products').select('id, name').eq('organization_id', ctx.orgId).is('deleted_at', null).order('id').range(from, from + 999));
    products.push(...page);
    if (page.length < 1000) break;
  }
  let suppliers = check(await sb.from('suppliers').select('id, name').eq('organization_id', ctx.orgId).is('deleted_at', null));
  const supNames = [...new Map(rows.filter((r) => r.supplier).map((r) => [norm(r.supplier), String(r.supplier).trim()])).entries()]
    .filter(([k]) => !suppliers.some((s) => norm(s.name) === k)).map(([, v]) => v);
  if (supNames.length) {
    const made = check(await sb.from('suppliers').insert(supNames.map((name) => ({ name, organization_id: ctx.orgId }))).select('id, name'));
    suppliers = suppliers.concat(made);
  }
  const supId = (n) => (n ? (suppliers.find((s) => norm(s.name) === norm(n)) || {}).id ?? null : null);
  const byName = new Map(products.map((p) => [norm(p.name), p.id]));
  const fresh = []; const updates = [];
  for (const r of rows) {
    const row = { name: String(r.name).trim().slice(0, 200), name_en: r.name_en ? String(r.name_en).trim().slice(0, 200) : null, waste_category_id: Number(r.waste_category_id),
      purchase_price_per_kg: price(r.purchase_price_per_kg), sales_price_per_kg: price(r.sales_price_per_kg), default_supplier_id: supId(r.supplier) };
    const id = byName.get(norm(row.name));
    if (id) { if (body.update) updates.push({ id, row }); } else { fresh.push({ ...row, organization_id: ctx.orgId, is_active: true }); byName.set(norm(row.name), -1); }
  }
  for (let i = 0; i < fresh.length; i += 200) check(await sb.from('products').insert(fresh.slice(i, i + 200)).select('id'));
  for (const u of updates) {
    const patch = { waste_category_id: u.row.waste_category_id };
    if (u.row.name_en) patch.name_en = u.row.name_en;
    if (u.row.purchase_price_per_kg != null) patch.purchase_price_per_kg = u.row.purchase_price_per_kg;
    if (u.row.sales_price_per_kg != null) patch.sales_price_per_kg = u.row.sales_price_per_kg;
    if (u.row.default_supplier_id) patch.default_supplier_id = u.row.default_supplier_id;
    check(await sb.from('products').update(patch).eq('id', u.id).select('id'));
  }
  return { created: fresh.length, updated: updates.length, suppliers_created: supNames.length };
});

// guests per day
route('GET', '/covers', async ({ query }) => {
  let q = sb.from('daily_covers').select('id, restaurant_id, date, guests, restaurants(name)').eq('organization_id', ctx.orgId).order('date', { ascending: false }).limit(60);
  if (query.restaurant_id) q = q.eq('restaurant_id', query.restaurant_id);
  return check(await q).map(flat);
});
route('PUT', '/covers', async ({ body }) =>
  check(await sb.from('daily_covers').upsert({ restaurant_id: body.restaurant_id, date: body.date, guests: body.guests }, { onConflict: 'restaurant_id,date' }).select().single()));

// waste
route('GET', '/waste', async ({ query }) => {
  const res = check(await sb.rpc('list_waste', {
    p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null,
    p_category: num(query.waste_category_id), p_reason: num(query.reason_id), p_mine: query.mine === '1',
    p_limit: num(query.limit) || 50, p_offset: num(query.offset) || 0, p_lang: ctx.lang,
  }));
  return { __meta: { total: res.total, total_kg: res.total_kg, total_value: res.total_value }, rows: res.rows };
});
function wasteRow(body) {
  const row = pick(body, ['restaurant_id', 'section_id', 'product_id', 'product_name', 'waste_category_id', 'category_id', 'reason_id', 'menu_item_id',
    'supplier_id', 'location', 'moment', 'note', 'recorded_at']);
  if (body.weight !== undefined) {
    row.weight_kg = Math.round((body.unit === 'g' ? body.weight / 1000 : body.weight) * 1000) / 1000;
    row.entered_unit = body.unit || 'kg';
  }
  return row;
}
route('POST', '/waste', async ({ body }) => {
  const me = ctx.profile || await profile();
  const row = { ...wasteRow(body), user_id: me.id };
  if (body.photo_path) row.photo_path = body.photo_path;
  if (['manual', 'scale', 'estimate'].includes(body.weight_source)) row.weight_source = body.weight_source;
  if (body.ai_suggestion) { row.ai_suggestion = body.ai_suggestion; row.ai_accepted = body.ai_accepted ?? null; }
  if (row.weight_kg > 500) throw new ApiError(400, 'Weight above 500 kg in one record, please check the unit');
  return check(await sb.from('waste_records').insert(row).select('id, product_name, waste_category_id, section_id, weight_kg, purchase_value, valuation_method').single());
});
route('PATCH', '/waste/:id', async ({ p, body }) =>
  check(await sb.from('waste_records').update(wasteRow(body)).eq('id', p.id).select('id'), true)[0]);
route('DELETE', '/waste/:id', async ({ p }) => softDelete('waste_records', p.id));
// Delete several at once. Row Level Security decides which ones the user may delete;
// the answer says how many were actually deleted.
route('POST', '/waste/delete', async ({ body }) => {
  const ids = [...new Set((body.ids || []).map(Number).filter((x) => Number.isInteger(x) && x > 0))].slice(0, 500);
  if (!ids.length) return { deleted: 0, requested: 0 };
  const rows = check(await sb.from('waste_records').update({ deleted_at: new Date().toISOString() }).in('id', ids).is('deleted_at', null).select('id'));
  return { deleted: rows.length, requested: ids.length };
});

// photos: upload straight to private storage, AI via edge function
route('POST', '/waste/photo', async ({ form }) => {
  const blob = form.get('photo');
  const month = new Date().toISOString().slice(0, 7);
  const path = `org-${ctx.orgId}/${month}/${crypto.randomUUID()}.jpg`;
  const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false });
  if (error) throw new ApiError(403, /row-level security/i.test(error.message) ? 'No permission to save a photo for this organization' : error.message);
  return { photo_path: path };
});
route('POST', '/waste/photo/identify', async ({ body }) => invoke('identify-food', { photo_path: body.photo_path, lang: ctx.lang }));

// automatic quick buttons: the restaurant's most registered products (last 30 days)
route('GET', '/top-products', async ({ query }) =>
  check(await sb.rpc('top_products', { p_restaurant: num(query.restaurant_id), p_days: num(query.days) || 30, p_limit: num(query.limit) || 12 })));

// gallery: photos, heaviest first
route('GET', '/gallery', async ({ query }) => {
  const res = check(await sb.rpc('gallery', {
    p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null,
    p_category: num(query.waste_category_id), p_limit: num(query.limit) || 24, p_offset: num(query.offset) || 0, p_lang: ctx.lang,
    p_sort: query.sort || 'heaviest',
  }));
  return { __meta: { total: res.total, total_kg: res.total_kg, total_value: res.total_value }, rows: res.rows };
});

// export: every record (flat) and guest counts for a period, for Excel
route('GET', '/export', async ({ query }) => check(await sb.rpc('export_data', {
  p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null,
  p_category: num(query.waste_category_id), p_reason: num(query.reason_id), p_mine: query.mine === '1', p_lang: ctx.lang,
})));

// CO2 factors and where they come from
route('GET', '/co2-factors', async () => {
  const rows = check(await sb.from('waste_categories').select('id, code, labels, co2e_per_kg, co2e_source, co2e_source_url, color, sort_order, organization_id')
    .eq('is_active', true).order('sort_order'));
  return rows.filter((r) => r.organization_id === null || r.organization_id === ctx.orgId)
    .map((r) => ({ ...r, label: r.labels?.[ctx.lang] || r.labels?.en || r.code }));
});

// public impact page (works without signing in; only restaurants with the page switched on)
route('GET', '/public-impact', async ({ query }) => check(await sb.rpc('public_impact', {
  p_org_slug: query.org, p_restaurant_slug: query.restaurant || null, p_lang: ctx.lang })));
route('GET', '/my-org-slug', async () => check(await sb.rpc('my_org_slug', { p_org: ctx.orgId })));

// interventions: what a restaurant changed, and the before/after effect measured from the records
const IV_FIELDS = ['restaurant_id', 'title', 'reason', 'description', 'type', 'start_date', 'end_date', 'status', 'responsible_label',
  'expected_change_pct', 'scope_waste_category_id', 'scope_reason_id', 'scope_menu_item_id'];
route('GET', '/interventions', async () => check(await sb.rpc('interventions_list', { p_org: ctx.orgId, p_lang: ctx.lang })));
route('GET', '/interventions/:id/effect', async ({ p, query }) =>
  check(await sb.rpc('intervention_effect', { p_id: Number(p.id), p_days: num(query.days) || 28 })));
route('POST', '/interventions', async ({ body }) =>
  check(await sb.from('interventions').insert({ ...pick(body, IV_FIELDS), organization_id: ctx.orgId }).select('id').single()));
route('PATCH', '/interventions/:id', async ({ p, body }) =>
  check(await sb.from('interventions').update(pick(body, IV_FIELDS)).eq('id', p.id).select('id'), true));
route('DELETE', '/interventions/:id', async ({ p }) => softDelete('interventions', p.id));

// best practices: a short story (problem, solution, result) with an optional photo or PDF
const BP_FIELDS = ['restaurant_id', 'intervention_id', 'category_id', 'title', 'problem', 'solution', 'result', 'result_change_pct', 'status',
  'attachment_path', 'attachment_name', 'attachment_type'];
route('GET', '/best-practices', async () => check(await sb.rpc('best_practices_list', { p_org: ctx.orgId, p_lang: ctx.lang })));
route('POST', '/best-practices', async ({ body }) =>
  check(await sb.from('best_practices').insert({ ...pick(body, BP_FIELDS), organization_id: ctx.orgId }).select('id').single()));
route('PATCH', '/best-practices/:id', async ({ p, body }) =>
  check(await sb.from('best_practices').update(pick(body, BP_FIELDS)).eq('id', p.id).select('id'), true));
route('DELETE', '/best-practices/:id', async ({ p }) => softDelete('best_practices', p.id));
route('POST', '/documents', async ({ form }) => {
  const file = form.get('file');
  const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `org-${ctx.orgId}/best-practices/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('documents').upload(path, file, { contentType: file.type, upsert: false });
  if (error) throw new ApiError(400, /row-level security/i.test(error.message) ? 'No permission to upload for this organization'
    : /mime|type/i.test(error.message) ? 'Only photos (JPG, PNG, WebP) and PDF files' : /size|large/i.test(error.message) ? 'File is larger than 10 MB' : error.message);
  return { path, name: file.name, type: file.type };
});

// weekly impact e-mail: one list of recipients per restaurant (or one overview for all restaurants)
route('GET', '/report-subscriptions', async () => check(await sb.from('report_subscriptions')
  .select('id, restaurant_id, recipients, language, is_active, last_sent_week, last_sent_at, last_status')
  .eq('organization_id', ctx.orgId).is('deleted_at', null)));
route('POST', '/report-subscriptions', async ({ body }) => check(await sb.from('report_subscriptions')
  .insert({ ...pick(body, ['restaurant_id', 'recipients', 'language', 'is_active']), organization_id: ctx.orgId }).select('id').single()));
route('PATCH', '/report-subscriptions/:id', async ({ p, body }) => check(await sb.from('report_subscriptions')
  .update(pick(body, ['recipients', 'language', 'is_active'])).eq('id', p.id).select('id'), true));
route('DELETE', '/report-subscriptions/:id', async ({ p }) => softDelete('report_subscriptions', p.id));
route('POST', '/report-subscriptions/:id/preview', async ({ p }) => invoke('weekly-report', { action: 'preview', id: Number(p.id) }));
route('POST', '/report-subscriptions/:id/send', async ({ p, body }) => invoke('weekly-report', { action: 'send', id: Number(p.id), to: body.to }));

// current state of the leaderboard switch (read fresh, so an open page follows the setting at once)
route('GET', '/leaderboard-enabled', async () => {
  const rows = check(await sb.from('organizations').select('leaderboard_enabled').eq('id', ctx.orgId).limit(1));
  return !!(rows[0] && rows[0].leaderboard_enabled);
});
// leaderboard between sections (switch in Settings › Leaderboard)
route('GET', '/leaderboard', async ({ query }) => check(await sb.rpc('leaderboard', {
  p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null, p_lang: ctx.lang })));
route('GET', '/prevention-ideas', async ({ query }) => check(await sb.rpc('prevention_ideas_list', { p_org: ctx.orgId, p_status: query.status || null, p_lang: ctx.lang })));
route('POST', '/prevention-ideas', async ({ body }) =>
  check(await sb.from('prevention_ideas').insert({ waste_record_id: body.waste_record_id, text: body.text }).select('id').single()));
route('PATCH', '/prevention-ideas/:id', async ({ p, body }) =>
  check(await sb.from('prevention_ideas').update(pick(body, ['status', 'review_note'])).eq('id', p.id).select('id'), true));
route('POST', '/leaderboard/awards', async ({ body }) => check(await sb.from('leaderboard_awards')
  .insert(pick(body, ['restaurant_id', 'section_id', 'period_from', 'period_to', 'points', 'prize', 'note'])).select('id').single()));
route('DELETE', '/leaderboard/awards/:id', async ({ p }) => softDelete('leaderboard_awards', p.id));
route('GET', '/sections', async () => check(await sb.from('sections').select('id, restaurant_id, name, sort_order, is_active')
  .eq('organization_id', ctx.orgId).is('deleted_at', null).order('sort_order').order('name')));
route('POST', '/sections', async ({ body }) => check(await sb.from('sections').insert(pick(body, ['restaurant_id', 'name', 'sort_order', 'is_active'])).select('id').single()));
route('PATCH', '/sections/:id', async ({ p, body }) => check(await sb.from('sections').update(pick(body, ['name', 'sort_order', 'is_active'])).eq('id', p.id).select('id'), true));
route('DELETE', '/sections/:id', async ({ p }) => softDelete('sections', p.id));

// dashboard
route('GET', '/dashboard', async ({ query }) => check(await sb.rpc('dashboard', {
  p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null, p_lang: ctx.lang,
})));

// Signed link to a best-practice attachment
export async function documentUrl(path) {
  const { data, error } = await sb.storage.from('documents').createSignedUrl(path, 600);
  if (error) throw new ApiError(404, 'File not found');
  return data.signedUrl;
}

// Signed, short-lived URL for a photo (storage policies decide who may see it)
export async function photoUrl(path) {
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, 300);
  if (error) throw new ApiError(404, 'Photo not found');
  return data.signedUrl;
}

// Signed links for many photos at once (one request). Missing or forbidden photos are left out.
export async function photoUrls(paths) {
  const list = [...new Set(paths.filter(Boolean))];
  if (!list.length) return {};
  const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(list, 3600);
  if (error) return {};
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]));
}

export async function request(path, { method = 'GET', body, form, query = {} } = {}) {
  const r = routes.find((x) => x.method === method && x.re.test(path));
  if (!r) throw new ApiError(404, `Unknown endpoint ${method} ${path}`);
  const p = path.match(r.re).groups || {};
  const out = await r.fn({ p, body: body || {}, form, query });
  if (out && out.__meta) return { ok: true, data: out.rows, meta: out.__meta };
  return { ok: true, data: out };
}
