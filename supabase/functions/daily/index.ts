// Daily job, called once a day by a GitHub Action:
// 1. keeps the free Supabase project active (any request counts as activity);
// 2. stores yesterday's and today's weather (Open-Meteo, no key) for every restaurant with coordinates;
// 3. sends the weekly impact e-mails for last week (Monday to Sunday) that have not gone out yet.
//    The first run on Monday sends them; if that run was missed, the next day's run catches up.
// It is idempotent and only fetches what is missing, so calling it more often does no harm.
import { admin, cors, json } from '../_shared/common.ts';
import { mailConfig, renderReport, sendMail } from '../_shared/report.ts';

const WMO = (c: number) => (c === 0 ? 'clear' : c <= 3 ? 'cloudy' : c <= 48 ? 'fog' : (c <= 67 || (c >= 80 && c <= 82)) ? 'rain' : (c <= 77 || c === 85 || c === 86) ? 'snow' : 'storm');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const sb = admin();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const y = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  const { data: rests } = await sb.from('restaurants')
    .select('id, latitude, longitude, organizations!inner(weather_enabled, is_demo)')
    .is('deleted_at', null).not('latitude', 'is', null).not('longitude', 'is', null);

  let synced = 0; const errors: string[] = [];
  for (const r of rests || []) {
    const org = (r as any).organizations;
    if (!org?.weather_enabled || org?.is_demo) continue;     // demo restaurants have generated weather
    const { data: have } = await sb.from('weather_records').select('date').eq('restaurant_id', r.id).in('date', [y, today]);
    if ((have || []).length === 2) continue;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${r.latitude}&longitude=${r.longitude}&start_date=${y}&end_date=${today}` +
        '&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code,relative_humidity_2m_mean&timezone=Europe%2FAmsterdam';
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const d = (await res.json()).daily || {};
      const rows = (d.time || []).map((date: string, i: number) => ({
        restaurant_id: r.id, date, source: 'open-meteo',
        temp_mean_c: d.temperature_2m_mean?.[i] ?? null, temp_max_c: d.temperature_2m_max?.[i] ?? null,
        temp_min_c: d.temperature_2m_min?.[i] ?? null, rainfall_mm: d.precipitation_sum?.[i] ?? null,
        condition: d.weather_code?.[i] != null ? WMO(d.weather_code[i]) : null, humidity_pct: d.relative_humidity_2m_mean?.[i] ?? null,
      }));
      const { error } = await sb.from('weather_records').upsert(rows, { onConflict: 'restaurant_id,date' });
      if (error) throw error;
      synced += rows.length;
    } catch (e) { errors.push(`restaurant ${r.id}: ${(e as Error).message}`); }
  }
  // Weekly e-mails (each list once per week; the database keeps track of what was sent)
  let mails = 0;
  const cfg = mailConfig();
  const { data: due, error: dueErr } = await sb.rpc('weekly_reports_due');
  if (dueErr) errors.push(`weekly e-mail: ${dueErr.message}`);
  for (const d of (due || []) as any[]) {
    if (!d || !d.subscription_id) continue;
    if (!cfg.key) { await sb.rpc('weekly_report_mark', { p_id: d.subscription_id, p_week: null, p_status: 'no_mail_service' }); continue; }
    try {
      const { html, subject } = renderReport(d, cfg.appUrl);
      const r = await sendMail(d.recipients, subject, html);
      await sb.rpc('weekly_report_mark', { p_id: d.subscription_id, p_week: r.ok ? d.week_from : null,
        p_status: r.ok ? `sent to ${d.recipients.length}` : String(r.error) });
      if (r.ok) mails += d.recipients.length; else errors.push(`weekly e-mail ${d.subscription_id}: ${r.error}`);
    } catch (e) { errors.push(`weekly e-mail ${d.subscription_id}: ${(e as Error).message}`); }
  }
  return json({ ok: true, data: { date: today, weather_rows: synced, weekly_mails: mails, errors } });
});
