// Missing products: what was typed in, or taken over from the AI, without a product from the list.
// One click adds it as a product (estimated price: median of its category, CO2: category value until set)
// or links it to an existing product. Past registrations with that name are linked too, so price and CO2 follow.
import { state, api, esc, fmt, toast, toastError, openModal, loadMeta, $, $$ } from './core.js';
import { t } from './i18n.js';

function medianPrice(catId) {
  const ps = (state.meta.products || []).filter((p) => p.waste_category_id === catId && Number(p.purchase_price_per_kg) > 0)
    .map((p) => Number(p.purchase_price_per_kg)).sort((a, b) => a - b);
  if (!ps.length) return null;
  const m = Math.floor(ps.length / 2);
  return Math.round((ps.length % 2 ? ps[m] : (ps[m - 1] + ps[m]) / 2) * 100) / 100;
}

export async function openMissingProducts(reload) {
  openModal(`<div class="mp"><h2>${t('mp_title')}</h2><p class="small muted">${t('mp_sub')}</p><div id="mp-list"><span class="spinner"></span></div>
    <div class="modal-actions"><button data-close>${t('close')}</button></div></div>`, async (card) => {
    let rows = [];
    try { rows = (await api('/products-missing', { query: { days: 90 } })).data || []; } catch (e) { toastError(e); return; }
    const meta = state.meta;
    const catOpts = (sel) => meta.waste_categories.map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
    const prodOpts = (meta.products || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    const draw = () => {
      $('#mp-list', card).innerHTML = rows.length ? `<div class="mp-rows">${rows.map((r, i) => `
        <div class="mp-row" data-i="${i}">
          <div class="mp-name"><strong>${esc(r.name)}</strong> ${r.from_ai ? `<span class="badge">${t('mp_ai')}</span>` : ''}
            <div class="small muted">${t('mp_count', { n: r.records })} · ${fmt.kg(Number(r.kg), 1)} · ${fmt.date(r.last)}</div></div>
          <div class="mp-act">
            <div class="mp-line"><input class="mp-new-name" value="${esc(r.name)}" aria-label="${t('name')}">
              <select class="mp-cat" aria-label="${t('category')}">${catOpts(r.waste_category_id)}</select>
              <button type="button" class="btn-sm btn-primary mp-add">+ ${t('mp_add')}</button></div>
            <div class="mp-line"><select class="mp-link-to" aria-label="${t('mp_link')}"><option value="">${t('mp_or_link')}</option>${prodOpts}</select>
              <button type="button" class="btn-sm mp-link">${t('mp_link')}</button></div>
          </div></div>`).join('')}</div>` : `<div class="empty">${t('mp_empty')}</div>`;
      $$('.mp-row', card).forEach((el) => {
        const r = rows[Number(el.dataset.i)];
        const done = async (productId, msgKey) => {
          const res = (await api('/products-missing/link', { method: 'POST', body: { product_id: productId, name: r.name } })).data;
          toast(t(msgKey, { n: res.linked }));
          rows = rows.filter((x) => x !== r); await loadMeta(); draw(); if (reload) reload();
        };
        $('.mp-add', el).onclick = async (e) => {
          e.target.disabled = true;
          const cat = Number($('.mp-cat', el).value);
          const name = $('.mp-new-name', el).value.trim() || r.name;
          const price = medianPrice(cat);
          try {
            const p = (await api('/products', { method: 'POST', body: { name, waste_category_id: cat, purchase_price_per_kg: price, price_estimated: price != null, is_active: true } })).data;
            await done(p.id, 'mp_added');
          } catch (err) { toastError(err); e.target.disabled = false; }
        };
        $('.mp-link', el).onclick = async (e) => {
          const pid = Number($('.mp-link-to', el).value);
          if (!pid) { toast(t('mp_choose'), 'error'); return; }
          e.target.disabled = true;
          try { await done(pid, 'mp_linked'); } catch (err) { toastError(err); e.target.disabled = false; }
        };
      });
    };
    draw();
  });
}
