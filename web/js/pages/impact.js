// Public impact page: no sign-in needed. Shows a restaurant's (or the whole organization's) waste trend
// for guests, students and partners. Only restaurants with "Public impact page" switched on are shown.
// Data comes from public_impact(), which never returns prices, people or photos.
import { api, app, esc, fmt, $, renderLangToggle } from '../core.js';
import { t } from '../i18n.js';
import { showCo2Info } from '../co2.js';

let chart = null;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export async function renderImpact(rest) {
  const [orgSlug, restSlug] = rest;
  document.getElementById('topbar').hidden = true;
  document.getElementById('demo-banner').hidden = true;
  app().className = 'app impact';
  app().innerHTML = `<div class="card empty"><span class="spinner"></span></div>`;
  let d = null;
  try { d = (await api('/public-impact', { query: { org: orgSlug || '', restaurant: restSlug || '' } })).data; } catch { d = null; }
  if (!d) {
    app().innerHTML = `<div class="card empty" style="margin-top:40px">${t('imp_pub_none')}</div>`;
    return;
  }
  const L = d.last30 || {};
  const change = L.prev_kg > 0 ? ((L.kg - L.prev_kg) / L.prev_kg) * 100 : null;
  const place = d.scope === 'restaurant' ? d.restaurants[0] : null;
  const title = place ? place.name : t('imp_pub_all', { org: d.organization });
  const tg = d.target;
  const per = tg ? t('per_' + (tg.period || 'month')) : '';
  document.title = `${title} · ${t('imp_pub_title')}`;

  app().innerHTML = `
    <header class="impact-head">
      <div>
        <div class="impact-kicker">${esc(d.organization)}${place && place.city ? ` · ${esc(place.city)}` : ''}</div>
        <h1>${esc(title)}</h1>
        <p class="impact-sub">${t('imp_pub_sub')}</p>
      </div>
      <div class="impact-tools no-print"><div class="lang-toggle" id="imp-lang" role="group" aria-label="Language"></div>
        <button type="button" class="btn-sm" id="imp-print">&#128424; ${t('print')}</button></div>
    </header>
    ${d.is_demo ? `<div class="note" style="margin:0 0 16px">${t('imp_pub_demo')}</div>` : ''}
    <section class="grid grid-kpi">
      <div class="card kpi"><div class="label">${t('imp_pub_kg30')}</div><div class="value">${fmt.kg(L.kg, 0)}</div>
        ${change == null ? '' : `<div class="delta ${change <= 0 ? 'good' : 'bad'}">${change > 0 ? '▲' : '▼'} ${fmt.pct(Math.abs(change), 0)} ${t('imp_pub_vs_prev')}</div>`}</div>
      <div class="card kpi"><div class="label">${t('kpi_per_guest')}</div><div class="value">${d.per_guest_30 != null ? `${fmt.num(d.per_guest_30)} g` : '–'}</div>
        <div class="delta muted">${t('imp_pub_per_guest_note')}</div></div>
      <button type="button" class="card kpi kpi-link" id="imp-co2"><div class="label">${t('kpi_co2')} <span class="info-i" aria-hidden="true">i</span></div>
        <div class="value">${L.co2e_kg >= 1000 ? `${fmt.num(L.co2e_kg / 1000, 1)} t` : fmt.kg(L.co2e_kg, 0)}</div>
        <div class="delta muted link-ish">${t('co2_short')}</div></button>
      <div class="card kpi"><div class="label">${t('imp_pub_records')}</div><div class="value">${fmt.num(L.records)}</div>
        <div class="delta muted">${t('imp_pub_records_note')}</div></div>
    </section>
    ${tg ? `<section class="card" style="margin-top:16px">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><h2 style="margin:0">${t('target')}: ${esc(tg.name)}</h2>
        ${tg.achieved ? `<span class="badge green">&#10003; ${t('target_reached')}</span>` : ''}</div>
      <div class="progress ${tg.achieved ? 'done' : ''}"><div style="width:${Math.min(100, tg.progress_pct)}%"></div></div>
      <div class="target-nums">
        <span>${t('baseline')}: <strong>${fmt.kg(tg.baseline_kg, 0)}</strong> ${per}</span>
        <span>${t('win_' + (tg.period || 'month'))}: <strong>${fmt.kg(tg.current_kg, 0)}</strong></span>
        <span>${t('goal')}: <strong>${fmt.kg(tg.target_kg, 0)}</strong> ${per} (−${fmt.pct(tg.reduction_goal_pct)})</span>
      </div></section>` : ''}
    <section class="grid grid-2" style="margin-top:16px">
      <div class="card"><h2>${t('imp_pub_trend')}</h2>${d.trend.length ? `<div class="chart-box"><canvas id="imp-trend"></canvas></div>` : `<div class="empty small">${t('no_data')}</div>`}</div>
      <div class="card"><h2>${t('imp_pub_what')}</h2>${bars(d.categories, true)}</div>
    </section>
    <section class="card" style="margin-top:16px"><h2>${t('imp_pub_why')}</h2>${bars(d.reasons, false)}</section>
    ${d.scope === 'organization' && d.restaurants.length > 1 ? `<section class="card" style="margin-top:16px"><h2>${t('restaurants')}</h2>
      <div class="chips">${d.restaurants.map((r) => `<a class="chip" href="#/impact/${encodeURIComponent(orgSlug)}/${encodeURIComponent(r.slug)}">${esc(r.name)}</a>`).join('')}</div></section>` : ''}
    <section class="impact-foot">
      <h3>${t('imp_pub_how')}</h3>
      <p>${t('imp_pub_how_text')}</p>
      <p class="small muted">${t('imp_pub_updated')}: ${fmt.date(d.updated)} · WASTE log</p>
    </section>`;

  renderLangToggle($('#imp-lang'));
  $('#imp-print').onclick = () => window.print();
  $('#imp-co2').onclick = () => showCo2Info(null, d.co2_factors);
  drawTrend(d.trend);
}

