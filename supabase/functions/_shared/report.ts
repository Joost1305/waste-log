// Weekly impact e-mail: HTML (inline styles, table layout, so it looks the same in Outlook, Gmail and Apple Mail)
// and sending through Resend. Used by the weekly-report function (preview, send now) and by the daily job (Monday).

type Lang = 'en' | 'nl';
const T: Record<Lang, Record<string, string>> = {
  en: {
    subject: 'Week {w}: {kg} food waste at {name}', week: 'Week {w}', waste: 'Food waste', cost: 'Purchase value', per_guest: 'Per guest',
    co2: 'CO₂-eq', vs_prev: 'vs previous week', same: 'same as previous week', regs: '{n} registrations on {d} of 7 days',
    gap: 'Nothing was registered on {m} days last week. The numbers are only as good as the registrations.',
    top: 'Thrown away most', why: 'Why', per_rest: 'Per restaurant', restaurant: 'Restaurant', regs_short: 'Registrations',
    target: 'Target', target_line: '{cur} in the last {d} days. Goal: {goal}, starting point: {base}.', reached: 'Goal reached', progress: '{p}% of the way',
    iv: 'Interventions running', iv_early: 'too early to tell', iv_ctrl: 'other restaurants {p}', bp: 'New best practices',
    open: 'Open the dashboard', foot: 'You receive this e-mail because your address is on the weekly e-mail list for {name} in WASTE log. A manager can change the list in Settings › Weekly e-mail.',
    all: 'all restaurants', none: 'No waste was registered last week.', avg: 'average of the 4 weeks before: {kg}',
  },
  nl: {
    subject: 'Week {w}: {kg} voedselverspilling bij {name}', week: 'Week {w}', waste: 'Voedselverspilling', cost: 'Inkoopwaarde', per_guest: 'Per gast',
    co2: 'CO₂-eq', vs_prev: 't.o.v. vorige week', same: 'gelijk aan vorige week', regs: '{n} registraties op {d} van de 7 dagen',
    gap: 'Op {m} dagen is vorige week niets geregistreerd. De cijfers zijn zo goed als de registraties.',
    top: 'Meest weggegooid', why: 'Waarom', per_rest: 'Per restaurant', restaurant: 'Restaurant', regs_short: 'Registraties',
    target: 'Doel', target_line: '{cur} in de laatste {d} dagen. Doel: {goal}, startpunt: {base}.', reached: 'Doel gehaald', progress: '{p}% van de weg',
    iv: 'Lopende interventies', iv_early: 'nog te vroeg', iv_ctrl: 'andere restaurants {p}', bp: 'Nieuwe best practices',
    open: 'Open het dashboard', foot: 'Je ontvangt deze e-mail omdat je adres op de wekelijkse e-maillijst van {name} in WASTE log staat. Een manager kan de lijst aanpassen via Beheer › Wekelijkse e-mail.',
    all: 'alle restaurants', none: 'Vorige week is er geen waste geregistreerd.', avg: 'gemiddelde van de 4 weken ervoor: {kg}',
  },
};

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fill = (s: string, v: Record<string, unknown>) => Object.entries(v).reduce((a, [k, x]) => a.split(`{${k}}`).join(String(x)), s);

