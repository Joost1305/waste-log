// Waste registration for kitchen staff. Target: done in about 10 seconds.
// Photo -> (AI suggestion) -> what -> weight -> reason -> save. Everything else is optional.
import { state, api, app, esc, fmt, toast, toastError, todayIso, $, $$, confirmDialog, openModal } from '../core.js';
import { t } from '../i18n.js';

const LS = { restaurant: 'fw_reg_restaurant', unit: 'fw_reg_unit', recent: 'fw_reg_recent', section: 'fw_reg_section_' };

// Sections are always asked when a restaurant has them (so you can see which counter the waste comes from).
// The leaderboard switch only controls the prevention question, the points and the leaderboard page.
const lbOn = () => !!(state.meta.organization && state.meta.organization.leaderboard_enabled);
const sectionsOf = (rid) => (state.meta.sections || []).filter((x) => x.restaurant_id === rid);
// Read the switch fresh: a phone that has been open for days follows the setting without reloading
async function refreshLeaderboardFlag() {
  try {
    const on = (await api('/leaderboard-enabled')).data;
    if (state.meta.organization && state.meta.organization.leaderboard_enabled !== on) {
      state.meta.organization.leaderboard_enabled = on;
    }
    return on;
  } catch { return lbOn(); }
}
function savedSection(rid) {
  let v = null;
  try { v = Number(localStorage.getItem(LS.section + rid)) || null; } catch { /* private mode */ }
  return sectionsOf(rid).some((x) => x.id === v) ? v : null;
}

let s; // page state

function freshState(keep = {}) {
  const meta = state.meta;
  const saved = Number(localStorage.getItem(LS.restaurant));
  const restaurantId = keep.restaurantId || (meta.restaurants.some((r) => r.id === saved) ? saved : meta.restaurants[0]?.id);
  return {
    restaurantId,
    sectionId: savedSection(restaurantId),
    unit: localStorage.getItem(LS.unit) || 'kg',
    photo: null, // { url, token, uploading, ai: 'thinking'|'done'|'off'|'fail', suggestion }
    productId: null, productName: '', categoryId: null, search: '',
    weight: '', weightSource: 'manual', reasonId: null,
    menuItemId: null, supplierId: null, location: '', moment: defaultMoment(), note: '', when: '',
    saving: false,
  };
}

function defaultMoment() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 22) return 'dinner';
  return 'closing';
}

export async function renderRegister() {
  s = freshState();
  app().className = 'app narrow';
  if (!state.meta.restaurants.length) { app().innerHTML = `<div class="card empty">${t('no_data')}</div>`; return; }
  app().innerHTML = `
    <div class="page-head"><h1>${t('reg_title')}</h1></div>
    <form class="reg" id="reg" novalidate>
      <div id="sec-restaurant"></div>
      <section class="step" id="sec-photo"></section>
      <section class="step" id="sec-what"></section>
      <section class="step" id="sec-weight"></section>
      <section class="step" id="sec-reason"></section>
      <section class="step"><details class="more" id="sec-more"><summary>${t('reg_more')}</summary><div id="more-body"></div></details></section>
      <div class="sticky-save"><button type="submit" class="btn-primary btn-xl" id="save-btn"></button></div>
    </form>
    <section class="card recent" id="sec-today" style="margin-top:18px"></section>`;
  $('#reg').onsubmit = (e) => { e.preventDefault(); save(); };
  renderAll();
  loadToday();
  refreshLeaderboardFlag();
}

function renderAll() {
  renderRestaurant(); renderPhoto(); renderWhat(); renderWeight(); renderReason(); renderMore(); updateSave();
  loadTop();
}

