// Settings › Invoices: upload a supplier invoice (PDF, photo, Excel/CSV), the AI reads the lines,
// the manager checks product, kilos and amount per line, then saves. Lines with a product and kilos
// give the invoice price that values the waste of that product (see save_invoice).
import { state, api, esc, fmt, toast, toastError, openModal, confirmDialog, todayIso, loadMeta } from './core.js';
import { t } from './i18n.js';
import { readSheet } from './xlsx-read.js';
import { invoiceUrl } from './backend.js';

const meta = () => state.meta;
const isAdmin = () => !!meta().permissions.users;
const n = (v) => { if (v === '' || v == null) return null; const x = Number(String(v).replace(',', '.')); return isFinite(x) ? x : null; };

export async function renderInvoices(el) {
  el.innerHTML = `<div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">${t('inv_title')}</h2>
      <div class="page-actions"><button class="btn-sm" id="inv-manual">${t('inv_manual')}</button>
      <label class="btn-primary btn-sm" for="inv-file" style="cursor:pointer">+ ${t('inv_upload')}</label>
      <input type="file" id="inv-file" accept=".pdf,application/pdf,image/*,.xlsx,.csv" hidden></div></div>
    <p class="muted small">${t('inv_sub')}</p>
    <div id="inv-list"><span class="spinner"></span></div></div>`;
  const reload = () => loadList(el);
  el.querySelector('#inv-file').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) await readFile(f, reload);
  };
  el.querySelector('#inv-manual').onclick = () => review({ items: [blankLine()], invoice_date: todayIso() }, null, reload);
  reload();
}

async function loadList(el) {
  let rows;
  try { rows = (await api('/invoices')).data || []; } catch (e) { toastError(e); return; }
  const box = el.querySelector('#inv-list');
  if (!rows.length) { box.innerHTML = `<div class="empty">${t('inv_empty')}</div>`; return; }
  box.innerHTML = `<div class="table-wrap"><table class="stack"><thead><tr><th>${t('date')}</th><th>${t('reg_supplier')}</th><th>${t('restaurant')}</th>
    <th class="right">${t('inv_total')}</th><th class="right">${t('inv_lines')}</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td data-label="${t('date')}">${fmt.date(r.invoice_date)}${r.invoice_number ? ` <span class="muted small">#${esc(r.invoice_number)}</span>` : ''}</td>
      <td data-label="${t('reg_supplier')}">${esc(r.supplier || '–')}</td>
      <td data-label="${t('restaurant')}">${esc(r.restaurant || t('all_restaurants'))}</td>
      <td class="right num" data-label="${t('inv_total')}">${r.total_amount != null ? fmt.money(r.total_amount, 2) : '–'}</td>
      <td class="right num" data-label="${t('inv_lines')}">${t('inv_priced_of', { a: r.priced, b: r.lines })}</td>
      <td class="actions">${r.file_path ? `<button class="btn-sm btn-ghost" data-file="${esc(r.file_path)}">${t('inv_open_file')}</button>` : ''}
        <button class="btn-sm" data-edit="${r.id}">${t('edit')}</button>
        <button class="btn-sm btn-ghost btn-danger" data-del="${r.id}">${t('delete')}</button></td></tr>`).join('')}
    </tbody></table></div>`;
  box.querySelectorAll('[data-file]').forEach((b) => (b.onclick = () => openFile(b.dataset.file)));
  box.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = async () => {
    try { const d = (await api(`/invoices/${b.dataset.edit}`)).data; review({ ...d, items: d.items.map((x) => ({ ...x, include: true })) }, Number(b.dataset.edit), () => loadList(el)); }
    catch (e) { toastError(e); }
  }));
  box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    if (!(await confirmDialog(t('inv_confirm_delete')))) return;
    try { await api(`/invoices/${b.dataset.del}`, { method: 'DELETE' }); toast(t('inv_deleted')); loadList(el); } catch (e) { toastError(e); }
  }));
}

async function openFile(path) {
  const w = window.open('', '_blank');
  try { const url = await invoiceUrl(path); if (w) w.location = url; else location.href = url; }
  catch (e) { if (w) w.close(); toastError(e); }
}

const blankLine = () => ({ include: true, description: '', product_id: null, quantity_kg: null, line_total: null, is_food: true, confidence: null });