export function renderReport(d: any, appUrl: string) {
  const lang: Lang = d.language === 'nl' ? 'nl' : 'en';
  const L = T[lang];
  const loc = lang === 'nl' ? 'nl-NL' : 'en-GB';
  const n = (v: number, dec = 0) => new Intl.NumberFormat(loc, { maximumFractionDigits: dec }).format(v);
  const kg = (v: number) => (v == null ? '–' : v < 1 ? `${n(v * 1000)} g` : `${n(v, v < 10 ? 1 : 0)} kg`);
  const money = (v: number) => new Intl.NumberFormat(loc, { style: 'currency', currency: d.currency || 'EUR', maximumFractionDigits: 0 }).format(v || 0);
  const date = (s: string) => new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short' }).format(new Date(s + 'T12:00:00'));
  const pct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n(Math.abs(v))}%`;
  const name = d.restaurant || `${d.organization} · ${L.all}`;
  const w = d.this_week || {};
  const green = '#2F5D50'; const ink = '#1d2321'; const muted = '#6b7570'; const line = '#e4e2da'; const good = '#3E7D4F'; const bad = '#B5524A';

  const kpi = (label: string, value: string, sub = '', color = ink) => `
    <td style="padding:12px 12px;border:1px solid ${line};border-radius:10px;background:#fff;vertical-align:top" width="50%">
      <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:${muted}">${label}</div>
      <div style="font-size:22px;font-weight:700;color:${color};margin-top:4px">${value}</div>
      ${sub ? `<div style="font-size:12px;color:${muted};margin-top:2px">${sub}</div>` : ''}</td>`;
  const h = (s: string) => `<h3 style="margin:22px 0 8px;font-size:15px;color:${ink}">${s}</h3>`;
  const ch = d.change_kg_pct;
  const missing = 7 - (w.active_days || 0);

  let body = '';
  if (!w.records) body += `<p style="color:${muted}">${L.none}</p>`;
  else {
    body += `<table role="presentation" width="100%" cellspacing="6" cellpadding="0" style="border-collapse:separate"><tr>
      ${kpi(L.waste, kg(w.kg), ch == null ? '' : ch === 0 ? L.same : `<span style="color:${ch < 0 ? good : bad};font-weight:600">${pct(ch)}</span> ${L.vs_prev}`)}
      ${kpi(L.cost, money(w.value))}</tr><tr>
      ${kpi(L.per_guest, w.g_per_guest != null ? `${n(w.g_per_guest)} g` : '–', d.avg4_g_per_guest != null ? fill(L.avg, { kg: `${n(d.avg4_g_per_guest)} g` }) : '')}
      ${kpi(L.co2, kg(d.co2e_kg))}</tr></table>
      <p style="font-size:13px;color:${muted};margin:6px 6px 0">${fill(L.regs, { n: w.records, d: w.active_days })}</p>
      ${missing >= 2 ? `<p style="font-size:13px;background:#F6E7DC;color:#8a4a22;padding:8px 12px;border-radius:8px">${fill(L.gap, { m: missing })}</p>` : ''}`;
    if (d.target) {
      const tg = d.target;
      body += h(`${L.target}: ${esc(tg.name)}`) + `
        <div style="background:${line};border-radius:99px;height:10px;overflow:hidden"><div style="background:${tg.achieved ? good : green};width:${tg.progress_pct}%;height:10px"></div></div>
        <p style="font-size:13px;color:${muted};margin:6px 0 0">${tg.achieved ? `<strong style="color:${good}">${L.reached}</strong> · ` : `${fill(L.progress, { p: tg.progress_pct })} · `}
          ${fill(L.target_line, { cur: kg(tg.current_kg), d: tg.window_days, goal: kg(tg.target_kg), base: kg(tg.baseline_kg) })}</p>`;
    }
    if ((d.top_products || []).length) {
      body += h(L.top) + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">${d.top_products.map((p: any, i: number) => `
        <tr><td style="padding:6px 0;border-bottom:1px solid ${line}">${i + 1}. ${esc(p.name)}</td>
          <td style="padding:6px 0;border-bottom:1px solid ${line};text-align:right;white-space:nowrap">${kg(p.kg)} · ${money(p.value)}</td></tr>`).join('')}</table>`;
    }
    if ((d.top_reasons || []).length) {
      body += h(L.why) + `<p style="font-size:14px;margin:0">${d.top_reasons.map((r: any) => `${esc(r.name)} <strong>${n(r.pct)}%</strong>`).join(' &nbsp;·&nbsp; ')}</p>`;
    }
    if (d.by_restaurant && d.by_restaurant.length > 1) {
      body += h(L.per_rest) + `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">
        <tr style="color:${muted};font-size:12px"><td style="padding:4px 0">${L.restaurant}</td><td align="right">kg</td><td align="right">${L.per_guest}</td><td align="right">${L.regs_short}</td></tr>
        ${d.by_restaurant.map((r: any) => `<tr><td style="padding:6px 0;border-top:1px solid ${line}">${esc(r.name)}</td>
          <td align="right" style="border-top:1px solid ${line}">${kg(r.kg)}</td>
          <td align="right" style="border-top:1px solid ${line}">${r.g_per_guest != null ? `${n(r.g_per_guest)} g` : '–'}</td>
          <td align="right" style="border-top:1px solid ${line}">${n(r.records)}${r.days < 5 ? ` <span style="color:${bad}">(${r.days}/7)</span>` : ''}</td></tr>`).join('')}</table>`;
    }
  }
  if ((d.interventions || []).length) {
    body += h(L.iv) + d.interventions.map((i: any) => {
      const e = i.effect || {};
      const eff = e.status === 'ok' && e.change_pct != null
        ? `<strong style="color:${e.change_pct <= 0 ? good : bad}">${pct(e.change_pct)}</strong>${e.control_change_pct != null ? ` <span style="color:${muted}">(${fill(L.iv_ctrl, { p: pct(e.control_change_pct) })})</span>` : ''}`
        : `<span style="color:${muted}">${L.iv_early}</span>`;
      return `<p style="font-size:14px;margin:4px 0">${esc(i.title)}${d.scope === 'organization' ? ` <span style="color:${muted}">· ${esc(i.restaurant)}</span>` : ''}: ${eff}</p>`;
    }).join('');
  }
  if ((d.best_practices || []).length) {
    body += h(L.bp) + d.best_practices.map((b: any) => `<p style="font-size:14px;margin:4px 0">&#9733; ${esc(b.title)}${b.restaurant ? ` <span style="color:${muted}">· ${esc(b.restaurant)}</span>` : ''}</p>`).join('');
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;background:#F4F2EC;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background:#FBFAF6;border-radius:14px">
<tr><td style="background:${green};color:#fff;padding:20px 24px;border-radius:14px 14px 0 0">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">WASTE log · ${fill(L.week, { w: d.week_number })} · ${date(d.week_from)} – ${date(d.week_to)}</div>
  <div style="font-size:22px;font-weight:700;margin-top:4px">${esc(name)}</div></td></tr>
<tr><td style="padding:18px 18px 8px">${body}
  <p style="margin:26px 0 8px"><a href="${esc(appUrl)}#/dashboard" style="background:${green};color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${L.open}</a></p>
</td></tr>
<tr><td style="padding:14px 24px 22px;font-size:12px;color:${muted};border-top:1px solid ${line}">${fill(L.foot, { name: esc(name) })}</td></tr>
</table></td></tr></table></body></html>`;
  const subject = fill(L.subject, { w: d.week_number, kg: kg(w.kg || 0), name });
  return { html, subject };
}

export function mailConfig() {
  return {
    key: Deno.env.get('RESEND_API_KEY') || '',
    from: Deno.env.get('MAIL_FROM') || 'WASTE log <onboarding@resend.dev>',
    appUrl: Deno.env.get('APP_URL') || 'https://joost1305.github.io/waste-log/',
  };
}

// One e-mail per recipient, so recipients do not see each other's addresses
export async function sendMail(to: string[], subject: string, html: string) {
  const { key, from } = mailConfig();
  if (!key) return { ok: false, error: 'no_mail_service' };
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(to.map((addr) => ({ from, to: [addr], subject, html }))),
  });
  if (!res.ok) return { ok: false, error: `mail service HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { ok: true, sent: to.length };
}
