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
  check(await sb.from('organizations').update(pick(body, ['name', 'default_value_per_kg', 'default_language', 'currency', 'weather_enabled'])).eq('id', ctx.orgId).select().single()));

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
  products: { table: 'products', select: '*, suppliers(name)', fields: ['name', 'waste_category_id', 'category_id', 'default_supplier_id', 'purchase_price_per_kg', 'sales_price_per_kg', 'is_quick_pick', 'is_active'] },
  'menu-items': { table: 'menu_items', select: '*, restaurants(name)', fields: ['name', 'restaurant_id', 'portion_size_g', 'sales_price', 'cost_price', 'is_active'] },
  targets: { table: 'targets', select: '*, restaurants(name)', fields: ['name', 'restaurant_id', 'period', 'baseline_kg', 'target_kg', 'start_date', 'end_date'] },
};
const flat = (r) => ({ ...r, supplier_name: r.suppliers?.name, restaurant_name: r.restaurants?.name });
for (const [path, c] of Object.entries(catalog)) {
  route('GET', `/${path}`, async () => check(await sb.from(c.table).select(c.select).eq('organization_id', ctx.orgId).is('deleted_at', null)
    .order(path === 'targets' ? 'start_date' : 'name', { ascending: path !== 'targets' })).map(flat));
  route('POST', `/${path}`, async ({ body }) => {
    const row = { ...pick(body, c.fields), organization_id: ctx.orgId };
    if (path === 'targets') row.created_by = (ctx.profile || await profile()).id;
    return check(await sb.from(c.table).insert(row).select().single());
  });
  route('PATCH', `/${path}/:id`, async ({ p, body }) => check(await sb.from(c.table).update(pick(body, c.fields)).eq('id', p.id).select(), true)[0]);
  route('DELETE', `/${path}/:id`, async ({ p }) => softDelete(c.table, p.id));
}

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
  const row = pick(body, ['restaurant_id', 'product_id', 'product_name', 'waste_category_id', 'category_id', 'reason_id', 'menu_item_id',
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
  return check(await sb.from('waste_records').insert(row).select('id, product_name, waste_category_id, weight_kg, purchase_value, valuation_method').single());
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
  if (error) throw new ApiError(400, error.message);
  return { photo_path: path };
});
route('POST', '/waste/photo/identify', async ({ body }) => invoke('identify-food', { photo_path: body.photo_path, lang: ctx.lang }));

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

// dashboard
route('GET', '/dashboard', async ({ query }) => check(await sb.rpc('dashboard', {
  p_org: ctx.orgId, p_restaurant: num(query.restaurant_id), p_from: query.from || null, p_to: query.to || null, p_lang: ctx.lang,
})));

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
