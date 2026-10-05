// Manage users of an organization (create, update, deactivate). Only org admins and super admins.
// Runs with the service role, so all permission checks happen here.
import { admin, caller, cors, fail, json, RANK } from '../_shared/common.ts';

const ROLES = ['employee', 'restaurant_manager', 'org_admin', 'super_admin'];
const LANGS = ['nl', 'en', 'fy'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (!me) return fail(401, 'Not signed in');
  if (me.rank < 50) return fail(403, 'Not allowed');

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const action = body.action;

  // Organization the change applies to: own organization; super admins may pass one.
  const orgId: number | null = me.role === 'super_admin' ? (Number(body.organization_id) || null) : me.organization_id;

  const audit = (act: string, id: string, details: Record<string, unknown>) =>
    sb.from('audit_log').insert({ organization_id: orgId, user_id: me.id, action: act, entity: 'users', entity_id: id, details });

  async function checkRestaurants(ids: unknown): Promise<number[] | Response> {
    if (ids === undefined) return [];
    if (!Array.isArray(ids) || ids.some((x) => !Number.isInteger(x))) return fail(400, 'restaurant_ids must be a list of ids');
    if (!ids.length) return [];
    const { data } = await sb.from('restaurants').select('id').eq('organization_id', orgId).is('deleted_at', null).in('id', ids);
    if ((data || []).length !== ids.length) return fail(400, 'Unknown restaurant');
    return ids as number[];
  }

  function checkRole(role: unknown): Response | null {
    if (typeof role !== 'string' || !ROLES.includes(role)) return fail(400, 'Unknown role');
    if (RANK[role] > me!.rank || (role === 'super_admin' && me!.role !== 'super_admin')) return fail(403, 'You cannot assign this role');
    return null;
  }

  async function loadTarget(id: unknown) {
    if (typeof id !== 'string') return null;
    const { data } = await sb.from('users').select('*').eq('id', id).is('deleted_at', null).maybeSingle();
    if (!data) return null;
    if (me!.role !== 'super_admin' && data.organization_id !== me!.organization_id) return null;   // never reveal other tenants
    if (RANK[data.role] > me!.rank) return null;
    return data;
  }

  if (action === 'create') {
    const { name, email, role, password, language = 'nl', is_active = true } = body;
    if (!orgId && role !== 'super_admin') return fail(400, 'No organization');
    if (typeof name !== 'string' || !name.trim() || name.length > 120) return fail(400, 'Name is required');
    if (typeof email !== 'string' || !EMAIL.test(email)) return fail(400, 'Valid email is required');
    if (typeof password !== 'string' || password.length < 8) return fail(400, 'Password must be at least 8 characters');
    if (!LANGS.includes(language)) return fail(400, 'Unknown language');
    const roleErr = checkRole(role); if (roleErr) return roleErr;
    const rids = await checkRestaurants(body.restaurant_ids); if (rids instanceof Response) return rids;

    const { data: created, error } = await sb.auth.admin.createUser({
      email: email.trim().toLowerCase(), password, email_confirm: true, user_metadata: { name: name.trim() },
    });
    if (error || !created.user) return fail(400, error?.message?.includes('registered') ? 'Email already in use' : (error?.message || 'Could not create user'));
    const uid = created.user.id;
    const { error: pErr } = await sb.from('users').insert({
      id: uid, organization_id: role === 'super_admin' ? null : orgId, role, email: email.trim().toLowerCase(),
      name: name.trim(), language, is_active: Boolean(is_active),
    });
    if (pErr) { await sb.auth.admin.deleteUser(uid); return fail(400, pErr.message); }
    if (rids.length) await sb.from('user_restaurants').insert(rids.map((r) => ({ user_id: uid, restaurant_id: r })));
    await audit('create', uid, { email, role });
    return json({ ok: true, data: { id: uid } }, 201);
  }

  if (action === 'update') {
    const target = await loadTarget(body.id);
    if (!target) return fail(404, 'User not found');
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) return fail(400, 'Name is required');
      patch.name = body.name.trim();
    }
    if (body.language !== undefined) {
      if (!LANGS.includes(body.language)) return fail(400, 'Unknown language');
      patch.language = body.language;
    }
    if (body.role !== undefined && body.role !== target.role) {
      if (target.id === me.id) return fail(400, 'You cannot change your own role');
      const roleErr = checkRole(body.role); if (roleErr) return roleErr;
      patch.role = body.role;
    }
    if (body.is_active !== undefined) {
      if (target.id === me.id && !body.is_active) return fail(400, 'You cannot deactivate yourself');
      patch.is_active = Boolean(body.is_active);
    }
    const authPatch: Record<string, unknown> = {};
    if (body.email !== undefined && body.email !== target.email) {
      if (typeof body.email !== 'string' || !EMAIL.test(body.email)) return fail(400, 'Valid email is required');
      authPatch.email = body.email.trim().toLowerCase(); authPatch.email_confirm = true; patch.email = authPatch.email;
    }
    if (body.password) {
      if (typeof body.password !== 'string' || body.password.length < 8) return fail(400, 'Password must be at least 8 characters');
      authPatch.password = body.password;
    }
    if (patch.is_active !== undefined) authPatch.ban_duration = patch.is_active ? 'none' : '876000h';
    const rids = body.restaurant_ids !== undefined ? await checkRestaurants(body.restaurant_ids) : null;
    if (rids instanceof Response) return rids;

    if (Object.keys(authPatch).length) {
      const { error } = await sb.auth.admin.updateUserById(target.id, authPatch);
      if (error) return fail(400, error.message);
    }
    if (Object.keys(patch).length) {
      const { error } = await sb.from('users').update(patch).eq('id', target.id);
      if (error) return fail(400, error.message);
    }
    if (rids) {
      await sb.from('user_restaurants').delete().eq('user_id', target.id);
      if (rids.length) await sb.from('user_restaurants').insert(rids.map((r) => ({ user_id: target.id, restaurant_id: r })));
    }
    await audit('update', target.id, { ...patch, password_changed: Boolean(body.password), restaurants_changed: Boolean(rids) });
    return json({ ok: true, data: { id: target.id } });
  }

  if (action === 'delete') {
    const target = await loadTarget(body.id);
    if (!target) return fail(404, 'User not found');
    if (target.id === me.id) return fail(400, 'You cannot delete yourself');
    await sb.auth.admin.updateUserById(target.id, { ban_duration: '876000h' });
    await sb.from('users').update({ is_active: false, deleted_at: new Date().toISOString() }).eq('id', target.id);
    await audit('delete', target.id, { email: target.email });
    return json({ ok: true, data: { deleted: true } });
  }

  return fail(400, 'Unknown action');
});
