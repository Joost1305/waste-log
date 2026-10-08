// Import products from Excel or CSV: pick a file, check how the columns are read, import.
// Imported products appear in "What is thrown away?" and are offered to the AI photo recognition.
import { state, api, esc, fmt, toast, toastError, openModal, loadMeta } from './core.js';
import { t } from './i18n.js';
import { readSheet } from './xlsx-read.js';
import { buildXlsx, downloadBlob } from './xlsx.js';

const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Which header words point to which field (English and Dutch, as people write them in practice)
const HEADERS = {
  name_en: ['english', 'engels', 'name en', 'name_en', 'naam en', 'name (en)'],
  name: ['product', 'name', 'naam', 'artikel', 'omschrijving', 'description', 'item', 'ingredient'],
  category: ['category', 'categorie', 'groep', 'group', 'productgroep', 'type', 'soort'],
  price: ['purchase', 'inkoop', 'price', 'prijs', 'cost', 'kostprijs'],
  sales: ['sales', 'verkoop', 'selling'],
  supplier: ['supplier', 'leverancier', 'vendor', 'groothandel'],
};
const FIELDS = ['name_en', 'name', 'category', 'price', 'sales', 'supplier'];

// Words that hint at a category, checked in the category column first and then in the product name
const HINTS = {
  meat: ['vlees', 'meat', 'kip', 'chicken', 'rund', 'beef', 'varken', 'pork', 'lam', 'lamb', 'gehakt', 'ham', 'spek', 'bacon', 'worst', 'sausage', 'eend', 'duck', 'kalkoen', 'turkey', 'wild', 'gevogelte', 'poultry', 'kalf', 'veal'],
  fish: ['vis', 'fish', 'zalm', 'salmon', 'kabeljauw', 'cod', 'garnaal', 'shrimp', 'prawn', 'mossel', 'mussel', 'tonijn', 'tuna', 'schaal', 'seafood', 'oester', 'oyster', 'makreel', 'haring'],
  dairy: ['zuivel', 'dairy', 'kaas', 'cheese', 'melk', 'milk', 'room', 'cream', 'boter', 'butter', 'yoghurt', 'yogurt', 'ei', 'eieren', 'egg', 'kwark'],
  bread: ['brood', 'bread', 'bakery', 'banket', 'croissant', 'stokbrood', 'baguette', 'bol', 'pastry', 'cake', 'taart'],
  starch: ['aardappel', 'potato', 'rijst', 'rice', 'pasta', 'noodle', 'couscous', 'bulgur', 'quinoa', 'friet', 'fries', 'zetmeel', 'starch', 'graan'],
  fruit: ['fruit', 'appel', 'apple', 'peer', 'pear', 'banaan', 'banana', 'citroen', 'lemon', 'limoen', 'lime', 'sinaasappel', 'orange', 'aardbei', 'strawberr', 'bes', 'berr', 'druif', 'grape', 'meloen', 'melon', 'mango', 'ananas'],
  vegetables: ['groente', 'vegetable', 'veg', 'sla', 'lettuce', 'tomaat', 'tomato', 'ui', 'onion', 'wortel', 'carrot', 'kool', 'cabbage', 'paprika', 'pepper', 'courgette', 'spinazie', 'spinach', 'prei', 'leek', 'champignon', 'mushroom', 'komkommer', 'cucumber', 'broccoli', 'bloemkool', 'knoflook', 'garlic', 'kruiden', 'herb', 'biet', 'beet'],
  prepared: ['bereid', 'prepared', 'soep', 'soup', 'saus', 'sauce', 'gerecht', 'dish', 'salade', 'salad', 'buffet'],
};

