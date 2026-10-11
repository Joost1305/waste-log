// Settings › Organizations (platform admin): the list, and a new organization in one form:
// name and language, restaurants with open days and sections, a copy of an existing product list
// and suppliers, and the first admin who gets an invitation by e-mail.
import { state, api, esc, toast, toastError, openModal, formHtml, bindPlaceFields } from './core.js';
import { t, lang } from './i18n.js';

const day = (d, style = 'short') => new Intl.DateTimeFormat(lang() === 'en' ? 'en-GB' : 'nl-NL', { weekday: style }).format(new Date(Date.UTC(2026, 0, 4 + d)));

export async function renderOrganizations(el) {
  el.innerHTML = `<div class="card"><div class="page-head" style="margin-bottom:8px"><h2 style="margin:0">${t('set_orgs')}</h2>
    <div class="page-actions"><button class="btn-primary btn-sm" id="org-new">+ ${t('ow_new')}</button></div></div>
    <p class="muted small">${t('ow_sub')}</p><div id="org-list"><span class="spinner"></span></div></div>`;
  let orgs = [];
  const load = async () => {
    try { orgs = (await api('/organizations')).data || []; } catch (e) { toastError(e); return; }
    el.querySelector('#org-list').innerHTML = `<div class="table-wrap"><table class="stack"><thead><tr><th>${t('name')}</th><th class="right">${t('restaurants_count')}</th><th></th></tr></thead><tbody>
      ${orgs.map((o) => `<tr><td data-label="${t('name')}">${esc(o.name)} ${o.is_demo ? '<span class="badge demo">DEMO</span>' : ''}</td>
        <td class="right num" data-label="${t('restaurants_count')}">${o.restaurant_count}</td>
        <td class="actions">${o.id === state.orgId ? `<span class="muted small">${t('ow_current')}</span>` : `<button class="btn-sm" data-go="${o.id}">${t('ow_open')}</button>`}</td></tr>`).join('')}
      </tbody></table></div>`;
    el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => switchTo(Number(b.dataset.go))));
  };
  el.querySelector('#org-new').onclick = () => wizard(orgs, load);
  load();
}

function switchTo(id) {
  state.orgId = id;
  try { localStorage.setItem('fw_org', String(id)); } catch { /* private mode */ }
  location.hash = '#/settings/restaurants';
  location.reload();
}

const restRow = (i, r = {}) => `<div class="ow-rest" data-r="${i}">
  <div class="field-row"><div class="field"><label>${t('name')}</label><input data-k="name" value="${esc(r.name || '')}" placeholder="${t('ow_rest_ph')}"></div>
    </div>
  ${formHtml([{ name: 'city', label: t('place_label'), type: 'place', placeholder: t('place_ph') }], {})}
  <div class="field"><label>${t('open_days')}</label><div class="ow-days">${[1, 2, 3, 4, 5, 6, 7].map((d) =>
    `<label class="ow-day"><input type="checkbox" data-day="${d}" ${(r.open_days || [1, 2, 3, 4, 5]).includes(d) ? 'checked' : ''}><span>${day(d)}</span></label>`).join('')}</div></div>
  <div class="field"><label>${t('ow_sections')}</label><input data-k="sections" value="${esc(r.sections || '')}" placeholder="${t('ow_sections_ph')}"></div>
  ${i > 0 ? `<button type="button" class="btn-sm btn-ghost btn-danger" data-rm="${i}">${t('delete')}</button>` : ''}</div>`;

