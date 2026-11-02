// App shell and router (hash based, no build step).
import { state, api, loadMeta, $, esc, app, toastError, renderLangToggle, compactActions } from './core.js';
import { t, setLang } from './i18n.js';
import { resetCo2Cache } from './co2.js';
import { renderLogin } from './pages/login.js';
import { renderRegister } from './pages/register.js';
import { renderRecords } from './pages/records.js';
import { renderGallery } from './pages/gallery.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderSettings } from './pages/settings.js';
import { renderProfile } from './pages/profile.js';
import { renderSetPassword } from './pages/set-password.js';
import { renderImpact } from './pages/impact.js';
import { renderInterventions } from './pages/interventions.js';
import { renderLeaderboard } from './pages/leaderboard.js';

// Line icons for the menu (24x24, stroke). Shown in the bottom bar on phones.
const svg = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  register: svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  dashboard: svg('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  records: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  gallery: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/>'),
  interventions: svg('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>'),
  leaderboard: svg('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M17 6h3a3 3 0 0 1-3 4M7 6H4a3 3 0 0 0 3 4"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  profile: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2.2-2.4 3.7M12 17h.01"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  more: svg('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>'),
};
// Phone bottom bar: the first four visible pages in this order get a tab, the rest go under More.
// Staff: Register, Records, Improve, Gallery. Managers: Register, Dashboard, Records, Improve.
const TAB_ORDER = ['register', 'dashboard', 'records', 'interventions', 'gallery', 'leaderboard', 'settings', 'profile'];

// Pages an organization admin can hide per role (Settings > Page access). Register, Settings and Profile always stay.
const hidden = (path) => !!(state.meta && Array.isArray(state.meta.hidden_pages) && state.meta.hidden_pages.includes(path));

const routes = [
  { path: 'register', render: renderRegister, nav: 'nav_register', show: () => true },
  { path: 'dashboard', render: renderDashboard, nav: 'nav_dashboard', show: (p) => p.dashboard && !hidden('dashboard') },
  { path: 'records', render: renderRecords, nav: 'nav_records', show: () => !hidden('records') },
  { path: 'gallery', render: renderGallery, nav: 'nav_gallery', show: () => !hidden('gallery') },
  { path: 'interventions', render: renderInterventions, nav: 'nav_interventions', show: () => !hidden('interventions') },
  { path: 'leaderboard', render: renderLeaderboard, nav: 'nav_leaderboard', show: () => !hidden('leaderboard') && !!(state.meta && state.meta.organization && state.meta.organization.leaderboard_enabled) },
  { path: 'settings', render: renderSettings, nav: 'nav_settings', show: (p) => p.catalog || p.users },
  { path: 'profile', render: renderProfile, nav: 'nav_profile', show: () => true },
];

// Everyone starts on registration: that is the page used most, on the kitchen floor.
function homePath() {
  return 'register';
}

async function ensureSession() {
  if (state.user) return true;
  try {
    const me = await api('/auth/me');
    state.user = me.data.user;
    setLang(state.user.language || 'en');
    if (state.user.role !== 'super_admin') state.orgId = state.user.organization_id;
    else if (state.user.organization_id) { // super admin: every start opens in their own organization (the trial); switching still works during use
      state.orgId = state.user.organization_id;
      try { localStorage.setItem('fw_org', String(state.orgId)); } catch { /* private mode */ }
    }
    await loadMeta();
    return true;
  } catch { return false; }
}

