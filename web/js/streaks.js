// Registration streaks: open days in a row on which the team registered its waste.
// Badges at 7, 30 and 100 days in a row, each with a printable certificate for the kitchen wall.
// Closed days do not break a streak, and today does not break it while the day is still going.
import { api, esc, fmt } from './core.js';
import { t } from './i18n.js';

export const LEVELS = [7, 30, 100];

export async function loadStreak(restaurantId) {
  if (!restaurantId) return null;
  try { return (await api('/streak', { query: { restaurant_id: restaurantId } })).data; } catch { return null; }
}

// Short line for the registration screen: "🔥 5 days in a row" (or a nudge when today is still empty)
export function streakLine(s) {
  if (!s) return '';
  if (s.current > 0) {
    const next = LEVELS.find((l) => l > s.current);
    return `<span class="streak-chip" title="${esc(t('st_best', { n: s.best }))}">🔥 ${t('st_in_row', { n: s.current })}${
      !s.today ? ` · ${t('st_keep')}` : next ? ` · ${t('st_to_next', { n: next - s.current })}` : ''}</span>`;
  }
  return `<span class="streak-chip off">${t('st_start')}</span>`;
}

// Badge row for one restaurant (dashboard)
export function badgesHtml(s) {
  if (!s) return '';
  const tiles = LEVELS.map((l) => {
    const got = s.earned && s.earned[String(l)];
    const pct = Math.min(100, Math.round((Math.max(s.current, 0) / l) * 100));
    return got
      ? `<button type="button" class="badge-tile got" data-cert="${s.restaurant_id}:${l}">
           <span class="badge-medal">${l}</span><span class="badge-name">${t('st_badge', { n: l })}</span>
           <span class="small muted">${t('st_earned', { d: fmt.date(got) })} · ${t('st_cert')}</span></button>`
      : `<div class="badge-tile">
           <span class="badge-medal off">${l}</span><span class="badge-name">${t('st_badge', { n: l })}</span>
           <span class="badge-progress"><span style="width:${pct}%"></span></span>
           <span class="small muted">${Math.min(s.current, l)} / ${l}</span></div>`;
  }).join('');
  return `<div class="streak-row">
      <div class="streak-head"><strong>${esc(s.restaurant)}</strong>
        <span class="muted small">${s.current > 0 ? `🔥 ${t('st_in_row', { n: s.current })}` : t('st_none_now')} · ${t('st_best', { n: s.best })}</span></div>
      <div class="badge-tiles">${tiles}</div></div>`;
}

// A printable certificate in its own window
export function openCertificate(s, level, orgName) {
  const got = s.earned && s.earned[String(level)];
  const w = window.open('', '_blank');
  if (!w) return false;
  const html = `<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8">
<title>${esc(t('st_cert_title'))} · ${esc(s.restaurant)}</title>
<style>
  @page { size: A4 landscape; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #1F2A27; background: #F6F4EF; }
  .sheet { width: 297mm; height: 210mm; padding: 16mm; display: flex; }
  .frame { flex: 1; border: 2.5mm solid #2F5D50; outline: .6mm solid #2F5D50; outline-offset: -5mm; display: flex; flex-direction: column;
    align-items: center; justify-content: center; text-align: center; background: #fff; padding: 12mm; }
  .kicker { font: 600 4.2mm -apple-system, "Segoe UI", sans-serif; letter-spacing: .25em; text-transform: uppercase; color: #2F5D50; }
  h1 { font-size: 15mm; margin: 6mm 0 3mm; font-weight: 700; }
  .num { font: 800 38mm/1 -apple-system, "Segoe UI", sans-serif; color: #2F5D50; margin: 2mm 0; }
  .who { font-size: 9mm; margin: 4mm 0 2mm; }
  .why { font-size: 5mm; color: #55625E; max-width: 190mm; line-height: 1.4; }
  .foot { margin-top: 10mm; font: 4mm -apple-system, "Segoe UI", sans-serif; color: #55625E; display: flex; gap: 14mm; }
  .print { position: fixed; top: 10px; right: 10px; font: 600 14px -apple-system, sans-serif; padding: 8px 14px; border-radius: 8px;
    border: 0; background: #2F5D50; color: #fff; cursor: pointer; }
  @media print { .print { display: none; } body { background: #fff; } }
</style></head><body>
<button class="print" onclick="window.print()">${esc(t('print'))}</button>
<div class="sheet"><div class="frame">
  <div class="kicker">WASTE log · ${esc(t('st_cert_title'))}</div>
  <div class="num">${level}</div>
  <h1>${esc(t('st_badge', { n: level }))}</h1>
  <div class="who">${esc(s.restaurant)}${orgName ? ` · ${esc(orgName)}` : ''}</div>
  <div class="why">${esc(t('st_cert_why', { n: level }))}</div>
  <div class="foot"><span>${esc(t('st_earned', { d: got ? fmt.date(got) : '' }))}</span><span>${esc(t('st_cert_motto'))}</span></div>
</div></div></body></html>`;
  w.document.open(); w.document.write(html); w.document.close();
  return true;
}