// ------------------------------------------------------------------ read a file
async function readFile(file, done) {
  const name = (file.name || '').toLowerCase();
  const sheet = name.endsWith('.xlsx') || name.endsWith('.csv');
  const closeWait = openModal(`<div class="inv-wait"><span class="spinner"></span><h2>${t('inv_reading')}</h2><p class="muted">${t('inv_reading_sub')}</p></div>`);
  document.getElementById('modal').onclick = null;
  let draft = { invoice_date: todayIso(), items: [] };
  let note = '';
  try {
    let body;
    if (sheet) {
      const rows = await readSheet(file);
      const text = rows.slice(0, 600).map((r) => r.map((c) => (c == null ? '' : String(c).replace(/\t|\n/g, ' '))).join('\t')).join('\n');
      body = { table_text: text };
      draft.original_filename = file.name;
    } else {
      if (file.size > 15 * 1024 * 1024) throw new Error(t('inv_too_big'));
      const form = new FormData(); form.append('file', file);
      const up = (await api('/invoices/file', { method: 'POST', form })).data;
      draft.file_path = up.path; draft.original_filename = up.name;
      body = { path: up.path };
    }
    const r = (await api('/invoices/read', { method: 'POST', body })).data || {};
    if (r.available === false) note = t('inv_ai_off');
    else if (!r.ok) note = t('inv_ai_fail');
    else {
      draft = { ...draft, supplier_id: r.supplier_id, supplier_name: r.supplier_name, invoice_number: r.invoice_number,
        invoice_date: r.invoice_date || draft.invoice_date, total_amount: r.total_amount,
        extraction_raw: { lines: r.lines, usage: r.usage },
        items: (r.lines || []).map((l) => ({ ...l, include: l.is_food !== false })) };
      if (!draft.items.length) note = t('inv_ai_fail');
    }
  } catch (e) {
    closeWait(); toastError(e); return;
  }
  closeWait();
  if (!draft.items.length) draft.items = [blankLine()];
  review(draft, null, done, note);
}

