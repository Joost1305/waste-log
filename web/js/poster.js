// Impact poster: one printable page for the kitchen wall, built from the records of a month.
// Written to start a conversation, not to blame anyone: "we" language, no names or sections,
// the good news first, a question under the big photo, reasons instead of people, and a box for ideas.
import { state, api, esc, fmt, toast, toastError, todayIso } from './core.js';
import { t, lang } from './i18n.js';
import { photoUrls } from './backend.js';
import { equivalentsLine } from './co2-equivalents.js';

const locale = () => (lang() === 'en' ? 'en-GB' : 'nl-NL');

function monthRange(which) {
  const today = todayIso();
  const [y, m] = today.split('-').map(Number);
  if (which === 'last') {
    const first = new Date(y, m - 2, 1); const last = new Date(y, m - 1, 0);
    return { from: first.toLocaleDateString('sv-SE'), to: last.toLocaleDateString('sv-SE'), date: first };
  }
  return { from: `${today.slice(0, 7)}-01`, to: today, date: new Date(y, m - 1, 1) };
}

async function gather(restaurantId, which) {
  const range = monthRange(which);
  const query = { restaurant_id: restaurantId || '', from: range.from, to: range.to };
  const [d, gal, ivs, ideas] = await Promise.all([
    api('/dashboard', { query }).then((r) => r.data),
    api('/gallery', { query: { ...query, sort: 'heaviest', limit: 60, offset: 0 } }).then((r) => r.data).catch(() => []),
    api('/interventions').then((r) => r.data || []).catch(() => []),
    api('/prevention-ideas', { query: { status: 'adopted' } }).then((r) => r.data || []).catch(() => []),
  ]);
  const urls = await photoUrls(gal.map((r) => r.photo_path)).catch(() => ({}));
  gal.forEach((r) => { r.url = urls[r.photo_path]; });
  return { range, d, gal: gal.filter((r) => r.url), ivs, ideas };
}

