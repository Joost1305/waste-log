// Weekly impact e-mail from the app (Settings › Weekly e-mail):
//   { action: 'preview', id }            -> { html, subject, recipients, mail_ready }
//   { action: 'send', id, to: 'me'|'list' } -> sends last week's e-mail to yourself or to the whole list
// Access is checked by the database: the report is read with the caller's own rights (RLS),
// so managers only reach the lists of their own restaurants. The Monday send runs in the daily job.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { admin, caller, cors, fail, json } from '../_shared/common.ts';
import { mailConfig, renderReport, sendMail } from '../_shared/report.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail(405, 'Method not allowed');
  const sb = admin();
  const me = await caller(req, sb);
  if (!me) return fail(401, 'Not signed in');
  if (me.rank < 30) return fail(403, 'Not allowed');

  let body: { action?: string; id?: number; to?: string };
  try { body = await req.json(); } catch { return fail(400, 'Invalid JSON'); }
  const id = Number(body.id);
  if (!id) return fail(400, 'Missing list');

  // Read with the caller's rights
  const user = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization')! } }, auth: { persistSession: false },
  });
  const { data, error } = await user.rpc('weekly_report_preview', { p_id: id });
  if (error) return fail(400, error.message);
  if (!data) return fail(404, 'List not found');

  const cfg = mailConfig();
  const { html, subject } = renderReport(data, cfg.appUrl);
  if (body.action === 'preview') {
    return json({ ok: true, data: { html, subject, recipients: data.recipients || [], mail_ready: !!cfg.key } });
  }
  if (body.action === 'send') {
    if (!cfg.key) return json({ ok: true, data: { ok: false, error: 'no_mail_service' } });
    const to = body.to === 'list' ? (data.recipients || []) : [me.email];
    if (!to.length) return fail(400, 'The list has no recipients');
    const r = await sendMail(to, subject, html);
    await sb.rpc('weekly_report_mark', { p_id: id, p_week: null,
      p_status: r.ok ? `${body.to === 'list' ? 'sent to list' : 'test sent to ' + me.email} ${new Date().toISOString()}` : r.error });
    return json({ ok: true, data: r });
  }
  return fail(400, 'Unknown action');
});