// ------------------------------------------------------------------ restaurant
function renderRestaurant() {
  const list = state.meta.restaurants;
  const el = $('#sec-restaurant');
  const secs = sectionsOf(s.restaurantId);
  el.innerHTML = (list.length > 1 ? `<div class="chips">${list.map((r) =>
    `<button type="button" class="chip ${r.id === s.restaurantId ? 'on' : ''}" data-r="${r.id}">${esc(r.name)}</button>`).join('')}</div>` : '') +
    (secs.length ? `<div class="reg-sections ${s.sectionId ? '' : 'need'}"><div class="small muted">${t('reg_section')}</div><div class="chips">${secs.map((x) =>
      `<button type="button" class="chip ${x.id === s.sectionId ? 'on' : ''}" data-sec="${x.id}">${esc(x.name)}</button>`).join('')}</div></div>` : '');
  $$('[data-r]', el).forEach((b) => (b.onclick = () => {
    s.restaurantId = Number(b.dataset.r);
    s.sectionId = savedSection(s.restaurantId);
    localStorage.setItem(LS.restaurant, String(s.restaurantId));
    renderRestaurant(); renderMore(); renderWhat(); loadToday(); loadTop(); updateSave();
  }));
  $$('[data-sec]', el).forEach((b) => (b.onclick = () => {
    s.sectionId = Number(b.dataset.sec);
    try { localStorage.setItem(LS.section + s.restaurantId, String(s.sectionId)); } catch { /* private mode */ }
    renderRestaurant(); updateSave();
  }));
}

// ------------------------------------------------------------------ photo + AI
function renderPhoto() {
  const el = $('#sec-photo');
  const head = `<div class="step-title"><span class="step-num">1</span>${t('reg_photo')}</div>`;
  if (!s.photo) {
    el.className = 'step';
    el.innerHTML = `${head}
      <div class="photo-btns">
        <label class="photo-btn btn" for="photo-input">&#128247;&nbsp; ${t('reg_photo_take')}</label>
        <label class="photo-btn btn" for="photo-pick">&#128444;&#65039;&nbsp; ${t('reg_photo_pick')}</label>
      </div>
      <input id="photo-input" type="file" accept="image/*" capture="environment" hidden>
      <input id="photo-pick" type="file" accept="image/*" hidden>`;
    // capture opens the camera straight away; the second input has no capture, so the phone offers the photo library
    $$('#photo-input, #photo-pick', el).forEach((i) => (i.onchange = (e) => e.target.files[0] && handlePhoto(e.target.files[0])));
    return;
  }
  const p = s.photo;
  let ai = '';
  if (p.uploading || p.ai === 'thinking') ai = `<div class="ai-card"><span class="spinner"></span> ${t('reg_ai_thinking')}</div>`;
  else if (p.ai === 'done' && p.suggestion) {
    const sg = p.suggestion;
    const cat = state.meta.waste_categories.find((c) => c.id === sg.waste_category_id);
    const applied = s.productId === sg.product_id && s.categoryId === sg.waste_category_id && (sg.product_id || s.productName === sg.product_name);
    ai = `<div class="ai-card"><div class="small muted">${t('reg_ai_suggest')}</div>
      <strong>${esc((state.meta.products.find((x) => x.id === sg.product_id) || {}).name || sg.product_name)}</strong> · ${esc(cat ? cat.label : '')} · ${fmt.pct(sg.confidence * 100)} ${t('reg_ai_sure')}
      ${sg.reason_id ? `<div class="small" style="margin-top:4px">${sg.is_plated_meal ? '&#127869; ' : ''}${t('reason')}: <strong>${esc((state.meta.waste_reasons.find((r) => r.id === sg.reason_id) || {}).label || '')}</strong></div>` : ''}
      ${applied ? '' : `<div style="margin-top:6px"><button type="button" class="btn-sm btn-primary" id="ai-use">${t('reg_ai_use')}</button></div>`}
      <div class="ai-note">${t('reg_ai_note')}</div></div>`;
  } else ai = `<div class="ai-card off">${p.ai === 'off' ? t('reg_ai_off') : t('reg_ai_fail')}</div>`;
  el.className = 'step done';
  el.innerHTML = `${head}<div class="photo-row"><img src="${p.url}" alt="">${ai}</div>
    <div style="margin-top:8px"><button type="button" class="btn-sm btn-ghost" id="photo-remove">${t('reg_remove')}</button></div>`;
  $('#photo-remove').onclick = () => { URL.revokeObjectURL(p.url); s.photo = null; renderPhoto(); updateSave(); };
  const use = $('#ai-use');
  if (use) use.onclick = () => applySuggestion(p.suggestion);
}

