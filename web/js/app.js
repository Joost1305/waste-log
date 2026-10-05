// App shell and router (hash based, no build step).
import { state, api, loadMeta, $, esc, app, toastError } from './core.js';
import { t, setLang } from './i18n.js';
import { renderLogin } from './pages/login.js';
import { renderRegister } from './pages/register.js';
import { renderRecords } from './pages/records.js';
import { renderDashboard } from './pages/dashboard.js';
import { renderSettings } from './pages/settings.js';
import { renderProfile } from './pages/profile.js';

const routes = [
  { path: 'register', render: renderRegister, nav: 'nav_register', show: () => true },
  { path: 'dashboard', render: renderDashboard, nav: 'nav_dashboard', show: (p) => p.dashboard },
  { path: 'records', render: renderRecords, nav: 'nav_records', show: () => true },
  { path: 'settings', render: renderSettings, nav: 'nav_settings', show: (p) => p.catalog || p.users },
  { path: 'profile', render: renderProfile, nav: 'nav_profile', show: () => true },
];

function homePath() {
  return state.meta && state.meta.permissions.dashboard ? 'dashboard' : 'register';
}

async function ensureSession() {
  if (state.user) return true;
  try {
    const me = await api('/auth/me');
    state.user = me.data.user;
    setLang(state.user.language || 'nl');
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

async function route() {
  const [path, ...rest] = location.hash.replace(/^#\//, '').split('/');
  if (path === 'logout') {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null; state.meta = null;
    location.hash = '#/login';
    return;
  }
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
window.addEventListener('fw:lang', async () => { await loadMeta(); route(); });
route();
