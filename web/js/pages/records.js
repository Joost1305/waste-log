// Waste records: filter, review, correct, delete.
import { state, api, app, esc, fmt, toast, toastError, todayIso, addDaysIso, $, $$, openModal, confirmDialog, formHtml, readForm, printHeader, printPage } from '../core.js';
import { t } from '../i18n.js';
import { photoUrl } from '../backend.js';
import { exportRecords } from '../export.js';
import { showCo2Info } from '../co2.js';

const PAGE = 50;
let f;
const selected = new Set();

export async function renderRecords() {
  const meta = state.meta;
  f = { restaurant_id: '', from: addDaysIso(todayIso(), -13), to: todayIso(), waste_category_id: '', reason_id: '', offset: 0 };
  const sel = (name, list, lab) => `<select name="${name}"><option value="">${t('all')}</option>${list.map((x) => `<option value="${x.id}">${esc(lab(x))}</option>`).join('')}</select>`;
  app().innerHTML = `
    <div id="rec-print-head"></div>
    <div class="page-head"><h1>${t('rec_title')}</h1>
      <div class="page-actions no-print">
        <button type="button" class="btn-sm" id="rec-print">&#128424; ${t('print')}</button>
        <button type="button" class="btn-sm" id="rec-xlsx">&#11015; ${t('export_xlsx')}</button></div></div>
    <form class="card filters no-print" id="rec-filters">
      ${meta.restaurants.length > 1 ? `<div><label>${t('restaurant')}</label>${sel('restaurant_id', meta.restaurants, (x) => x.name)}</div>` : ''}
      <div><label>${t('from')}</label><input type="date" name="from" value="${f.from}"></div>
      <div><label>${t('to')}</label><input type="date" name="to" value="${f.to}"></div>
      <div><label>${t('category')}</label>${sel('waste_category_id', meta.waste_categories, (x) => x.label)}</div>
      <div><label>${t('reason')}</label>${sel('reason_id', meta.waste_reasons, (x) => x.label)}</div>
    </form>
    <div class="card" style="margin-top:16px"><div id="rec-list"><span class="spinner"></span></div></div>`;
  $('#rec-filters').onchange = (e) => { f[e.target.name] = e.target.value; f.offset = 0; selected.clear(); load(); };
  $('#rec-print').onclick = () => printPage();
  $('#rec-xlsx').onclick = () => exportRecords(f);
  selected.clear();
  load();
}