function wizard(orgs, done) {
  const sources = orgs.filter((o) => !o.is_demo);
  const defSrc = (sources.find((o) => o.id === state.orgId) || sources[0] || orgs[0] || {}).id;
  let n = 1;
  openModal(`<div class="ow-modal"><h2>${t('ow_new')}</h2>
    <h3>1. ${t('ow_s_org')}</h3>
    <div class="field-row"><div class="field" style="flex:2"><label>${t('name')}</label><input id="ow-name" placeholder="${t('ow_name_ph')}" required></div>
      <div class="field"><label>${t('language')}</label><select id="ow-lang"><option value="en">English</option><option value="nl">Nederlands</option></select></div>
      <div class="field"><label>${t('default_value')}</label><input id="ow-val" inputmode="decimal" value="6.5"></div></div>
    <h3>2. ${t('ow_s_rest')}</h3>
    <div id="ow-rests">${restRow(0)}</div>
    <button type="button" class="btn-sm" id="ow-add-rest">+ ${t('ow_add_rest')}</button>
    <h3>3. ${t('ow_s_data')}</h3>
    <label class="check"><input type="checkbox" id="ow-copy" ${defSrc ? 'checked' : ''}> ${t('ow_copy_products')}</label>
    <div class="field" style="margin-top:6px"><select id="ow-src">${orgs.map((o) => `<option value="${o.id}" ${o.id === defSrc ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}</select></div>
    <label class="check"><input type="checkbox" id="ow-sups" checked> ${t('ow_copy_suppliers')}</label>
    <h3>4. ${t('ow_s_admin')}</h3>
    <p class="muted small">${t('ow_admin_sub')}</p>
    <div class="field-row"><div class="field"><label>${t('name')}</label><input id="ow-aname"></div>
      <div class="field"><label>${t('email')}</label><input id="ow-amail" type="email"></div></div>
    <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button><button type="button" class="btn-primary" id="ow-create">${t('ow_create')}</button></div></div>`,
  (card, close) => {
    document.getElementById('modal').onclick = null;
    const rests = card.querySelector('#ow-rests');
    const bindRm = () => rests.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => b.closest('.ow-rest').remove()));
    bindPlaceFields(rests);
    card.querySelector('#ow-add-rest').onclick = () => { rests.insertAdjacentHTML('beforeend', restRow(n++)); bindRm(); bindPlaceFields(rests.lastElementChild); rests.lastElementChild.querySelector('input').focus(); };
    const copy = card.querySelector('#ow-copy');
    const syncCopy = () => { card.querySelector('#ow-src').disabled = !copy.checked; card.querySelector('#ow-sups').disabled = !copy.checked; };
    copy.onchange = syncCopy; syncCopy();
    card.querySelector('#ow-create').onclick = async (e) => {
      const name = card.querySelector('#ow-name').value.trim();
      if (!name) { toast(t('ow_need_name'), 'error'); card.querySelector('#ow-name').focus(); return; }
      const restaurants = [...rests.querySelectorAll('.ow-rest')].map((r) => ({
        name: r.querySelector('[data-k="name"]').value.trim(),
        city: r.querySelector('[name="city"]').value.trim(),
        latitude: Number(r.querySelector('[name="latitude"]').value) || null,
        longitude: Number(r.querySelector('[name="longitude"]').value) || null,
        open_days: [...r.querySelectorAll('[data-day]:checked')].map((x) => Number(x.dataset.day)),
        sections: r.querySelector('[data-k="sections"]').value.split(',').map((x) => x.trim()).filter(Boolean),
      })).filter((r) => r.name);
      if (!restaurants.length) { toast(t('ow_need_rest'), 'error'); return; }
      const aname = card.querySelector('#ow-aname').value.trim();
      const amail = card.querySelector('#ow-amail').value.trim();
      if ((aname || amail) && !(aname && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(amail))) { toast(t('ow_need_admin'), 'error'); return; }
      const lng = card.querySelector('#ow-lang').value;
      e.target.disabled = true;
      let res;
      try {
        res = (await api('/organizations/full', { method: 'POST', body: {
          name, default_language: lng, default_value_per_kg: Number(card.querySelector('#ow-val').value.replace(',', '.')) || 6.5,
          restaurants, copy_products_from: copy.checked ? Number(card.querySelector('#ow-src').value) : null,
          copy_suppliers: copy.checked && card.querySelector('#ow-sups').checked } })).data;
      } catch (err) { toastError(err); e.target.disabled = false; return; }
      let invited = '';
      if (aname && amail) {
        try { await api(`/organizations/${res.id}/admin`, { method: 'POST', body: { name: aname, email: amail, language: lng } }); invited = amail; }
        catch (err) { toastError(err); }
      }
      close();
      done && done();
      openModal(`<h2>${t('ow_done_title', { o: esc(name) })}</h2>
        <ul><li>${t('ow_done_rest', { r: res.restaurants, s: res.sections })}</li>
          <li>${t('ow_done_prod', { p: res.products, s: res.suppliers })}</li>
          <li>${invited ? t('ow_done_invite', { e: esc(invited) }) : t('ow_done_noinvite')}</li></ul>
        <p class="muted small">${t('ow_done_next')}</p>
        <div class="modal-actions"><button type="button" data-close>${t('close')}</button><button type="button" class="btn-primary" id="ow-go">${t('ow_open_new')}</button></div>`,
      (c2) => { c2.querySelector('#ow-go').onclick = () => switchTo(res.id); });
    };
  });
}
