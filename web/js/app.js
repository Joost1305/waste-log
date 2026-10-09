// App shell and router (hash based, no build step).
import { state, api, loadMeta, $, esc, app, toastError, renderLangToggle } from './core.js';
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

const routes = [
  { path: 'register', render: renderRegister, nav: 'nav_register', show: () => true },
  { path: 'dashboard', render: renderDashboard, nav: 'nav_dashboard', show: (p) => p.dashboard },
  { path: 'records', render: renderRecords, nav: 'nav_records', show: () => true },
  { path: 'gallery', render: renderGallery, nav: 'nav_gallery', show: () => true },
  { path: 'interventions', render: renderInterventions, nav: 'nav_interventions', show: () => true },
  { path: 'leaderboard', render: renderLeaderboard, nav: 'nav_leaderboard', show: () => !!(state.meta && state.meta.organization && state.meta.organization.leaderboard_enabled) },
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
    await loadMeta();
    return true;
  } catch { return false; }
}

async function renderShell() {
  const top = $('#topbar');
  const banner = $('#demo-banner');
  if (!state.user) { top.hidden = true; banner.hidden = true; return; }
  top.hidden = false;
  const p = state.meta.permissions;
  const current = location.hash.replace(/^#\//, '').split('/')[0] || homePath();
  const nav = $('#nav');
  nav.innerHTML = routes.filter((r) => r.show(p)).map((r) =>
    `<a href="#/${r.path}" class="${current === r.path ? 'active' : ''}">${t(r.nav)}</a>`).join('') +
    `<a href="#/logout">${t('nav_logout')}</a>`;
  nav.classList.remove('open');
  $('#menu-toggle').onclick = () => nav.classList.toggle('open');

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
  app().className = 'app';
  window.scrollTo(0, 0);
  try { await r.render(rest); } catch (e) { console.error(e); toastError(e); }
}

window.addEventListener('hashchange', route);
window.addEventListener('fw:lang', async () => { resetCo2Cache(); if (state.user) await loadMeta(); route(); });
// Opening the app (or reopening a saved tab or home-screen icon) always lands on registration,
// whatever page was open last time. Invitation and password links are left alone.
if (!authLink && !/^#\/(login|impact)/.test(location.hash) && location.hash !== '#/register') {
  history.replaceState(null, '', `${location.pathname}${location.search}#/register`);
}
route();