function applySuggestion(sg) {
  s.productId = sg.product_id || null;
  s.productName = sg.product_id ? '' : sg.product_name;
  s.categoryId = sg.waste_category_id || null;
  // The AI's reason (e.g. plate waste when it sees a served plate), unless the user already picked one
  if (sg.reason_id && !s.reasonId && state.meta.waste_reasons.some((r) => r.id === sg.reason_id)) s.reasonId = sg.reason_id;
  applyWeight(sg);
  const prod = state.meta.products.find((x) => x.id === s.productId);
  if (prod && prod.default_supplier_id) s.supplierId = prod.default_supplier_id;
  renderPhoto(); renderWhat(); renderWeight(); renderReason(); renderMore(); updateSave();
}

// Fill the weight from the AI (read from a scale display, or estimated) unless the user typed one.
function applyWeight(sg) {
  if (!sg || !sg.suggested_weight_kg || s.weight) return;
  const kg = Number(sg.suggested_weight_kg);
  if (kg < 1) { s.unit = 'g'; s.weight = String(Math.round(kg * 1000)); }
  else { s.unit = 'kg'; s.weight = String(Math.round(kg * 100) / 100).replace('.', ','); }
  s.weightSource = sg.weight_source === 'scale' ? 'scale' : 'estimate';
}

async function resizeImage(file, max = 1280) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
  } finally { URL.revokeObjectURL(url); }
}

async function handlePhoto(file) {
  let blob;
  try { blob = await resizeImage(file); } catch { blob = file; }
  const photo = { url: URL.createObjectURL(blob), uploading: true, ai: 'thinking' };
  s.photo = photo;
  renderPhoto();
  try {
    const form = new FormData();
    form.append('photo', blob, 'photo.jpg');
    const up = (await api('/waste/photo', { method: 'POST', form })).data;
    if (s.photo !== photo) return;
    photo.token = up.photo_path;
    photo.uploading = false;
    renderPhoto(); updateSave();
    const ai = (await api('/waste/photo/identify', { method: 'POST', body: { photo_path: photo.token } })).data;
    if (s.photo !== photo) return;
    if (ai && ai.available === false) { photo.ai = 'off'; renderPhoto(); updateSave(); return; }
    if (ai && ai.ok && ai.suggestion) {
      photo.ai = 'done'; photo.suggestion = ai.suggestion;
      // Pre-fill only if the user hasn't chosen anything yet; never overwrite a user choice.
      if (!s.productId && !s.productName && !s.categoryId) applySuggestion(ai.suggestion);
      else { if (!s.weight) { applyWeight(ai.suggestion); renderWeight(); } renderWhat(); }
    } else photo.ai = 'fail';
  } catch (e) {
    if (s.photo !== photo) return;
    if (!photo.token) { toastError(e); URL.revokeObjectURL(photo.url); s.photo = null; } else photo.ai = 'fail';
  }
  renderPhoto(); updateSave();
}

// ------------------------------------------------------------------ what
// Automatic quick buttons per restaurant, fetched once per restaurant and refreshed after saving
const topCache = new Map();
async function loadTop(force = false) {
  const rid = s.restaurantId;
  if (!rid || (!force && topCache.has(rid))) return;
  try {
    const rows = (await api('/top-products', { query: { restaurant_id: rid } })).data || [];
    topCache.set(rid, rows.map((r) => Number(r.product_id)));
    if (rid === s.restaurantId && !s.search) renderWhat();
  } catch { topCache.set(rid, []); }
}

function recentIds() { try { return JSON.parse(localStorage.getItem(LS.recent) || '[]'); } catch { return []; } }

// Product search as you type: ignores accents and capitals, words in any order ("kip dij" finds
// "Kipdijfilet"), best matches first: name starts with it, then a word starts with it, then anywhere.
// Quick buttons and your recent products go first among equal matches.
const fold = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
let searchIndex = null;
function searchProducts(products, query, recent) {
  if (!searchIndex || searchIndex.list !== products) {
    searchIndex = { list: products, items: products.map((p) => {
      // search the shown name first, and also the other language
      const n = fold(p.name); const all = fold([p.name, p.name_nl, p.name_en].filter(Boolean).join(' '));
      return { p, n, all, words: all.split(/[^a-z0-9]+/).filter(Boolean) };
    }) };
  }
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const rec = new Map(recent.map((id, i) => [id, i]));
  const out = [];
  for (const it of searchIndex.items) {
    let score = 0;
    let ok = true;
    for (const term of terms) {
      if (it.n.startsWith(term)) score += 3;
      else if (it.words.some((w) => w.startsWith(term))) score += 2;
      else if (it.all.includes(term)) score += 1;
      else { ok = false; break; }
    }
    if (!ok) continue;
    if (it.n === fold(query).trim()) score += 10;
    if (it.p.is_quick_pick) score += 1.5;
    if (rec.has(it.p.id)) score += 2 - rec.get(it.p.id) / 20;
    out.push([score, it.n.length, it.p]);
  }
  out.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return out.map((x) => x[2]);
}

