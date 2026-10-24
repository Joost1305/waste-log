// Management dashboard. All numbers come from the dashboard() database function.
// Chart rules: one measure per chart (no dual axes), single hue for single-series
// charts, recessive grid, hover tooltips on every chart, tables next to charts.
import { state, api, app, esc, fmt, toast, toastError, todayIso, addDaysIso, $, $$, printHeader, printPage } from '../core.js';
import { t } from '../i18n.js';
import { exportDashboard } from '../export.js';
import { showCo2Info } from '../co2.js';
import { equivalentsLine } from '../co2-equivalents.js';
import { showCostInfo } from '../cost.js';
import { summaryHtml, dailyChart, dailyChartNote, weatherCardHtml, dayLabel, kgPerOpenDay } from '../dash-insights.js';
import { loadStreak, badgesHtml, openCertificate } from '../streaks.js';
import { openModal } from '../core.js';

const charts = [];
let q; let last = null;

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export async function renderDashboard() {
  q = { preset: '12w', restaurant_id: '', from: addDaysIso(todayIso(), -83), to: todayIso() };
  const meta = state.meta;
  app().innerHTML = `
    <div id="dash-print-head"></div>
    <div class="page-head"><div><h1>${t('dash_title')}</h1><div class="muted small" id="dash-period"></div></div>
      <div class="page-actions no-print">
        <button type="button" class="btn-sm" id="dash-print">&#128424; ${t('print')}</button>
        <button type="button" class="btn-sm" id="dash-xlsx">&#11015; ${t('export_xlsx')}</button></div></div>
    <form class="card filters no-print" id="dash-filters">
      ${meta.restaurants.length > 1 ? `<div><label>${t('restaurant')}</label><select name="restaurant_id"><option value="">${t('all_restaurants')}</option>
        ${meta.restaurants.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>${t('period')}</label><select name="preset">
        <option value="4w">${t('p_4w')}</option><option value="12w" selected>${t('p_12w')}</option>
        <option value="26w">${t('p_26w')}</option><option value="custom">${t('p_custom')}</option></select></div>
      <div class="custom-range hidden"><label>${t('from')}</label><input type="date" name="from" value="${q.from}"></div>
      <div class="custom-range hidden"><label>${t('to')}</label><input type="date" name="to" value="${q.to}"></div>
    </form>
    <div id="dash-body" style="margin-top:16px"><div class="card empty"><span class="spinner"></span></div></div>`;
  $('#dash-filters').onchange = (e) => {
    const { name, value } = e.target;
    q[name] = value;
    if (name === 'preset') {
      $$('.custom-range').forEach((x) => x.classList.toggle('hidden', value !== 'custom'));
      const days = { '4w': 27, '12w': 83, '26w': 181 }[value];
      if (days) { q.to = todayIso(); q.from = addDaysIso(q.to, -days); }
    }
    load();
  };
  $('#dash-print').onclick = () => printPage();
  $('#dash-xlsx').onclick = () => { if (last) exportDashboard(last, q); };
  load();
}

async function load() {
  const body = $('#dash-body');
  try {
    const query = { restaurant_id: q.restaurant_id, from: q.from, to: q.to };
    // The daily series is extra: if it fails, the dashboard still shows everything else
    const [d, daily] = await Promise.all([
      api('/dashboard', { query }).then((r) => r.data),
      api('/dashboard-daily', { query }).then((r) => r.data).catch(() => null),
    ]);
    last = d;
    draw(d, daily);
  } catch (e) { toastError(e); body.innerHTML = ''; }
}

// Sales from the till: waste as % of food sales, per 100 dishes sold, and per dish sold versus wasted
async function loadSales() {
  const box = $('#dash-sales');
  // Only when the organization uses sales reports (Settings › Organization)
  if (!box || !(state.meta.organization && state.meta.organization.sales_enabled)) return;
  let s;
  try { s = (await api('/sales-summary', { query: { restaurant_id: q.restaurant_id, from: q.from, to: q.to } })).data; } catch { return; }
  if (!s || !s.has_sales) {
    box.innerHTML = `<div class="card muted small" style="margin-top:16px">${t('ds_no_sales')} <a href="#/settings/sales">${t('sl_title')}</a></div>`;
    return;
  }
  const dishes = (s.dishes || []).filter((d) => d.sold > 0 || d.waste_kg > 0);
  box.innerHTML = `<div class="card" style="margin-top:16px"><h2>${t('ds_sales_title')}</h2>
    <div class="grid grid-kpi" style="margin-top:4px">
      <div class="kpi"><div class="label">${t('ds_pct_sales')}</div><div class="value">${s.waste_pct_of_food_sales != null ? fmt.pct(s.waste_pct_of_food_sales, 1) : '–'}</div>
        <div class="delta muted">${fmt.money(s.waste_value)} / ${fmt.money(s.food_sales_excl)}</div></div>
      <div class="kpi"><div class="label">${t('ds_food_sales')}</div><div class="value">${fmt.money(s.food_sales_excl)}</div>
        <div class="delta muted">${t('ds_excl_vat')}</div></div>
      <div class="kpi"><div class="label">${t('ds_per_100')}</div><div class="value">${s.waste_kg_per_100_dishes != null ? fmt.kg(s.waste_kg_per_100_dishes, 1) : '–'}</div>
        <div class="delta muted">${t('ds_dishes_sold', { n: fmt.num(s.dishes_sold) })}</div></div>
    </div>
    <p class="small muted" style="margin:10px 0 0">${t('ds_cover', { a: s.days_covered, b: s.window_days })}
      ${s.unlinked_qty > 0 ? ` ${t('ds_unlinked', { n: fmt.num(s.unlinked_qty) })} <a href="#/settings/menu">${t('tl_btn')}</a>` : ''}</p>
    ${dishes.length ? `<h3 style="margin:16px 0 6px">${t('ds_per_dish')}</h3>${table(
      [t('reg_menu_item'), t('tl_sold'), t('wasted'), t('ds_per_100_short'), t('ds_of_served')],
      dishes.map((d) => [esc(d.name), fmt.num(d.sold), d.waste_kg ? fmt.kg(d.waste_kg, 1) : '–',
        d.waste_per_100 != null && d.waste_kg ? fmt.kg(d.waste_per_100, 1) : '–',
        d.waste_pct != null && d.waste_kg ? fmt.pct(d.waste_pct, 1) : (d.portion_g ? '–' : `<span class="small muted">${t('ds_no_portion')}</span>`)]),
      [false, true, true, true, true])}` : ''}
  </div>`;
}

function delta(pct, goodWhenDown = true) {
  if (pct == null) return `<div class="delta muted">&nbsp;</div>`;
  const good = goodWhenDown ? pct <= 0 : pct >= 0;
  return `<div class="delta ${good ? 'good' : 'bad'}">${pct > 0 ? '▲' : '▼'} ${fmt.pct(Math.abs(pct), 1)} ${t('vs_prev')}</div>`;
}

function draw(d, daily) {
  charts.splice(0).forEach((c) => c.destroy());
  const T = d.totals;
  $('#dash-period').textContent = `${fmt.date(d.period.from)} – ${fmt.date(d.period.to)}`;
  const restName = q.restaurant_id ? (state.meta.restaurants.find((r) => r.id === Number(q.restaurant_id)) || {}).name : t('all_restaurants');
  $('#dash-print-head').innerHTML = printHeader(t('dash_title'), `${restName} · ${fmt.date(d.period.from)} – ${fmt.date(d.period.to)}`);
  const body = $('#dash-body');
  if (!T.records) { body.innerHTML = `<div class="card empty">${t('no_data')}</div><div id="dash-health"></div>`; loadHealth(); return; }

  const tg = d.target;
  const period = (tg && tg.period) || 'month';
  const per = t('per_' + period);
  const targetHtml = tg ? `
    <div class="card">
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">${t('target')}: ${esc(tg.name)}</h2>
        ${tg.achieved ? `<span class="badge green">&#10003; ${t('target_reached')}</span>` : ''}
      </div>
      <div class="progress ${tg.achieved ? 'done' : ''}"><div style="width:${Math.min(100, tg.progress_pct)}%"></div></div>
      <div class="target-nums">
        <span>${t('baseline')}: <strong>${fmt.kg(tg.baseline_kg, 0)}</strong> ${per}</span>
        <span>${t('win_' + period)}: <strong>${fmt.kg(tg.current_kg, 0)}</strong></span>
        <span>${t('goal')}: <strong>${fmt.kg(tg.target_kg, 0)}</strong> ${per} (−${fmt.pct(tg.reduction_goal_pct)})</span>
        <span>${t('progress')}: <strong>${fmt.pct(tg.progress_pct)}</strong></span>
      </div>
    </div>` : `<div class="card muted small">${t('target_none')}</div>`;

  const showRest = state.meta.restaurants.length > 1 && !q.restaurant_id;
  // Inedible trim (peel, seeds, bones) counts in kg and CO2, but is not money that could have been saved
  const trimKg = Number(T.unavoidable_kg) || 0; const trimValue = Number(T.unavoidable_value) || 0;
  const co2Eq = equivalentsLine(Number(T.co2e_kg), t, fmt.num, { kitchen: true, max: 2 });
  body.innerHTML = `
    ${daily ? summaryHtml(d, daily) : ''}
    <div class="grid grid-kpi">
      <div class="card kpi"><div class="label">${t('kpi_total')}</div><div class="value">${fmt.kg(T.kg, 0)}</div>${delta(T.change_kg_pct)}<div class="delta muted" title="${t('per_reg_day_hint')}">${fmt.kg((daily && kgPerOpenDay(daily)) ?? T.kg_per_day, 1)} ${t('per_reg_day')}</div>
        ${trimKg > 0 ? `<div class="delta muted">${t('trim_of', { kg: fmt.kg(trimKg, 1) })}</div>` : ''}</div>
      <button type="button" class="card kpi kpi-link" id="kpi-cost" title="${t('cost_hint')}"><div class="label">${t('kpi_cost')} <span class="info-i" aria-hidden="true">i</span></div>
        <div class="value">${fmt.money(T.value - trimValue)}</div>
        <div class="delta muted">${trimValue > 0 ? `${t('cost_avoidable')} · ${t('cost_trim', { v: fmt.money(trimValue) })}` : t('purchase_value')} · <span class="link-ish">${t('co2_short')}</span></div></button>
      <div class="card kpi"><div class="label">${t('kpi_per_guest')}</div><div class="value">${T.g_per_guest != null ? `${fmt.num(T.g_per_guest)} g` : '–'}</div>
        <div class="delta muted">${fmt.num(T.guests)} ${t('guests').toLowerCase()}</div></div>
      <button type="button" class="card kpi kpi-link" id="kpi-co2" title="${t('co2_hint')}"><div class="label">${t('kpi_co2')} <span class="info-i" aria-hidden="true">i</span></div>
        <div class="value">${T.co2e_kg >= 1000 ? `${fmt.num(T.co2e_kg / 1000, 1)} t` : fmt.kg(T.co2e_kg, 0)}</div>
        ${co2Eq ? `<div class="eq">${co2Eq} <span class="eq-tag">${t('eq_indication')}</span></div>` : ''}
        <div class="delta muted link-ish">${t('co2_short')}</div></button>
    </div>
    <div style="margin-top:16px">${targetHtml}</div>
    ${daily ? `<div class="card" style="margin-top:16px"><h2>${t('dc_title')}</h2><div class="chart-box tall"><canvas id="c-daily"></canvas></div>
      ${dailyChartNote(daily) ? `<div class="note">${dailyChartNote(daily)}</div>` : ''}</div>` : ''}
    <div id="dash-sales"></div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h2>${t('trend')} (kg)</h2><div class="chart-box"><canvas id="c-trend"></canvas></div></div>
      <div class="card"><h2>${t('trend_guest')}</h2><div class="chart-box"><canvas id="c-trend-guest"></canvas></div></div>
      <div class="card"><h2>${t('by_category')}</h2><div class="chart-box"><canvas id="c-cat"></canvas></div></div>
      <div class="card"><h2>${t('by_reason')}</h2><div class="chart-box"><canvas id="c-reason"></canvas></div></div>
    </div>
    ${showRest ? `<div class="card" style="margin-top:16px"><h2>${t('by_outlet')}</h2>${table(
      [t('restaurant'), 'kg', t('value'), t('guests'), t('g_per_guest')],
      d.by_restaurant.map((r) => [esc(r.name), fmt.kg(r.kg, 0), fmt.money(r.value), fmt.num(r.guests), r.g_per_guest != null ? `${fmt.num(r.g_per_guest)} g` : '–']),
      [false, true, true, true, true])}</div>` : ''}
    ${sectionCard(d.by_section || [])}
    ${daily ? `<div style="margin-top:16px">${weatherCardHtml(daily)}</div>` : ''}
    <div id="dash-streaks"></div>
    <div id="dash-health"></div>
    <div class="grid grid-2" style="margin-top:16px">
      <div class="card"><h2>${t('by_supplier')}</h2>${table(
        [t('reg_supplier'), t('wasted'), t('purchased'), t('waste_rate')],
        d.by_supplier.map((r) => [esc(r.name), fmt.kg(r.kg, 0), r.purchased_kg ? fmt.kg(r.purchased_kg, 0) : '–', fmt.pct(r.waste_rate_pct, 1)]),
        [false, true, true, true])}</div>
      <div class="card"><h2>${t('by_menu')}</h2>${table(
        [t('reg_menu_item'), t('wasted'), `${t('produced')} (${t('portions')})`, t('waste_rate')],
        d.by_menu_item.map((r) => [esc(r.name), fmt.kg(r.kg, 0), r.portions_produced ? fmt.num(r.portions_produced) : '–', fmt.pct(r.waste_rate_pct, 1)]),
        [false, true, true, true])}</div>
    </div>
    <div class="card" style="margin-top:16px"><h2>${t('top_products')}</h2>${table(
      [t('product'), 'kg', t('value'), t('records')],
      d.top_products.map((r) => [esc(r.name), fmt.kg(r.kg, 0), fmt.money(r.value), fmt.num(r.records)]),
      [false, true, true, true])}
      ${trimKg > 0 ? `<div class="note">${t('top_trim_note', { kg: fmt.kg(trimKg, 1), v: fmt.money(trimValue) })}</div>` : ''}
      <div class="note">${t('dq_note', { p: fmt.num(d.data_quality.priced_pct), v: fmt.money(state.meta.organization.default_value_per_kg, 2) })}</div>
      ${d.data_quality.estimated_kg_pct > 0 ? `<div class="note">${t('est_note', { p: fmt.num(d.data_quality.estimated_kg_pct, 1) })}</div>` : ''}
      <div class="note">${t('rate_note')}</div>
    </div>`;

  loadSales(); loadStreaks(); loadHealth();
  $('#kpi-co2').onclick = () => showCo2Info(null, null, Number(T.co2e_kg));
  $('#kpi-cost').onclick = () => showCostInfo(d.valuation_mix, T.value, state.meta.organization.default_value_per_kg);

  const ink2 = css('--ink-2'); const line = css('--line'); const primary = css('--primary');
  const base = {
    responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
    plugins: { legend: { display: false }, tooltip: { backgroundColor: css('--ink'), padding: 10, cornerRadius: 8, displayColors: false } },
    scales: {
      x: { grid: { display: false }, ticks: { color: ink2, font: { size: 11 } }, border: { color: line } },
      y: { grid: { color: line }, ticks: { color: ink2, font: { size: 11 } }, border: { display: false }, beginAtZero: true },
    },
  };
  const weekLabel = (w) => fmt.date(w).replace(/\s?\d{4}$/, '');

  charts.push(new Chart($('#c-trend'), {
    type: 'bar',
    data: { labels: d.trend.map((x) => weekLabel(x.week)),
      datasets: [{ data: d.trend.map((x) => Math.round(x.kg)), backgroundColor: primary, borderRadius: 4, maxBarThickness: 28 }] },
    options: { ...base, plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip,
      callbacks: { title: (i) => `${t('date')}: ${fmt.date(d.trend[i[0].dataIndex].week)}`, label: (c) => `${fmt.kg(d.trend[c.dataIndex].kg, 1)} · ${fmt.money(d.trend[c.dataIndex].value)}` } } } },
  }));
  const perGuest = d.trend.map((x) => (x.guests ? Math.round((x.kg * 1000) / x.guests) : null));
  charts.push(new Chart($('#c-trend-guest'), {
    type: 'line',
    data: { labels: d.trend.map((x) => weekLabel(x.week)),
      datasets: [{ data: perGuest, borderColor: primary, backgroundColor: primary, borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, tension: 0.25, spanGaps: true }] },
    options: { ...base, interaction: { mode: 'index', intersect: false },
      plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: { label: (c) => `${c.raw} g` } } } },
  }));
  const hbar = (el, rows) => new Chart(el, {
    type: 'bar',
    data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => Math.round(r.kg)),
      // inedible trim: grey bar, and no euros (it is not money that could have been saved)
      backgroundColor: rows.map((r) => (r.avoidable === false ? ink2 : primary)), borderRadius: 4, maxBarThickness: 22 }] },
    options: { ...base, indexAxis: 'y',
      scales: { x: { ...base.scales.y }, y: { ...base.scales.x, ticks: { color: css('--ink'), font: { size: 12 } } } },
      plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: {
        label: (c) => { const r = rows[c.dataIndex]; return `${fmt.kg(r.kg, 1)} · ${r.avoidable === false ? t('trim_no_cost') : fmt.money(r.value)} · ${fmt.pct((r.kg / T.kg) * 100)}`; } } } } },
  });
  charts.push(hbar($('#c-cat'), d.by_category));
  if (daily && $('#c-daily')) { const c = dailyChart($('#c-daily'), d, daily, css); if (c) charts.push(c); }
  charts.push(hbar($('#c-reason'), d.by_reason));
}

function table(head, rows, numeric) {
  if (!rows.length) return `<div class="empty small">${t('no_data')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${numeric[i] ? 'right' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? 'right num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// Waste per section (food court counters etc.); share is within the section's own restaurant
function sectionCard(rows) {
  if (!rows.length) return '';
  const tot = {};
  rows.forEach((r) => { tot[r.restaurant_id] = (tot[r.restaurant_id] || 0) + Number(r.kg); });
  const multi = new Set(rows.map((r) => r.restaurant_id)).size > 1;
  const name = (r) => `${r.name ? esc(r.name) : `<span class="muted">${t('no_section')}</span>`}${multi ? ` <span class="muted small">· ${esc(r.restaurant)}</span>` : ''}
    <div class="muted small">${t('ds_regs_n', { n: fmt.num(r.records) })}</div>`;
  const share = (r) => {
    const p = tot[r.restaurant_id] > 0 ? Number(r.kg) / tot[r.restaurant_id] * 100 : 0;
    return `<span class="sec-share"><span class="sec-bar"><span style="width:${p.toFixed(1)}%"></span></span>${fmt.pct(p, 0)}</span>`;
  };
  return `<div class="card" style="margin-top:16px"><h2>${t('by_section')}</h2>${table(
    [t('lb_section'), 'kg', t('ds_share'), t('value')],
    rows.map((r) => [name(r), `<span class="nowrap">${fmt.kg(r.kg, 1)}</span>`, share(r), `<span class="nowrap">${fmt.money(r.value)}</span>`]),
    [false, true, true, true])}</div>`;
}

// ------------------------------------------------------------------ streaks (badges and certificates)
async function loadStreaks() {
  const box = $('#dash-streaks');
  if (!box) return;
  const ids = q.restaurant_id ? [Number(q.restaurant_id)] : state.meta.restaurants.map((r) => r.id);
  const list = (await Promise.all(ids.slice(0, 12).map(loadStreak))).filter((s) => s && (s.best > 0 || s.current > 0));
  if (!list.length || !$('#dash-streaks')) return;
  box.innerHTML = `<div class="card" style="margin-top:16px"><h2>${t('st_title')}</h2>
    <p class="small muted" style="margin-top:-6px">${t('st_sub')}</p>${list.map(badgesHtml).join('')}</div>`;
  box.querySelectorAll('[data-cert]').forEach((b) => (b.onclick = () => {
    const [rid, level] = b.dataset.cert.split(':').map(Number);
    const s = list.find((x) => x.restaurant_id === rid);
    if (!openCertificate(s, level, state.meta.organization && state.meta.organization.name)) toastError(new Error(t('st_popup')));
  }));
}

// ------------------------------------------------------------------ usage per location
async function loadHealth() {
  const box = $('#dash-health');
  if (!box) return;
  let h;
  try { h = (await api('/usage-health')).data; } catch { return; }
  const rows = (h && h.rows) || [];
  if (!rows.length || !$('#dash-health')) return;
  const statusOf = (missed, last) => (last == null || missed >= 14 ? 'inactive' : missed >= 4 ? 'slipping' : 'active');
  const pill = (st) => `<span class="health-pill ${st}">${t('uh_' + st)}</span>`;
  const lastTxt = (last, missed) => (last == null ? t('uh_never')
    : `${dayLabel(last)}${missed > 0 ? ` · ${t('uh_missed', { n: missed })}` : ''}`);
  const count = (st) => rows.filter((r) => r.status === st).length;
  box.innerHTML = `<div class="card" style="margin-top:16px"><h2>${t('uh_title')}</h2>
    <p class="small muted" style="margin-top:-6px">${t('uh_sub')}</p>
    <div class="health-sum">${['active', 'slipping', 'inactive'].map((st) => `<div class="health-box ${st}"><strong>${count(st)}</strong> ${t('uh_' + st)}</div>`).join('')}</div>
    <div class="table-wrap"><table><thead><tr><th>${t('restaurant')}</th><th>${t('uh_status')}</th><th>${t('uh_last')}</th>
      <th class="right">${t('uh_days30')}</th><th class="no-print"></th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td><strong>${esc(r.name)}</strong></td><td>${pill(r.status)}</td><td class="small">${lastTxt(r.last, r.missed)}</td>
        <td class="right num">${r.days_30} / ${r.open_30}</td>
        <td class="right no-print">${r.status !== 'active' ? `<button type="button" class="btn-sm" data-remind="${r.restaurant_id}">${t('uh_remind')}</button>` : ''}</td></tr>
        ${(r.sections || []).map((x) => { const st = statusOf(x.missed, x.last); return `<tr class="health-sec"><td class="small">↳ ${esc(x.name)}</td><td>${pill(st)}</td>
          <td class="small">${lastTxt(x.last, x.missed)}</td><td></td>
          <td class="right no-print">${st !== 'active' ? `<button type="button" class="btn-sm btn-ghost" data-remind="${r.restaurant_id}" data-sec="${esc(x.name)}">${t('uh_remind')}</button>` : ''}</td></tr>`; }).join('')}`).join('')}
    </tbody></table></div>
    <div class="note">${t('uh_note')}</div></div>`;
  box.querySelectorAll('[data-remind]').forEach((b) => (b.onclick = () => {
    const r = rows.find((x) => x.restaurant_id === Number(b.dataset.remind));
    const where = b.dataset.sec ? `${r.name} · ${b.dataset.sec}` : r.name;
    const msg = t('uh_msg', { where, url: location.origin + location.pathname });
    openModal(`<h2>${t('uh_remind_title', { where: esc(where) })}</h2>
      <p class="small muted">${t('uh_remind_sub')}</p>
      <textarea id="uh-msg" rows="5" style="width:100%">${esc(msg)}</textarea>
      <div class="modal-actions"><button type="button" data-close>${t('close')}</button><button type="button" class="btn-primary" id="uh-copy">${t('uh_copy')}</button></div>`,
    (card) => {
      card.querySelector('#uh-copy').onclick = async () => {
        const ta = card.querySelector('#uh-msg');
        try { await navigator.clipboard.writeText(ta.value); toast(t('uh_copied')); } catch { ta.select(); document.execCommand('copy'); toast(t('uh_copied')); }
      };
    });
  }));
}
