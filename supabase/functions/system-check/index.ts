// Morning system check (GitHub Action every morning, or "Run now" by the platform admin).
// Tests every connection the app depends on, lists the important changes of the last 24 hours and
// the gaps in the data, and stores the result (Settings › System check).
//   green  = works      orange = works, but worth a look      red = broken, the morning job then fails
//
// Called without a signed-in user (the scheduled job): runs at most once per 30 minutes, otherwise
// it returns the last result, so nobody can run up the AI cost by calling it in a loop.
// Called by a signed-in super admin: always runs.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { admin, caller, cors, fail, json } from '../_shared/common.ts';

type Status = 'ok' | 'warn' | 'fail';
interface Check { key: string; status: Status; detail: string; ms?: number }

const SITE = 'https://joost1305.github.io/waste-log/';
const REPO = 'Joost1305/waste-log';
// 1x1 transparent PNG, for the photo storage round trip
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

async function timed(key: string, fn: () => Promise<{ status: Status; detail: string }>): Promise<Check> {
  const t = Date.now();
  try {
    const r = await fn();
    return { key, ...r, ms: Date.now() - t };
  } catch (e) {
    return { key, status: 'fail', detail: (e as Error).message.slice(0, 300), ms: Date.now() - t };
  }
}
const hoursAgo = (iso: string) => (Date.now() - new Date(iso).getTime()) / 3600000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (me && me.role !== 'super_admin') return fail(403, 'Not allowed');
  const trigger = me ? 'manual' : 'schedule';

  // Scheduled calls: not more than once per 30 minutes
  if (!me) {
    const { data: last } = await sb.from('system_checks').select('id, run_at, status').order('run_at', { ascending: false }).limit(1).maybeSingle();
    if (last && hoursAgo(last.run_at) < 0.5) return json({ ok: true, data: { ...last, reused: true } });
  }

  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3600000);
  const checks: Check[] = [];

  // 1. Database (and everything the database prepares for this check)
  let inputs: any = null;
  checks.push(await timed('database', async () => {
    const { data, error } = await sb.rpc('system_check_inputs', { p_from: from.toISOString(), p_to: to.toISOString() });
    if (error) throw new Error(error.message);
    inputs = data;
    return { status: 'ok', detail: 'reachable' };
  }));

  // 2. The website, and whether it runs the newest version
  checks.push(await timed('app', async () => {
    const res = await fetch(SITE, { signal: AbortSignal.timeout(15000), headers: { 'cache-control': 'no-cache' } });
    if (!res.ok) return { status: 'fail', detail: `website answers HTTP ${res.status}` };
    const live = ((await res.text()).match(/js\/app\.js\?v=([0-9a-f]{7,40})/) || [])[1] || '';
    try {
      const gh = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/pages.yml/runs?branch=main&per_page=5`,
        { signal: AbortSignal.timeout(10000), headers: { accept: 'application/vnd.github+json', 'user-agent': 'waste-log-system-check' } });
      if (!gh.ok) return { status: 'ok', detail: `online (version ${live || '?'}; GitHub not reachable to compare)` };
      const runs = ((await gh.json()).workflow_runs || []) as any[];
      // A run cancelled because a newer one started is not a failure
      const done = runs.filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion));
      if (done[0] && done[0].conclusion !== 'success') {
        return { status: 'fail', detail: `online, but the last update failed to publish (${done[0].conclusion}, ${done[0].created_at})` };
      }
      const good = done.find((r) => r.conclusion === 'success');
      if (good && live && !String(good.head_sha).startsWith(live)) {
        return { status: 'warn', detail: `online, but version ${live} is shown while ${String(good.head_sha).slice(0, 8)} was published` };
      }
      return { status: 'ok', detail: `online, newest version (${live})` };
    } catch {
      return { status: 'ok', detail: `online (version ${live || '?'})` };
    }
  }));

  // 3. Signing in (the shared student login) and reading data with that user's rights
  checks.push(await timed('sign_in', async () => {
    const email = Deno.env.get('CHECK_LOGIN_EMAIL') || 'student@hth.demo';
    const password = Deno.env.get('CHECK_LOGIN_PASSWORD') || 'nofoodwaste';
    const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await user.auth.signInWithPassword({ email, password });
    if (error) return { status: 'fail', detail: `${email} cannot sign in: ${error.message}` };
    const { data: rows, error: e2 } = await user.from('restaurants').select('id').is('deleted_at', null).limit(5);
    await user.auth.signOut();
    if (e2) return { status: 'fail', detail: `signed in, but reading data failed: ${e2.message}` };
    if (!rows || !rows.length) return { status: 'warn', detail: `signed in as ${email}, but no restaurants visible` };
    return { status: 'ok', detail: `${email} signs in and sees ${rows.length} restaurant(s)` };
  }));

  // 4. Photo storage: upload, read back through a signed link, delete
  checks.push(await timed('photos', async () => {
    const path = `system-check/${to.toISOString().replace(/[:.]/g, '-')}.png`;
    const up = await sb.storage.from('waste-photos').upload(path, PNG, { contentType: 'image/png', upsert: true });
    if (up.error) return { status: 'fail', detail: `upload failed: ${up.error.message}` };
    try {
      const { data: link, error } = await sb.storage.from('waste-photos').createSignedUrl(path, 60);
      if (error || !link) return { status: 'fail', detail: `uploaded, but no link: ${error?.message}` };
      const got = await fetch(link.signedUrl, { signal: AbortSignal.timeout(10000) });
      if (!got.ok) return { status: 'fail', detail: `uploaded, but reading it back gave HTTP ${got.status}` };
      return { status: 'ok', detail: 'upload, read back and delete work' };
    } finally {
      await sb.storage.from('waste-photos').remove([path]);
    }
  }));

  // 5. AI photo recognition: the key and the model answer (a tiny text question, about €0.01)
  checks.push(await timed('ai', async () => {
    const key = Deno.env.get('ANTHROPIC_API_KEY') || '';
    const model = Deno.env.get('ANTHROPIC_MODEL') || 'claude-sonnet-5-5';
    if (!key) return { status: 'warn', detail: 'no AI key set: photos are not recognised, people choose the product themselves' };
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      const why = res.status === 401 ? 'the key is not accepted' : res.status === 402 || /credit|billing/i.test(body) ? 'no credit left'
        : res.status === 404 ? `model ${model} not found` : res.status === 429 ? 'rate limit' : res.status >= 500 ? 'AI service down' : body;
      return { status: res.status === 429 || res.status >= 500 ? 'warn' : 'fail', detail: `AI answers HTTP ${res.status}: ${why}` };
    }
    return { status: 'ok', detail: `answers (model ${model})` };
  }));

  // 6. E-mail service
  checks.push(await timed('mail', async () => (Deno.env.get('RESEND_API_KEY')
    ? { status: 'ok', detail: 'connected' }
    : { status: 'warn', detail: 'not connected yet: weekly e-mails are not sent' })));

  // 7. Weather for today, and 8. the hourly job
  checks.push(await timed('weather', async () => {
    if (!inputs) return { status: 'warn', detail: 'not checked (database not reachable)' };
    const miss = inputs.weather_missing || [];
    return miss.length ? { status: 'warn', detail: `no weather for today yet: ${miss.join(', ')}` } : { status: 'ok', detail: 'today\'s weather is in' };
  }));
  checks.push(await timed('hourly_job', async () => {
    if (!inputs) return { status: 'warn', detail: 'not checked (database not reachable)' };
    if (!inputs.hourly_last_run) return { status: 'warn', detail: 'no run recorded yet' };
    const h = hoursAgo(inputs.hourly_last_run);
    const when = `last run ${Math.round(h * 60)} min ago`;
    return { status: h < 2 ? 'ok' : h < 6 ? 'warn' : 'fail', detail: h < 2 ? when : `${when}: the hourly job (weather, weekly e-mails) is not running` };
  }));

  const status: Status = checks.some((c) => c.status === 'fail') ? 'fail' : checks.some((c) => c.status === 'warn') || (inputs?.gaps || []).length ? 'warn' : 'ok';
  const row = {
    trigger, status, checks,
    changes: inputs?.changes || [], changes_all: inputs?.changes_all || 0, gaps: inputs?.gaps || [],
    window_from: from.toISOString(), window_to: to.toISOString(),
  };
  const { data: saved, error } = await sb.from('system_checks').insert(row).select('id, run_at').single();
  if (error) checks.push({ key: 'database', status: 'fail', detail: `result could not be saved: ${error.message}` });
  // Keep 180 days of results
  await sb.from('system_checks').delete().lt('run_at', new Date(Date.now() - 180 * 86400000).toISOString());
  return json({ ok: true, data: { id: saved?.id, run_at: saved?.run_at, ...row, status: error ? 'fail' : status } });
});