function renderWhat() {
  const meta = state.meta;
  const el = $('#sec-what');
  const done = Boolean(s.productId || s.categoryId);
  const q = s.search.trim().toLowerCase();
  let tiles; let autoCount = 0;
  if (q) tiles = searchProducts(meta.products, q, recentIds()).slice(0, 12);
  else {
    // Most registered in this restaurant first, then pinned quick buttons, then this device's recent products
    const byId = (id) => meta.products.find((p) => p.id === id);
    const top = (topCache.get(s.restaurantId) || []).map(byId).filter(Boolean);
    const quick = meta.products.filter((p) => p.is_quick_pick);
    const rec = recentIds().map(byId).filter(Boolean);
    tiles = [...new Set([...top, ...quick, ...rec])].slice(0, 12);
    autoCount = top.length;
  }
  const catLabel = (id) => (meta.waste_categories.find((c) => c.id === id) || {}).label || '';
  const selected = s.productId ? meta.products.find((p) => p.id === s.productId) : null;
  // Products the AI matched to the photo: shown as their own row of tiles, best match first and pre-selected
  const sg = s.photo && s.photo.ai === 'done' && s.photo.suggestion;
  const photoTiles = !q && sg ? (sg.candidates || []).map((c) => meta.products.find((p) => p.id === c.id)).filter(Boolean) : [];
  if (photoTiles.length) tiles = tiles.filter((p) => !photoTiles.includes(p)).slice(0, 8);
  const tileHtml = (p) => `<button type="button" class="tile ${p.id === s.productId ? 'on' : ''}" data-p="${p.id}">
      ${esc(p.name)}<span class="sub">${esc(catLabel(p.waste_category_id))}</span></button>`;
  // The chosen product's name appears in the search line; typing there starts a new search
  const choiceName = selected ? selected.name : (s.productName || '');
  const showChoice = !s.search && Boolean(choiceName);
  el.className = `step ${done ? 'done' : ''}`;
  el.innerHTML = `
    <div class="step-title"><span class="step-num">2</span>${t('reg_what')}</div>
    <div class="field"><input type="search" id="what-search" class="${showChoice ? 'has-choice' : ''}" placeholder="${t('reg_search')}"
      value="${esc(showChoice ? choiceName : s.search)}" autocomplete="off"></div>
    ${photoTiles.length ? `<div class="small muted" style="margin:-4px 0 8px">&#128247; ${t('reg_photo_matches')}</div>
      <div class="tiles photo-tiles">${photoTiles.map(tileHtml).join('')}</div>
      <div style="height:14px"></div>` : ''}
    ${!q && autoCount ? `<div class="small muted" style="margin:-4px 0 8px">${t('reg_top_hint')}</div>` : ''}
    <div class="tiles">${tiles.map(tileHtml).join('')}
      ${q && !tiles.some((p) => fold(p.name) === fold(q)) ? `<button type="button" class="tile" id="free-text">“${esc(s.search.trim())}”<span class="sub">${t('reg_free_text')}</span></button>` : ''}
    </div>
    ${!s.productId ? `<div style="margin-top:12px"><div class="small muted" style="margin-bottom:6px">${t('reg_or_category')}</div>
      <div class="chips">${meta.waste_categories.map((c) =>
        `<button type="button" class="chip ${c.id === s.categoryId ? 'on' : ''}" data-c="${c.id}">${esc(c.label)}</button>`).join('')}</div></div>` : ''}
    ${done ? `<div class="selected-line">${t('reg_selected')}: <strong>${esc(selected ? selected.name : (s.productName || ''))}</strong>
      ${selected || s.productName ? ' · ' : ''}${esc(catLabel(selected ? selected.waste_category_id : s.categoryId))}</div>` : ''}`;
  const search = $('#what-search');
  // Tapping the line while it shows the chosen product selects the text, so typing replaces it
  search.onfocus = () => { if (search.classList.contains('has-choice')) search.select(); };
  search.oninput = () => {
    s.search = search.value;
    // Emptying the line clears the choice
    if (!search.value && (s.productId || s.productName)) { s.productId = null; s.productName = ''; s.categoryId = null; updateSave(); renderPhoto(); }
    const pos = search.selectionStart; renderWhat(); const n = $('#what-search'); n.focus(); n.setSelectionRange(pos, pos);
  };
  $$('[data-p]', el).forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.p);
    if (s.productId === id) { s.productId = null; s.categoryId = null; }
    else {
      const p = meta.products.find((x) => x.id === id);
      s.productId = id; s.productName = ''; s.categoryId = p.waste_category_id;
      if (p.default_supplier_id) s.supplierId = p.default_supplier_id;
    }
    s.search = '';
    renderWhat(); renderMore(); updateSave(); renderPhoto();
  }));
  $$('[data-c]', el).forEach((b) => (b.onclick = () => {
    const id = Number(b.dataset.c);
    s.categoryId = s.categoryId === id ? null : id;
    renderWhat(); updateSave(); renderPhoto();
  }));
  const free = $('#free-text');
  if (free) free.onclick = () => { s.productId = null; s.productName = s.search.trim(); s.search = ''; renderWhat(); updateSave(); };
}