// ------------------------------------------------------------------ check and save
function review(d, editId, done, note = '') {
  const m = meta();
  const supName = d.supplier_name || (m.suppliers || []).find((s) => s.id === d.supplier_id)?.name || '';
  const prodOpts = [...m.products].sort((a, b) => a.name.localeCompare(b.name));
  const rests = m.restaurants;
  let items = d.items.map((x) => ({ ...x }));
  const restVal = d.restaurant_id ?? (rests.length === 1 ? rests[0].id : '');

  const lineHtml = (l, i) => {
    const kg = n(l.quantity_kg); const tot = n(l.line_total);
    const ppk = kg > 0 && tot > 0 ? fmt.money(tot / kg, 2) + '/kg' : '';
    const low = l.confidence != null && l.confidence < 0.6;
    return `<div class="inv-line ${l.include ? '' : 'off'}" data-i="${i}">
      <label class="inv-inc" title="${t('inv_include')}"><input type="checkbox" data-f="include" ${l.include ? 'checked' : ''}></label>
      <div class="inv-desc"><input data-f="description" value="${esc(l.description || '')}" placeholder="${t('inv_desc')}">
        ${l.quantity != null || l.unit ? `<div class="small muted">${esc([l.quantity, l.unit].filter((x) => x != null && x !== '').join(' '))}${l.unit_price != null ? ` · ${fmt.money(l.unit_price, 2)}` : ''}</div>` : ''}</div>
      <div class="inv-prod"><select data-f="product_id"><option value="">${t('inv_no_product')}</option>
        ${prodOpts.map((p) => `<option value="${p.id}" ${p.id === l.product_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        ${low ? `<div class="small inv-low">${t('inv_check')}</div>` : ''}</div>
      <div class="inv-num inv-kg"><label>kg</label><input data-f="quantity_kg" inputmode="decimal" value="${l.quantity_kg ?? ''}"></div>
      <div class="inv-num inv-eur"><label>€</label><input data-f="line_total" inputmode="decimal" value="${l.line_total ?? ''}"></div>
      <div class="inv-ppk small muted">${ppk}</div>
    </div>`;
  };
  const summary = () => {
    const inc = items.filter((l) => l.include);
    const priced = inc.filter((l) => l.product_id && n(l.quantity_kg) > 0 && n(l.line_total) > 0).length;
    const sum = inc.reduce((a, l) => a + (n(l.line_total) || 0), 0);
    return t('inv_summary', { a: inc.length, b: priced, s: fmt.money(sum, 2) });
  };

  openModal(`<div class="inv-modal"><h2>${editId ? t('inv_edit') : t('inv_check_title')}</h2>
    ${note ? `<div class="note" style="margin-bottom:12px">${esc(note)}</div>` : `<p class="muted small">${t('inv_check_sub')}</p>`}
    ${d.file_path ? `<p class="small"><button type="button" class="link-btn" id="inv-see">${t('inv_open_file')}</button></p>` : ''}
    <div class="field-row inv-head">
      <div class="field"><label>${t('reg_supplier')}</label><input id="inv-sup" list="inv-sups" value="${esc(supName)}" placeholder="${t('inv_sup_ph')}">
        <datalist id="inv-sups">${(m.suppliers || []).map((s) => `<option value="${esc(s.name)}">`).join('')}</datalist></div>
      <div class="field"><label>${t('date')}</label><input type="date" id="inv-date" value="${esc(d.invoice_date || '')}" required></div>
      <div class="field"><label>${t('inv_number')}</label><input id="inv-no" value="${esc(d.invoice_number || '')}"></div>
      <div class="field"><label>${t('restaurant')}</label><select id="inv-rest">
        ${isAdmin() || rests.length > 1 ? `<option value="">${t('all_restaurants')}</option>` : ''}
        ${rests.map((r) => `<option value="${r.id}" ${String(r.id) === String(restVal) ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
      <div class="field"><label>${t('inv_total')}</label><input id="inv-total" inputmode="decimal" value="${d.total_amount ?? ''}"></div>
    </div>
    <div class="inv-lines-head small muted"><span></span><span>${t('inv_desc')}</span><span>${t('product')}</span><span>kg</span><span>€</span><span></span></div>
    <div id="inv-lines">${items.map(lineHtml).join('')}</div>
    <button type="button" class="btn-sm" id="inv-add">+ ${t('inv_add_line')}</button>
    <div class="note small" style="margin-top:12px">${t('inv_kg_help')}</div>
    <label class="check" style="margin-top:10px"><input type="checkbox" id="inv-upd" checked> ${t('inv_update_prices')}</label>
    <div class="inv-foot"><strong id="inv-sum">${summary()}</strong>
      <div class="modal-actions" style="margin:0"><button type="button" data-close>${t('cancel')}</button>
      <button type="button" class="btn-primary" id="inv-save">${t('save')}</button></div></div></div>`,
  (card, close) => {
    document.getElementById('modal').onclick = null; // a stray tap outside must not throw away the checked lines
    const linesBox = card.querySelector('#inv-lines');
    const bind = () => {
      linesBox.querySelectorAll('.inv-line').forEach((row) => {
        const i = Number(row.dataset.i);
        row.querySelectorAll('[data-f]').forEach((inp) => {
          const f = inp.dataset.f;
          const upd = () => {
            items[i][f] = f === 'include' ? inp.checked : f === 'product_id' ? (Number(inp.value) || null) : inp.value;
            if (f === 'include') row.classList.toggle('off', !inp.checked);
            if (f === 'quantity_kg' || f === 'line_total') {
              const kg = n(items[i].quantity_kg); const tot = n(items[i].line_total);
              row.querySelector('.inv-ppk').textContent = kg > 0 && tot > 0 ? fmt.money(tot / kg, 2) + '/kg' : '';
            }
            card.querySelector('#inv-sum').textContent = summary();
          };
          inp.oninput = upd; inp.onchange = upd;
        });
      });
    };
    bind();
    card.querySelector('#inv-add').onclick = () => {
      items.push(blankLine());
      linesBox.insertAdjacentHTML('beforeend', lineHtml(items[items.length - 1], items.length - 1));
      bind();
      linesBox.lastElementChild.querySelector('[data-f="description"]').focus();
    };
    const see = card.querySelector('#inv-see');
    if (see) see.onclick = () => openFile(d.file_path);
    card.querySelector('#inv-save').onclick = async (e) => {
      const date = card.querySelector('#inv-date').value;
      if (!date) { toast(t('inv_need_date'), 'error'); return; }
      const rest = card.querySelector('#inv-rest').value;
      if (!rest && !isAdmin() && rests.length > 1) { toast(t('inv_need_rest'), 'error'); return; }
      const inc = items.filter((l) => l.include && (String(l.description || '').trim() || l.product_id));
      if (!inc.length) { toast(t('inv_need_line'), 'error'); return; }
      const sup = card.querySelector('#inv-sup').value.trim();
      const known = (m.suppliers || []).find((s) => s.name.toLowerCase() === sup.toLowerCase());
      const body = {
        restaurant_id: rest ? Number(rest) : null,
        supplier_id: known ? known.id : null, supplier_name: known ? null : sup || null,
        invoice_number: card.querySelector('#inv-no').value.trim() || null, invoice_date: date,
        total_amount: n(card.querySelector('#inv-total').value),
        file_path: d.file_path || null, original_filename: d.original_filename || null, extraction_raw: d.extraction_raw || null,
        update_prices: card.querySelector('#inv-upd').checked,
        items: inc.map((l) => ({ description: String(l.description || '').trim(), product_id: l.product_id || null,
          quantity: l.quantity ?? null, unit: l.unit || null, unit_price: l.unit_price ?? null,
          quantity_kg: n(l.quantity_kg), line_total: n(l.line_total), confidence: l.confidence ?? null })),
      };
      e.target.disabled = true;
      try {
        const r = editId ? (await api(`/invoices/${editId}`, { method: 'PATCH', body })).data : (await api('/invoices', { method: 'POST', body })).data;
        close();
        toast(t('inv_saved', { a: r.priced, b: r.revalued }));
        if (!known && sup) { try { await loadMeta(); } catch { /* list refreshes next time */ } }
        done && done();
      } catch (err) { toastError(err); e.target.disabled = false; }
    };
  });
}
