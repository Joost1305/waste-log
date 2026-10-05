import { state, api, app, esc, toast, toastError, $ } from '../core.js';
import { t, LANGS, setLang } from '../i18n.js';

export function renderProfile() {
  const u = state.user;
  app().className = 'app narrow';
  app().innerHTML = `
    <div class="page-head"><h1>${t('profile_title')}</h1></div>
    <form class="card" id="p-form">
      <div class="field"><label>${t('name')}</label><input name="name" value="${esc(u.name)}" required></div>
      <div class="field"><label>${t('email')}</label><input value="${esc(u.email)}" disabled></div>
      <div class="field"><label>${t('role')}</label><input value="${esc(t('role_' + u.role))}" disabled></div>
      <div class="field"><label>${t('language')}</label><select name="language">
        ${Object.entries(LANGS).map(([v, l]) => `<option value="${v}" ${v === u.language ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <button class="btn-primary" type="submit">${t('save')}</button>
    </form>
    <form class="card" id="pw-form">
      <h2>${t('change_password')}</h2>
      <div class="field"><label>${t('current_password')}</label><input type="password" name="current_password" autocomplete="current-password" required></div>
      <div class="field"><label>${t('new_password')} (min. 8)</label><input type="password" name="new_password" minlength="8" autocomplete="new-password" required></div>
      <button class="btn-primary" type="submit">${t('change_password')}</button>
    </form>`;
  $('#p-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const res = await api('/auth/me', { method: 'PATCH', body: { name: f.name.value.trim(), language: f.language.value } });
      state.user = res.data.user;
      setLang(state.user.language);
      toast(t('saved'));
      window.dispatchEvent(new Event('fw:lang'));
    } catch (err) { toastError(err); }
  };
  $('#pw-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/auth/me', { method: 'PATCH', body: { current_password: f.current_password.value, new_password: f.new_password.value } });
      f.reset(); toast(t('saved'));
    } catch (err) { toastError(err); }
  };
}
