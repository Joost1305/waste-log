import { api, app, esc, toastError, renderLangToggle } from '../core.js';
import { t } from '../i18n.js';
import { SHOW_DEMO_LOGINS } from '../config.js';

// Two demo logins on the sign-in page; one tap fills in the account and signs in (password demo1234)
const DEMO = [{ email: 'orgadmin@hth.demo', label: 'demo_admin' }, { email: 'student@hth.demo', label: 'demo_student' }];

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
        <div class="demo-accounts" hidden>${t('demo_accounts')}<br>
          <button type="button" class="btn-sm own-login" data-own="j.de.vos@hotelschool.nl"><strong>Joost de Vos</strong><span>j.de.vos@hotelschool.nl · ${t('own_login_hint')}</span></button>
          <div class="demo-btns">${DEMO.map((d) => `<button type="button" class="btn-sm" data-demo="${esc(d.email)}"><strong>${t(d.label)}</strong><span>${esc(d.email)}</span></button>`).join('')}</div></div>
      </form>
    </div>`;
  const form = document.getElementById('login-form');
  renderLangToggle(document.getElementById('login-lang'));
  form.querySelector('.demo-accounts').hidden = !SHOW_DEMO_LOGINS;
  form.querySelectorAll('[data-demo]').forEach((b) => (b.onclick = () => {
    form.email.value = b.dataset.demo; form.password.value = 'demo1234'; form.requestSubmit();
  }));
  // Own account: fills in the e-mail only; the password stays private (the phone's password manager can fill it)
  form.querySelectorAll('[data-own]').forEach((b) => (b.onclick = () => {
    form.email.value = b.dataset.own; form.password.value = ''; form.password.focus();
  }));
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
