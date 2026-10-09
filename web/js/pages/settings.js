// Settings: products, suppliers, dishes, guests per day, targets, restaurants, users,
// organization, audit log and (super admin) organizations. One generic CRUD view.
import { state, api, app, esc, fmt, toast, toastError, todayIso, $, $$, openModal, confirmDialog, formHtml, readForm, loadMeta, labelOf } from '../core.js';
import { t, LANGS } from '../i18n.js';
import { exportAll } from '../export.js';
import { openProductImport } from '../product-import.js';

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
      headerActions: [{ label: `&#11014; ${t('imp_btn')}`, run: (reload) => openProductImport(reload) }],
      columns: [
        [t('name'), (r) => `${esc(r.name)} ${r.is_demo ? '<span class="badge demo">DEMO</span>' : ''}`],
        [t('name_en_col'), (r) => `<span class="muted">${esc(r.name_en || '')}</span>`],
        [t('category'), (r) => esc(labelOf(meta.waste_categories, r.waste_category_id))],
        [t('reg_supplier'), (r) => esc(r.supplier_name || '')],
        [t('price_kg'), (r) => fmt.money(r.purchase_price_per_kg, 2), true],
        [t('quick_pick'), (r) => yes(r.is_quick_pick)],
      ],
      fields: () => [
        { name: 'name', label: t('name_nl_field'), required: true },
        { name: 'name_en', label: t('name_en_field') },
        { name: 'waste_category_id', label: t('category'), type: 'select', blank: false, options: catOpts() },
        { name: 'category_id', label: t('subcategory'), type: 'select', options: meta.subcategories.map((c) => ({ value: c.id, label: `${labelOf(meta.waste_categories, c.waste_category_id)} › ${c.label}` })) },
        { name: 'default_supplier_id', label: t('default_supplier'), type: 'select', options: meta.suppliers.map((s) => ({ value: s.id, label: s.name })) },
        { name: 'purchase_price_per_kg', label: t('price_kg'), type: 'number', step: '0.01' },
        { name: 'sales_price_per_kg', label: t('sales_kg'), type: 'number', step: '0.01' },
        { name: 'is_quick_pick', label: t('quick_pick'), type: 'checkbox' },
        { name: 'is_active', label: t('active'), type: 'checkbox', default: true },
      ],
    },
    p.catalog && {
      key: 'suppliers', title: t('set_suppliers'), endpoint: '/suppliers', canEdit: true, reloadMeta: true,
      columns: [[t('name'), (r) => esc(r.name)], [t('contact'), (r) => esc(r.contact || '')]],
      fields: () => [{ name: 'name', label: t('name'), required: true }, { name: 'contact', label: t('contact') }],
    },
    p.catalog && {
      key: 'menu', title: t('set_menu'), endpoint: '/menu-items', canEdit: true, reloadMeta: true,
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
      columns: [[t('name'), (r) => esc(r.name)], [t('city'), (r) => esc(r.city || '')], [t('public_impact'), (r) => yes(r.public_impact_enabled)]],
      fields: () => [
        { name: 'name', label: t('name'), required: true }, { name: 'city', label: t('city') },
        { name: 'latitude', label: t('latitude'), type: 'number', step: 'any' }, { name: 'longitude', label: t('longitude'), type: 'number', step: 'any' },
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
        { name: 'restaurant_ids', label: t('restaurants'), type: 'multiselect', options: restOpts() },
        { name: 'language', label: t('language'), type: 'select', blank: false, numericValue: false, options: Object.entries(LANGS).map(([v, l]) => ({ value: v, label: l })) },
        ...(row ? [] : [{ name: 'invite', label: t('invite_email'), type: 'checkbox', default: true }]),
        { name: 'password', label: row ? `${t('new_password')} (${t('pw_optional')})` : `${t('password')} (min. 8)`, type: 'password', emptyAsUndefined: true },
        { name: 'is_active', label: t('active'), type: 'checkbox', default: true },
      ],
    },
    p.dashboard && { key: 'weekly', title: t('set_weekly'), custom: renderWeekly },
    p.dashboard && { key: 'leaderboard', title: t('set_leaderboard'), custom: renderLeaderboardSettings },
    p.dashboard && { key: 'export', title: t('set_export'), custom: renderExport },
    p.org_settings && { key: 'organization', title: t('set_org'), custom: renderOrg },
    p.audit && { key: 'audit', title: t('set_audit'), custom: renderAudit },
    p.organizations && {
      key: 'organizations', title: t('set_orgs'), endpoint: '/organizations', canEdit: false, canDelete: false, afterSave: () => location.reload(),
      columns: [[t('name'), (r) => `${esc(r.name)} ${r.is_demo ? '<span class="badge demo">DEMO</span>' : ''}`], [t('restaurants_count'), (r) => r.restaurant_count, true]],
      fields: () => [{ name: 'name', label: t('name'), required: true }, { name: 'default_value_per_kg', label: t('default_value'), type: 'number', step: '0.01', default: 6.5 }],
    },
  ].filter(Boolean);
}

