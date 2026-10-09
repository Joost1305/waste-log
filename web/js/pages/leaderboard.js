// Leaderboard between the sections of a restaurant (bakery, salad bar, pizza ...).
// Points for showing up, careful registrations and prevention ideas, plus a bonus for less waste per guest
// than the section's own weeks before. Not for "fewest kilos": that would reward not registering.
// Only shown when the leaderboard is switched on (Settings › Leaderboard).
// #/leaderboard/screen is a large, self-refreshing view for a screen in the kitchen.
import { state, api, app, esc, fmt, toast, toastError, todayIso, addDaysIso, $, $$, openModal, printPage } from '../core.js';
import { t } from '../i18n.js';

let q = { restaurant_id: '', range: 'current' };
let data = null;
let timer = null;
const isAdmin = () => !!state.meta.permissions.users;
const medal = (i) => ['&#129351;', '&#129352;', '&#129353;'][i] || `${i + 1}`;

function range(d) {
  // current period comes from the server; previous and season are worked out here
  if (q.range === 'previous') {
    if (d.period === 'month') {
      const first = new Date(d.from + 'T12:00:00'); first.setMonth(first.getMonth() - 1);
      const from = first.toLocaleDateString('sv-SE');
      return { from, to: addDaysIso(d.from, -1) };
    }
    return { from: addDaysIso(d.from, -7), to: addDaysIso(d.from, -1) };
  }
  if (q.range === 'season' && d.season_start) return { from: d.season_start, to: todayIso() };
  return {};
}

export async function renderLeaderboard(rest = []) {
  clearInterval(timer);
  const screen = rest[0] === 'screen';
  if (screen) {
    document.getElementById('topbar').hidden = true;
    document.getElementById('demo-banner').hidden = true;
    app().className = 'app lb-screen';
    timer = setInterval(() => { if (location.hash.startsWith('#/leaderboard/screen')) load(true); else clearInterval(timer); }, 5 * 60 * 1000);
  }
  app().innerHTML = `<div id="lb"><div class="card empty"><span class="spinner"></span></div></div>`;
  await load(screen);
}

async function load(screen = false) {
  try {
    let d = (await api('/leaderboard', { query: { restaurant_id: q.restaurant_id } })).data;
    if (d.enabled && q.range !== 'current') d = (await api('/leaderboard', { query: { restaurant_id: d.restaurant_id || '', ...range(d) } })).data;
    data = d;
  } catch (e) { toastError(e); return; }
  if (!data.enabled) { $('#lb').innerHTML = `<div class="card empty">${t('lb_off')}</div>`; return; }
  if (screen) drawScreen(); else draw();
}

function periodLabel(d) {
  return `${fmt.date(d.from)} – ${fmt.date(d.to)}`;
}