async function load() {
  const el = $('#rec-list');
  try {
    const res = await api('/waste', { query: { ...f, limit: PAGE } });
    const rows = res.data; const m = res.meta;
    const canEditAny = state.meta.permissions.edit_any_waste;
    const today = todayIso();
    const isEditable = (r) => canEditAny || (r.user_id === state.user.id && r.created_at.slice(0, 10) === today);
    const deletable = rows.filter(isEditable);
    const rest = f.restaurant_id ? (state.meta.restaurants.find((x) => x.id === Number(f.restaurant_id)) || {}).name : t('all_restaurants');
    $('#rec-print-head').innerHTML = printHeader(t('rec_title'), `${rest} · ${fmt.date(f.from)} – ${fmt.date(f.to)}`);
    el.innerHTML = `
      <div class="rec-bar">
        <div class="muted small">${fmt.num(m.total)} ${t('records')} · <strong>${fmt.kg(m.total_kg)}</strong> · ${fmt.money(m.total_value)} ·
          <button type="button" class="link-btn" id="rec-co2" title="${t('co2_hint')}">CO₂-eq <span class="info-i" aria-hidden="true">i</span></button></div>
        ${deletable.length ? `<button type="button" class="btn-sm btn-danger no-print" id="rec-del-sel" disabled>${t('delete_selected')} (<span id="sel-n">0</span>)</button>` : ''}
      </div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr>
        ${deletable.length ? `<th class="no-print sel-col"><input type="checkbox" id="sel-all" aria-label="${t('select_all')}" title="${t('select_all')}"></th>` : ''}
        <th>${t('date')}</th><th>${t('product')}</th><th>${t('category')}</th><th>${t('reason')}</th>
        ${state.meta.restaurants.length > 1 ? `<th>${t('restaurant')}</th>` : ''}<th class="right">${t('weight')}</th><th class="right">${t('value')}</th>
        <th>${t('user')}</th><th class="no-print"></th></tr></thead><tbody>
        ${rows.map((r) => {
          const editable = isEditable(r);
          return `<tr>
          ${deletable.length ? `<td class="no-print sel-col">${editable ? `<input type="checkbox" data-sel="${r.id}" ${selected.has(r.id) ? 'checked' : ''} aria-label="${t('select_all')}">` : ''}</td>` : ''}
          <td class="nowrap">${fmt.dateTime(r.recorded_at)}</td>
          <td>${esc(r.product_name || '–')} ${r.has_photo ? `<a href="#" data-photo="${r.id}" title="${t('photo')}">&#128247;</a>` : ''}
            ${r.is_demo ? '<span class="badge demo">DEMO</span>' : ''}</td>
          <td><span class="dot" style="background:${esc(r.category_color || '#999')}"></span>${esc(r.category)}</td>
          <td>${esc(r.reason)}</td>
          ${state.meta.restaurants.length > 1 ? `<td>${esc(r.restaurant_name)}</td>` : ''}
          <td class="right num">${fmt.kg(r.weight_kg, 2)}${r.weight_source === 'estimate' ? ` <span class="badge warn" title="${t('reg_w_estimate')}">${t('badge_estimate')}</span>` : ''}</td>
          <td class="right num" title="${t('val_' + r.valuation_method)} · ${fmt.money(r.unit_cost_per_kg, 2)}/kg">${fmt.money(r.purchase_value, 2)}</td>
          <td class="small">${esc(r.user_name || '')}</td>
          <td class="actions no-print">${editable ? `<button class="btn-sm" data-edit="${r.id}">${t('edit')}</button>
            <button class="btn-sm btn-ghost btn-danger" data-del="${r.id}">${t('delete')}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
        <div class="pager no-print"><button class="btn-sm" id="pg-prev" ${f.offset === 0 ? 'disabled' : ''}>${t('previous')}</button>
          <span class="small muted">${f.offset + 1}–${Math.min(f.offset + PAGE, m.total)} / ${m.total}</span>
          <button class="btn-sm" id="pg-next" ${f.offset + PAGE >= m.total ? 'disabled' : ''}>${t('next')}</button></div>`
      : `<div class="empty">${t('no_data')}</div>`}`;
    const prev = $('#pg-prev'); const next = $('#pg-next');
    if (prev) prev.onclick = () => { f.offset = Math.max(0, f.offset - PAGE); load(); };
    if (next) next.onclick = () => { f.offset += PAGE; load(); };
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(t('confirm_delete_one')))) return;
      try { await api(`/waste/${b.dataset.del}`, { method: 'DELETE' }); selected.delete(Number(b.dataset.del)); toast(t('deleted_n', { n: 1 })); load(); } catch (e) { toastError(e); }
    }));
    $('#rec-co2').onclick = () => showCo2Info();
    // Multi-select delete
    const syncSel = () => {
      const n = selected.size;
      const btn = $('#rec-del-sel'); if (btn) { btn.disabled = n === 0; $('#sel-n').textContent = n; }
      const all = $('#sel-all');
      if (all) { const ids = deletable.map((r) => r.id); all.checked = ids.length > 0 && ids.every((id) => selected.has(id)); all.indeterminate = !all.checked && ids.some((id) => selected.has(id)); }
    };
    $$('[data-sel]', el).forEach((c) => (c.onchange = () => { const id = Number(c.dataset.sel); if (c.checked) selected.add(id); else selected.delete(id); syncSel(); }));
    const all = $('#sel-all');
    if (all) all.onchange = () => { deletable.forEach((r) => (all.checked ? selected.add(r.id) : selected.delete(r.id))); $$('[data-sel]', el).forEach((c) => { c.checked = all.checked; }); syncSel(); };
    const delSel = $('#rec-del-sel');
    if (delSel) delSel.onclick = async () => {
      const ids = [...selected];
      if (!ids.length || !(await confirmDialog(t('confirm_delete_n', { n: ids.length })))) return;
      try {
        const r = (await api('/waste/delete', { method: 'POST', body: { ids } })).data;
        selected.clear();
        toast(r.deleted === r.requested ? t('deleted_n', { n: r.deleted }) : t('deleted_some', { n: r.deleted, m: r.requested }), r.deleted === r.requested ? '' : 'error');
        if (f.offset >= m.total - r.deleted && f.offset > 0) f.offset = Math.max(0, f.offset - PAGE);
        load();
      } catch (e) { toastError(e); }
    };
    syncSel();
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => edit(rows.find((r) => r.id === Number(b.dataset.edit)))));
    $$('[data-photo]', el).forEach((a) => (a.onclick = async (e) => {
      e.preventDefault();
      const row = rows.find((r) => r.id === Number(a.dataset.photo));
      try {
        const url = await photoUrl(row.photo_path);
        openModal(`<img src="${esc(url)}" alt="" style="width:100%;border-radius:10px">
          <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
      } catch (err) { toastError(err); }
    }));
  } catch (e) { toastError(e); el.innerHTML = ''; }
}

function edit(r) {
  const meta = state.meta;
  const fields = [
    { name: 'product_id', label: t('product'), type: 'select', options: meta.products.map((p) => ({ value: p.id, label: p.name })) },
    { name: 'product_name', label: `${t('product')} (${t('reg_free_text').toLowerCase()})`, type: 'text' },
    { name: 'waste_category_id', label: t('category'), type: 'select', blank: false, options: meta.waste_categories.map((c) => ({ value: c.id, label: c.label })) },
    { name: 'reason_id', label: t('reason'), type: 'select', blank: false, options: meta.waste_reasons.map((c) => ({ value: c.id, label: c.label })) },
    { name: 'weight', label: `${t('weight')} (kg)`, type: 'number', step: '0.001', required: true },
    { name: 'menu_item_id', label: t('reg_menu_item'), type: 'select', options: meta.menu_items.map((m) => ({ value: m.id, label: m.name })) },
    { name: 'supplier_id', label: t('reg_supplier'), type: 'select', options: meta.suppliers.map((m) => ({ value: m.id, label: m.name })) },
    { name: 'note', label: t('reg_note'), type: 'text' },
  ];
  const values = { ...r, weight: r.weight_kg, product_name: r.product_id ? '' : r.product_name };
  openModal(`<h2>${t('edit')}</h2><form id="edit-form">${formHtml(fields, values)}
    <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button><button class="btn-primary" type="submit">${t('save')}</button></div></form>`,
  (card, close) => {
    // Picking another product also picks its category (still changeable).
    card.querySelector('[name=product_id]').onchange = (e) => {
      const p = meta.products.find((x) => x.id === Number(e.target.value));
      if (p) card.querySelector('[name=waste_category_id]').value = String(p.waste_category_id);
    };
    card.querySelector('#edit-form').onsubmit = async (e) => {
      e.preventDefault();
      const b = readForm(card, fields);
      b.unit = 'kg';
      if (b.product_id) b.product_name = null;
      try { await api(`/waste/${r.id}`, { method: 'PATCH', body: b }); close(); toast(t('saved')); load(); } catch (err) { toastError(err); }
    };
  });
}
