// Weather helpers: a small chip ("☁ 14°C · 2 mm") and the symbol per condition.
// Weather comes from Open-Meteo, stored once a day per restaurant (see functions/daily).
import { esc, fmt } from './core.js';
import { t } from './i18n.js';

const ICON = { clear: '☀', cloudy: '☁', fog: '🌫', rain: '🌧', snow: '❄', storm: '⛈' };

export const wxIcon = (cond) => ICON[cond] || '';
// A day counts as a rain day from 1 mm; a few drops do not change who comes in for lunch
export const RAIN_MM = 1;

// Accepts a weather_records row (temp_max_c, rainfall_mm, condition) or a dashboard day (tmax, rain, cond)
export function wxParts(w) {
  if (!w) return null;
  const tmax = w.temp_max_c ?? w.tmax; const rain = w.rainfall_mm ?? w.rain; const cond = w.condition ?? w.cond;
  if (tmax == null && rain == null && !cond) return null;
  return { tmax: tmax == null ? null : Number(tmax), rain: rain == null ? null : Number(rain), cond };
}

export function wxText(w) {
  const p = wxParts(w);
  if (!p) return '';
  const bits = [];
  if (p.cond) bits.push(t('wx_' + p.cond));
  if (p.tmax != null) bits.push(`${t('wx_max')} ${fmt.num(p.tmax)}°C`);
  if (p.rain != null) bits.push(p.rain >= RAIN_MM ? `${fmt.num(p.rain, 1)} mm ${t('wx_rain_word')}` : t('wx_dry'));
  return bits.join(' · ');
}

export function wxChip(w, { rain = true } = {}) {
  const p = wxParts(w);
  if (!p) return '';
  return `<span class="wx-chip" title="${esc(wxText(w))}">${wxIcon(p.cond)}${p.tmax != null ? ` ${fmt.num(p.tmax)}°` : ''}${
    rain && p.rain != null && p.rain >= RAIN_MM ? ` <span class="wx-rain">${fmt.num(p.rain, 1)} mm</span>` : ''}</span>`;
}
