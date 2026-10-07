// Excel exports: dashboard (summary + all records of the period), records list, and everything.
// All data comes through the normal API, so Row Level Security decides what ends up in the file.
import { state, api, toast, toastError, todayIso } from './core.js';
import { t } from './i18n.js';
import { buildXlsx, downloadBlob } from './xlsx.js';

const n = (v, fmt) => ({ n: v == null ? null : Number(v), fmt });
const kg = (v) => n(v, 'dec2');
const money = (v) => n(v, 'money');
const pct = (v) => n(v, 'pct');
const yesNo = (b) => (b == null ? '' : b ? t('yes') : t('no'));

function slug(s) {
  return String(s || 'export').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function fileName(parts) {
  return `wastelog-${parts.filter(Boolean).map(slug).join('-')}.xlsx`;
}
const restaurantName = (id) => (id ? (state.meta.restaurants.find((r) => r.id === Number(id)) || {}).name : t('all_restaurants'));

function recordsSheet(records) {
  const cur = state.meta.organization?.currency || 'EUR';
  return {
    name: t('sh_records'),
    rows: [
      ['ID', t('date'), t('restaurant'), t('product'), t('category'), t('subcategory'), t('reason'), t('reg_menu_item'), t('reg_supplier'),
        t('reg_location'), t('reg_moment'), `${t('weight')} (kg)`, t('weight_source'), t('valuation'), `${t('unit_cost')} (${cur})`,
        `${t('value')} (${cur})`, `${t('potential_sales')} (${cur})`, t('co2_factor'), t('co2_kg'), t('has_photo'), t('ai_accepted'),
        t('user'), t('reg_note'), 'Demo'],
      ...records.map((r) => [
        r.id, { date: r.recorded_local }, r.restaurant, r.product, r.category, r.subcategory, r.reason, r.dish, r.supplier,
        r.location ? t('loc_' + r.location) : '', r.moment ? t('mom_' + r.moment) : '', n(r.weight_kg, 'dec3'),
        t('ws_' + (r.weight_source || 'manual')), t('val_' + r.valuation_method), money(r.unit_cost_per_kg), money(r.purchase_value),
        money(r.potential_sales_value), n(r.co2e_per_kg, 'dec2'), kg(r.co2e_kg), yesNo(r.has_photo), yesNo(r.ai_accepted),
        r.user, r.note, r.is_demo ? 'demo' : '']),
    ],
  };
}

function coversSheet(covers) {
  return { name: t('sh_guests'), rows: [[t('date'), t('restaurant'), t('guests')], ...covers.map((c) => [{ date: c.date }, c.restaurant, c.guests])] };
}

function filterSheet(lines) {
  return {
    name: t('filters_label'),
    rows: [[t('filters_label'), ''], ...lines, [t('generated'), { date: new Date().toLocaleString('sv-SE').replace(' ', 'T') }],
      [t('set_org'), state.meta.organization?.name || '']],
    widths: [28, 50],
  };
}

function dashboardSheets(d) {
  const T = d.totals; const tg = d.target;
  const cur = state.meta.organization?.currency || 'EUR';
  const summary = [
    [t('sh_summary'), ''],
    [t('set_org'), state.meta.organization?.name || ''],
    [t('period'), `${d.period.from} – ${d.period.to}`],
    [t('kpi_records'), T.records],
    [`${t('kpi_total')} (kg)`, kg(T.kg)],
    [`${t('kpi_cost')} (${cur})`, money(T.value)],
    [`${t('kpi_per_guest')} (g)`, n(T.g_per_guest, 'dec1')],
    [t('guests'), T.guests],
    [t('co2_kg'), kg(T.co2e_kg)],
    [`kg ${t('per_day')}`, kg(T.kg_per_day)],
    [`${t('vs_prev')} (%)`, pct(T.change_kg_pct)],
  ];
  if (tg) {
    summary.push(['', ''], [t('target'), tg.name], [t('period_label'), t('period_' + (tg.period || 'month'))],
      [`${t('baseline')} (kg ${t('per_' + (tg.period || 'month'))})`, kg(tg.baseline_kg)],
      [`${t('goal')} (kg ${t('per_' + (tg.period || 'month'))})`, kg(tg.target_kg)],
      [`${t('win_' + (tg.period || 'month'))} (kg)`, kg(tg.current_kg)],
      [`${t('progress')} (%)`, pct(tg.progress_pct)], [t('target_reached'), yesNo(tg.achieved)]);
  }
  const simple = (name, head, rows) => ({ name, rows: [head, ...rows] });
  return [
    { name: t('sh_summary'), rows: summary, widths: [34, 40] },
    simple(t('sh_weekly'), [t('date'), 'kg', `${t('value')} (${cur})`, t('guests'), t('g_per_guest')],
      d.trend.map((x) => [{ date: x.week }, kg(x.kg), money(x.value), x.guests, n(x.guests ? (x.kg * 1000) / x.guests : null, 'dec1')])),
    simple(t('by_category'), [t('category'), 'kg', `${t('value')} (${cur})`, t('co2_kg'), t('records'), '%'],
      d.by_category.map((r) => [r.name, kg(r.kg), money(r.value), kg(r.co2e_kg), r.records, pct(T.kg ? (r.kg / T.kg) * 100 : null)])),
    simple(t('by_reason'), [t('reason'), 'kg', `${t('value')} (${cur})`, t('records'), '%'],
      d.by_reason.map((r) => [r.name, kg(r.kg), money(r.value), r.records, pct(T.kg ? (r.kg / T.kg) * 100 : null)])),
    simple(t('by_outlet'), [t('restaurant'), 'kg', `${t('value')} (${cur})`, t('guests'), t('g_per_guest')],
      d.by_restaurant.map((r) => [r.name, kg(r.kg), money(r.value), r.guests, n(r.g_per_guest, 'dec1')])),
    simple(t('by_supplier'), [t('reg_supplier'), `${t('wasted')} (kg)`, `${t('purchased')} (kg)`, `${t('waste_rate')} (%)`],
      d.by_supplier.map((r) => [r.name, kg(r.kg), kg(r.purchased_kg || null), pct(r.waste_rate_pct)])),
    simple(t('by_menu'), [t('reg_menu_item'), `${t('wasted')} (kg)`, `${t('produced')} (${t('portions')})`, `${t('waste_rate')} (%)`],
      d.by_menu_item.map((r) => [r.name, kg(r.kg), r.portions_produced || null, pct(r.waste_rate_pct)])),
    simple(t('top_products'), [t('product'), 'kg', `${t('value')} (${cur})`, t('records')],
      d.top_products.map((r) => [r.name, kg(r.kg), money(r.value), r.records])),
  ];
}

async function run(fn) {
  toast(t('exporting'));
  try {
    const out = await fn();
    if (out === false) { toast(t('export_none')); return; }
    toast(t('export_ready'));
  } catch (e) { toastError(e); }
}

// Dashboard: the summaries on screen plus every record of the period.
export function exportDashboard(d, q) {
  return run(async () => {
    const ex = (await api('/export', { query: { restaurant_id: q.restaurant_id, from: d.period.from, to: d.period.to } })).data;
    const sheets = [...dashboardSheets(d), recordsSheet(ex.records), coversSheet(ex.covers),
      filterSheet([[t('restaurant'), restaurantName(q.restaurant_id)], [t('period'), `${d.period.from} – ${d.period.to}`]])];
    downloadBlob(buildXlsx(sheets), fileName([state.meta.organization?.name, q.restaurant_id && restaurantName(q.restaurant_id), d.period.from, d.period.to]));
  });
}

// Records page: exactly the filtered list (all pages, not only the visible one).
export function exportRecords(f) {
  return run(async () => {
    const ex = (await api('/export', { query: { restaurant_id: f.restaurant_id, from: f.from, to: f.to, waste_category_id: f.waste_category_id, reason_id: f.reason_id } })).data;
    if (!ex.records.length) return false;
    const lab = (list, id) => (id ? ((list || []).find((x) => x.id === Number(id)) || {}).label : t('all'));
    downloadBlob(buildXlsx([recordsSheet(ex.records), filterSheet([
      [t('restaurant'), restaurantName(f.restaurant_id)], [t('period'), `${f.from || '…'} – ${f.to || '…'}`],
      [t('category'), lab(state.meta.waste_categories, f.waste_category_id)], [t('reason'), lab(state.meta.waste_reasons, f.reason_id)],
    ])]), fileName([state.meta.organization?.name, t('sh_records'), f.from, f.to]));
  });
}

// Everything: records, guests, dashboard summaries and the catalog. Empty dates = all time.
export function exportAll({ from, to, restaurant_id }) {
  return run(async () => {
    const p = state.meta.permissions;
    const ex = (await api('/export', { query: { restaurant_id, from, to } })).data;
    const sheets = [];
    if (p.dashboard && ex.records.length) {
      const first = from || ex.records[0].recorded_local.slice(0, 10);
      const d = (await api('/dashboard', { query: { restaurant_id, from: first, to: to || todayIso() } })).data;
      sheets.push(...dashboardSheets(d));
    }
    sheets.push(recordsSheet(ex.records), coversSheet(ex.covers));
    if (p.catalog) {
      const [products, suppliers, dishes] = await Promise.all(['/products', '/suppliers', '/menu-items'].map((e) => api(e).then((r) => r.data)));
      const cat = (id) => ((state.meta.waste_categories.find((c) => c.id === id) || {}).label || '');
      sheets.push(
        { name: t('set_products'), rows: [[t('name'), t('category'), t('reg_supplier'), t('price_kg'), t('sales_kg'), t('quick_pick'), t('active')],
          ...products.map((r) => [r.name, cat(r.waste_category_id), r.supplier_name, money(r.purchase_price_per_kg), money(r.sales_price_per_kg), yesNo(r.is_quick_pick), yesNo(r.is_active)])] },
        { name: t('set_suppliers'), rows: [[t('name'), t('contact')], ...suppliers.map((r) => [r.name, r.contact])] },
        { name: t('set_menu'), rows: [[t('name'), t('restaurant'), t('portion_g'), t('sales_price'), t('cost_price'), t('active')],
          ...dishes.map((r) => [r.name, r.restaurant_name || t('all_restaurants'), r.portion_size_g, money(r.sales_price), money(r.cost_price), yesNo(r.is_active)])] },
      );
    }
    if (p.dashboard) {
      const targets = (await api('/targets')).data;
      sheets.push({ name: t('sh_targets'), rows: [[t('name'), t('restaurant'), t('period_label'), t('baseline'), t('goal'), t('start_date'), t('end_date')],
        ...targets.map((r) => [r.name, r.restaurant_name || t('whole_org'), t('period_' + (r.period || 'month')), kg(r.baseline_kg), kg(r.target_kg),
          r.start_date ? { date: r.start_date } : '', r.end_date ? { date: r.end_date } : ''])] });
    }
    sheets.push(filterSheet([[t('restaurant'), restaurantName(restaurant_id)], [t('period'), `${from || '…'} – ${to || '…'}`]]));
    downloadBlob(buildXlsx(sheets), fileName([state.meta.organization?.name, from || 'all', to]));
  });
}