function guessColumns(header) {
  const map = {};
  const h = header.map(norm);
  for (const f of FIELDS) {
    const i = h.findIndex((x, idx) => x && !Object.values(map).includes(idx) && HEADERS[f].some((w) => x.includes(w)));
    if (i >= 0) map[f] = i;
  }
  // "verkoopprijs" contains "prijs": make sure purchase price does not grab the sales column
  if (map.price !== undefined && map.price === map.sales) delete map.price;
  if (map.name === undefined) map.name = 0;
  return map;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).replace(/[€$£\s]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export async function openProductImport(onDone) {
  let factors;
  try { factors = (await api('/co2-factors')).data; } catch (e) { toastError(e); return; }
  const cats = state.meta.waste_categories;
  const other = cats.find((c) => c.code === 'other') || cats[cats.length - 1];
  const byWord = new Map();
  factors.forEach((f) => { [f.code, ...Object.values(f.labels || {})].forEach((w) => byWord.set(norm(w), f.id)); });

  const matchCategory = (catCell, name) => {
    const c = norm(catCell);
    if (c && byWord.has(c)) return byWord.get(c);
    for (const text of [c, norm(name)]) {
      if (!text) continue;
      for (const [code, words] of Object.entries(HINTS)) {
        if (words.some((w) => text.split(/[^a-z0-9]+/).some((tok) => tok === w || (w.length >= 3 && tok.startsWith(w))))) {
          const cat = cats.find((x) => x.code === code);
          if (cat) return cat.id;
        }
      }
    }
    return null;
  };

  let rows = []; let header = []; let map = {}; let fileName = '';

  openModal(`
    <h2>${t('imp_title')}</h2>
    <p class="muted small">${t('imp_sub')}</p>
    <div class="field"><input type="file" id="imp-file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"></div>
    <p class="small"><button type="button" class="link-btn" id="imp-template">${t('imp_template')}</button></p>
    <div id="imp-body"></div>
    <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button>
      <button type="button" class="btn-primary" id="imp-go" disabled>${t('imp_go')}</button></div>`,
  (card, close) => {
    const body = card.querySelector('#imp-body');
    const go = card.querySelector('#imp-go');
    card.querySelector('#imp-template').onclick = () => downloadBlob(buildXlsx([{ name: t('set_products'), rows: [
      [t('imp_col_name'), t('imp_col_name_en'), t('imp_col_category'), t('imp_col_price'), t('imp_col_sales'), t('imp_col_supplier')],
      ['Tomaten', 'Tomatoes', 'Vegetables', 3.2, null, 'Fresh Farms'], ['Kipdij', 'Chicken thigh', 'Meat', 8.9, null, 'Butcher Jansen'], ['Desembrood', 'Sourdough bread', 'Bread & bakery', 4.5, null, ''],
    ] }]), 'wastelog-products-template.xlsx');

    const parsed = () => {
      const existing = new Set(state.meta.products.map((p) => norm(p.name_nl || p.name)));
      const seen = new Set();
      const defCat = Number(card.querySelector('#imp-defcat')?.value) || other.id;
      return rows.map((r) => {
        const name = r[map.name] == null ? '' : String(r[map.name]).trim();
        const key = norm(name);
        const catId = matchCategory(map.category !== undefined ? r[map.category] : null, name);
        const out = {
          name, waste_category_id: catId || defCat, guessed: !catId,
          name_en: map.name_en !== undefined && r[map.name_en] != null ? String(r[map.name_en]).trim() : '',
          purchase_price_per_kg: map.price !== undefined ? toNumber(r[map.price]) : null,
          sales_price_per_kg: map.sales !== undefined ? toNumber(r[map.sales]) : null,
          supplier: map.supplier !== undefined && r[map.supplier] != null ? String(r[map.supplier]).trim() : '',
          status: !name ? 'empty' : seen.has(key) ? 'dup' : existing.has(key) ? 'exists' : 'new',
        };
        if (name) seen.add(key);
        return out;
      }).filter((x) => x.status !== 'empty');
    };

    const draw = () => {
      const opts = (sel) => `<option value="">–</option>${header.map((h, i) => `<option value="${i}" ${sel === i ? 'selected' : ''}>${esc(h || `${t('imp_column')} ${i + 1}`)}</option>`).join('')}`;
      const list = parsed();
      const n = { new: list.filter((x) => x.status === 'new').length, exists: list.filter((x) => x.status === 'exists').length };
      const unknown = list.filter((x) => x.guessed && x.status !== 'dup').length;
      const catName = (id) => (cats.find((c) => c.id === id) || {}).label || '';
      body.innerHTML = `
        <div class="note" style="margin:0 0 12px">${esc(fileName)} · ${t('imp_found', { n: list.length })}</div>
        <div class="field-row">${FIELDS.map((f) => `<div class="field"><label>${t('imp_col_' + f)}</label>
          <select data-map="${f}">${opts(map[f])}</select></div>`).join('')}</div>
        <div class="field"><label>${t('imp_defcat')}${unknown ? ` (${unknown})` : ''}</label><select id="imp-defcat">
          ${cats.map((c) => `<option value="${c.id}" ${c.id === (Number(card.dataset.defcat) || other.id) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></div>
        <label class="check small"><input type="checkbox" id="imp-update" ${card.dataset.update === '1' ? 'checked' : ''}> ${t('imp_update', { n: n.exists })}</label>
        <div class="table-wrap" style="max-height:260px;overflow:auto;margin-top:10px"><table><thead><tr>
          <th>${t('imp_col_name')}</th><th>${t('category')}</th><th class="right">${t('price_kg')}</th><th>${t('reg_supplier')}</th><th></th></tr></thead><tbody>
          ${list.slice(0, 60).map((x) => `<tr><td>${esc(x.name)}</td><td>${esc(catName(x.waste_category_id))}${x.guessed ? ' <span class="badge warn">?</span>' : ''}</td>
            <td class="right num">${x.purchase_price_per_kg != null ? fmt.money(x.purchase_price_per_kg, 2) : '–'}</td><td class="small">${esc(x.supplier)}</td>
            <td class="small muted">${x.status === 'new' ? t('imp_new') : x.status === 'exists' ? t('imp_exists') : t('imp_dup')}</td></tr>`).join('')}
          </tbody></table></div>
        ${list.length > 60 ? `<div class="small muted" style="margin-top:6px">${t('imp_more', { n: list.length - 60 })}</div>` : ''}
        <div class="note">${t('imp_price_note')}</div>`;
      body.querySelectorAll('[data-map]').forEach((s) => (s.onchange = () => {
        if (s.value === '') delete map[s.dataset.map]; else map[s.dataset.map] = Number(s.value);
        draw();
      }));
      body.querySelector('#imp-defcat').onchange = (e) => { card.dataset.defcat = e.target.value; draw(); };
      body.querySelector('#imp-update').onchange = (e) => { card.dataset.update = e.target.checked ? '1' : ''; draw(); };
      const upd = card.dataset.update === '1' ? n.exists : 0;
      go.disabled = map.name === undefined || !(n.new || upd);
      go.textContent = upd ? t('imp_go_nu', { n: n.new, u: upd }) : t('imp_go_n', { n: n.new });
    };

    card.querySelector('#imp-file').onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      fileName = file.name;
      body.innerHTML = `<div class="empty"><span class="spinner"></span></div>`;
      try {
        const all = (await readSheet(file)).filter((r) => r.some((c) => c !== null && c !== ''));
        if (all.length < 2) { body.innerHTML = `<div class="note">${t('imp_empty')}</div>`; return; }
        header = all[0].map((h) => (h == null ? '' : String(h)));
        rows = all.slice(1);
        map = guessColumns(header);
        draw();
      } catch (err) {
        body.innerHTML = `<div class="note">${err.code === 'unsupported' ? t('imp_xls') : esc(err.message)}</div>`;
      }
    };

    go.onclick = async () => {
      const list = parsed().filter((x) => x.status !== 'dup');
      go.disabled = true; go.innerHTML = `<span class="spinner"></span>`;
      try {
        const res = (await api('/products/import', { method: 'POST', body: { rows: list, update: card.dataset.update === '1' } })).data;
        await loadMeta();
        close();
        toast(t('imp_done', { c: res.created, u: res.updated, s: res.suppliers_created }));
        if (onDone) onDone();
      } catch (err) { toastError(err); go.disabled = false; go.textContent = t('imp_go'); }
    };
  });
}
