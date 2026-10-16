// Settings › Sales: upload till reports (one file or a whole batch), check restaurant and period, import.
// Below: the till groups per restaurant (food, drinks or other; which groups count as guests).
// Settings › Dishes › "Link till items": link what the till sells to the app's dishes.
import { state, api, esc, fmt, toast, toastError, openModal, confirmDialog, loadMeta } from './core.js';
import { t } from './i18n.js';
import { readSalesFile } from './sales-read.js';

const LS_REST = 'fw_sales_restaurant';
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export async function renderSales(el) {
  el.innerHTML = `<div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">${t('sl_title')}</h2>
      <div class="page-actions"><label class="btn-primary btn-sm" for="sl-file" style="cursor:pointer">+ ${t('sl_upload')}</label>
      <input type="file" id="sl-file" accept=".xlsx,.csv,.pdf,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" multiple hidden></div></div>
    <p class="muted small">${t('sl_sub')}</p>
    <div id="sl-list"><span class="spinner"></span></div></div>
    <div class="card"><h2>${t('sl_groups')}</h2><p class="muted small">${t('sl_groups_sub')}</p><div id="sl-groups"><span class="spinner"></span></div></div>`;
  const reload = () => { loadReports(el); loadGroups(el); };
  el.querySelector('#sl-file').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    if (files.length) await preview(files, reload);
  };
  reload();
}

async function loadReports(el) {
  let rows;
  try { rows = (await api('/sales-reports')).data || []; } catch (e) { toastError(e); return; }
  const box = el.querySelector('#sl-list');
  if (!rows.length) { box.innerHTML = `<div class="empty">${t('sl_empty')}</div>`; return; }
  const period = (r) => (r.period_from === r.period_to ? fmt.date(r.period_from + 'T12:00:00') : `${fmt.date(r.period_from + 'T12:00:00')} – ${fmt.date(r.period_to + 'T12:00:00')}`);
  box.innerHTML = `<div class="table-wrap"><table class="stack"><thead><tr><th>${t('period')}</th><th>${t('restaurant')}</th>
    <th class="right">${t('sl_revenue')}</th><th class="right">${t('sl_lines')}</th><th></th></tr></thead><tbody>
    ${rows.slice(0, 120).map((r) => `<tr><td data-label="${t('period')}">${period(r)}<div class="small muted">${esc(r.file_name || '')}</div></td>
      <td data-label="${t('restaurant')}">${esc(r.restaurant_name || '')}</td>
      <td class="right num" data-label="${t('sl_revenue')}">${fmt.money(r.total_excl, 2)}</td>
      <td class="right num" data-label="${t('sl_lines')}">${fmt.num(r.line_count)}</td>
      <td class="actions"><button class="btn-sm btn-ghost btn-danger" data-del="${r.id}">${t('delete')}</button></td></tr>`).join('')}
    </tbody></table></div>${rows.length > 120 ? `<p class="small muted">${t('sl_more', { n: rows.length - 120 })}</p>` : ''}`;
  box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('sl_confirm_delete')))) return;
    try { await api(`/sales-reports/${b.dataset.del}`, { method: 'DELETE' }); toast(t('deleted')); loadReports(el); } catch (e) { toastError(e); }
  }));
}

async function loadGroups(el) {
  let rows;
  try { rows = (await api('/sales-groups')).data || []; } catch (e) { toastError(e); return; }
  const box = el.querySelector('#sl-groups');
  if (!rows.length) { box.innerHTML = `<div class="empty">${t('sl_groups_empty')}</div>`; return; }
  const byRest = new Map();
  rows.forEach((g) => { if (!byRest.has(g.restaurant_name)) byRest.set(g.restaurant_name, []); byRest.get(g.restaurant_name).push(g); });
  box.innerHTML = [...byRest.entries()].map(([rest, list]) => `<h3 style="margin:14px 0 6px">${esc(rest)}</h3>
    <div class="table-wrap"><table><thead><tr><th>${t('sl_group')}</th><th>${t('sl_kind')}</th><th>${t('sl_counts_guests')}</th></tr></thead><tbody>
    ${list.map((g) => `<tr><td>${esc(g.group_name || t('sl_no_group'))}</td>
      <td><select data-kind="${g.id}" aria-label="${t('sl_kind')}">${['food', 'drink', 'other'].map((k) => `<option value="${k}" ${g.kind === k ? 'selected' : ''}>${t('sl_k_' + k)}</option>`).join('')}</select></td>
      <td><label class="check"><input type="checkbox" data-guests="${g.id}" ${g.counts_guests ? 'checked' : ''}> <span class="small muted">${t('sl_guests_hint')}</span></label></td></tr>`).join('')}
    </tbody></table></div>`).join('');
  const save = async (id) => {
    const kind = box.querySelector(`[data-kind="${id}"]`).value;
    const guests = box.querySelector(`[data-guests="${id}"]`).checked;
    try { await api(`/sales-groups/${id}`, { method: 'PATCH', body: { kind, counts_guests: guests } }); toast(t('saved')); } catch (e) { toastError(e); }
  };
  box.querySelectorAll('[data-kind]').forEach((s) => (s.onchange = () => save(s.dataset.kind)));
  box.querySelectorAll('[data-guests]').forEach((c) => (c.onchange = () => save(c.dataset.guests)));
}

