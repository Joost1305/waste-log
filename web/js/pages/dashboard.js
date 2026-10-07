// Management dashboard. All numbers come from the dashboard() database function.
// Chart rules: one measure per chart (no dual axes), single hue for single-series
// charts, recessive grid, hover tooltips on every chart, tables next to charts.
import { state, api, app, esc, fmt, toastError, todayIso, addDaysIso, $, $$, printHeader, printPage } from '../core.js';
import { t } from '../i18n.js';
import { exportDashboard } from '../export.js';
import { showCo2Info } from '../co2.js';

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
    const d = (await api('/dashboard', { query: { restaurant_id: q.restaurant_id, from: q.from, to: q.to } })).data;
    last = d;
    draw(d);
  } catch (e) { toastError(e); body.innerHTML = ''; }
}

function delta(pct, goodWhenDown = true) {
  if (pct == null) return `<div class="delta muted">&nbsp;</div>`;
  const good = goodWhenDown ? pct <= 0 : pct >= 0;
  return `<div class="delta ${good ? 'good' : 'bad'}">${pct > 0 ? '▲' : '▼'} ${fmt.pct(Math.abs(pct), 1)} ${t('vs_prev')}</div>`;
}

function draw(d) {
  charts.splice(0).forEach((c) => c.destroy());
  const T = d.totals;
  $('#dash-period').textContent = `${fmt.date(d.period.from)} – ${fmt.date(d.period.to)}`;
  const restName = q.restaurant_id ? (state.meta.restaurants.find((r) => r.id === Number(q.restaurant_id)) || {}).name : t('all_restaurants');
  $('#dash-print-head').innerHTML = printHeader(t('dash_title'), `${restName} · ${fmt.date(d.period.from)} – ${fmt.date(d.period.to)}`);
  const body = $('#dash-body');
  if (!T.records) { body.innerHTML = `<div class="card empty">${t('no_data')}</div>`; return; }

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
  body.innerHTML = `
    <div class="grid grid-kpi">
      <div class="card kpi"><div class="label">${t('kpi_total')}</div><div class="value">${fmt.kg(T.kg, 0)}</div>${delta(T.change_kg_pct)}<div class="delta muted">${fmt.kg(T.kg_per_day, 1)} ${t('per_day')}</div></div>
      <div class="card kpi"><div class="label">${t('kpi_cost')}</div><div class="value">${fmt.money(T.value)}</div>
        <div class="delta muted">${t('purchase_value')}</div></div>
      <div class="card kpi"><div class="label">${t('kpi_per_guest')}</div><div class="value">${T.g_per_guest != null ? `${fmt.num(T.g_per_guest)} g` : '–'}</div>
        <div class="delta muted">${fmt.num(T.guests)} ${t('guests').toLowerCase()}</div></div>
      <button type="button" class="card kpi kpi-link" id="kpi-co2" title="${t('co2_hint')}"><div class="label">${t('kpi_co2')} <span class="info-i" aria-hidden="true">i</span></div>
        <div class="value">${T.co2e_kg >= 1000 ? `${fmt.num(T.co2e_kg / 1000, 1)} t` : fmt.kg(T.co2e_kg, 0)}</div>
        <div class="delta muted link-ish">${t('co2_short')}</div></button>
    </div>
    <div style="margin-top:16px">${targetHtml}</div>
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
      <div class="note">${t('dq_note', { p: fmt.num(d.data_quality.priced_pct), v: fmt.money(state.meta.organization.default_value_per_kg, 2) })}</div>
      ${d.data_quality.estimated_kg_pct > 0 ? `<div class="note">${t('est_note', { p: fmt.num(d.data_quality.estimated_kg_pct, 1) })}</div>` : ''}
      <div class="note">${t('rate_note')}</div>
    </div>`;

  $('#kpi-co2').onclick = () => showCo2Info();

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
    data: { labels: rows.map((r) => r.name), datasets: [{ data: rows.map((r) => Math.round(r.kg)), backgroundColor: primary, borderRadius: 4, maxBarThickness: 22 }] },
    options: { ...base, indexAxis: 'y',
      scales: { x: { ...base.scales.y }, y: { ...base.scales.x, ticks: { color: css('--ink'), font: { size: 12 } } } },
      plugins: { ...base.plugins, tooltip: { ...base.plugins.tooltip, callbacks: {
        label: (c) => { const r = rows[c.dataIndex]; return `${fmt.kg(r.kg, 1)} · ${fmt.money(r.value)} · ${fmt.pct((r.kg / T.kg) * 100)}`; } } } } },
  });
  charts.push(hbar($('#c-cat'), d.by_category));
  charts.push(hbar($('#c-reason'), d.by_reason));
}

function table(head, rows, numeric) {
  if (!rows.length) return `<div class="empty small">${t('no_data')}</div>`;
  return `<div class="table-wrap"><table><thead><tr>${head.map((h, i) => `<th class="${numeric[i] ? 'right' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td class="${numeric[i] ? 'right num' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
