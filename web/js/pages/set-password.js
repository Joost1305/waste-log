// Choose a password after following an invitation or password-reset email.
// The email link already signed the person in; here they pick their own password.
import { state, api, app, esc, toast, toastError } from '../core.js';
import { t } from '../i18n.js';

export function renderSetPassword(onDone) {
  app().className = 'app narrow';
  app().innerHTML = `
    <div class="login-wrap"><form class="card login-card" id="sp-form">
      <div class="logo"><img src="img/icon.svg" width="40" height="40" alt="">
        <div><h1>${t('sp_title')}</h1><div class="muted small">${esc(state.user ? state.user.email : '')}</div></div></div>
      <p class="muted small">${t('sp_sub')}</p>
      <div class="field"><label>${t('new_password')} (min. 8)</label><input type="password" name="p1" minlength="8" autocomplete="new-password" required></div>
      <div class="field"><label>${t('sp_repeat')}</label><input type="password" name="p2" minlength="8" autocomplete="new-password" required></div>
      <button class="btn-primary btn-xl" type="submit">${t('sp_save')}</button>
    </form></div>`;
  const form = document.getElementById('sp-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (form.p1.value !== form.p2.value) { toast(t('sp_mismatch'), 'error'); return; }
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await api('/auth/password', { method: 'PATCH', body: { password: form.p1.value } });
      toast(t('saved'));
      onDone();
    } catch (err) { toastError(err); btn.disabled = false; }
  };
}