async function renderShell() {
  const top = $('#topbar');
  const banner = $('#demo-banner');
  if (!state.user) { top.hidden = true; banner.hidden = true; $('#tabbar').hidden = true; $('#more-sheet').hidden = true; return; }
  top.hidden = false;
  const p = state.meta.permissions;
  const current = location.hash.replace(/^#\//, '').split('/')[0] || homePath();
  const visible = routes.filter((r) => r.show(p));
  const nav = $('#nav');
  nav.innerHTML = visible.map((r) =>
    `<a href="#/${r.path}" class="${current === r.path ? 'active' : ''}">${t(r.nav)}</a>`).join('') +
    `<a href="#/logout">${t('nav_logout')}</a>`;
  renderTabbar(visible, current, p);

  renderLangToggle($('#lang-toggle'));

  banner.hidden = !state.meta.organization || !state.meta.organization.is_demo;
  banner.textContent = t('demo_banner');

  // Super admin: organization switcher
  const sw = $('#org-switch');
  if (state.user.role === 'super_admin') {
    const orgs = (await api('/organizations')).data;
    sw.hidden = false;
    sw.innerHTML = orgs.map((o) => `<option value="${o.id}" ${o.id === state.meta.organization?.id ? 'selected' : ''}>${esc(o.name)}</option>`).join('');
    sw.onchange = async () => {
      state.orgId = Number(sw.value);
      localStorage.setItem('fw_org', String(state.orgId));
      await loadMeta();
      route();
    };
  } else sw.hidden = true;
}

function renderTabbar(visible, current, p) {
  const bar = $('#tabbar');
  const byPath = Object.fromEntries(visible.map((r) => [r.path, r]));
  const ordered = TAB_ORDER.filter((x) => byPath[x]).map((x) => byPath[x]);
  const tabs = ordered.slice(0, 4);
  const rest = ordered.slice(4);
  const inMore = rest.some((r) => r.path === current);
  const tab = (href, icon, label, on) => `<a href="${href}" class="tab ${on ? 'active' : ''}" ${on ? 'aria-current="page"' : ''}>${ICONS[icon]}<span>${label}</span></a>`;
  bar.innerHTML = tabs.map((r) => tab(`#/${r.path}`, r.path, t(r.nav), current === r.path)).join('') +
    `<button type="button" class="tab ${inMore ? 'active' : ''}" id="tab-more" aria-haspopup="true">${ICONS.more}<span>${t('nav_more')}</span></button>`;
  bar.hidden = false;
  const sheet = $('#more-sheet');
  const item = (href, icon, label, on, ext) => `<a href="${href}" class="more-item ${on ? 'active' : ''}" ${ext ? 'target="_blank" rel="noopener"' : ''}>${ICONS[icon]}<span>${label}</span></a>`;
  sheet.querySelector('.more-card').innerHTML = `<div class="more-grab" aria-hidden="true"></div>
    ${rest.map((r) => item(`#/${r.path}`, r.path, t(r.nav), current === r.path)).join('')}
    ${item('help/staff.html', 'help', t('nav_help'), false, true)}
    ${p.dashboard ? item('help/admins.html', 'help', t('help_admin'), false, true) : ''}
    ${item('#/logout', 'logout', t('nav_logout'), false)}`;
  const close = () => { sheet.hidden = true; };
  $('#tab-more').onclick = () => { sheet.hidden = !sheet.hidden; };
  sheet.onclick = (e) => { if (e.target === sheet || e.target.closest('a')) close(); };
  close();
}

// Arriving from an invitation or password-reset email: the link carries the sign-in in the URL.
// The auth library signs the person in; we then ask them to choose a password.
const authLink = (() => {
  const h = new URLSearchParams(String(window.__authHash || '').replace(/^#/, ''));
  if (h.get('error_description')) return { error: h.get('error_description') };
  return ['invite', 'recovery', 'signup', 'magiclink'].includes(h.get('type')) ? { type: h.get('type') } : null;
})();

async function route() {
  if (authLink && !authLink.handled) {
    authLink.handled = true;
    if (authLink.error) { location.hash = '#/login'; setTimeout(() => toastError(new Error(authLink.error)), 300); return; }
    if (await ensureSession()) {
      await renderShell();
      return renderSetPassword(() => { location.hash = `#/${homePath()}`; });
    }
    location.hash = '#/login'; return;
  }
  const [path, ...rest] = location.hash.replace(/^#\//, '').split('/');
  if (path === 'logout') {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null; state.meta = null;
    location.hash = '#/login';
    return;
  }
  // Public impact page: open to everyone, no sign-in, no app menu
  if (path === 'impact') { window.scrollTo(0, 0); return renderImpact(rest); }
  if (path === 'login') {
    state.user = null;
    await renderShell();
    return renderLogin(async () => { await ensureSession(); location.hash = `#/${homePath()}`; });
  }
  if (!(await ensureSession())) { location.hash = '#/login'; return; }
  const r = routes.find((x) => x.path === path && x.show(state.meta.permissions));
  if (!r) { location.hash = `#/${homePath()}`; return; }
  await renderShell();
  // The big kitchen-TV leaderboard runs full screen: no bottom bar
  document.body.classList.toggle('screen-mode', path === 'leaderboard' && rest[0] === 'screen');
  app().className = 'app';
  window.scrollTo(0, 0);
  try { await r.render(rest); } catch (e) { console.error(e); toastError(e); }
}

// Pages draw their header (sometimes after loading data); fold their buttons for phones whenever one appears.
new MutationObserver(() => compactActions(app())).observe(app(), { childList: true, subtree: true });

window.addEventListener('hashchange', route);
window.addEventListener('fw:lang', async () => { resetCo2Cache(); if (state.user) await loadMeta(); route(); });
// Opening the app (or reopening a saved tab or home-screen icon) always lands on registration,
// whatever page was open last time. Invitation and password links are left alone.
if (!authLink && !/^#\/(login|impact)/.test(location.hash) && location.hash !== '#/register') {
  history.replaceState(null, '', `${location.pathname}${location.search}#/register`);
}
route();
