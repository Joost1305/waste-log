import { api, app, esc, toast, toastError, renderLangToggle } from '../core.js';
import { t } from '../i18n.js';
import { SHOW_DEMO_LOGINS } from '../config.js';

// Shared student try-out login: one tap fills in the account and signs in
const TRY = { email: 'student@hth.demo', password: 'nofoodwaste' };
// Own accounts: one tap fills in the e-mail, the person types their own password
const OWN = [{ name: 'Joost de Vos', email: 'j.de.vos@hotelschool.nl' }];

export function renderLogin(onSuccess) {
  app().className = 'app';
  app().innerHTML = `
    <div class="login-wrap">
      <form class="card login-card" id="login-form" autocomplete="on">
        <div class="logo"><img src="img/icon.svg" width="40" height="40" alt="">
          <div style="flex:1"><h1>${t('login_title')}</h1><div class="muted small">${t('login_sub')}</div></div>
          <div class="lang-toggle" id="login-lang" role="group" aria-label="Language"></div></div>
        <div class="field"><label>${t('email')}</label><input type="email" name="email" autocomplete="username" required></div>
        <div class="field"><label>${t('password')}</label><input type="password" name="password" autocomplete="current-password" required></div>
        <button class="btn-primary btn-xl" type="submit">${t('sign_in')}</button>
        <div class="forgot-row"><button type="button" class="link-btn" id="forgot-btn">${t('forgot_pw')}</button></div>
        <div class="demo-accounts" hidden>
          ${OWN.map((o) => `<button type="button" class="btn-sm own-login" data-own="${esc(o.email)}"><strong>${esc(o.name)}</strong><span>${esc(o.email)} · ${t('own_login_hint')}</span></button>`).join('')}
          <div class="small muted" style="margin-top:10px">${t('try_student')}</div>
          <button type="button" class="btn-sm own-login" data-demo="${esc(TRY.email)}"><strong>${t('demo_student')}</strong><span>${esc(TRY.email)} · ${t('try_pw', { p: TRY.password })}</span></button></div>
      </form>
    </div>`;
  const form = document.getElementById('login-form');
  renderLangToggle(document.getElementById('login-lang'));
  form.querySelector('.demo-accounts').hidden = !SHOW_DEMO_LOGINS;
  form.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => {
    form.email.value = b.dataset.demo; form.password.value = TRY.password; form.requestSubmit();
  }));
  // Own account: fills in the e-mail only; the password stays private (the phone's password manager can fill it)
  form.querySelectorAll('[data-own]').forEach((b) => (b.onclick = () => {
    form.email.value = b.dataset.own; form.password.value = ''; form.password.focus();
  }));
  document.getElementById('forgot-btn').onclick = async (e) => {
    const email = form.email.value.trim();
    if (!email || !form.email.checkValidity()) { toastError(new Error(t('forgot_need_email'))); form.email.focus(); return; }
    e.target.disabled = true;
    try { await api('/auth/forgot', { method: 'POST', body: { email } }); toast(t('forgot_sent', { e: email })); }
    catch (err) { toastError(err); }
    finally { e.target.disabled = false; }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/auth/login', { method: 'POST', body: { email: form.email.value.trim(), password: form.password.value } });
      onSuccess();
    } catch (err) { toastError(err); btn.disabled = false; }
  };
}
