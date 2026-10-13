// Settings: products, suppliers, dishes, guests per day, targets, restaurants, users,
// organization, audit log and (super admin) organizations. One generic CRUD view.
import { state, api, app, esc, fmt, toast, toastError, todayIso, $, $$, openModal, confirmDialog, formHtml, readForm, loadMeta, labelOf, bindPlaceFields } from '../core.js';
import { t, LANGS, lang } from '../i18n.js';
import { exportAll } from '../export.js';
import { openProductImport } from '../product-import.js';
import { openMissingProducts } from '../missing-products.js';
import { renderInvoices } from '../invoices.js';
import { renderSales, openTillLinks } from '../sales.js';

// Sales (till reports) is an option per organization, switched on in Settings › Organization
const salesOn = () => !!(state.meta.organization && state.meta.organization.sales_enabled);
import { renderOrganizations } from '../org-wizard.js';

const yes = (b) => (b ? '&#10003;' : '');

function sections() {
  const p = state.meta.permissions;
  const meta = state.meta;
  const catOpts = () => meta.waste_categories.map((c) => ({ value: c.id, label: c.label }));
  const restOpts = () => meta.restaurants.map((r) => ({ value: r.id, label: r.name }));
  const roles = ['employee', 'restaurant_manager', 'org_admin', ...(state.user.role === 'super_admin' ? ['super_admin'] : [])];
  return [
    p.catalog && {
      key: 'products', title: t('set_products'), endpoint: '/products', canEdit: true, reloadMeta: true,
      headerActions: [{ label: `&#128269; ${t('mp_btn')}`, run: (reload) => openMissingProducts(reload) },
        { label: `&#11014; ${t('imp_btn')}`, run: (reload) => openProductImport(reload) }],
      columns: [
        // Dutch and English name in one cell (English underneath), a star for quick buttons: keeps the table narrow
        [t('name'), (r) => `<div class="pname">${esc(r.name)}${r.is_quick_pick ? ` <span class="qp" title="${t('quick_pick')}" aria-label="${t('quick_pick')}">&#9733;</span>` : ''}
          ${r.is_demo ? '<span class="badge demo">DEMO</span>' : ''}</div>${r.name_en ? `<div class="small muted">${esc(r.name_en)}</div>` : ''}`],
        [t('category'), (r) => esc(labelOf(meta.waste_categories, r.waste_category_id))],
        [t('reg_supplier'), (r) => esc(r.supplier_name || '')],
        [t('price_kg_short'), (r) => `${r.price_estimated ? `<span class="muted" title="${t('price_est_hint')}">≈ </span>` : ''}${fmt.money(r.purchase_price_per_kg, 2)}`, true],
        [t('co2_col'), (r) => (r.co2e_per_kg != null ? `<span title="${esc(r.co2e_source || '')}">${fmt.num(r.co2e_per_kg, 2)}</span>` : `<span class="muted" title="${t('co2_cat_hint')}">${t('co2_cat_short')}</span>`), true],
      ],
      fields: () => [
        { name: 'name', label: t('name_nl_field'), required: true },
        { name: 'name_en', label: t('name_en_field') },
        { name: 'waste_category_id', label: t('category'), type: 'select', blank: false, options: catOpts() },
        { name: 'category_id', label: t('subcategory'), type: 'select', options: meta.subcategories.map((c) => ({ value: c.id, label: `${labelOf(meta.waste_categories, c.waste_category_id)} › ${c.label}` })) },
        { name: 'default_supplier_id', label: t('default_supplier'), type: 'select', options: meta.suppliers.map((s) => ({ value: s.id, label: s.name })) },
        { name: 'purchase_price_per_kg', label: t('price_kg'), type: 'number', step: '0.01' },
        { name: 'price_estimated', label: t('price_est_field'), type: 'checkbox' },
        { name: 'sales_price_per_kg', label: t('sales_kg'), type: 'number', step: '0.01' },
        { name: 'co2e_per_kg', label: t('co2_field'), type: 'number', step: '0.01' },
        { name: 'co2e_source', label: t('co2_src_field') },
        { name: 'is_quick_pick', label: t('quick_pick'), type: 'checkbox' },
        { name: 'is_active', label: t('active'), type: 'checkbox', default: true },
      ],
    },
    p.catalog && {
      key: 'suppliers', title: t('set_suppliers'), endpoint: '/suppliers', canEdit: true, reloadMeta: true,
      columns: [[t('name'), (r) => esc(r.name)], [t('contact'), (r) => esc(r.contact || '')]],
      fields: () => [{ name: 'name', label: t('name'), required: true }, { name: 'contact', label: t('contact') }],
    },
    p.catalog && { key: 'invoices', title: t('inv_title'), custom: renderInvoices },
    p.catalog && {
      key: 'menu', title: t('set_menu'), endpoint: '/menu-items', canEdit: true, reloadMeta: true,
      headerActions: salesOn() ? [{ label: `&#128279; ${t('tl_btn')}`, run: (reload) => openTillLinks(reload) }] : [],
      columns: [
        [t('name'), (r) => esc(r.name)], [t('restaurant'), (r) => esc(r.restaurant_name || t('all_restaurants'))],
        [t('portion_g'), (r) => fmt.num(r.portion_size_g), true], [t('sales_price'), (r) => fmt.money(r.sales_price, 2), true],
      ],
      fields: () => [
        { name: 'name', label: t('name'), required: true },
        { name: 'restaurant_id', label: t('restaurant'), type: 'select', blankLabel: t('all_restaurants'), options: restOpts() },
        { name: 'portion_size_g', label: t('portion_g'), type: 'number' },
        { name: 'sales_price', label: t('sales_price'), type: 'number', step: '0.01' },
        { name: 'cost_price', label: t('cost_price'), type: 'number', step: '0.01' },
        { name: 'is_active', label: t('active'), type: 'checkbox', default: true },
      ],
    },
    p.catalog && {
      key: 'covers', title: t('set_covers'), endpoint: '/covers', createMethod: 'PUT', canEdit: false, canDelete: false,
      columns: [[t('date'), (r) => fmt.date(r.date)], [t('restaurant'), (r) => esc(r.restaurant_name)], [t('guests'), (r) => fmt.num(r.guests), true]],
      fields: () => [
        { name: 'restaurant_id', label: t('restaurant'), type: 'select', blank: false, options: restOpts() },
        { name: 'date', label: t('date'), type: 'date', required: true, default: todayIso() },
        { name: 'guests', label: t('guests'), type: 'number', required: true },
      ],
    },
    p.dashboard && {
      key: 'targets', title: t('set_targets'), endpoint: '/targets', canCreate: p.targets, canEdit: p.targets, canDelete: p.targets,
      columns: [
        [t('name'), (r) => esc(r.name)], [t('restaurant'), (r) => esc(r.restaurant_name || t('whole_org'))],
        [t('period_label'), (r) => t('period_' + (r.period || 'month'))],
        [t('baseline'), (r) => `${fmt.kg(r.baseline_kg, 0)} <span class="muted small">${t('per_' + (r.period || 'month'))}</span>`, true],
        [t('goal'), (r) => `${fmt.kg(r.target_kg, 0)} <span class="muted small">${t('per_' + (r.period || 'month'))}</span>`, true],
        [t('start_date'), (r) => fmt.date(r.start_date)], [t('end_date'), (r) => (r.end_date ? fmt.date(r.end_date) : '–')],
      ],
      fields: () => [
        { name: 'help', label: t('target_help'), type: 'help' },
        { name: 'name', label: t('name'), required: true },
        { name: 'restaurant_id', label: t('restaurant'), type: 'select', blankLabel: t('whole_org'), options: restOpts() },
        { name: 'period', label: t('period_label'), type: 'select', blank: false, numericValue: false, default: 'month',
          options: ['week', 'month', 'year'].map((v) => ({ value: v, label: t('period_' + v) })) },
        { name: 'baseline_kg', label: t('baseline_kg'), type: 'number', step: '0.1', required: true },
        { name: 'target_kg', label: t('target_kg'), type: 'number', step: '0.1', required: true },
        { name: 'start_date', label: t('start_date'), type: 'date', required: true, default: todayIso() },
        { name: 'end_date', label: t('end_date'), type: 'date' },
      ],
    },
    p.catalog && {
      key: 'restaurants', title: t('set_restaurants'), endpoint: '/restaurants', canCreate: p.restaurants, canEdit: true, canDelete: p.restaurants, reloadMeta: true,
      // Public impact page: one link per restaurant (when switched on) and one for the whole organization
      headerActions: [{ label: `&#127757; ${t('imp_pub_open_all')}`, run: () => openPublic('') }],
      rowActions: [{ label: t('imp_pub_open'), show: (r) => r.public_impact_enabled, run: (r) => openPublic(r.slug) }],
      columns: [[t('name'), (r) => esc(r.name)], [t('city'), (r) => esc(r.city || '')],
        [t('open_days'), (r) => esc(openDaysLabel(r.open_days))], [t('public_impact'), (r) => yes(r.public_impact_enabled)]],
      fields: () => [
        { name: 'name', label: t('name'), required: true },
        { name: 'city', label: t('place_label'), type: 'place', placeholder: t('place_ph') },
        { name: 'open_days', label: t('open_days'), type: 'multiselect', default: [1, 2, 3, 4, 5, 6, 7],
          options: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: weekdayName(d) })) },
        { name: 'public_impact_enabled', label: t('public_impact'), type: 'checkbox' },
      ],
    },
    p.users && {
      key: 'users', title: t('set_users'), endpoint: '/users', canEdit: true,
      columns: [
        [t('name'), (r) => `${esc(r.name)}${r.is_active ? '' : ' <span class="badge">inactive</span>'}${r.invite_pending ? ` <span class="badge warn">${t('invite_pending')}</span>` : ''}`], [t('email'), (r) => esc(r.email)],
        [t('role'), (r) => t('role_' + r.role)],
        [t('restaurants'), (r) => (['org_admin', 'super_admin'].includes(r.role) ? t('all_restaurants') : r.restaurant_ids.map((id) => esc(labelOf(meta.restaurants, id))).join(', '))],
        [t('last_login'), (r) => fmt.dateTime(r.last_login_at)],
      ],
      rowActions: [{ label: t('send_reset'), show: (r) => r.id !== state.user.id && r.is_active, run: async (r) => {
        if (!(await confirmDialog(t('confirm_reset', { e: r.email }), t('send'), false))) return;
        try { await api(`/users/${r.id}/send-reset`, { method: 'POST' }); toast(t('reset_sent', { e: r.email })); } catch (e) { toastError(e); }
      } }],
      validate: (body, row) => {
        if (!row && !body.invite && !(body.password && body.password.length >= 8)) return t('pw_needed');
        return null;
      },
      afterCreate: (body) => { if (body.invite) toast(t('invite_sent', { e: body.email })); },
      fields: (row) => [
        { name: 'name', label: t('name'), required: true },
        { name: 'email', label: t('email'), type: 'email', required: true },
        { name: 'role', label: t('role'), type: 'select', blank: false, numericValue: false, options: roles.map((r) => ({ value: r, label: t('role_' + r) })) },
        { name: 'restaurant_ids', label: t('restaurants'), type: 'multiselect', options: restOpts(), default: meta.restaurants.map((r) => r.id) },
        { name: 'language', label: t('language'), type: 'select', blank: false, numericValue: false, options: Object.entries(LANGS).map(([v, l]) => ({ value: v, label: l })) },
        ...(row ? [] : [{ name: 'invite', label: t('invite_email'), type: 'checkbox', default: true }]),
        { name: 'password', label: row ? `${t('new_password')} (${t('pw_optional')})` : `${t('password')} (min. 8)`, type: 'password', emptyAsUndefined: true },
        { name: 'is_active', label: t('active'), type: 'checkbox', default: true },
      ],
    },
    p.dashboard && salesOn() && { key: 'sales', title: t('sl_title'), custom: renderSales },
    p.dashboard && { key: 'weekly', title: t('set_weekly'), custom: renderWeekly },
    p.dashboard && { key: 'leaderboard', title: t('set_leaderboard'), custom: renderLeaderboardSettings },
    p.dashboard && { key: 'export', title: t('set_export'), custom: renderExport },
    p.org_settings && { key: 'organization', title: t('set_org'), custom: renderOrg },
    // The platform admin finds the audit log inside System check; organization admins keep their own tab
    p.audit && state.user.role !== 'super_admin' && { key: 'audit', title: t('set_audit'), custom: renderAudit },
    p.organizations && { key: 'organizations', title: t('set_orgs'), custom: renderOrganizations },
    state.user.role === 'super_admin' && { key: 'system', title: t('sc_title'), custom: renderSystemCheck },
  ].filter(Boolean);
}

