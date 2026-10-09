// Interventions and best practices.
// Interventions: a restaurant writes down what it changes (and from when). The app measures the effect from the
// waste records: the same number of days before and after the start, per guest when guest counts exist, and next to
// the organization's other restaurants in the same weeks. Managers and admins only.
// Best practices: short stories (problem, solution, result) with an optional photo or PDF. Everyone in the
// organization can read published ones; managers write them for their own restaurants.
import { state, api, app, esc, fmt, toast, toastError, todayIso, $, $$, openModal, confirmDialog, formHtml, readForm, printPage } from '../core.js';
import { t } from '../i18n.js';
import { documentUrl } from '../backend.js';

const STATUSES = ['planned', 'active', 'completed', 'stopped'];
let tab = 'interventions';
let ivs = []; let bps = { rows: [], categories: [] };
let filt = { restaurant_id: '', status: '', category_id: '' };
let chart = null;
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const canManage = () => !!state.meta.permissions.dashboard;

export async function renderInterventions(rest = []) {
  tab = rest[0] === 'best-practices' || !canManage() ? 'best-practices' : 'interventions';
  app().innerHTML = `
    <div class="page-head"><div><h1>${t(canManage() ? 'iv_title' : 'bp_title')}</h1><div class="muted small">${t(canManage() ? 'iv_sub' : 'bp_sub')}</div></div>
      <div class="page-actions no-print">
        <button type="button" class="btn-sm" id="iv-print">&#128424; ${t('print')}</button>
        ${canManage() ? `<button type="button" class="btn-sm btn-primary" id="iv-new">+ ${t(tab === 'interventions' ? 'iv_new' : 'bp_new')}</button>` : ''}
      </div></div>
    ${canManage() ? `<div class="chips no-print" style="margin-bottom:14px">
      <a class="chip ${tab === 'interventions' ? 'on' : ''}" href="#/interventions">${t('iv_tab')}</a>
      <a class="chip ${tab === 'best-practices' ? 'on' : ''}" href="#/interventions/best-practices">${t('bp_tab')}</a></div>` : ''}
    <div id="iv-filters"></div>
    <div id="iv-body"><div class="card empty"><span class="spinner"></span></div></div>`;
  $('#iv-print').onclick = () => printPage();
  if ($('#iv-new')) $('#iv-new').onclick = () => (tab === 'interventions' ? editIntervention() : editBestPractice());
  await load();
}

async function load() {
  try {
    if (tab === 'interventions') ivs = (await api('/interventions')).data || [];
    else {
      bps = (await api('/best-practices')).data || { rows: [], categories: [] };
      if (canManage() && !ivs.length) ivs = (await api('/interventions')).data || [];
    }
  } catch (e) { toastError(e); $('#iv-body').innerHTML = ''; return; }
  draw();
}

function draw() { if (tab === 'interventions') drawInterventions(); else drawBestPractices(); }

// ------------------------------------------------------------------ interventions
function effectBadge(e, big = false) {
  if (!e) return '';
  if (e.status === 'planned') return `<div class="muted small">${t('iv_eff_planned')}</div>`;
  if (e.status === 'too_early') return `<div class="muted small">${t('iv_eff_early')}</div>`;
  if (e.change_pct == null) return `<div class="muted small">${t('iv_eff_none')}</div>`;
  const good = e.change_pct <= 0;
  return `<div class="iv-effect ${big ? 'big' : ''} ${good ? 'good' : 'bad'}">${e.change_pct > 0 ? '+' : '−'}${fmt.pct(Math.abs(e.change_pct), 0)}
      <span>${t(e.metric === 'per_guest' ? 'iv_per_guest' : 'iv_per_day')}</span></div>
    ${e.control_change_pct != null ? `<div class="small muted">${t('iv_ctrl_short', { p: `${e.control_change_pct > 0 ? '+' : '−'}${fmt.pct(Math.abs(e.control_change_pct), 0)}` })}</div>` : ''}
    ${e.low_data ? `<div class="small"><span class="badge warn">${t('iv_low_data')}</span></div>` : ''}`;
}

function focusText(i) {
  const f = [i.scope_category, i.scope_reason, i.scope_menu_item].filter(Boolean);
  return f.length ? f.map(esc).join(' · ') : t('iv_focus_all');
}