function draw() {
  const d = data;
  const rows = d.rows || [];
  const finished = d.to < d.today;
  const max = Math.max(1, ...rows.map((r) => r.points));
  $('#lb').innerHTML = `
    <div class="page-head"><div><h1>${t('lb_title')}</h1><div class="muted small">${t('lb_sub')}</div></div>
      <div class="page-actions no-print">
        <a class="btn-sm btn" href="#/leaderboard/screen">&#128250; ${t('lb_screen')}</a>
        <button type="button" class="btn-sm" id="lb-print">&#128424; ${t('print')}</button></div></div>
    ${d.restaurants.length > 1 ? `<div class="chips no-print" style="margin-bottom:10px">${d.restaurants.map((r) =>
      `<button type="button" class="chip ${r.id === d.restaurant_id ? 'on' : ''}" data-r="${r.id}">${esc(r.name)}</button>`).join('')}</div>` : ''}
    <div class="chips no-print" style="margin-bottom:14px">
      ${['current', 'previous', ...(d.season_start ? ['season'] : [])].map((r) =>
        `<button type="button" class="chip ${q.range === r ? 'on' : ''}" data-range="${r}">${t(`lb_r_${r}_${d.period}`)}</button>`).join('')}</div>
    ${!d.restaurant_id ? `<div class="card empty">${t('lb_no_sections')}</div>` : `
    <div class="lb-prize card">
      <div class="lb-trophy">&#127942;</div>
      <div><div class="small muted">${q.range === 'season' ? t('lb_season') : finished ? t('lb_finished') : t('lb_running')} · ${periodLabel(d)}</div>
        <div class="lb-prize-text">${esc(d.prize || t('lb_no_prize'))}</div></div>
      ${isAdmin() && finished && q.range !== 'season' && rows.length && !d.awards.some((a) => a.from === d.from) ?
        `<button type="button" class="btn-primary btn-sm no-print" id="lb-award">${t('lb_award')}</button>` : ''}
    </div>
    <div class="lb-podium">${rows.slice(0, 3).map((r, i) => `
      <div class="card lb-pod lb-pod-${i + 1}"><div class="lb-medal">${medal(i)}</div>
        <div class="lb-name">${esc(r.name)}</div><div class="lb-points">${fmt.num(r.points)} <span>${t('lb_pts')}</span></div></div>`).join('')}</div>
    <div class="card" style="margin-top:14px"><div class="table-wrap"><table class="lb-table"><thead><tr>
      <th>#</th><th>${t('lb_section')}</th><th>${t('lb_points')}</th>
      <th class="right">${t('lb_c_presence')}</th><th class="right">${t('lb_c_quality')}</th><th class="right">${t('lb_c_ideas')}</th><th class="right">${t('lb_c_improve')}</th>
      <th class="right">${t('lb_regs')}</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${medal(i)}</td><td><strong>${esc(r.name)}</strong>
          <div class="small muted">${t('lb_days', { d: r.days, o: r.open_days })}${r.photo_pct != null ? ` · ${t('lb_photo_pct', { p: r.photo_pct })}` : ''}</div></td>
        <td style="min-width:150px"><div class="lb-bar">
          ${['presence', 'quality', 'ideas', 'improvement'].map((k) => `<span class="lb-seg lb-${k}" style="width:${(r[k] / max) * 100}%" title="${t('lb_c_' + (k === 'improvement' ? 'improve' : k))}: ${r[k]}"></span>`).join('')}
          </div><strong>${fmt.num(r.points)}</strong></td>
        <td class="right num">${r.presence}</td><td class="right num">${r.quality}</td>
        <td class="right num">${r.ideas}${r.ideas_adopted ? ` <span class="small muted">(${r.ideas_adopted}&#10003;)</span>` : ''}</td>
        <td class="right num">${r.improvement}${r.waste_change_pct != null && r.registrations > 0 ? `<div class="small muted">${r.waste_change_pct > 0 ? '+' : r.waste_change_pct < 0 ? '−' : ''}${fmt.pct(Math.abs(r.waste_change_pct))} ${t('lb_waste_pg')}</div>` : ''}</td>
        <td class="right num">${fmt.num(r.registrations)}</td></tr>`).join('')}
      </tbody></table></div>
      <div class="lb-legend small muted">${['presence', 'quality', 'ideas', 'improvement'].map((k) => `<span><i class="lb-seg lb-${k}"></i>${t('lb_c_' + (k === 'improvement' ? 'improve' : k))}</span>`).join('')}</div>
    </div>
    ${d.idea_of_period ? `<div class="card lb-idea" style="margin-top:14px"><div class="small muted">&#128161; ${t('lb_idea_of')} · ${esc(d.idea_of_period.section || '')}</div>
      <div class="lb-idea-text">“${esc(d.idea_of_period.text)}”</div></div>` : ''}
    <div class="grid grid-2" style="margin-top:14px">
      <div class="card" id="lb-ideas"><h2>${t(isAdmin() ? 'lb_review' : 'lb_adopted')}</h2><span class="spinner"></span></div>
      <div class="card"><h2>${t('lb_hall')}</h2>${d.awards.length ? `<ul class="lb-hall">${d.awards.map((a) => `<li>&#127942; <strong>${esc(a.section)}</strong>
        <span class="small muted">${fmt.date(a.from)} – ${fmt.date(a.to)}${a.points != null ? ` · ${a.points} ${t('lb_pts')}` : ''}</span>
        ${a.prize ? `<div class="small">${esc(a.prize)}</div>` : ''}</li>`).join('')}</ul>` : `<div class="empty small">${t('lb_hall_empty')}</div>`}</div>
    </div>
    <details class="card" style="margin-top:14px"><summary><strong>${t('lb_how')}</strong></summary>
      <ul class="small lb-rules">
        <li>${t('lb_rule_presence', { p: d.rules.presence })}</li>
        <li>${t('lb_rule_quality', { n: d.rules.registrations_per_day })}</li>
        <li>${t('lb_rule_ideas', { p: d.rules.idea, n: d.rules.ideas_per_day, a: d.rules.adopted })}</li>
        <li>${t('lb_rule_improve', { m: d.rules.improvement_max, p: d.rules.presence_min_pct })}</li>
        <li>${t('lb_rule_why')}</li></ul></details>`}`;
  $('#lb-print').onclick = () => printPage();
  $$('[data-r]').forEach((b) => (b.onclick = () => { q.restaurant_id = b.dataset.r; load(); }));
  $$('[data-range]').forEach((b) => (b.onclick = () => { q.range = b.dataset.range; load(); }));
  if ($('#lb-award')) $('#lb-award').onclick = () => award();
  if (d.restaurant_id) loadIdeas();
}

async function loadIdeas() {
  const el = $('#lb-ideas');
  let rows = [];
  try { rows = (await api('/prevention-ideas', { query: isAdmin() ? {} : { status: 'adopted' } })).data || []; } catch (e) { el.innerHTML += ''; return; }
  const rest = (data.restaurants.find((r) => r.id === data.restaurant_id) || {}).name;
  rows = rows.filter((i) => i.restaurant === rest);
  const open = rows.filter((i) => i.status === 'new');
  const adopted = rows.filter((i) => i.status === 'adopted').slice(0, 8);
  const item = (i, review) => `<li class="lb-idea-row"><div>“${esc(i.text)}”</div>
    <div class="small muted">${esc(i.section || '')}${i.user_name ? ` · ${esc(i.user_name)}` : ''} · ${fmt.date(i.created_at)}
      ${i.record ? ` · ${fmt.kg(i.record.kg, 2)} ${esc(i.record.product || '')}${i.record.reason ? ` (${esc(i.record.reason)})` : ''}` : ''}</div>
    ${review ? `<div class="lb-idea-actions no-print"><button type="button" class="btn-sm btn-primary" data-adopt="${i.id}">&#10003; ${t('lb_adopt')}</button>
      <button type="button" class="btn-sm btn-ghost" data-reject="${i.id}">${t('lb_reject')}</button></div>` : ''}</li>`;
  el.innerHTML = `<h2>${t(isAdmin() ? 'lb_review' : 'lb_adopted')}</h2>
    ${isAdmin() ? (open.length ? `<ul class="lb-idealist">${open.map((i) => item(i, true)).join('')}</ul>` : `<div class="empty small">${t('lb_review_empty')}</div>`) : ''}
    ${isAdmin() && adopted.length ? `<h3 style="margin-top:14px">${t('lb_adopted')}</h3>` : ''}
    ${adopted.length ? `<ul class="lb-idealist">${adopted.map((i) => item(i, false)).join('')}</ul>` : (!isAdmin() ? `<div class="empty small">${t('lb_adopted_empty')}</div>` : '')}`;
  const review = async (id, status) => {
    try { await api(`/prevention-ideas/${id}`, { method: 'PATCH', body: { status } }); toast(t(status === 'adopted' ? 'lb_adopted_toast' : 'saved')); load(); }
    catch (e) { toastError(e); }
  };
  $$('[data-adopt]', el).forEach((b) => (b.onclick = () => review(b.dataset.adopt, 'adopted')));
  $$('[data-reject]', el).forEach((b) => (b.onclick = () => review(b.dataset.reject, 'rejected')));
}

function award() {
  const d = data; const top = d.rows[0];
  openModal(`<h2>${t('lb_award')}</h2><p class="small muted">${periodLabel(d)}</p>
    <form id="aw-form">
      <div class="field"><label>${t('lb_section')}</label><select name="section_id">${d.rows.map((r) =>
        `<option value="${r.section_id}" ${r === top ? 'selected' : ''}>${esc(r.name)} (${r.points} ${t('lb_pts')})</option>`).join('')}</select></div>
      <div class="field"><label>${t('lb_prize')}</label><input name="prize" value="${esc(d.prize || '')}"></div>
      <div class="field"><label>${t('lb_note')}</label><input name="note" placeholder="${t('lb_note_ph')}"></div>
      <div class="modal-actions"><button type="button" data-close>${t('cancel')}</button><button class="btn-primary">${t('save')}</button></div></form>`, (card, close) => {
    card.querySelector('#aw-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target; const sid = Number(f.section_id.value);
      try {
        await api('/leaderboard/awards', { method: 'POST', body: { restaurant_id: d.restaurant_id, section_id: sid, period_from: d.from, period_to: d.to,
          points: (d.rows.find((r) => r.section_id === sid) || {}).points, prize: f.prize.value || null, note: f.note.value || null } });
        close(); toast(t('saved')); load();
      } catch (err) { toastError(err); }
    };
  });
}

// Big view for a kitchen screen: ranking, prize and the idea of the week. Refreshes every 5 minutes.
function drawScreen() {
  const d = data; const rows = d.rows || [];
  const rest = (d.restaurants.find((r) => r.id === d.restaurant_id) || {}).name || '';
  const max = Math.max(1, ...rows.map((r) => r.points));
  $('#lb').innerHTML = `<div class="lb-screen-head"><div><div class="lb-kicker">${esc(rest)} · ${periodLabel(d)}</div><h1>${t('lb_title')}</h1></div>
      <div class="lb-screen-prize">&#127942; ${esc(d.prize || '')}</div></div>
    <ol class="lb-screen-list">${rows.map((r, i) => `<li><span class="lb-rank">${medal(i)}</span><span class="lb-sname">${esc(r.name)}</span>
      <span class="lb-sbar"><span style="width:${(r.points / max) * 100}%"></span></span><span class="lb-spts">${fmt.num(r.points)}</span></li>`).join('')}</ol>
    ${d.idea_of_period ? `<div class="lb-screen-idea">&#128161; ${t('lb_idea_of')}: “${esc(d.idea_of_period.text)}” <span>· ${esc(d.idea_of_period.section || '')}</span></div>` : ''}
    <div class="lb-screen-foot">${t('lb_screen_foot')} · <a href="#/leaderboard">${t('lb_screen_exit')}</a></div>`;
}