// Where the "?" in Settings jumps to in the admin help page
const HELP_ANCHOR = { products: '#products', invoices: '#products', suppliers: '#setup', menu: '#setup', covers: '#setup', targets: '#setup',
  restaurants: '#setup', users: '#users', weekly: '#share', leaderboard: '#leaderboard', export: '#data', audit: '#data', organization: '#setup' };

export async function renderSettings(rest) {
  const list = sections();
  const chosen = list.find((s) => s.key === rest[0]);
  const current = chosen || list[0];
  // Phone: without a chosen section only the list shows; with one, only that section plus a back link
  app().innerHTML = `
    <div class="page-head"><h1>${t('set_title')} <a class="help-q help-q-sm" href="help/admins.html${HELP_ANCHOR[current.key] || ''}" title="${t('help_admin')}" aria-label="${t('help_admin')}">?</a></h1></div>
    <div class="settings ${chosen ? 'has-section' : 'menu-only'}">
      <nav class="settings-nav">${list.map((s) => `<a href="#/settings/${s.key}" class="${s === current ? 'active' : ''}">${s.title}</a>`).join('')}</nav>
      <div class="settings-main"><a href="#/settings" class="settings-back">&#8249; ${t('set_title')}</a><div id="set-body"></div></div>
    </div>`;
  if (current.custom) return current.custom($('#set-body'));
  return crud($('#set-body'), current);
}