export async function renderSettings(rest) {
  const list = sections();
  const current = list.find((s) => s.key === rest[0]) || list[0];
  app().innerHTML = `
    <div class="page-head"><h1>${t('set_title')}</h1></div>
    <div class="settings">
      <nav class="settings-nav">${list.map((s) => `<a href="#/settings/${s.key}" class="${s === current ? 'active' : ''}">${s.title}</a>`).join('')}</nav>
      <div id="set-body"></div>
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
    $('#crud-list').innerHTML = rows.length ? `<div class="table-wrap"><table><thead><tr>
      ${cfg.columns.map((c) => `<th class="${c[2] ? 'right' : ''}">${c[0]}</th>`).join('')}<th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr>${cfg.columns.map((c) => `<td class="${c[2] ? 'right num' : ''}">${c[1](r) ?? ''}</td>`).join('')}
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
  ];
  el.innerHTML = `<form class="card" id="org-form"><h2>${t('set_org')}</h2>${formHtml(fields, org)}
    <button class="btn-primary" type="submit">${t('save')}</button></form>`;
  $('#org-form').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('/organization', { method: 'PATCH', body: readForm(el, fields) }); await loadMeta(); toast(t('org_saved')); } catch (err) { toastError(err); }
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
  $('#wk-list', el).innerHTML = `<div class="table-wrap"><table><thead><tr><th>${t('restaurant')}</th><th>${t('wk_recipients')}</th><th>${t('language')}</th><th>${t('status')}</th><th></th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr><td><strong>${esc(r.name)}</strong></td>
      <td class="small">${r.sub && r.sub.recipients.length ? `${esc(r.sub.recipients.slice(0, 2).join(', '))}${r.sub.recipients.length > 2 ? ` +${r.sub.recipients.length - 2}` : ''}` : '<span class="muted">–</span>'}</td>
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
      <div class="field"><label class="check"><input type="checkbox" name="is_active" ${!s || s.is_active ? 'checked' : ''}> ${t('wk_active')}</label></div>
      ${s && s.last_status ? `<p class="small muted">${t('wk_last_status')}: ${esc(s.last_status === 'no_mail_service' ? t('wk_no_mail') : s.last_status)}</p>` : ''}
      <div class="err" id="wk-err"></div>
      <div class="modal-actions" style="flex-wrap:wrap">
        ${s ? `<button type="button" class="btn-ghost btn-danger" id="wk-del" style="margin-right:auto">${t('delete')}</button>
          <button type="button" class="btn-sm" id="wk-prev">${t('wk_preview')}</button>` : ''}
        <button type="button" data-close>${t('cancel')}</button><button class="btn-primary">${t('save')}</button></div>
    </form>`, (card, close) => {
    const read = () => {
      const recipients = $('[name=recipients]', card).value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
      const bad = recipients.find((x) => !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(x));
      if (bad) throw new Error(t('wk_bad', { e: bad }));
      return { recipients, language: $('[name=language]', card).value, is_active: $('[name=is_active]', card).checked };
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

async function renderAudit(el) {
  const rows = (await api('/audit', { query: { limit: 200 } })).data;
  el.innerHTML = `<div class="card"><h2>${t('set_audit')}</h2><div class="table-wrap"><table><thead><tr>
    <th>${t('when')}</th><th>${t('user')}</th><th>${t('action')}</th><th>${t('entity')}</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="nowrap small">${fmt.dateTime(r.created_at)}</td><td>${esc(r.user_name || '–')}</td>
      <td><span class="badge">${esc(r.action)}</span></td><td>${esc(r.entity)} ${r.entity_id ? '#' + r.entity_id : ''}</td>
      <td class="small muted">${esc((r.details || '').slice(0, 120))}</td></tr>`).join('')}</tbody></table></div></div>`;
}