// Guess the restaurant from the file name ("Le_Debut", "Mangerie" for the Food Court), else the last one used
function guessRestaurant(fileName) {
  const rests = state.meta.restaurants;
  const f = norm(fileName);
  const hit = rests.find((r) => norm(r.name).split(' ').filter((w) => w.length > 3 && !['amsterdam', 'den', 'haag', 'restaurant'].includes(w)).some((w) => f.includes(w)));
  if (hit) return hit.id;
  if (/mangerie|food ?court/.test(f)) { const fc = rests.find((r) => /food ?court|mangerie/.test(norm(r.name))); if (fc) return fc.id; }
  let last = null; try { last = Number(localStorage.getItem(LS_REST)); } catch { /* private mode */ }
  return rests.some((r) => r.id === last) ? last : rests[0]?.id;
}

async function preview(files, reload) {
  openModal(`<div class="card empty"><span class="spinner"></span> ${t('sl_reading', { n: files.length })}</div>`);
  const items = [];
  for (const f of files) {
    try {
      const r = await readSalesFile(f);
      items.push({ file: f.name, restaurant_id: guessRestaurant(f.name), from: r.period?.from || '', to: r.period?.to || r.period?.from || '',
        lines: r.lines, total: r.total, warnings: r.warnings, include: r.lines.length > 0 });
    } catch (e) {
      items.push({ file: f.name, error: e.code === 'unsupported' ? t('imp_xls') : e.message, include: false, lines: [] });
    }
  }
  items.sort((a, b) => String(a.from).localeCompare(String(b.from)));
  const rests = state.meta.restaurants;
  openModal(`<h2>${t('sl_check')}</h2><p class="small muted">${t('sl_check_sub')}</p>
    <div class="table-wrap sl-preview"><table><thead><tr><th></th><th>${t('sl_file')}</th><th>${t('restaurant')}</th><th>${t('sl_from')}</th><th>${t('sl_to')}</th>
      <th class="right">${t('sl_lines')}</th><th class="right">${t('sl_revenue_incl')}</th></tr></thead><tbody>
      ${items.map((x, i) => `<tr><td><input type="checkbox" data-inc="${i}" ${x.include ? 'checked' : ''} ${x.error || !x.lines.length ? 'disabled' : ''} aria-label="${t('sl_include')}"></td>
        <td class="small">${esc(x.file)}${x.error ? `<div class="err">${esc(x.error)}</div>` : ''}${(x.warnings || []).map((w) => `<div class="small" style="color:var(--accent)">${esc(w)}</div>`).join('')}</td>
        <td><select data-rest="${i}" aria-label="${t('restaurant')}">${rests.map((r) => `<option value="${r.id}" ${r.id === x.restaurant_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></td>
        <td><input type="date" data-from="${i}" value="${esc(x.from)}" aria-label="${t('sl_from')}"></td>
        <td><input type="date" data-to="${i}" value="${esc(x.to)}" aria-label="${t('sl_to')}"></td>
        <td class="right num">${fmt.num(x.lines.length)}</td>
        <td class="right num">${x.lines.length ? fmt.money(x.lines.reduce((s, l) => s + l.incl, 0), 2) : '–'}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="err" id="sl-err"></div><div id="sl-progress" class="small muted"></div>
    <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button><button class="btn-primary" id="sl-go">${t('sl_import', { n: items.filter((x) => x.include).length })}</button></div>`,
  (card, close) => {
    const go = card.querySelector('#sl-go');
    const count = () => { go.textContent = t('sl_import', { n: items.filter((x) => x.include).length }); go.disabled = !items.some((x) => x.include); };
    card.querySelectorAll('[data-inc]').forEach((c) => (c.onchange = () => { items[c.dataset.inc].include = c.checked; count(); }));
    card.querySelectorAll('[data-rest]').forEach((s) => (s.onchange = () => { items[s.dataset.rest].restaurant_id = Number(s.value); }));
    card.querySelectorAll('[data-from]').forEach((s) => (s.onchange = () => { items[s.dataset.from].from = s.value; }));
    card.querySelectorAll('[data-to]').forEach((s) => (s.onchange = () => { items[s.dataset.to].to = s.value; }));
    count();
    go.onclick = async () => {
      const todo = items.filter((x) => x.include);
      const bad = todo.find((x) => !x.from || !x.to || x.to < x.from);
      if (bad) { card.querySelector('#sl-err').textContent = t('sl_need_period', { f: bad.file }); return; }
      go.disabled = true;
      let done = 0; let replaced = 0; const failed = [];
      for (const x of todo) {
        card.querySelector('#sl-progress').textContent = t('sl_progress', { a: done + 1, b: todo.length });
        try {
          const r = (await api('/sales-reports', { method: 'POST', body: { restaurant_id: x.restaurant_id, period_from: x.from, period_to: x.to, file_name: x.file, lines: x.lines } })).data;
          if (r && r.replaced) replaced++;
          done++;
        } catch (e) { failed.push(`${x.file}: ${e.message}`); }
      }
      try { localStorage.setItem(LS_REST, String(todo[todo.length - 1].restaurant_id)); } catch { /* private mode */ }
      if (failed.length) { card.querySelector('#sl-err').innerHTML = failed.map(esc).join('<br>'); go.disabled = false; reload(); return; }
      close(); toast(t('sl_done', { n: done, r: replaced })); reload();
    };
  });
}

// ------------------------------------------------------------------ Settings › Dishes › Link till items
const stripStar = (s) => String(s).replace(/\s*\*\s*$/, '').trim();
function similarity(a, b) {
  const A = new Set(norm(stripStar(a)).split(' ').filter((w) => w.length > 2)); const B = new Set(norm(b).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let n = 0; A.forEach((w) => { if (B.has(w) || [...B].some((x) => x.startsWith(w) || w.startsWith(x))) n++; });
  return n / Math.max(A.size, B.size);
}

export async function openTillLinks(onDone) {
  openModal(`<div class="card empty"><span class="spinner"></span></div>`);
  let items; let dishes;
  try {
    [items, dishes] = await Promise.all([api('/sales-items').then((r) => r.data || []), api('/menu-items').then((r) => r.data || [])]);
  } catch (e) { toastError(e); document.getElementById('modal').hidden = true; return; }
  let onlyOpen = true;
  const draw = (card) => {
    const list = items.filter((x) => !onlyOpen || x.unlinked);
    const dishName = (id) => (dishes.find((d) => d.id === Number(id)) || {}).name;
    card.querySelector('#tl-body').innerHTML = list.length ? `<div class="table-wrap"><table class="stack"><thead><tr><th>${t('tl_item')}</th><th class="right">${t('tl_sold')}</th><th>${t('tl_dish')}</th><th></th></tr></thead><tbody>
      ${list.map((x) => {
        const i = items.indexOf(x);
        const ranked = dishes.map((d) => [similarity(x.item_name, d.name), d]).sort((a, b) => b[0] - a[0]);
        const best = !x.menu_item_id && ranked[0] && ranked[0][0] >= 0.5 ? ranked[0][1].id : null;
        const sel = x.menu_item_id || best || '';
        return `<tr><td data-label="${t('tl_item')}"><strong>${esc(x.item_name)}</strong>
            <div class="small muted">${esc((x.restaurants || []).join(', '))} · ${esc((x.groups || []).join(', '))}${x.avg_price ? ` · ${fmt.money(x.avg_price, 2)}` : ''}</div>
            ${x.ignored ? `<span class="badge">${t('tl_not_dish')}</span>` : x.menu_item_id ? `<span class="badge green">&#10003; ${esc(dishName(x.menu_item_id) || '')}</span>` : ''}</td>
          <td class="right num" data-label="${t('tl_sold')}">${fmt.num(x.qty)}</td>
          <td data-label="${t('tl_dish')}"><select data-dish="${i}" aria-label="${t('tl_dish')}"><option value="">${t('tl_choose')}</option>
            ${ranked.map(([, d]) => `<option value="${d.id}" ${Number(sel) === d.id ? 'selected' : ''}>${esc(d.name)}${d.restaurant_name ? ` (${esc(d.restaurant_name)})` : ''}</option>`).join('')}</select>
            ${best && !x.menu_item_id ? `<div class="small muted">${t('tl_suggested')}</div>` : ''}</td>
          <td class="actions"><button class="btn-sm btn-primary" data-link="${i}">${t('tl_link')}</button>
            <button class="btn-sm" data-new="${i}">+ ${t('tl_new')}</button>
            ${x.ignored ? `<button class="btn-sm btn-ghost" data-undo="${i}">${t('tl_undo')}</button>` : `<button class="btn-sm btn-ghost" data-ign="${i}">${t('tl_not_dish')}</button>`}</td></tr>`;
      }).join('')}</tbody></table></div>` : `<div class="empty">${t(onlyOpen ? 'tl_all_done' : 'tl_none')}</div>`;
    const link = async (i, body) => {
      try { await api('/sales-items/link', { method: 'POST', body: { item_name: items[i].item_name, ...body } }); } catch (e) { toastError(e); return false; }
      Object.assign(items[i], { menu_item_id: body.menu_item_id || null, ignored: !!body.ignored, unlinked: !body.menu_item_id && !body.ignored });
      draw(card); return true;
    };
    card.querySelectorAll('[data-link]').forEach((b) => (b.onclick = () => {
      const v = card.querySelector(`[data-dish="${b.dataset.link}"]`).value;
      if (!v) { toast(t('tl_choose_first'), 'error'); return; }
      link(Number(b.dataset.link), { menu_item_id: Number(v) });
    }));
    card.querySelectorAll('[data-ign]').forEach((b) => (b.onclick = () => link(Number(b.dataset.ign), { ignored: true })));
    card.querySelectorAll('[data-undo]').forEach((b) => (b.onclick = () => link(Number(b.dataset.undo), {})));
    card.querySelectorAll('[data-new]').forEach((b) => (b.onclick = () => {
      const x = items[Number(b.dataset.new)];
      const rest = state.meta.restaurants.find((r) => (x.restaurants || []).length === 1 && r.name === x.restaurants[0]);
      const row = b.closest('tr');
      row.insertAdjacentHTML('afterend', `<tr class="tl-new"><td colspan="4"><form class="tl-new-form">
        <div class="field-row"><div class="field"><label>${t('name')}</label><input name="name" required value="${esc(stripStar(x.item_name))}"></div>
          <div class="field"><label>${t('portion_g')}</label><input name="portion" type="number" min="1" step="1" inputmode="numeric" placeholder="${t('tl_portion_ph')}"></div>
          <div class="field"><label>${t('sales_price')}</label><input name="price" type="number" step="0.01" value="${x.avg_price ?? ''}"></div></div>
        <div class="small muted" style="margin-bottom:8px">${t('tl_portion_why')}</div>
        <button class="btn-primary btn-sm">${t('tl_create_link')}</button> <button type="button" class="btn-sm btn-ghost" data-cancel>${t('cancel')}</button></form></td></tr>`);
      const f = row.nextElementSibling.querySelector('form');
      f.querySelector('[data-cancel]').onclick = () => row.nextElementSibling.remove();
      f.onsubmit = async (e) => {
        e.preventDefault();
        const num = (v) => (v === '' ? null : Number(v));
        try {
          const d = (await api('/menu-items', { method: 'POST', body: { name: f.name.value.trim(), restaurant_id: rest ? rest.id : null,
            portion_size_g: num(f.portion.value), sales_price: num(f.price.value), is_active: true } })).data;
          dishes.push({ ...d, restaurant_name: rest ? rest.name : null });
          await link(Number(b.dataset.new), { menu_item_id: d.id });
        } catch (err) { toastError(err); }
      };
    }));
  };
  openModal(`<h2>${t('tl_title')}</h2><p class="small muted">${t('tl_sub')}</p>
    <label class="check" style="margin:6px 0 10px"><input type="checkbox" id="tl-open" checked> ${t('tl_only_open')}</label>
    <div id="tl-body"></div>
    <div class="modal-actions"><button data-close>${t('close')}</button></div>`, (card, close) => {
    card.querySelector('#tl-open').onchange = (e) => { onlyOpen = e.target.checked; draw(card); };
    card.querySelector('[data-close]').addEventListener('click', async () => { await loadMeta(); if (onDone) onDone(); });
    if (!items.length) { card.querySelector('#tl-body').innerHTML = `<div class="empty">${t('tl_no_sales')}</div>`; return; }
    draw(card);
  });
}