async function crud(el, cfg) {
  const canCreate = cfg.canCreate !== false;
  const canDelete = cfg.canDelete !== false;
  el.innerHTML = `<div class="card"><div class="page-head" style="margin-bottom:12px"><h2 style="margin:0">${cfg.title}</h2>
    <div class="page-actions">${(cfg.headerActions || []).map((a, i) => `<button class="btn-sm" data-hact="${i}">${a.label}</button>`).join('')}
    ${canCreate ? `<button class="btn-primary btn-sm" id="crud-add">+ ${t('add')}</button>` : ''}</div></div><div id="crud-list"><span class="spinner"></span></div></div>`;
  let rows = [];
  const load = async () => {
    try { rows = (await api(cfg.endpoint)).data; } catch (e) { toastError(e); return; }
    $('#crud-list').innerHTML = rows.length ? `<div class="table-wrap"><table class="stack"><thead><tr>
      ${cfg.columns.map((c) => `<th class="${c[2] ? 'right' : ''}">${c[0]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr>${cfg.columns.map((c) => `<td class="${c[2] ? 'right num' : ''}" data-label="${esc(String(c[0]).replace(/<[^>]*>/g, ''))}">${c[1](r) ?? ''}</td>`).join('')}
        <td class="actions">${(cfg.rowActions || []).map((a, i) => (a.show(r) ? `<button class="btn-sm btn-ghost" data-act="${i}" data-id="${r.id}">${a.label}</button>` : '')).join('')}
        ${cfg.canEdit ? `<button class="btn-sm" data-edit="${r.id}">${t('edit')}</button>` : ''}
        ${canDelete && r.id !== state.user.id ? `<button class="btn-sm btn-ghost btn-danger" data-del="${r.id}">${t('delete')}</button>` : ''}</td></tr>`).join('')}
      </tbody></table></div>` : `<div class="empty">${t('no_data')}</div>`;
    const byId = (id) => rows.find((r) => String(r.id) === String(id));
    $$('[data-edit]', el).forEach((b) => (b.onclick = () => openForm(byId(b.dataset.edit))));
    $$('[data-act]', el).forEach((b) => (b.onclick = () => cfg.rowActions[Number(b.dataset.act)].run(byId(b.dataset.id))));
    $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
      if (!(await confirmDialog(t('confirm_delete')))) return;
      try { await api(`${cfg.endpoint}/${b.dataset.del}`, { method: 'DELETE' }); await after(); } catch (e) { toastError(e); }
    }));
  };
  const after = async () => { if (cfg.reloadMeta) await loadMeta(); if (cfg.afterSave) cfg.afterSave(); await load(); };
  const openForm = (row) => {
    const fields = cfg.fields(row);
    const values = row ? { ...row } : Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.name, f.default]));
    if (row) fields.forEach((f) => { if (f.type === 'password') values[f.name] = ''; });
    openModal(`<h2>${row ? t('edit') : t('add')}: ${cfg.title}</h2><form id="crud-form">${formHtml(fields, values)}
      <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button><button class="btn-primary" type="submit">${t('save')}</button></div></form>`,
    (card, close) => {
      bindPlaceFields(card);
      card.querySelector('#crud-form').onsubmit = async (e) => {
        e.preventDefault();
        const body = readForm(card, fields);
        const invalid = cfg.validate && cfg.validate(body, row);
        if (invalid) { toast(invalid, 'error'); return; }
        try {
          if (row) await api(`${cfg.endpoint}/${row.id}`, { method: 'PATCH', body });
          else { await api(cfg.endpoint, { method: cfg.createMethod || 'POST', body }); if (cfg.afterCreate) cfg.afterCreate(body); }
          close(); toast(t('saved')); await after();
        } catch (err) { toastError(err); }
      };
    });
  };
  $$('[data-hact]', el).forEach((b) => (b.onclick = () => cfg.headerActions[Number(b.dataset.hact)].run(() => load())));
  const add = $('#crud-add');
  if (add) add.onclick = () => openForm(null);
  load();
}

async function openPublic(restSlug) {
  try {
    const org = (await api('/my-org-slug')).data;
    const url = `${location.origin}${location.pathname}#/impact/${encodeURIComponent(org)}${restSlug ? '/' + encodeURIComponent(restSlug) : ''}`;
    window.open(url, '_blank', 'noopener');
  } catch (e) { toastError(e); }
}