// ------------------------------------------------------------------ weight
function renderWeight() {
  const el = $('#sec-weight');
  const done = Number(String(s.weight).replace(',', '.')) > 0;
  el.className = `step ${done ? 'done' : ''}`;
  el.innerHTML = `
    <div class="step-title"><span class="step-num">3</span>${t('reg_weight')}</div>
    <div class="weight-row">
      <input id="weight" type="text" inputmode="decimal" autocomplete="off" placeholder="0" value="${esc(s.weight)}" aria-label="${t('reg_weight')}">
      <div class="unit-toggle">${['g', 'kg'].map((u) => `<button type="button" class="${s.unit === u ? 'on' : ''}" data-u="${u}">${u}</button>`).join('')}</div>
    </div>
    <div id="weight-note"></div>`;
  renderWeightNote();
  const w = $('#weight');
  w.oninput = () => {
    w.value = w.value.replace(/[^0-9.,]/g, '');
    s.weight = w.value;
    s.weightSource = 'manual';          // typed or corrected by the user
    renderWeightNote();
    el.classList.toggle('done', Number(s.weight.replace(',', '.')) > 0);
    updateSave();
  };
  $$('[data-u]', el).forEach((b) => (b.onclick = () => {
    if (b.dataset.u !== s.unit) s.weightSource = 'manual';
    s.unit = b.dataset.u; localStorage.setItem(LS.unit, s.unit); renderWeight(); updateSave();
  }));
}

function renderWeightNote() {
  const n = $('#weight-note');
  if (!n) return;
  n.innerHTML = s.weightSource === 'estimate' && s.weight
    ? `<div class="weight-note estimate">${t('reg_w_estimate')}</div>`
    : s.weightSource === 'scale' && s.weight ? `<div class="weight-note scale">${t('reg_w_scale')}</div>` : '';
}

// ------------------------------------------------------------------ reason
function renderReason() {
  const el = $('#sec-reason');
  el.className = `step ${s.reasonId ? 'done' : ''}`;
  el.innerHTML = `<div class="step-title"><span class="step-num">4</span>${t('reg_reason')}</div>
    <div class="tiles">${state.meta.waste_reasons.map((r) =>
      `<button type="button" class="tile ${r.id === s.reasonId ? 'on' : ''}" data-reason="${r.id}">${esc(r.label)}</button>`).join('')}</div>`;
  $$('[data-reason]', el).forEach((b) => (b.onclick = () => { s.reasonId = Number(b.dataset.reason); renderReason(); updateSave(); }));
}

