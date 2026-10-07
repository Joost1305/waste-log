// Shared helpers: API client, app state, formatting, DOM, toast, modal, forms.
import { t, lang, setLang, LANGS } from './i18n.js';

export const state = { user: null, meta: null, orgId: Number(localStorage.getItem('fw_org')) || null };

// ------------------------------------------------------------------ API
// All calls go through backend.js (Supabase). Same shape as before: { ok, data, meta }.
import { request, setContext, ApiError as BackendError } from './backend.js';
export const ApiError = BackendError;

export async function api(path, opts = {}) {
  setContext({ orgId: state.orgId, lang: lang() });
  try {
    return await request(path, opts);
  } catch (e) {
    if (e.status === 401 && !path.startsWith('/auth/')) { state.user = null; location.hash = '#/login'; }
    throw e;
  }
}

export async function loadMeta() {
  state.meta = (await api('/meta')).data;
  if (state.meta.organization) state.orgId = state.meta.organization.id;
  setContext({ orgId: state.orgId });
  return state.meta;
}

// ------------------------------------------------------------------ formatting
const locale = () => (lang() === 'en' ? 'en-GB' : 'nl-NL');
// Accepts ISO strings from Postgres/Supabase ('2026-10-07T19:26:03+00:00', '2026-10-07 19:26:03+00'),
// plain dates and Date objects. Returns null for anything unreadable instead of throwing.
function toDate(s) {
  if (!s) return null;
  if (s instanceof Date) return Number.isNaN(s.getTime()) ? null : s;
  let str = String(s).trim().replace(' ', 'T');
  if (/T\d{2}:\d{2}.*[+-]\d{2}$/.test(str)) str += ':00';
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}
export const fmt = {
  kg(n, d = 1) {
    if (n == null) return '–';
    if (Math.abs(n) < 1) return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: 0 }).format(n * 1000)} g`;
    return `${new Intl.NumberFormat(locale(), { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n)} kg`;
  },
  num(n, d = 0) { return n == null ? '–' : new Intl.NumberFormat(locale(), { maximumFractionDigits: d }).format(n); },
  money(n, d = 0) {
    if (n == null) return '–';
    const cur = (state.meta && state.meta.organization && state.meta.organization.currency) || 'EUR';
    return new Intl.NumberFormat(locale(), { style: 'currency', currency: cur, maximumFractionDigits: d, minimumFractionDigits: d }).format(n);
  },
  pct(n, d = 0) { return n == null ? '–' : `${new Intl.NumberFormat(locale(), { maximumFractionDigits: d }).format(n)}%`; },
  date(s) { const d = toDate(s); return d ? new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', year: 'numeric' }).format(d) : '–'; },
  dateTime(s) { const d = toDate(s); return d ? new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(d) : '–'; },
  time(s) { const d = toDate(s); return d ? new Intl.DateTimeFormat(locale(), { hour: '2-digit', minute: '2-digit' }).format(d) : ''; },
};
export const todayIso = () => new Date().toLocaleDateString('sv-SE');
export const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return d.toLocaleDateString('sv-SE'); };

// ------------------------------------------------------------------ DOM
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export const app = () => document.getElementById('app');

let toastTimer;
export function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, type === 'error' ? 4500 : 2600);
}
export function toastError(e) {
  const details = e.body && e.body.error && e.body.error.details;
  const extra = Array.isArray(details) && details.length ? `: ${details.map((d) => `${d.field} ${d.message}`).join(', ')}` : '';
  toast(`${e.message || t('error')}${extra}`, 'error');
}

// ------------------------------------------------------------------ modal
export function openModal(html, onMount) {
  const m = document.getElementById('modal');
  const card = m.querySelector('.modal-card');
  card.innerHTML = html;
  m.hidden = false;
  const close = () => { m.hidden = true; card.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  m.onclick = (e) => { if (e.target === m) close(); };
  card.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
  if (onMount) onMount(card, close);
  const first = card.querySelector('input, select, textarea');
  if (first) first.focus();
  return close;
}

export function confirmDialog(message, okLabel, danger = true) {
  return new Promise((resolve) => {
    openModal(`<p>${esc(message)}</p><div class="modal-actions">
      <button data-close>${t('cancel')}</button><button class="btn-primary ${danger ? 'btn-danger' : ''}" id="cf-ok">${esc(okLabel || t('delete'))}</button></div>`,
    (card, close) => { card.querySelector('#cf-ok').onclick = () => { close(); resolve(true); };
      card.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => { close(); resolve(false); })); });
  });
}

// ------------------------------------------------------------------ forms
// fields: [{ name, label, type: text|number|email|password|date|select|multiselect|checkbox|textarea, options:[{value,label}], step, required }]
export function formHtml(fields, values = {}) {
  return fields.map((f) => {
    const v = values[f.name];
    const req = f.required ? 'required' : '';
    if (f.type === 'help') return `<div class="note" style="margin:0 0 14px">${esc(f.label)}</div>`;
    if (f.type === 'checkbox') {
      return `<div class="field"><label class="check"><input type="checkbox" name="${f.name}" ${v ? 'checked' : ''}> ${esc(f.label)}</label></div>`;
    }
    if (f.type === 'select') {
      const opts = (f.blank !== false ? `<option value="">${esc(f.blankLabel || t('none'))}</option>` : '') +
        f.options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(v ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`).join('');
      return `<div class="field"><label>${esc(f.label)}</label><select name="${f.name}" ${req}>${opts}</select></div>`;
    }
    if (f.type === 'multiselect') {
      const set = new Set((v || []).map(String));
      return `<div class="field"><label>${esc(f.label)}</label>${f.options.map((o) =>
        `<label class="check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}" ${set.has(String(o.value)) ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}</div>`;
    }
    if (f.type === 'textarea') {
      return `<div class="field"><label>${esc(f.label)}</label><textarea name="${f.name}" rows="3" ${req}>${esc(v ?? '')}</textarea></div>`;
    }
    return `<div class="field"><label>${esc(f.label)}</label><input type="${f.type || 'text'}" name="${f.name}" value="${esc(v ?? '')}"
      ${f.step ? `step="${f.step}"` : ''} ${f.type === 'number' ? 'inputmode="decimal"' : ''} ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${req}></div>`;
  }).join('');
}

export function readForm(root, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'multiselect') { out[f.name] = $$(`input[name="${f.name}"]:checked`, root).map((i) => Number(i.value)); continue; }
    const el = root.querySelector(`[name="${f.name}"]`);
    if (!el) continue;
    if (f.type === 'checkbox') { out[f.name] = el.checked; continue; }
    const raw = el.value.trim();
    if (f.type === 'number' || f.numeric) out[f.name] = raw === '' ? null : Number(raw.replace(',', '.'));
    else if (f.type === 'select' && f.numericValue !== false && raw !== '' && /^\d+$/.test(raw)) out[f.name] = Number(raw);
    else out[f.name] = raw === '' ? (f.emptyAsUndefined ? undefined : null) : raw;
    if (f.emptyAsUndefined && out[f.name] == null) delete out[f.name];
  }
  return out;
}

export const labelOf = (list, id) => { const x = (list || []).find((i) => i.id === id); return x ? (x.label || x.name) : ''; };

// ------------------------------------------------------------------ language switch
// EN | NL switch. Saved to the user's profile when signed in, otherwise only in this browser.
export function renderLangToggle(el) {
  el.innerHTML = Object.keys(LANGS).map((l) =>
    `<button type="button" data-lang="${l}" class="${l === lang() ? 'on' : ''}" aria-pressed="${l === lang()}" title="${esc(LANGS[l])}">${l.toUpperCase()}</button>`).join('');
  el.querySelectorAll('[data-lang]').forEach((b) => (b.onclick = async () => {
    const l = b.dataset.lang;
    if (l === lang()) return;
    setLang(l);
    if (state.user) {
      try { const res = await api('/auth/me', { method: 'PATCH', body: { language: l } }); state.user = res.data.user || { ...state.user, language: l }; }
      catch (e) { toastError(e); }
    }
    window.dispatchEvent(new Event('fw:lang'));
  }));
}


// ------------------------------------------------------------------ print
// A header that only appears on paper: organization, page title, selection and print date.
export function printHeader(title, selection) {
  const org = (state.meta && state.meta.organization && state.meta.organization.name) || '';
  return `<div class="print-only print-head"><div><strong>WASTE log</strong> · ${esc(org)}</div>
    <div class="print-title">${esc(title)}</div>${selection ? `<div>${esc(selection)}</div>` : ''}
    <div class="small">${t('printed')}: ${fmt.dateTime(new Date().toISOString())}</div></div>`;
}
export function printPage() { window.print(); }

// Charts are drawn on canvas at screen size; redraw them at paper size before printing and back after.
function resizeCharts() {
  if (!window.Chart) return;
  Object.values(window.Chart.instances || {}).forEach((c) => { try { c.resize(); } catch { /* chart gone */ } });
}
window.addEventListener('beforeprint', resizeCharts);
window.addEventListener('afterprint', resizeCharts);