async function renderOrg(el) {
  const org = (await api('/organization')).data;
  const fields = [
    { name: 'name', label: t('name'), required: true },
    { name: 'default_value_per_kg', label: t('default_value'), type: 'number', step: '0.01', required: true },
    { name: 'default_language', label: t('language'), type: 'select', blank: false, numericValue: false, options: Object.entries(LANGS).map(([v, l]) => ({ value: v, label: l })) },
    { name: 'currency', label: t('currency'), required: true },
    { name: 'weather_enabled', label: t('weather_enabled'), type: 'checkbox' },
    { name: 'sales_enabled', label: t('sales_enabled'), type: 'checkbox' },
  ];
  el.innerHTML = `<form class="card" id="org-form"><h2>${t('set_org')}</h2>${formHtml(fields, org)}
    <p class="small muted" style="margin-top:-6px">${t('sales_enabled_hint')}</p>
    <button class="btn-primary" type="submit">${t('save')}</button></form>`;
  $('#org-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = readForm(el, fields);
      await api('/organization', { method: 'PATCH', body }); await loadMeta(); toast(t('org_saved'));
      // The Sales page appears or disappears in the menu
      if (!!body.sales_enabled !== !!org.sales_enabled) renderSettings(['organization']);
    } catch (err) { toastError(err); }
  };
}

// ------------------------------------------------------------------ leaderboard: switch, prize, sections
async function renderLeaderboardSettings(el) {
  const meta = state.meta; const p = meta.permissions;
  let org = null; let secs = [];
  try {
    [org, secs] = await Promise.all([p.org_settings ? api('/organization').then((r) => r.data) : null, api('/sections').then((r) => r.data || [])]);
  } catch (e) { toastError(e); return; }
  const on = org ? org.leaderboard_enabled : !!meta.organization.leaderboard_enabled;
  el.innerHTML = `
    ${org ? `<form class="card" id="lb-form"><h2>${t('set_leaderboard')}</h2>
      <p class="muted small">${t('lbs_sub')}</p>
      <div class="field"><label class="check lb-switch"><input type="checkbox" name="leaderboard_enabled" ${on ? 'checked' : ''}> <strong>${t('lbs_on')}</strong></label>
        <div class="small muted">${t('lbs_on_help')}</div></div>
      <div class="field"><label>${t('lb_prize')}</label><input name="leaderboard_prize" value="${esc(org.leaderboard_prize || '')}" placeholder="${t('lbs_prize_ph')}"></div>
      <div class="field-row">
        <div class="field"><label>${t('lbs_period')}</label><select name="leaderboard_period">
          ${['week', 'month'].map((x) => `<option value="${x}" ${org.leaderboard_period === x ? 'selected' : ''}>${t('lbs_period_' + x)}</option>`).join('')}</select></div>
        <div class="field"><label>${t('lbs_season')}</label><input type="date" name="leaderboard_season_start" value="${esc(org.leaderboard_season_start || '')}"></div>
      </div>
      <button class="btn-primary" type="submit">${t('save')}</button></form>`
    : `<div class="card"><h2>${t('set_leaderboard')}</h2><p class="small">${on ? t('lbs_is_on') : t('lbs_is_off')}</p></div>`}
    <div class="card" style="margin-top:16px"><h2>${t('lbs_sections')}</h2><p class="muted small">${t('lbs_sections_help')}</p>
      ${meta.restaurants.map((r) => {
        const list = secs.filter((x) => x.restaurant_id === r.id);
        return `<div class="lbs-rest"><h3>${esc(r.name)}</h3>
          <div class="chips">${list.map((x) => `<button type="button" class="chip ${x.is_active ? '' : 'muted'}" data-sec="${x.id}">${esc(x.name)}${x.is_active ? '' : ` (${t('lbs_inactive')})`} &#9998;</button>`).join('') || `<span class="muted small">${t('lbs_none')}</span>`}</div>
          <form class="lbs-add" data-rest="${r.id}"><input name="name" maxlength="60" placeholder="${t('lbs_add_ph')}"><button class="btn-sm" type="submit">+ ${t('add')}</button></form></div>`;
      }).join('')}
    </div>`;
  const reload = async () => { await loadMeta(); renderLeaderboardSettings(el); };
  if ($('#lb-form')) $('#lb-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = { leaderboard_enabled: f.leaderboard_enabled.checked, leaderboard_prize: f.leaderboard_prize.value.trim() || null,
      leaderboard_period: f.leaderboard_period.value, leaderboard_season_start: f.leaderboard_season_start.value || null };
    try {
      await api('/organization', { method: 'PATCH', body });
      await loadMeta(); toast(body.leaderboard_enabled ? t('lbs_saved_on') : t('lbs_saved_off'));
      window.dispatchEvent(new HashChangeEvent('hashchange'));   // rebuild the menu
    } catch (err) { toastError(err); }
  };
  $$('.lbs-add', el).forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault();
    const name = f.name.value.trim();
    if (!name) return;
    try { await api('/sections', { method: 'POST', body: { restaurant_id: Number(f.dataset.rest), name, sort_order: secs.length } }); toast(t('saved')); reload(); }
    catch (err) { toastError(err); }
  }));
  $$('[data-sec]', el).forEach((b) => (b.onclick = () => {
    const x = secs.find((y) => y.id === Number(b.dataset.sec));
    const fields = [{ name: 'name', label: t('name'), required: true }, { name: 'sort_order', label: t('lbs_order'), type: 'number', step: '1' },
      { name: 'is_active', label: t('active'), type: 'checkbox' }];
    openModal(`<h2>${t('edit')}: ${esc(x.name)}</h2><form id="sec-form">${formHtml(fields, x)}
      <div class="modal-actions"><button type="button" class="btn-ghost btn-danger" id="sec-del" style="margin-right:auto">${t('delete')}</button>
      <button type="button" data-close>${t('cancel')}</button><button class="btn-primary">${t('save')}</button></div></form>`, (card, close) => {
      card.querySelector('#sec-form').onsubmit = async (e) => {
        e.preventDefault();
        try { await api(`/sections/${x.id}`, { method: 'PATCH', body: readForm(card, fields) }); close(); toast(t('saved')); reload(); } catch (err) { toastError(err); }
      };
      card.querySelector('#sec-del').onclick = async () => {
        close();
        if (!(await confirmDialog(t('lbs_del_confirm', { n: x.name })))) return;
        try { await api(`/sections/${x.id}`, { method: 'DELETE' }); reload(); } catch (err) { toastError(err); }
      };
    });
  }));
}