export function render({ range, d, gal, ivs, ideas }, restaurantId) {
  const T = d.totals;
  const month = new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(range.date);
  const rest = restaurantId ? (state.meta.restaurants.find((r) => r.id === Number(restaurantId)) || {}).name : state.meta.organization.name;
  if (!T.records) return `<div class="pst-page"><div class="pst-empty">${t('pst_empty', { m: esc(month) })}</div></div>`;

  const avoidKg = Math.max(0, Number(T.kg) - Number(T.unavoidable_kg || 0));
  const change = T.change_kg_pct == null ? null : Number(T.change_kg_pct);
  const improved = change != null && change <= -3;
  const headline = improved
    ? `<div class="pst-good">↓ ${fmt.pct(Math.abs(change), 0)}</div><div class="pst-good-sub">${t('pst_less')}</div>`
    : `<div class="pst-good pst-neutral">${fmt.num(T.records)}</div><div class="pst-good-sub">${t('pst_regs_thanks', { d: fmt.num(T.registered_days) })}</div>`;

  const hero = gal[0];
  const heroName = hero ? esc(hero.product_name || hero.category) : '';
  const eq = equivalentsLine(Number(T.co2e_kg), t, (n, dd) => fmt.num(n, dd), { kitchen: true, max: 2 });

  // Top 3 products by avoidable value, each with a photo when one exists
  const photoOf = {};
  gal.forEach((r) => { if (r.product_name && !photoOf[r.product_name]) photoOf[r.product_name] = r.url; });
  const top = (d.top_products || []).slice(0, 3);

  // Reasons that could be prevented, biggest first
  const reasons = (d.by_reason || []).filter((r) => r.avoidable !== false).slice(0, 3);
  const maxR = Math.max(...reasons.map((r) => Number(r.kg)), 1);

  // One thing to do: an active intervention here, otherwise an adopted team idea
  const iv = ivs.find((i) => i.status === 'active' && (!restaurantId || !i.restaurant_id || String(i.restaurant_id) === String(restaurantId)));
  const idea = ideas[0];
  const action = iv ? esc(iv.title) : idea ? `“${esc(idea.text)}”` : '';

  const tg = d.target;
  const demo = state.meta.organization && state.meta.organization.is_demo;

  return `<div class="pst-page">
    ${demo ? `<div class="pst-demo">${t('demo_banner')}</div>` : ''}
    <header class="pst-head"><div class="pst-kicker">${esc(rest)}</div><h1>${t('pst_title', { m: esc(month) })}</h1></header>
    <section class="pst-top">
      <div class="pst-headline">${headline}</div>
      <div class="pst-figs">
        <div><strong>${fmt.kg(avoidKg, 0)}</strong><span>${t('pst_avoidable')}</span></div>
        <div><strong>${fmt.money(T.value)}</strong><span>${t('pst_value')}</span></div>
        ${eq ? `<div class="pst-eq">CO₂ ${esc(eq)}</div>` : ''}
      </div>
    </section>
    ${hero ? `<section class="pst-hero"><img src="${esc(hero.url)}" alt="">
      <div class="pst-hero-txt"><div class="pst-hero-kg">${fmt.kg(hero.weight_kg, 1)}</div><div class="pst-hero-name">${heroName}</div>
        <div class="pst-q">${t('pst_question')}</div></div></section>` : ''}
    <section class="pst-cols">
      <div><h2>${t('pst_top3')}</h2>
        ${top.length ? `<ol class="pst-top3">${top.map((p) => `<li>${photoOf[p.name] ? `<img src="${esc(photoOf[p.name])}" alt="">` : '<span class="pst-noimg"></span>'}
          <div><strong>${esc(p.name)}</strong><span>${fmt.kg(p.kg, 1)} · ${fmt.money(p.value)}</span></div></li>`).join('')}</ol>` : `<div class="pst-muted">${t('no_data')}</div>`}</div>
      <div><h2>${t('pst_why')}</h2>
        ${reasons.map((r) => `<div class="pst-reason"><div class="pst-reason-l"><span>${esc(r.name)}</span><span>${fmt.kg(r.kg, 0)}</span></div>
          <div class="pst-bar"><span style="width:${(Number(r.kg) / maxR * 100).toFixed(0)}%"></span></div></div>`).join('')}
        ${tg ? `<div class="pst-target"><div class="pst-reason-l"><span>${t('target')}: ${esc(tg.name)}</span><span>${tg.achieved ? '✓' : fmt.pct(Math.min(100, tg.progress_pct))}</span></div>
          <div class="pst-bar pst-bar-t"><span style="width:${Math.min(100, Math.max(0, tg.progress_pct))}%"></span></div></div>` : ''}</div>
    </section>
    ${action ? `<section class="pst-action"><div class="pst-label">${t('pst_action')}</div><div class="pst-action-txt">${action}</div></section>` : ''}
    <section class="pst-ideas"><div class="pst-label">${t('pst_ideas')}</div><div class="pst-lines"></div></section>
    <footer class="pst-foot">
      <div>${t('pst_thanks', { n: fmt.num(T.records) })} ${t('pst_honest')}</div>
      <div>${esc(rest)} · ${fmt.date(range.from)} – ${fmt.date(range.to)} · ${t('pst_days', { r: fmt.num(T.registered_days), o: fmt.num(T.open_days) })} · WASTE log</div>
    </footer></div>`;
}

export async function openPoster(restaurantId) {
  let which = 'this';
  const el = document.createElement('div');
  el.className = 'poster'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', t('pst_button'));
  el.innerHTML = `<div class="pst-bar-top no-print">
      <select id="pst-month"><option value="this">${t('pst_this')}</option><option value="last">${t('pst_last')}</option></select>
      <button type="button" class="btn-primary" id="pst-print">&#128424; ${t('print')}</button>
      <button type="button" id="pst-close">${t('close')}</button></div>
    <div class="pst-wrap"><div class="pst-page"><div class="pst-empty"><span class="spinner"></span></div></div></div>`;
  document.body.appendChild(el); document.body.classList.add('poster-on');
  const close = () => { document.removeEventListener('keydown', onKey); el.remove(); document.body.classList.remove('poster-on'); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const draw = async () => {
    el.querySelector('.pst-wrap').innerHTML = `<div class="pst-page"><div class="pst-empty"><span class="spinner"></span></div></div>`;
    try { el.querySelector('.pst-wrap').innerHTML = render(await gather(restaurantId, which), restaurantId); } catch (e) { toastError(e); }
  };
  el.querySelector('#pst-close').onclick = close;
  el.querySelector('#pst-month').onchange = (e) => { which = e.target.value; draw(); };
  el.querySelector('#pst-print').onclick = async () => {
    // wait for the photos, otherwise the print can come out with empty boxes
    const imgs = [...el.querySelectorAll('.pst-page img')];
    await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = r; i.onerror = r; }))));
    if (!imgs.length && !el.querySelector('.pst-head')) { toast(t('no_data')); return; }
    window.print();
  };
  await draw();
}