// ------------------------------------------------------------------ more details
function renderMore() {
  const meta = state.meta;
  const menu = meta.menu_items.filter((m) => !m.restaurant_id || m.restaurant_id === s.restaurantId);
  const opt = (list, cur, lab = (x) => x.name) => `<option value="">${t('none')}</option>` +
    list.map((x) => `<option value="${x.id ?? x}" ${String(x.id ?? x) === String(cur ?? '') ? 'selected' : ''}>${esc(lab(x))}</option>`).join('');
  $('#more-body').innerHTML = `
    <div class="field-row">
      <div class="field"><label>${t('reg_menu_item')}</label><select id="m-menu">${opt(menu, s.menuItemId)}</select></div>
      <div class="field"><label>${t('reg_supplier')}</label><select id="m-supplier">${opt(meta.suppliers, s.supplierId)}</select></div>
      <div class="field"><label>${t('reg_location')}</label><select id="m-location">${opt(meta.locations, s.location, (x) => t('loc_' + x))}</select></div>
      <div class="field"><label>${t('reg_moment')}</label><select id="m-moment">${opt(meta.moments, s.moment, (x) => t('mom_' + x))}</select></div>
    </div>
    <div class="field"><label>${t('reg_note')}</label><input id="m-note" maxlength="1000" value="${esc(s.note)}"></div>
    <div class="field"><label>${t('reg_when')}</label><input id="m-when" type="datetime-local" value="${esc(s.when)}" max="${todayIso()}T23:59"></div>`;
  $('#m-menu').onchange = (e) => (s.menuItemId = e.target.value ? Number(e.target.value) : null);
  $('#m-supplier').onchange = (e) => (s.supplierId = e.target.value ? Number(e.target.value) : null);
  $('#m-location').onchange = (e) => (s.location = e.target.value);
  $('#m-moment').onchange = (e) => (s.moment = e.target.value);
  $('#m-note').oninput = (e) => (s.note = e.target.value);
  $('#m-when').onchange = (e) => (s.when = e.target.value);
}

// ------------------------------------------------------------------ save
function weightNumber() { return Number(String(s.weight).replace(',', '.')); }

function missing() {
  const m = [];
  if (sectionsOf(s.restaurantId).length && !s.sectionId) m.push(t('reg_section_short'));
  if (!s.productId && !s.categoryId) m.push(t('product'));
  if (!(weightNumber() > 0)) m.push(t('weight'));
  if (!s.reasonId) m.push(t('reason'));
  return m;
}

function updateSave() {
  const b = $('#save-btn');
  if (!b) return;
  const m = missing();
  const w = weightNumber();
  b.disabled = m.length > 0 || s.saving || (s.photo && s.photo.uploading);
  b.innerHTML = s.saving ? `<span class="spinner"></span>` : m.length
    ? t('reg_save')
    : `${t('reg_save')} · ${fmt.kg(s.unit === 'g' ? w / 1000 : w, 2)}`;
  // The bar only sticks to the bottom once everything is filled in; until then the next open step is highlighted.
  const bar = b.closest('.sticky-save');
  if (bar) bar.classList.toggle('ready', !m.length);
  markNextStep();
}

function markNextStep() {
  const steps = [
    [$('#sec-restaurant .reg-sections'), !(sectionsOf(s.restaurantId).length && !s.sectionId)],
    // The photo comes first, but stops being the next step as soon as someone skips it and fills in anything else
    [$('#sec-photo'), !!s.photo || !!(s.productId || s.categoryId || s.productName || weightNumber() > 0 || s.reasonId)],
    [$('#sec-what'), !!(s.productId || s.categoryId)],
    [$('#sec-weight'), weightNumber() > 0],
    [$('#sec-reason'), !!s.reasonId],
  ].filter(([el]) => el);
  const next = steps.find(([, ok]) => !ok);
  steps.forEach(([el]) => el.classList.toggle('next', !!next && el === next[0]));
}

