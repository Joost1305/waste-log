// Photo gallery: waste with a photo, sorted by weight (heaviest or lightest first), by category or by date.
// Photos are private; each is shown through a short-lived signed link.
import { state, api, app, esc, fmt, toast, toastError, todayIso, addDaysIso, $, $$, openModal, confirmDialog, printHeader, printPage } from '../core.js';
import { t } from '../i18n.js';
import { photoUrls } from '../backend.js';
import { showCo2Info } from '../co2.js';

const PAGE = 24;
const SORTS = ['heaviest', 'lightest', 'category', 'newest'];
let q; let items = []; let total = 0;

export async function renderGallery() {
  const meta = state.meta;
  q = { restaurant_id: '', waste_category_id: '', preset: '28', sort: 'heaviest', offset: 0 };
  app().innerHTML = `
    <div id="gal-print-head"></div>
    <div class="page-head"><div><h1>${t('gal_title')}</h1><div class="muted small">${t('gal_sub')}</div></div>
      <div class="page-actions no-print"><button type="button" class="btn-sm" id="gal-print">&#128424; ${t('print')}</button></div></div>
    <form class="card filters no-print" id="gal-filters">
      ${meta.restaurants.length > 1 ? `<div><label>${t('restaurant')}</label><select name="restaurant_id"><option value="">${t('all_restaurants')}</option>
        ${meta.restaurants.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>${t('period')}</label><select name="preset">
        <option value="7">${t('gal_7')}</option><option value="28" selected>${t('p_4w')}</option>
        <option value="84">${t('p_12w')}</option><option value="all">${t('gal_all')}</option></select></div>
      <div><label>${t('category')}</label><select name="waste_category_id"><option value="">${t('all')}</option>
        ${meta.waste_categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></div>
      <div><label>${t('gal_sort')}</label><select name="sort">
        ${SORTS.map((s) => `<option value="${s}" ${s === q.sort ? 'selected' : ''}>${t('sort_' + s)}</option>`).join('')}</select></div>
    </form>
    <div id="gal-summary" class="muted small" style="margin:14px 2px 10px"></div>
    <div id="gal-grid"></div>
    <div style="text-align:center;margin-top:16px" class="no-print"><button class="hidden" id="gal-more">${t('gal_more')}</button></div>`;
  $('#gal-filters').onchange = (e) => { q[e.target.name] = e.target.value; load(true); };
  $('#gal-more').onclick = () => load(false);
  $('#gal-print').onclick = () => printPage();
  load(true);
}

function periodLabel() {
  return { 7: t('gal_7'), 28: t('p_4w'), 84: t('p_12w'), all: t('gal_all') }[q.preset];
}

async function load(reset) {
  if (reset) { q.offset = 0; items = []; $('#gal-grid').innerHTML = `<div class="card empty"><span class="spinner"></span></div>`; }
  const query = {
    restaurant_id: q.restaurant_id, waste_category_id: q.waste_category_id, limit: PAGE, offset: q.offset, sort: q.sort,
    from: q.preset === 'all' ? '' : addDaysIso(todayIso(), -(Number(q.preset) - 1)), to: todayIso(),
  };
  try {
    const res = await api('/gallery', { query });
    total = res.meta.total;
    const rows = res.data;
    const urls = await photoUrls(rows.map((r) => r.photo_path));
    rows.forEach((r) => { r.url = urls[r.photo_path]; });
    items = items.concat(rows);
    q.offset += rows.length;
    $('#gal-summary').innerHTML = total
      ? `${fmt.num(total)} ${t('gal_photos')} · <strong>${fmt.kg(res.meta.total_kg)}</strong> · ${fmt.money(res.meta.total_value)}`
      : '';
    const rest = q.restaurant_id ? (state.meta.restaurants.find((r) => r.id === Number(q.restaurant_id)) || {}).name : t('all_restaurants');
    $('#gal-print-head').innerHTML = printHeader(t('gal_title'), `${rest} · ${periodLabel()} · ${t('sort_' + q.sort)}`);
    draw();
  } catch (e) { toastError(e); $('#gal-grid').innerHTML = ''; }
}

function card(r, i, rank) {
  return `
    <button class="gal-card" data-i="${i}" type="button">
      <div class="gal-img">${r.url ? `<img src="${esc(r.url)}" alt="" loading="lazy">` : ''}
        ${rank ? `<span class="gal-rank">#${rank}</span>` : ''}
        <span class="gal-weight">${fmt.kg(r.weight_kg, 1)}${r.weight_source === 'estimate' ? ` <small>${t('badge_estimate')}</small>` : ''}</span>
      </div>
      <div class="gal-body">
        <div class="gal-title">${esc(r.product_name || r.category)}</div>
        <div class="small muted"><span class="dot" style="background:${esc(r.category_color || '#999')}"></span>${esc(r.category)} · ${esc(r.reason)}</div>
        <div class="gal-meta small"><span>${fmt.money(r.purchase_value, 2)}</span><span class="muted">${fmt.date(r.recorded_at)}</span></div>
      </div>
    </button>`;
}

function draw() {
  const grid = $('#gal-grid');
  if (!items.length) { grid.innerHTML = `<div class="card empty">${t('gal_empty')}</div>`; $('#gal-more').classList.add('hidden'); return; }
  const ranked = q.sort === 'heaviest' || q.sort === 'lightest';
  if (q.sort === 'category') {
    // One block per category, heaviest first inside each block
    const groups = [];
    items.forEach((r, i) => {
      let g = groups[groups.length - 1];
      if (!g || g.id !== r.waste_category_id) { g = { id: r.waste_category_id, name: r.category, color: r.category_color, list: [] }; groups.push(g); }
      g.list.push([r, i]);
    });
    grid.innerHTML = groups.map((g) => {
      const kg = g.list.reduce((a, [r]) => a + Number(r.weight_kg), 0);
      return `<section class="gal-group"><h2 class="gal-group-head"><span class="dot" style="background:${esc(g.color || '#999')}"></span>${esc(g.name)}
        <span class="muted small">${g.list.length} · ${fmt.kg(kg)}</span></h2>
        <div class="gallery">${g.list.map(([r, i], k) => card(r, i, k + 1)).join('')}</div></section>`;
    }).join('');
  } else {
    grid.innerHTML = `<div class="gallery">${items.map((r, i) => card(r, i, ranked ? i + 1 : null)).join('')}</div>`;
  }
  $('#gal-more').classList.toggle('hidden', items.length >= total);
  $$('[data-i]', grid).forEach((b) => (b.onclick = () => open(items[Number(b.dataset.i)])));
}

function canDelete(r) {
  return state.meta.permissions.edit_any_waste
    || (r.user_id === state.user.id && r.created_at && r.created_at.slice(0, 10) === todayIso());
}

function open(r) {
  openModal(`
    ${r.url ? `<img src="${esc(r.url)}" alt="" style="width:100%;border-radius:10px;max-height:60vh;object-fit:contain;background:#000">` : ''}
    <h2 style="margin-top:14px">${fmt.kg(r.weight_kg, 2)} ${esc(r.product_name || r.category)}
      ${r.weight_source === 'estimate' ? `<span class="badge warn">${t('badge_estimate')}</span>` : ''}</h2>
    <div class="muted">${esc(r.category)} · ${esc(r.reason)} · ${esc(r.restaurant_name)}</div>
    <div style="margin-top:8px">${t('value')}: <strong>${fmt.money(r.purchase_value, 2)}</strong> ·
      <button type="button" class="link-btn" id="gal-co2" title="${t('co2_hint')}">CO₂-eq: ${fmt.kg(r.co2e_kg, 1)} <span class="info-i" aria-hidden="true">i</span></button></div>
    <div class="small muted" style="margin-top:4px">${fmt.dateTime(r.recorded_at)}${r.user_name ? ' · ' + esc(r.user_name) : ''}</div>
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <div class="modal-actions">
      ${canDelete(r) ? `<button type="button" class="btn-ghost btn-danger" id="gal-del" style="margin-right:auto">${t('delete')}</button>` : ''}
      <button data-close>${t('close')}</button></div>`,
  (card, close) => {
    card.querySelector('#gal-co2').onclick = () => { close(); showCo2Info(r); };
    const del = card.querySelector('#gal-del');
    if (del) del.onclick = async () => {
      close();
      if (!(await confirmDialog(t('confirm_delete_one')))) return;
      try { await api(`/waste/${r.id}`, { method: 'DELETE' }); toast(t('deleted_n', { n: 1 })); load(true); } catch (e) { toastError(e); }
    };
  });
}