// Simple horizontal bars as HTML (share of kilos); reads well on phones and on paper
function bars(rows, colored) {
  if (!rows || !rows.length) return `<div class="empty small">${t('no_data')}</div>`;
  return `<div class="hbars">${rows.map((r) => `<div class="hbar">
    <div class="hbar-label">${colored ? `<span class="dot" style="background:${esc(r.color || '#999')}"></span>` : ''}${esc(r.name)}</div>
    <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, Number(r.pct) || 0)}%"></div></div>
    <div class="hbar-val num">${fmt.pct(r.pct)}</div></div>`).join('')}</div>`;
}

function drawTrend(trend) {
  if (chart) { chart.destroy(); chart = null; }
  const el = document.getElementById('imp-trend');
  if (!el || !window.Chart) return;
  const primary = css('--primary'); const ink2 = css('--ink-2'); const line = css('--line');
  chart = new Chart(el, {
    type: 'bar',
    data: { labels: trend.map((x) => fmt.date(x.week).replace(/\s?\d{4}$/, '')),
      datasets: [{ data: trend.map((x) => Number(x.kg)), backgroundColor: primary, borderRadius: 4, maxBarThickness: 28 }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: {
        title: (i) => `${t('imp_pub_week_of')} ${fmt.date(trend[i[0].dataIndex].week)}`,
        label: (c) => { const x = trend[c.dataIndex]; return `${fmt.kg(x.kg, 1)}${x.g_per_guest != null ? ` · ${x.g_per_guest} g ${t('per_guest_short')}` : ''}`; } } } },
      scales: { x: { grid: { display: false }, ticks: { color: ink2, font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: line }, ticks: { color: ink2, font: { size: 11 }, callback: (v) => `${v} kg` } } } },
  });
}