// ------------------------------------------------------------------ morning system check (platform admin)
const SC_DOT = { ok: 'sc-ok', warn: 'sc-warn', fail: 'sc-fail' };
const scDot = (st) => `<span class="sc-dot ${SC_DOT[st] || ''}" role="img" aria-label="${t('sc_st_' + st)}"></span>`;
// How a changed value reads: on/off, lists, empty
function scVal(v) {
  if (v === null || v === undefined || v === '') return '–';
  if (v === true) return t('sc_on'); if (v === false) return t('sc_off');
  if (Array.isArray(v)) return v.length ? v.join(', ') : '–';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v);
}
// One line per change: who, what, and for updates the fields with old -> new
function scChange(c) {
  const ent = t('sc_ent_' + c.entity) !== 'sc_ent_' + c.entity ? t('sc_ent_' + c.entity) : c.entity;
  const fields = c.changes ? Object.entries(c.changes).map(([k, [a, b]]) => {
    const lab = t('sc_f_' + k) !== 'sc_f_' + k ? t('sc_f_' + k) : k.replace(/_/g, ' ');
    // weekdays (1 = Monday) read as day names
    const v = (x) => (['send_days', 'open_days'].includes(k) && Array.isArray(x) ? x.map((d) => weekdayName(Number(d), 'short')) : x);
    return `${esc(lab)}: <span class="muted">${esc(scVal(v(a)))}</span> &rarr; <strong>${esc(scVal(v(b)))}</strong>`;
  }).join('; ') : '';
  return `<li><span class="small muted nowrap">${fmt.dateTime(c.at)}</span> · <strong>${esc(!c.user || c.user === 'system' ? t('sc_system') : c.user)}</strong>
    ${t('sc_act_' + c.action)} ${esc(ent.toLowerCase())}${c.name ? ` <em>${esc(c.name)}</em>` : ''}${c.org ? ` <span class="small muted">(${esc(c.org)})</span>` : ''}
    ${fields ? `<div class="small sc-fields">${fields}</div>` : ''}</li>`;
}
// Many of the same change by the same person (an import) become one line that opens
function scChangeList(list) {
  const groups = new Map();
  list.forEach((c) => {
    const k = `${c.user}|${c.action}|${c.entity}|${c.changes ? Object.keys(c.changes).sort().join(',') : ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  return [...groups.values()].map((g) => {
    if (g.length < 5) return g.map(scChange).join('');
    const c = g[0];
    const ent = t('sc_ent_' + c.entity) !== 'sc_ent_' + c.entity ? t('sc_ent_' + c.entity) : c.entity;
    return `<li><details><summary><strong>${esc(!c.user || c.user === 'system' ? t('sc_system') : c.user)}</strong> ${t('sc_act_' + c.action)} ${g.length} × ${esc(ent.toLowerCase())}
      ${c.changes ? `<span class="small muted">(${esc(Object.keys(c.changes).map((k) => (t('sc_f_' + k) !== 'sc_f_' + k ? t('sc_f_' + k) : k)).join(', '))})</span>` : ''}</summary>
      <ul class="sc-changes">${g.map(scChange).join('')}</ul></details></li>`;
  }).join('');
}

async function renderSystemCheck(el, pick) {
  el.innerHTML = `<div class="card"><span class="spinner"></span></div>`;
  let rows = [];
  try { rows = (await api('/system-checks')).data || []; } catch (e) { toastError(e); return; }
  const cur = rows.find((r) => r.id === pick) || rows[0];
  const head = `<div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">${t('sc_title')}</h2>
      <div class="page-actions"><button class="btn-primary btn-sm" id="sc-run">${t('sc_run')}</button></div></div>
    <p class="small muted" style="margin-top:0">${t('sc_sub')}</p>`;
  if (!cur) { el.innerHTML = `<div class="card">${head}<div class="empty">${t('sc_none')}</div></div>`; bindRun(); return; }
  const counts = { fail: cur.checks.filter((c) => c.status === 'fail').length, warn: cur.checks.filter((c) => c.status === 'warn').length };
  el.innerHTML = `<div class="card">${head}
      <div class="sc-head ${SC_DOT[cur.status]}">${scDot(cur.status)} <strong>${t('sc_overall_' + cur.status)}</strong>
        <span class="small muted">· ${fmt.dateTime(cur.run_at)} · ${t(cur.trigger === 'manual' ? 'sc_manual' : 'sc_scheduled')}</span></div>
      <ul class="sc-list">${cur.checks.map((c) => `<li>${scDot(c.status)}<div><strong>${t('sc_k_' + c.key)}</strong>
        <div class="small muted">${esc(c.detail)}${c.ms ? ` · ${fmt.num(c.ms)} ms` : ''}</div></div></li>`).join('')}</ul>
    </div>
    ${cur.gaps.length ? `<div class="card"><h2>${t('sc_gaps')}</h2><ul class="sc-list">${cur.gaps.map((g) => `<li>${scDot('warn')}<div>
      <strong>${t('sc_g_' + g.key)}</strong>${g.count ? ` (${g.count})` : ''} <span class="small muted">· ${esc(g.org || '')}</span>
      <div class="small muted">${esc((g.items || []).join(', '))}${g.count > (g.items || []).length ? ' …' : ''}</div></div></li>`).join('')}</ul></div>` : ''}
    <div class="card"><div class="page-head" style="margin-bottom:6px"><h2 style="margin:0">${t('sc_changes')}</h2>
      <div class="page-actions"><button class="btn-sm" id="sc-all">${t('sc_all', { n: fmt.num(cur.changes_all) })}</button></div></div>
      <p class="small muted" style="margin-top:0">${t('sc_changes_sub', { from: fmt.dateTime(cur.window_from), to: fmt.dateTime(cur.window_to) })}</p>
      ${cur.changes.length ? `<ul class="sc-changes">${scChangeList(cur.changes)}</ul>` : `<div class="empty">${t('sc_no_changes')}</div>`}</div>
    <div class="card"><div class="page-head" style="margin-bottom:0"><h2 style="margin:0">${t('set_audit')}</h2>
      <div class="page-actions"><button class="btn-sm" id="sc-audit">${t('sc_audit_show')}</button></div></div>
      <p class="small muted" style="margin:6px 0 0">${t('sc_audit_sub')}</p><div id="sc-audit-body"></div></div>
    <div class="card"><h2>${t('sc_history')}</h2><div class="table-wrap"><table><tbody>
      ${rows.map((r) => {
        const f = r.checks.filter((c) => c.status === 'fail').length; const w = r.checks.filter((c) => c.status === 'warn').length;
        return `<tr class="${r.id === cur.id ? 'sc-current' : ''}"><td class="nowrap">${scDot(r.status)} ${fmt.dateTime(r.run_at)}</td>
          <td class="small">${f ? `<strong>${t('sc_n_fail', { n: f })}</strong> ` : ''}${w ? t('sc_n_warn', { n: w }) : ''}${!f && !w ? t('sc_all_ok') : ''}
            · ${t('sc_n_changes', { n: r.changes.length })}</td>
          <td class="actions">${r.id === cur.id ? '' : `<button class="btn-sm btn-ghost" data-sc="${r.id}">${t('sc_open')}</button>`}</td></tr>`;
      }).join('')}</tbody></table></div></div>`;
  bindRun();
  $$('[data-sc]', el).forEach((b) => (b.onclick = () => renderSystemCheck(el, Number(b.dataset.sc))));
  $('#sc-audit', el).onclick = async (e) => {
    const box = $('#sc-audit-body', el);
    if (box.innerHTML) { box.innerHTML = ''; e.target.textContent = t('sc_audit_show'); return; }
    box.innerHTML = '<span class="spinner"></span>';
    try { await renderAudit(box, true); e.target.textContent = t('sc_audit_hide'); } catch (err) { box.innerHTML = ''; toastError(err); }
  };
  $('#sc-all', el).onclick = async () => {
    openModal(`<div class="card empty"><span class="spinner"></span></div>`);
    let all = [];
    try { all = (await api(`/system-checks/${cur.id}/all`)).data || []; } catch (e) { toastError(e); document.getElementById('modal').hidden = true; return; }
    openModal(`<h2>${t('sc_all_title')}</h2><p class="small muted">${t('sc_changes_sub', { from: fmt.dateTime(cur.window_from), to: fmt.dateTime(cur.window_to) })}</p>
      ${all.length ? `<ul class="sc-changes sc-modal-list">${scChangeList(all.map((c) => (c.entity === 'waste_records' && c.kg != null ? { ...c, name: fmt.kg(Number(c.kg), 2) } : c)))}</ul>` : `<div class="empty">${t('sc_no_changes')}</div>`}
      ${all.length >= 1000 ? `<p class="small muted">${t('sc_first_1000')}</p>` : ''}
      <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
  };
  function bindRun() {
    $('#sc-run', el).onclick = async (e) => {
      e.target.disabled = true; e.target.innerHTML = `<span class="spinner"></span> ${t('sc_running')}`;
      try { await api('/system-checks/run', { method: 'POST' }); toast(t('sc_done')); } catch (err) { toastError(err); }
      renderSystemCheck(el);
    };
  }
}

// ------------------------------------------------------------------ weekly impact e-mail
async function renderWeekly(el) {
  const meta = state.meta;
  el.innerHTML = `<div class="card"><h2>${t('set_weekly')}</h2><p class="muted small">${t('wk_sub')}</p><div id="wk-list"><span class="spinner"></span></div></div>`;
  let subs = [];
  try { subs = (await api('/report-subscriptions')).data || []; } catch (e) { toastError(e); return; }
  const rows = [
    ...(meta.permissions.users ? [{ restaurant_id: null, name: t('wk_overview') }] : []),
    ...meta.restaurants.map((r) => ({ restaurant_id: r.id, name: r.name })),
  ].map((r) => ({ ...r, sub: subs.find((s) => (s.restaurant_id || null) === r.restaurant_id) }));
  const status = (s) => {
    if (!s) return `<span class="muted">${t('wk_none')}</span>`;
    if (!s.is_active) return `<span class="badge">${t('wk_paused')}</span>`;
    if (s.last_status === 'no_mail_service') return `<span class="badge warn">${t('wk_no_mail')}</span>`;
    if (s.last_sent_week) return `<span class="badge green">&#10003; ${t('wk_last', { d: fmt.date(s.last_sent_at) })}</span>`;
    return `<span class="badge green">${t('wk_on')}</span>`;
  };
  $('#wk-list', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('restaurant')}</th><th>${t('wk_recipients')}</th><th>${t('wk_when_col')}</th><th>${t('language')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td><strong>${esc(r.name)}</strong></td>
      <td class="small">${r.sub && r.sub.recipients.length ? `${esc(r.sub.recipients.slice(0, 2).join(', '))}${r.sub.recipients.length > 2 ? ` +${r.sub.recipients.length - 2}` : ''}` : '<span class="muted">–</span>'}</td>
      <td class="small">${r.sub ? scheduleLabel(r.sub) : ''}</td>
      <td>${r.sub ? r.sub.language.toUpperCase() : ''}</td><td>${status(r.sub)}</td>
      <td class="actions"><button class="btn-sm" data-wk="${i}">${r.sub ? t('edit') : t('wk_setup')}</button></td></tr>`).join('')}
    </tbody></table></div>
    <p class="small muted" style="margin-top:12px">${t('wk_when')}</p>`;
  $$('[data-wk]', el).forEach((b) => (b.onclick = () => editWeekly(rows[Number(b.dataset.wk)], () => renderWeekly(el))));
}

function editWeekly(row, reload) {
  const s = row.sub;
  openModal(`<h2>${t('set_weekly')}: ${esc(row.name)}</h2>
    <form id="wk-form">
      <div class="field"><label>${t('wk_recipients')}</label>
        <textarea name="recipients" rows="4" placeholder="chef@hotelschool.nl&#10;souschef@hotelschool.nl">${esc(s ? s.recipients.join('\n') : '')}</textarea>
        <div class="small muted">${t('wk_recipients_help')}</div></div>
      <div class="field"><label>${t('language')}</label><select name="language">
        ${['en', 'nl'].map((l) => `<option value="${l}" ${(s ? s.language : (state.meta.organization.default_language || 'en')) === l ? 'selected' : ''}>${LANGS[l] || l}</option>`).join('')}</select></div>
      <fieldset class="wk-when"><legend>${t('wk_when_col')}</legend>
        <div class="chips" role="group" aria-label="${t('wk_when_col')}">
          <button type="button" class="chip" data-mode="weekly">${t('wk_mode_weekly')}</button>
          <button type="button" class="chip" data-mode="dates">${t('wk_mode_dates')}</button></div>
        <div id="wk-weekly" class="wk-days">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<label class="wk-day"><input type="checkbox" value="${d}"><span>${weekdayName(d, 'short')}</span></label>`).join('')}</div>
        <div id="wk-dates"><div id="wk-cal"></div><p class="small muted" id="wk-dates-info"></p></div>
        <div class="field" style="margin-top:10px"><label for="wk-hour">${t('wk_hour')}</label>
          <select id="wk-hour">${Array.from({ length: 24 }, (_, h) => `<option value="${h}">${String(h).padStart(2, '0')}:00</option>`).join('')}</select></div>
        <p class="small muted" style="margin:6px 0 0">${t('wk_period_note')}</p>
      </fieldset>
      <div class="field"><label class="check"><input type="checkbox" name="is_active" ${!s || s.is_active ? 'checked' : ''}> ${t('wk_active')}</label></div>
      ${s && s.last_status ? `<p class="small muted">${t('wk_last_status')}: ${esc(s.last_status === 'no_mail_service' ? t('wk_no_mail') : s.last_status)}</p>` : ''}
      <div class="err" id="wk-err"></div>
      <div class="modal-actions" style="flex-wrap:wrap">
        ${s ? `<button type="button" class="btn-ghost btn-danger" id="wk-del" style="margin-right:auto">${t('delete')}</button>
          <button type="button" class="btn-sm" id="wk-prev">${t('wk_preview')}</button>` : ''}
        <button type="button" data-close>${t('cancel')}</button><button class="btn-primary">${t('save')}</button></div>
    </form>`, (card, close) => {
    // Schedule: ticked weekdays, or dates picked in the calendar (the calendar replaces the weekdays)
    const sch = {
      mode: s ? s.schedule_mode || 'weekly' : 'weekly',
      days: new Set(s && s.send_days && s.send_days.length ? s.send_days.map(Number) : [1]),
      dates: new Set(s && s.send_dates ? s.send_dates : []),
      month: todayIso().slice(0, 7),
    };
    $('#wk-hour', card).value = String(s && s.send_hour != null ? s.send_hour : 7);
    $$('#wk-weekly input', card).forEach((c) => { c.checked = sch.days.has(Number(c.value)); c.onchange = () => { if (c.checked) sch.days.add(Number(c.value)); else sch.days.delete(Number(c.value)); }; });
    const showMode = () => {
      $$('[data-mode]', card).forEach((b) => { b.classList.toggle('on', b.dataset.mode === sch.mode); b.setAttribute('aria-pressed', String(b.dataset.mode === sch.mode)); });
      $('#wk-weekly', card).hidden = sch.mode !== 'weekly';
      $('#wk-dates', card).hidden = sch.mode !== 'dates';
      if (sch.mode === 'dates') drawCal();
    };
    const drawCal = () => {
      const [y, m] = sch.month.split('-').map(Number);
      const first = new Date(y, m - 1, 1);
      const offset = (first.getDay() + 6) % 7;           // Monday first
      const daysIn = new Date(y, m, 0).getDate();
      const today = todayIso();
      const iso = (d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const title = new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : 'nl-NL', { month: 'long', year: 'numeric' }).format(first);
      const cells = [...Array(offset).fill('<span></span>'), ...Array.from({ length: daysIn }, (_, i) => {
        const d = iso(i + 1); const on = sch.dates.has(d); const past = d < today;
        return `<button type="button" class="wk-cal-day ${on ? 'on' : ''} ${d === today ? 'today' : ''}" data-date="${d}" aria-pressed="${on}" ${past ? 'disabled' : ''}>${i + 1}</button>`;
      })];
      $('#wk-cal', card).innerHTML = `<div class="wk-cal-head">
          <button type="button" class="btn-sm btn-ghost" data-cal="-1" aria-label="${t('wk_prev_month')}">&#8249;</button>
          <strong>${esc(title)}</strong>
          <button type="button" class="btn-sm btn-ghost" data-cal="1" aria-label="${t('wk_next_month')}">&#8250;</button></div>
        <div class="wk-cal-grid">${[1, 2, 3, 4, 5, 6, 7].map((d) => `<span class="wk-cal-wd">${weekdayName(d, 'narrow')}</span>`).join('')}${cells.join('')}</div>`;
      $$('[data-cal]', card).forEach((b) => (b.onclick = () => {
        const d = new Date(y, m - 1 + Number(b.dataset.cal), 1);
        sch.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; drawCal();
      }));
      $$('[data-date]', card).forEach((b) => (b.onclick = () => {
        if (sch.dates.has(b.dataset.date)) sch.dates.delete(b.dataset.date); else sch.dates.add(b.dataset.date);
        drawCal();
      }));
      const ahead = [...sch.dates].filter((d) => d >= today).sort();
      $('#wk-dates-info', card).innerHTML = ahead.length
        ? `${t('wk_dates_n', { n: ahead.length })}: ${ahead.slice(0, 6).map((d) => esc(fmt.date(d + 'T12:00:00'))).join(', ')}${ahead.length > 6 ? ' …' : ''}
           · <button type="button" class="link-btn" id="wk-clear">${t('wk_clear')}</button>`
        : t('wk_dates_none');
      const clr = $('#wk-clear', card);
      if (clr) clr.onclick = () => { sch.dates = new Set([...sch.dates].filter((d) => d < today)); drawCal(); };
    };
    $$('[data-mode]', card).forEach((b) => (b.onclick = () => { sch.mode = b.dataset.mode; showMode(); }));
    showMode();

    const read = () => {
      const recipients = $('[name=recipients]', card).value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const bad = recipients.find((x) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x));
      if (bad) throw new Error(t('wk_bad', { e: bad }));
      if (sch.mode === 'weekly' && !sch.days.size) throw new Error(t('wk_need_day'));
      if (sch.mode === 'dates' && ![...sch.dates].some((d) => d >= todayIso())) throw new Error(t('wk_need_date'));
      return { recipients, language: $('[name=language]', card).value, is_active: $('[name=is_active]', card).checked,
        schedule_mode: sch.mode, send_days: [...sch.days].sort(), send_hour: Number($('#wk-hour', card).value),
        // past dates are dropped when saving: they have done their job
        send_dates: [...sch.dates].filter((d) => d >= todayIso()).sort() };
    };
    $('#wk-form', card).onsubmit = async (e) => {
      e.preventDefault();
      try {
        const body = read();
        if (s) await api(`/report-subscriptions/${s.id}`, { method: 'PATCH', body });
        else await api('/report-subscriptions', { method: 'POST', body: { ...body, restaurant_id: row.restaurant_id } });
        close(); toast(t('saved')); reload();
      } catch (err) { $('#wk-err', card).textContent = err.message; }
    };
    if (s) {
      $('#wk-del', card).onclick = async () => {
        close();
        if (!(await confirmDialog(t('wk_del_confirm', { n: row.name })))) return;
        try { await api(`/report-subscriptions/${s.id}`, { method: 'DELETE' }); reload(); } catch (err) { toastError(err); }
      };
      $('#wk-prev', card).onclick = () => { close(); previewWeekly(s, row, reload); };
    }
  });
}

async function previewWeekly(s, row, reload) {
  openModal(`<div class="card empty"><span class="spinner"></span> ${t('wk_building')}</div>`);
  let p;
  try { p = (await api(`/report-subscriptions/${s.id}/preview`, { method: 'POST' })).data; } catch (e) { toastError(e); document.getElementById('modal').hidden = true; return; }
  openModal(`<div class="wk-preview"><h2>${t('wk_preview')}: ${esc(row.name)}</h2>
    <div class="small muted">${t('wk_subject')}: <strong>${esc(p.subject)}</strong><br>${t('wk_to')}: ${esc(p.recipients.join(', ') || '–')}</div>
    ${p.mail_ready ? '' : `<div class="note" style="margin:10px 0">${t('wk_no_mail_long')}</div>`}
    <iframe class="wk-frame" title="preview" sandbox=""></iframe>
    <div class="err" id="wk-perr"></div>
    <div class="modal-actions" style="flex-wrap:wrap">
      ${p.mail_ready ? `<button type="button" class="btn-sm" id="wk-me">${t('wk_send_me')}</button>
        <button type="button" class="btn-sm" id="wk-all">${t('wk_send_list', { n: p.recipients.length })}</button>` : ''}
      <button data-close>${t('close')}</button></div></div>`, (card) => {
    card.querySelector('.wk-frame').srcdoc = p.html;
    const send = async (to, btn) => {
      btn.disabled = true;
      try {
        const r = (await api(`/report-subscriptions/${s.id}/send`, { method: 'POST', body: { to } })).data;
        if (r && r.ok) { toast(t('wk_sent', { n: r.sent })); reload(); } else $('#wk-perr', card).textContent = r && r.error === 'no_mail_service' ? t('wk_no_mail_long') : (r && r.error) || 'Error';
      } catch (e) { $('#wk-perr', card).textContent = e.message; }
      btn.disabled = false;
    };
    if ($('#wk-me', card)) $('#wk-me', card).onclick = (e) => send('me', e.target);
    if ($('#wk-all', card)) $('#wk-all', card).onclick = async () => {
      if (!(await confirmDialog(t('wk_send_confirm', { n: p.recipients.length }), t('wk_send_list', { n: p.recipients.length }), false))) return;
      try {
        const r = (await api(`/report-subscriptions/${s.id}/send`, { method: 'POST', body: { to: 'list' } })).data;
        if (r && r.ok) { toast(t('wk_sent', { n: r.sent })); reload(); } else toast((r && r.error) || 'Error', 'error');
      } catch (err) { toastError(err); }
    };
  });
}

function renderExport(el) {
  const meta = state.meta;
  el.innerHTML = `<form class="card" id="exp-form"><h2>${t('export_title')}</h2>
    <p class="muted small">${t('export_sub')}</p>
    <div class="field-row">
      ${meta.restaurants.length > 1 ? `<div class="field"><label>${t('restaurant')}</label><select name="restaurant_id"><option value="">${t('all_restaurants')}</option>
        ${meta.restaurants.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>${t('from')}</label><input type="date" name="from"></div>
      <div class="field"><label>${t('to')}</label><input type="date" name="to"></div>
    </div>
    <button class="btn-primary" type="submit">&#11015; ${t('export_xlsx')}</button></form>`;
  $('#exp-form').onsubmit = async (e) => {
    e.preventDefault();
    const fm = e.target; const btn = fm.querySelector('button[type=submit]');
    btn.disabled = true;
    await exportAll({ restaurant_id: fm.restaurant_id ? fm.restaurant_id.value : '', from: fm.from.value, to: fm.to.value });
    btn.disabled = false;
  };
}

async function renderAudit(el, bare = false) {
  const rows = (await api('/audit', { query: { limit: 200 } })).data;
  el.innerHTML = `<div class="${bare ? '' : 'card'}">${bare ? '' : `<h2>${t('set_audit')}</h2>`}<div class="table-wrap" style="${bare ? 'margin-top:10px' : ''}"><table><thead><tr>
    <th>${t('when')}</th><th>${t('user')}</th><th>${t('action')}</th><th>${t('entity')}</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap small">${fmt.dateTime(r.created_at)}</td><td>${esc(r.user_name || '–')}</td>
      <td><span class="badge">${esc(r.action)}</span></td><td>${esc(r.entity)} ${r.entity_id ? '#' + r.entity_id : ''}</td>
      <td class="small muted">${esc((r.details || '').slice(0, 120))}</td></tr>`).join('')}</tbody></table></div></div>`;
}

// Short description of a list's schedule, for the overview table
function scheduleLabel(sub) {
  const hour = `${String(sub.send_hour ?? 7).padStart(2, '0')}:00`;
  if (sub.schedule_mode === 'dates') {
    const ahead = (sub.send_dates || []).filter((d) => d >= todayIso()).sort();
    if (!ahead.length) return `<span class="badge warn">${t('wk_dates_none_short')}</span>`;
    return `${t('wk_next', { d: esc(fmt.date(ahead[0] + 'T12:00:00')) })} · ${hour}${ahead.length > 1 ? ` <span class="muted">(+${ahead.length - 1})</span>` : ''}`;
  }
  const d = (sub.send_days || [1]).map(Number).sort();
  const days = d.length === 7 ? t('open_every_day') : d.map((x) => weekdayName(x, 'short')).join(', ');
  return `${esc(days)} · ${hour}`;
}

// Weekday names in the current language (ISO: 1 = Monday)
function weekdayName(d, style = 'long') {
  return new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : 'nl-NL', { weekday: style }).format(new Date(Date.UTC(2026, 0, 4 + d)));
}
function openDaysLabel(days) {
  const d = (days || [1, 2, 3, 4, 5, 6, 7]).map(Number).sort();
  if (d.length === 7) return t('open_every_day');
  const run = d.every((x, i) => i === 0 || x === d[i - 1] + 1);
  return run && d.length > 2 ? `${weekdayName(d[0], 'short')} - ${weekdayName(d[d.length - 1], 'short')}` : d.map((x) => weekdayName(x, 'short')).join(', ');
}
