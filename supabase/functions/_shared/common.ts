// Shared helpers for WASTE log edge functions.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}

export function fail(status: number, message: string) {
  return json({ ok: false, error: { message } }, status);
}

export const RANK: Record<string, number> = { employee: 10, restaurant_manager: 30, org_admin: 50, super_admin: 100 };

// Service-role client: bypasses RLS, so every function re-checks permissions itself.
export function admin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface Caller { id: string; email: string; role: string; rank: number; organization_id: number | null }

// Resolve the signed-in caller from the Authorization header and load their active profile.
export async function caller(req: Request, sb: SupabaseClient): Promise<Caller | null> {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) return null;
  const { data: p } = await sb.from('users').select('id, email, role, organization_id, is_active, deleted_at')
    .eq('id', data.user.id).maybeSingle();
  if (!p || !p.is_active || p.deleted_at) return null;
  return { id: p.id, email: p.email, role: p.role, rank: RANK[p.role] ?? 0, organization_id: p.organization_id };
}
