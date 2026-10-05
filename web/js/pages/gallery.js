// Photo gallery: waste with a photo, heaviest first. Makes the impact visible at a glance.
// Photos are private; each is shown through a short-lived signed link.
import { state, api, app, esc, fmt, toastError, todayIso, addDaysIso, $, $$, openModal } from '../core.js';
import { t } from '../i18n.js';
import { photoUrls } from '../backend.js';

const PAGE = 24;
let q; let items = []; let total = 0;

export async function renderGallery() {
  const meta = state.meta;
  q = { restaurant_id: '', waste_category_id: '', preset: '28', offset: 0 };
  app().innerHTML = `
    <div class="page-head"><div><h1>${t('gal_title')}</h1><div class="muted small">${t('gal_sub')}</div></div></div>
    <form class="card filters" id="gal-filters">
      ${meta.restaurants.length > 1 ? `<div><label>${t('restaurant')}</label><select name="restaurant_id"><option value="">${t('all_restaurants')}</option>
        ${meta.restaurants.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>${t('period')}</label><select name="preset">
        <option value="7">${t('gal_7')}</option><option value="28" selected>${t('p_4w')}</option>
        <option value="84">${t('p_12w')}</option><option value="all">${t('gal_all')}</option></select></div>
      <div><label>${t('category')}</label><select name="waste_category_id"><option value="">${t('all')}</option>
        ${meta.waste_categories.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('')}</select></div>
    </form>
    <div id="gal-summary" class="muted small" style="margin:14px 2px 10px"></div>
    <div id="gal-grid" class="gallery"></div>
    <div style="text-align:center;margin-top:16px"><button class="hidden" id="gal-more">${t('gal_more')}</button></div>`;
  $('#gal-filters').onchange = (e) => { q[e.target.name] = e.target.value; load(true); };
  $('#gal-more').onclick = () => load(false);
  load(true);
}

async function load(reset) {
  if (reset) { q.offset = 0; items = []; $('#gal-grid').innerHTML = `<div class="card empty"><span class="spinner"></span></div>`; }
  const query = {
    restaurant_id: q.restaurant_id, waste_category_id: q.waste_category_id, limit: PAGE, offset: q.offset,
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
    draw();
  } catch (e) { toastError(e); $('#gal-grid').innerHTML = ''; }
}

function draw() {
  const grid = $('#gal-grid');
  if (!items.length) { grid.innerHTML = `<div class="card empty">${t('gal_empty')}</div>`; $('#gal-more').classList.add('hidden'); return; }
  grid.innerHTML = items.map((r, i) => `
    <button class="gal-card" data-i="${i}" type="button">
      <div class="gal-img">${r.url ? `<img src="${esc(r.url)}" alt="" loading="lazy">` : ''}
        <span class="gal-rank">#${i + 1}</span>
        <span class="gal-weight">${fmt.kg(r.weight_kg, 1)}${r.weight_source === 'estimate' ? ` <small>${t('badge_estimate')}</small>` : ''}</span>
      </div>
      <div class="gal-body">
        <div class="gal-title">${esc(r.product_name || r.category)}</div>
        <div class="small muted"><span class="dot" style="background:${esc(r.category_color || '#999')}"></span>${esc(r.category)} · ${esc(r.reason)}</div>
        <div class="gal-meta small"><span>${fmt.money(r.purchase_value, 2)}</span><span class="muted">${fmt.date(r.recorded_at)}</span></div>
      </div>
    </button>`).join('');
  $('#gal-more').classList.toggle('hidden', items.length >= total);
  $$('[data-i]', grid).forEach((b) => (b.onclick = () => open(items[Number(b.dataset.i)])));
}

function open(r) {
  openModal(`
    ${r.url ? `<img src="${esc(r.url)}" alt="" style="width:100%;border-radius:10px;max-height:60vh;object-fit:contain;background:#000">` : ''}
    <h2 style="margin-top:14px">${fmt.kg(r.weight_kg, 2)} ${esc(r.product_name || r.category)}
      ${r.weight_source === 'estimate' ? `<span class="badge warn">${t('badge_estimate')}</span>` : ''}</h2>
    <div class="muted">${esc(r.category)} · ${esc(r.reason)} · ${esc(r.restaurant_name)}</div>
    <div style="margin-top:8px">${t('value')}: <strong>${fmt.money(r.purchase_value, 2)}</strong> · CO₂-eq: ${fmt.kg(r.co2e_kg, 1)}</div>
    <div class="small muted" style="margin-top:4px">${fmt.dateTime(r.recorded_at)}${r.user_name ? ' · ' + esc(r.user_name) : ''}</div>
    ${r.note ? `<p>${esc(r.note)}</p>` : ''}
    <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
}