function drawInterventions() {
  const rests = [...new Map(ivs.map((i) => [i.restaurant_id, i.restaurant_name])).entries()];
  $('#iv-filters').innerHTML = ivs.length ? `<form class="card filters no-print" id="iv-f">
    ${rests.length > 1 ? `<div><label>${t('restaurant')}</label><select name="restaurant_id"><option value="">${t('all_restaurants')}</option>
      ${rests.map(([id, n]) => `<option value="${id}" ${String(id) === filt.restaurant_id ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></div>` : ''}
    <div><label>${t('status')}</label><select name="status"><option value="">${t('all')}</option>
      ${STATUSES.map((s) => `<option value="${s}" ${s === filt.status ? 'selected' : ''}>${t('iv_st_' + s)}</option>`).join('')}</select></div></form>` : '';
  if ($('#iv-f')) $('#iv-f').onchange = (e) => { filt[e.target.name] = e.target.value; drawInterventions(); };
  const rows = ivs.filter((i) => (!filt.restaurant_id || String(i.restaurant_id) === filt.restaurant_id) && (!filt.status || i.status === filt.status));
  if (!rows.length) {
    $('#iv-body').innerHTML = `<div class="card empty">${ivs.length ? t('no_data') : t('iv_empty')}</div>`;
    return;
  }
  $('#iv-body').innerHTML = `<div class="iv-list">${rows.map((i) => `
    <div class="card iv-card">
      <div class="iv-main">
        <div class="small muted">${esc(i.restaurant_name)} · ${fmt.date(i.start_date)}${i.end_date ? ` – ${fmt.date(i.end_date)}` : ''}</div>
        <h3>${esc(i.title)} <span class="badge ${i.status === 'active' ? 'green' : ''}">${t('iv_st_' + i.status)}</span>
          ${i.best_practice_id ? `<span class="badge">&#9733; ${t('bp_short')}</span>` : ''}</h3>
        ${i.description ? `<p class="small">${esc(i.description)}</p>` : ''}
        ${i.reason ? `<p class="small muted">${t('iv_why_short')}: ${esc(i.reason)}</p>` : ''}
        <div class="small muted">${t('iv_focus')}: ${focusText(i)}${i.responsible_label ? ` · ${esc(i.responsible_label)}` : ''}</div>
      </div>
      <div class="iv-side">${effectBadge(i.effect)}
        <div class="iv-actions no-print">
          <button type="button" class="btn-sm" data-eff="${i.id}">${t('iv_view_effect')}</button>
          ${i.can_edit ? `<button type="button" class="btn-sm btn-ghost" data-edit="${i.id}">${t('edit')}</button>` : ''}
        </div></div>
    </div>`).join('')}</div>`;
  $$('[data-eff]').forEach((b) => (b.onclick = () => showEffect(ivs.find((x) => x.id === Number(b.dataset.eff)))));
  $$('[data-edit]').forEach((b) => (b.onclick = () => editIntervention(ivs.find((x) => x.id === Number(b.dataset.edit)))));
}

function ivFields(restaurantId) {
  const m = state.meta;
  const menu = m.menu_items.filter((x) => !restaurantId || !x.restaurant_id || x.restaurant_id === Number(restaurantId));
  return [
    { name: 'title', label: t('iv_f_title'), required: true, placeholder: t('iv_f_title_ph') },
    { name: 'restaurant_id', label: t('restaurant'), type: 'select', required: true, blank: false, options: m.restaurants.map((r) => ({ value: r.id, label: r.name })) },
    { name: 'description', label: t('iv_f_what'), type: 'textarea' },
    { name: 'reason', label: t('iv_f_why'), type: 'textarea' },
    { name: 'start_date', label: t('iv_f_start'), type: 'date', required: true },
    { name: 'end_date', label: t('iv_f_end'), type: 'date' },
    { name: 'status', label: t('status'), type: 'select', blank: false, numericValue: false, options: STATUSES.map((s) => ({ value: s, label: t('iv_st_' + s) })) },
    { name: 'help1', type: 'help', label: t('iv_f_focus_help') },
    { name: 'scope_waste_category_id', label: t('category'), type: 'select', blankLabel: t('iv_focus_all'), options: m.waste_categories.map((c) => ({ value: c.id, label: c.label })) },
    { name: 'scope_reason_id', label: t('reason'), type: 'select', blankLabel: t('iv_focus_all'), options: m.waste_reasons.map((r) => ({ value: r.id, label: r.label })) },
    ...(menu.length ? [{ name: 'scope_menu_item_id', label: t('reg_menu_item'), type: 'select', blankLabel: t('iv_focus_all'), options: menu.map((x) => ({ value: x.id, label: x.name })) }] : []),
    { name: 'expected_change_pct', label: t('iv_f_expected'), type: 'number', step: '1', placeholder: '-20' },
    { name: 'responsible_label', label: t('iv_f_who') },
  ];
}

function editIntervention(iv) {
  const values = iv ? { ...iv } : { start_date: todayIso(), status: 'active', restaurant_id: state.meta.restaurants[0] && state.meta.restaurants[0].id };
  const fields = ivFields(values.restaurant_id);
  openModal(`<h2>${t(iv ? 'iv_edit' : 'iv_new')}</h2>
    <form id="iv-form">${formHtml(fields, values)}<div class="err" id="iv-err"></div>
    <div class="modal-actions">${iv ? `<button type="button" class="btn-ghost btn-danger" id="iv-del" style="margin-right:auto">${t('delete')}</button>` : ''}
      <button type="button" data-close>${t('cancel')}</button><button class="btn-primary">${t('save')}</button></div></form>`, (card, close) => {
    $('#iv-form', card).onsubmit = async (e) => {
      e.preventDefault();
      const body = readForm(card, fields.filter((f) => f.type !== 'help'));
      if (body.end_date && body.end_date < body.start_date) { $('#iv-err', card).textContent = t('iv_err_dates'); return; }
      try {
        if (iv) await api(`/interventions/${iv.id}`, { method: 'PATCH', body });
        else await api('/interventions', { method: 'POST', body });
        close(); toast(t('saved')); tab = 'interventions'; await load();
      } catch (err) { $('#iv-err', card).textContent = err.message; }
    };
    if (iv) $('#iv-del', card).onclick = async () => {
      close();
      if (!(await confirmDialog(t('iv_del_confirm', { t: iv.title })))) return;
      try { await api(`/interventions/${iv.id}`, { method: 'DELETE' }); toast(t('deleted')); await load(); } catch (err) { toastError(err); }
    };
  });
}

async function showEffect(iv, days = 28) {
  let e;
  try { e = (await api(`/interventions/${iv.id}/effect`, { query: { days } })).data; } catch (err) { toastError(err); return; }
  const per = e.metric === 'per_guest';
  const val = (w) => (w ? (per ? `${fmt.num(w.g_per_guest, 0)} g` : fmt.kg(w.kg_per_day, 1)) : '–');
  const b = e.before; const a = e.after;
  const sign = (n) => (n == null ? '–' : `${n > 0 ? '+' : '−'}${fmt.pct(Math.abs(n), 0)}`);
  openModal(`<div class="iv-modal">
    <div class="small muted">${esc(iv.restaurant_name)} · ${t('iv_focus')}: ${focusText(iv)}</div>
    <h2 style="margin-top:4px">${esc(iv.title)}</h2>
    ${iv.description ? `<p>${esc(iv.description)}</p>` : ''}
    ${iv.reason ? `<p class="small muted">${t('iv_why_short')}: ${esc(iv.reason)}</p>` : ''}
    <div class="field-row no-print" style="align-items:end"><div class="field"><label>${t('iv_window')}</label>
      <select id="iv-days">${[14, 28, 56].map((d) => `<option value="${d}" ${d === e.window_days ? 'selected' : ''}>${t('iv_days', { n: d })}</option>`).join('')}</select></div></div>
    ${e.status === 'ok' ? `
      <div class="grid grid-kpi iv-kpis">
        <div class="card kpi"><div class="label">${t('iv_before')}</div><div class="value">${val(b)}</div><div class="delta muted">${t(per ? 'iv_per_guest' : 'iv_per_day')} · ${fmt.date(b.from)} – ${fmt.date(b.to)}</div></div>
        <div class="card kpi"><div class="label">${t('iv_after')}</div><div class="value">${val(a)}</div><div class="delta muted">${t(per ? 'iv_per_guest' : 'iv_per_day')} · ${fmt.date(a.from)} – ${fmt.date(a.to)}</div></div>
        <div class="card kpi"><div class="label">${t('iv_change')}</div><div class="value ${e.change_pct <= 0 ? 'good-txt' : 'bad-txt'}">${sign(e.change_pct)}</div>
          <div class="delta muted">${e.control_change_pct != null ? t('iv_ctrl_short', { p: sign(e.control_change_pct) }) : t('iv_no_ctrl')}</div></div>
        <div class="card kpi"><div class="label">${t('iv_saved')}</div><div class="value">${e.saved_kg != null && e.saved_kg > 0 ? fmt.kg(e.saved_kg, 0) : '–'}</div>
          <div class="delta muted">${e.saved_value > 0 ? `≈ ${fmt.money(e.saved_value)} ${t('purchase_value')}` : t('iv_saved_note')}</div></div>
      </div>
      ${e.net_change_pct != null ? `<div class="note">${t(e.net_change_pct <= 0 ? 'iv_net_good' : 'iv_net_bad', { n: fmt.pct(Math.abs(e.net_change_pct), 0) })}</div>` : ''}
      ${e.low_data ? `<div class="note">${t('iv_low_data_note', { b: b.records, a: a.records })}</div>` : ''}`
    : `<div class="note">${e.status === 'planned' ? t('iv_eff_planned') : t('iv_eff_early')}</div>`}
    <h3 style="margin-top:16px">${t('iv_weekly')}</h3>
    <div class="chart-box"><canvas id="iv-chart"></canvas></div>
    <p class="small muted" style="margin-top:10px">${t('iv_method', { d: e.window_days })}</p>
    <div class="modal-actions no-print">
      ${iv.can_edit && e.status === 'ok' && !iv.best_practice_id ? `<button type="button" class="btn-sm" id="iv-share">&#9733; ${t('iv_share')}</button>` : ''}
      <button data-close>${t('close')}</button></div></div>`, (card, close) => {
    $('#iv-days', card).onchange = (ev) => { close(); showEffect(iv, Number(ev.target.value)); };
    const sh = $('#iv-share', card);
    if (sh) sh.onclick = () => { close(); shareAsBestPractice(iv, e); };
    drawEffectChart(e, per);
  });
}

function drawEffectChart(e, per) {
  if (chart) { chart.destroy(); chart = null; }
  const el = document.getElementById('iv-chart');
  if (!el || !window.Chart || !e.weekly) return;
  const wk = e.weekly;
  const vals = wk.map((w) => (per ? w.g_per_guest : Math.round((w.kg / Math.max(1, w.days)) * 100) / 100));
  const muted = css('--line'); const primary = css('--primary'); const accent = css('--accent') || '#c98a2b';
  chart = new Chart(el, {
    type: 'bar',
    data: { labels: wk.map((w) => fmt.date(w.week).replace(/\s?\d{4}$/, '')),
      datasets: [{ data: vals, borderRadius: 4, maxBarThickness: 26,
        backgroundColor: wk.map((w) => (w.phase === 'after' ? primary : w.phase === 'start' ? accent : muted)) }] },
    options: { responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { displayColors: false, callbacks: {
        title: (i) => `${t('imp_pub_week_of')} ${fmt.date(wk[i[0].dataIndex].week)} · ${t('iv_ph_' + wk[i[0].dataIndex].phase)}`,
        label: (c) => (c.raw == null ? '–' : per ? `${c.raw} g ${t('per_guest_short')}` : `${fmt.kg(c.raw, 1)} ${t('per_day')}`) } } },
      scales: { x: { grid: { display: false }, ticks: { color: css('--ink-2'), font: { size: 11 } } },
        y: { beginAtZero: true, grid: { color: css('--line') }, ticks: { color: css('--ink-2'), font: { size: 11 }, callback: (v) => (per ? `${v} g` : `${v} kg`) } } } },
  });
}

function shareAsBestPractice(iv, e) {
  const sign = (n) => `${n > 0 ? '+' : '−'}${fmt.pct(Math.abs(n), 0)}`;
  const result = t('iv_share_result', {
    c: sign(e.change_pct), m: t(e.metric === 'per_guest' ? 'iv_per_guest' : 'iv_per_day'), d: e.after.days,
    ctrl: e.control_change_pct != null ? t('iv_share_ctrl', { p: sign(e.control_change_pct) }) : '',
  });
  tab = 'best-practices';
  editBestPractice({ title: iv.title, restaurant_id: iv.restaurant_id, intervention_id: iv.id, problem: iv.reason || '',
    solution: iv.description || '', result, result_change_pct: e.change_pct, status: 'published' }, true);
}

// ------------------------------------------------------------------ best practices
function drawBestPractices() {
  const cats = bps.categories || [];
  const used = new Set(bps.rows.map((r) => r.category_id));
  $('#iv-filters').innerHTML = bps.rows.length ? `<div class="chips no-print" style="margin-bottom:14px" id="bp-cats">
    <button type="button" class="chip ${!filt.category_id ? 'on' : ''}" data-cat="">${t('all')}</button>
    ${cats.filter((c) => used.has(c.id)).map((c) => `<button type="button" class="chip ${String(c.id) === filt.category_id ? 'on' : ''}" data-cat="${c.id}">${esc(c.label)}</button>`).join('')}</div>` : '';
  $$('[data-cat]').forEach((b) => (b.onclick = () => { filt.category_id = b.dataset.cat; drawBestPractices(); }));
  const rows = bps.rows.filter((r) => !filt.category_id || String(r.category_id) === filt.category_id);
  if (!rows.length) { $('#iv-body').innerHTML = `<div class="card empty">${t('bp_empty')}</div>`; return; }
  $('#iv-body').innerHTML = `<div class="bp-grid">${rows.map((r) => `
    <article class="card bp-card">
      <div class="small muted">${r.category ? `<span class="badge green">${esc(r.category)}</span> ` : ''}${r.status !== 'published' ? `<span class="badge warn">${t('bp_draft')}</span> ` : ''}
        ${esc(r.restaurant_name || t('bp_whole_org'))} · ${fmt.date(r.published_at || r.created_at)}${r.author_name ? ` · ${esc(r.author_name)}` : ''}</div>
      <h3>${esc(r.title)}</h3>
      ${r.result_change_pct != null ? `<div class="iv-effect ${r.result_change_pct <= 0 ? 'good' : 'bad'}">${r.result_change_pct > 0 ? '+' : '−'}${fmt.pct(Math.abs(r.result_change_pct), 0)} <span>${t('bp_waste')}</span></div>` : ''}
      ${r.problem ? `<div class="bp-sec"><strong>${t('bp_problem')}</strong><p>${esc(r.problem)}</p></div>` : ''}
      ${r.solution ? `<div class="bp-sec"><strong>${t('bp_solution')}</strong><p>${esc(r.solution)}</p></div>` : ''}
      ${r.result ? `<div class="bp-sec"><strong>${t('bp_result')}</strong><p>${esc(r.result)}</p></div>` : ''}
      ${r.attachment_path ? `<div class="bp-att" data-att="${esc(r.attachment_path)}" data-type="${esc(r.attachment_type || '')}" data-name="${esc(r.attachment_name || '')}"></div>` : ''}
      ${r.intervention_title ? `<div class="small muted">${t('bp_from_iv')}: ${esc(r.intervention_title)}</div>` : ''}
      ${r.can_edit ? `<div class="no-print" style="margin-top:8px"><button type="button" class="btn-sm btn-ghost" data-bp="${r.id}">${t('edit')}</button></div>` : ''}
    </article>`).join('')}</div>`;
  $$('[data-bp]').forEach((b) => (b.onclick = () => editBestPractice(bps.rows.find((x) => x.id === Number(b.dataset.bp)))));
  // Attachments: photos inline, PDFs as a link (signed links, private storage)
  $$('[data-att]').forEach(async (el) => {
    try {
      const url = await documentUrl(el.dataset.att);
      el.innerHTML = el.dataset.type.startsWith('image/')
        ? `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${esc(el.dataset.name)}"></a>`
        : `<a class="btn-sm" href="${url}" target="_blank" rel="noopener">&#128196; ${esc(el.dataset.name || 'PDF')}</a>`;
    } catch { el.remove(); }
  });
}

function editBestPractice(bp, fromIntervention = false) {
  const isNew = !bp || !bp.id;
  const v = { status: 'published', ...(bp || {}) };
  v.publish = v.status === 'published';
  const m = state.meta;
  const restOpts = m.restaurants.map((r) => ({ value: r.id, label: r.name }));
  const fields = [
    { name: 'title', label: t('bp_f_title'), required: true },
    { name: 'restaurant_id', label: t('restaurant'), type: 'select', blank: !!m.permissions.users, blankLabel: t('bp_whole_org'),
      options: restOpts },
    { name: 'category_id', label: t('bp_f_category'), type: 'select', options: (bps.categories || []).map((c) => ({ value: c.id, label: c.label })) },
    { name: 'problem', label: t('bp_problem'), type: 'textarea' },
    { name: 'solution', label: t('bp_solution'), type: 'textarea' },
    { name: 'result', label: t('bp_result'), type: 'textarea' },
    { name: 'result_change_pct', label: t('bp_f_pct'), type: 'number', step: '0.1' },
    ...(ivs.length ? [{ name: 'intervention_id', label: t('bp_from_iv'), type: 'select',
      options: ivs.filter((i) => i.can_edit).map((i) => ({ value: i.id, label: `${i.title} (${i.restaurant_name})` })) }] : []),
    { name: 'publish', label: t('bp_f_publish'), type: 'checkbox' },
  ];
  openModal(`<h2>${t(isNew ? 'bp_new' : 'bp_edit')}</h2>
    ${fromIntervention ? `<div class="note" style="margin-bottom:12px">${t('bp_prefilled')}</div>` : ''}
    <form id="bp-form">${formHtml(fields, v)}
      <div class="field"><label>${t('bp_f_file')}</label>
        ${v.attachment_name ? `<div class="small" id="bp-cur">&#128206; ${esc(v.attachment_name)} <button type="button" class="link-btn" id="bp-rm">${t('reg_remove')}</button></div>` : ''}
        <input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf"><div class="small muted">${t('bp_f_file_help')}</div></div>
      <div class="err" id="bp-err"></div>
      <div class="modal-actions">${!isNew ? `<button type="button" class="btn-ghost btn-danger" id="bp-del" style="margin-right:auto">${t('delete')}</button>` : ''}
        <button type="button" data-close>${t('cancel')}</button><button class="btn-primary" id="bp-save">${t('save')}</button></div></form>`, (card, close) => {
    let removeAtt = false;
    if ($('#bp-rm', card)) $('#bp-rm', card).onclick = () => { removeAtt = true; $('#bp-cur', card).remove(); };
    $('#bp-form', card).onsubmit = async (e) => {
      e.preventDefault();
      const body = readForm(card, fields);
      body.status = body.publish ? 'published' : 'draft'; delete body.publish;
      const file = card.querySelector('input[name="file"]').files[0];
      $('#bp-save', card).disabled = true;
      try {
        if (file) {
          if (file.size > 10 * 1024 * 1024) throw new Error(t('bp_err_size'));
          const form = new FormData(); form.append('file', file, file.name);
          const up = (await api('/documents', { method: 'POST', form })).data;
          Object.assign(body, { attachment_path: up.path, attachment_name: up.name, attachment_type: up.type });
        } else if (removeAtt) Object.assign(body, { attachment_path: null, attachment_name: null, attachment_type: null });
        if (isNew) await api('/best-practices', { method: 'POST', body });
        else await api(`/best-practices/${bp.id}`, { method: 'PATCH', body });
        close(); toast(t('saved'));
        if (tab !== 'best-practices' || location.hash !== '#/interventions/best-practices') location.hash = '#/interventions/best-practices';
        else await load();
      } catch (err) { $('#bp-err', card).textContent = err.message; $('#bp-save', card).disabled = false; }
    };
    if (!isNew) $('#bp-del', card).onclick = async () => {
      close();
      if (!(await confirmDialog(t('iv_del_confirm', { t: bp.title })))) return;
      try { await api(`/best-practices/${bp.id}`, { method: 'DELETE' }); toast(t('deleted')); await load(); } catch (err) { toastError(err); }
    };
  });
}