async function save() {
  if (missing().length || s.saving) return;
  s.saving = true; updateSave();
  const body = {
    restaurant_id: s.restaurantId,
    section_id: sectionsOf(s.restaurantId).length ? s.sectionId : null,
    product_id: s.productId,
    product_name: s.productId ? null : (s.productName || null),
    waste_category_id: s.categoryId,
    reason_id: s.reasonId,
    weight: weightNumber(),
    unit: s.unit,
    menu_item_id: s.menuItemId,
    supplier_id: s.supplierId,
    location: s.location || null,
    moment: s.moment || null,
    note: s.note || null,
    photo_path: s.photo && s.photo.token ? s.photo.token : null,
    weight_source: s.weightSource,
  };
  // Store the AI suggestion and whether the user accepted it (measures AI accuracy later)
  const sg = s.photo && s.photo.suggestion;
  if (sg) {
    body.ai_suggestion = sg;
    body.ai_accepted = sg.waste_category_id === s.categoryId && (!sg.product_id || sg.product_id === s.productId);
  }
  if (s.when) body.recorded_at = new Date(s.when).toISOString();
  try {
    const rec = (await api('/waste', { method: 'POST', body })).data;
    if (s.productId) {
      const ids = [s.productId, ...recentIds().filter((x) => x !== s.productId)].slice(0, 6);
      localStorage.setItem(LS.recent, JSON.stringify(ids));
    }
    const catName = (state.meta.waste_categories.find((c) => c.id === rec.waste_category_id) || {}).label || '';
    toast(`${t('reg_saved')}: ${fmt.kg(rec.weight_kg, 2)} ${rec.product_name || catName} (${fmt.money(rec.purchase_value, 2)})`);
    if (s.photo) URL.revokeObjectURL(s.photo.url);
    s = freshState({ restaurantId: s.restaurantId });
    $('#sec-more').open = false;
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadToday(); loadTop(true);
    if (lbOn() && await refreshLeaderboardFlag()) askPrevention(rec);
  } catch (e) {
    s.saving = false; updateSave(); toastError(e);
  }
}

// ------------------------------------------------------------------ prevention question (leaderboard on)
function askPrevention(rec) {
  const sec = (state.meta.sections || []).find((x) => x.id === rec.section_id);
  const hints = ['prev_hint_batch', 'prev_hint_fifo', 'prev_hint_order', 'prev_hint_portion', 'prev_hint_store'];
  openModal(`<h2>${t('prev_q')}</h2>
    <p class="small muted">${sec ? t('prev_sub_section', { s: esc(sec.name) }) : t('prev_sub')}</p>
    <div class="chips" style="margin-bottom:10px">${hints.map((h) => `<button type="button" class="chip" data-hint="${h}">${t(h)}</button>`).join('')}</div>
    <form id="prev-form"><div class="field"><textarea name="text" rows="3" maxlength="500" placeholder="${t('prev_ph')}"></textarea></div>
      <div class="err" id="prev-err"></div>
      <div class="modal-actions"><button type="button" data-close>${t('prev_skip')}</button><button class="btn-primary" id="prev-send">${t('prev_send')}</button></div></form>`,
  (card, close) => {
    const ta = card.querySelector('textarea');
    $$('[data-hint]', card).forEach((b) => (b.onclick = () => { ta.value = ta.value ? `${ta.value.replace(/\s+$/, '')} ${t(b.dataset.hint)}` : t(b.dataset.hint); ta.focus(); }));
    card.querySelector('#prev-form').onsubmit = async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (text.length < 3) { card.querySelector('#prev-err').textContent = t('prev_short'); return; }
      card.querySelector('#prev-send').disabled = true;
      try {
        await api('/prevention-ideas', { method: 'POST', body: { waste_record_id: rec.id, text } });
        close(); toast(t('prev_thanks'));
      } catch (err) { card.querySelector('#prev-err').textContent = err.message; card.querySelector('#prev-send').disabled = false; }
    };
  });
}

// ------------------------------------------------------------------ today
async function loadToday() {
  const el = $('#sec-today');
  if (!el) return;
  try {
    const res = await api('/waste', { query: { mine: '1', from: todayIso(), to: todayIso(), restaurant_id: s.restaurantId, limit: 50 } });
    const rows = res.data;
    el.innerHTML = `<h2>${t('reg_today')} <span class="muted small">· ${fmt.kg(res.meta.total_kg, 1)} · ${fmt.money(res.meta.total_value, 2)}</span></h2>
      ${rows.length ? `<ul>${rows.map((r) => `<li><div><strong>${fmt.kg(r.weight_kg, 2)}</strong> ${esc(r.product_name || r.category)}
        <div class="small muted">${fmt.time(r.recorded_at)} · ${esc(r.reason)}${r.has_photo ? ' · &#128247;' : ''}</div></div>
        <button class="btn-sm btn-ghost btn-danger" data-del="${r.id}">${t('delete')}</button></li>`).join('')}</ul>`
    : `<p class="muted">${t('reg_nothing_today')}</p>`}`;
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(t('confirm_delete')))) return;
      try { await api(`/waste/${b.dataset.del}`, { method: 'DELETE' }); loadToday(); } catch (e) { toastError(e); }
    }));
  } catch (e) { el.innerHTML = ''; }
}
