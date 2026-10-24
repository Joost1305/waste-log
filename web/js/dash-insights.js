// Dashboard additions built on the daily series (dashboard_daily):
//  - one summary line at the top ("12% above your baseline; biggest cause …; best day …")
//  - the daily chart with reference lines (same day last week, 4-week average, baseline) and rain days shaded
//  - the "Weather and waste" card
// Rule throughout: an open day without registrations is "no data", never zero waste. It is left out of every average.
import { esc, fmt, addDaysIso } from './core.js';
import { t, lang } from './i18n.js';
import { wxIcon, wxText, RAIN_MM } from './weather.js';

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const dow = (iso) => new Date(`${iso}T12:00:00`).getDay();
const loc = () => (lang() === 'en' ? 'en-GB' : 'nl-NL');
export const dayLabel = (iso, withWeekday = true) => new Intl.DateTimeFormat(loc(), { ...(withWeekday ? { weekday: 'short' } : {}), day: 'numeric', month: 'short' }).format(new Date(`${iso}T12:00:00`));
const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000) + 1;

// Days of the selected period that are finished (today is still going) and split in registered / missing
function periodDays(daily) {
  // Days before the very first registration are not "missed": the kitchen simply had not started yet
  const first = (daily.days.find((x) => x.n > 0) || {}).d || daily.today;
  const all = daily.days.filter((x) => x.d >= daily.from && x.d <= daily.to && x.d >= first);
  const done = all.filter((x) => x.d < daily.today);
  return { all, done, reg: done.filter((x) => x.n > 0), missing: done.filter((x) => x.open && x.n === 0) };
}

// Baseline per open day, from the target's baseline per week / month / year
function baselinePerDay(d, daily) {
  const tg = d.target;
  if (!tg || !(Number(tg.baseline_kg) > 0)) return null;
  const pdays = { week: 7, month: 30, year: 365 }[tg.period] || 30;
  const openShare = (daily.open_dows || []).length / 7 || 1;
  return Number(tg.baseline_kg) / (pdays * openShare);
}

// ------------------------------------------------------------------ summary line
export function summaryHtml(d, daily) {
  const { reg, missing } = periodDays(daily);
  if (!reg.length) {
    return missing.length ? `<div class="card insight warn-line">${t('sum_no_reg', { n: missing.length })}</div>` : '';
  }
  const avg = mean(reg.map((x) => Number(x.kg)));
  const parts = [];

  // 1. Compared with the baseline (target), otherwise with the previous period of the same length
  const base = baselinePerDay(d, daily);
  if (base) {
    const diff = (avg / base - 1) * 100;
    parts.push(t(diff >= 0 ? 'sum_above_base' : 'sum_below_base', { p: fmt.pct(Math.abs(diff)), kg: fmt.kg(avg, 1) }));
  } else {
    const span = daysBetween(daily.from, daily.to);
    const pFrom = addDaysIso(daily.from, -span); const pTo = addDaysIso(daily.from, -1);
    const prev = daily.days.filter((x) => x.d >= pFrom && x.d <= pTo && x.n > 0);
    if (prev.length >= 3) {
      const diff = (avg / mean(prev.map((x) => Number(x.kg))) - 1) * 100;
      parts.push(Math.abs(diff) < 3 ? t('sum_same_prev', { kg: fmt.kg(avg, 1) })
        : t(diff > 0 ? 'sum_up_prev' : 'sum_down_prev', { p: fmt.pct(Math.abs(diff)), kg: fmt.kg(avg, 1) }));
    } else parts.push(t('sum_avg', { kg: fmt.kg(avg, 1) }));
  }

  // 2. Biggest avoidable cause
  const total = Number(d.totals.kg) || 0;
  const top = (d.by_reason || []).filter((r) => r.avoidable !== false).sort((a, b) => b.kg - a.kg)[0];
  if (top && total > 0) parts.push(t('sum_cause', { r: esc(String(top.name).toLowerCase()), p: fmt.pct((top.kg / total) * 100) }));

  // 3. Best day: lowest waste (per guest when guest numbers are there). Half-registered days do not count:
  //    a day needs at least half the usual number of registrations.
  const usualN = median(reg.map((x) => x.n));
  const full = reg.filter((x) => x.n >= Math.max(1, usualN / 2));
  const withGuests = full.filter((x) => x.guests > 0);
  const perGuest = withGuests.length >= Math.max(3, full.length * 0.7);
  const pool = perGuest ? withGuests : full;
  if (pool.length >= 3) {
    const val = (x) => (perGuest ? (x.kg * 1000) / x.guests : Number(x.kg));
    const best = pool.reduce((a, b) => (val(b) < val(a) ? b : a));
    parts.push(t('sum_best', { d: dayLabel(best.d), v: perGuest ? `${fmt.num(val(best))} g ${t('per_guest_short')}` : fmt.kg(best.kg, 1) }));
  }

  return `<div class="card insight">
      <div class="insight-text">${parts.join(' ')}</div>
      ${missing.length ? `<div class="insight-missing">${t(missing.length === 1 ? 'sum_missing_1' : 'sum_missing', { n: missing.length })}</div>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ daily chart
export function dailyChart(canvas, d, daily, css) {
  const byDate = new Map(daily.days.map((x) => [x.d, x]));
  // Closed days without registrations are not on the axis (a Monday-Friday kitchen has no empty weekends)
  const days = periodDays(daily).all.filter((x) => x.open || x.n > 0);
  if (!days.length) return null;
  const val = (x) => (x && x.n > 0 ? Number(x.kg) : null);
  const current = days.map((x) => val(x));
  const lastWeek = days.map((x) => val(byDate.get(addDaysIso(x.d, -7))));
  const avg4 = days.map((x) => {
    const from = addDaysIso(x.d, -27);
    const vals = daily.days.filter((y) => y.d >= from && y.d <= x.d && y.n > 0 && y.d < daily.today).map((y) => Number(y.kg));
    return vals.length >= 5 ? Math.round(mean(vals) * 100) / 100 : null;
  });
  const base = baselinePerDay(d, daily);
  const ink2 = css('--ink-2'); const ink3 = css('--ink-3'); const line = css('--line');
  const datasets = [
    { label: t('dc_current'), data: current, borderColor: css('--primary'), backgroundColor: css('--primary'), borderWidth: 2.5,
      pointRadius: days.length > 60 ? 1.5 : 3, pointHoverRadius: 5, tension: 0.2, spanGaps: false,
      segment: { borderDash: (c) => (days[c.p1DataIndex] && days[c.p1DataIndex].d === daily.today ? [3, 3] : undefined) } },
    { label: t('dc_last_week'), data: lastWeek, borderColor: ink3, borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, tension: 0.2, spanGaps: false },
    { label: t('dc_avg4'), data: avg4, borderColor: css('--accent'), borderWidth: 2, pointRadius: 0, tension: 0.3, spanGaps: true },
  ];
  if (base) datasets.push({ label: t('baseline'), data: days.map(() => Math.round(base * 100) / 100), borderColor: css('--warn'), borderDash: [2, 4], borderWidth: 1.5, pointRadius: 0 });

  // Rain days: a light blue band behind the day (weather is context, not a second measure on the chart)
  const rainBands = {
    id: 'rainBands',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: a, scales: { x } } = chart;
      const w = days.length > 1 ? (x.getPixelForValue(1) - x.getPixelForValue(0)) : (a.right - a.left);
      ctx.save(); ctx.fillStyle = 'rgba(74, 133, 196, 0.10)';
      days.forEach((day, i) => { if (day.rain != null && day.rain >= RAIN_MM) ctx.fillRect(x.getPixelForValue(i) - w / 2, a.top, w, a.bottom - a.top); });
      ctx.restore();
    },
  };
  return new Chart(canvas, {
    type: 'line',
    data: { labels: days.map((x) => dayLabel(x.d, days.length <= 35)), datasets },
    plugins: [rainBands],
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { color: ink2, boxWidth: 18, boxHeight: 2, font: { size: 11 } } },
        tooltip: { backgroundColor: css('--ink'), padding: 10, cornerRadius: 8, displayColors: true,
          callbacks: {
            title: (i) => { const x = days[i[0].dataIndex]; return `${dayLabel(x.d)}${x.d === daily.today ? ` · ${t('dc_so_far')}` : ''}`; },
            label: (c) => (c.raw == null ? `${c.dataset.label}: ${c.datasetIndex === 0 ? t('dc_no_data') : '–'}` : `${c.dataset.label}: ${fmt.kg(c.raw, 1)}`),
            afterBody: (i) => { const w = wxText(days[i[0].dataIndex]); return w ? `${wxIcon(days[i[0].dataIndex].cond)} ${w}` : ''; },
          } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: ink2, font: { size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, border: { color: line } },
        y: { grid: { color: line }, ticks: { color: ink2, font: { size: 11 }, callback: (v) => `${v} kg` }, border: { display: false }, beginAtZero: true },
      },
    },
  });
}

export function dailyChartNote(daily) {
  const { missing } = periodDays(daily);
  const hasRain = periodDays(daily).all.some((x) => x.rain != null && x.rain >= RAIN_MM);
  return [missing.length ? t(missing.length === 1 ? 'dc_gap_note_1' : 'dc_gap_note', { n: missing.length }) : '', hasRain ? t('dc_rain_note') : ''].filter(Boolean).join(' ');
}

// ------------------------------------------------------------------ weather and waste
const MIN_DAYS = 5;
const BUCKETS = [
  ['warm', (x) => x.tmax != null && x.tmax >= 20],
  ['mild', (x) => x.tmax != null && x.tmax >= 10 && x.tmax < 20],
  ['cold', (x) => x.tmax != null && x.tmax < 10],
  ['rain', (x) => x.rain != null && x.rain >= RAIN_MM],
  ['dry', (x) => x.rain != null && x.rain < RAIN_MM],
];
const PAIRS = [['rain', 'dry'], ['warm', 'mild'], ['cold', 'mild']];

export function weatherCardHtml(daily) {
  const head = `<h2>${t('wx_title')}</h2>`;
  if (!daily.days.some((x) => x.tmax != null || x.rain != null)) {
    return `<div class="card">${head}<p class="muted small">${t('wx_none')}</p></div>`;
  }
  // Finished, registered days with weather; avoidable waste only (trim does not depend on the weather)
  const usable = daily.days.filter((x) => x.n > 0 && x.d < daily.today && (x.tmax != null || x.rain != null));
  const withGuests = usable.filter((x) => x.guests > 0);
  const perGuest = withGuests.length >= 10 && withGuests.length >= usable.length * 0.7;
  const pool = perGuest ? withGuests : usable;
  const value = (x) => (perGuest ? (x.akg * 1000) / x.guests : Number(x.akg));

  // Compare each day with what is usual for that weekday, so "Friday is always busy" is not read as a weather effect
  const perDow = {};
  pool.forEach((x) => { (perDow[dow(x.d)] = perDow[dow(x.d)] || []).push(value(x)); });
  const usual = {};
  Object.entries(perDow).forEach(([k, a]) => { if (a.length >= 3) usual[k] = median(a); });
  const rows = pool.filter((x) => usual[dow(x.d)] > 0).map((x) => ({ ...x, v: value(x), r: value(x) / usual[dow(x.d)] }));

  // Too early for any comparison: say how far along the data is instead of a table of zeros
  if (rows.length < 20) {
    return `<div class="card">${head}<p>${t('wx_collecting', { n: usable.length })}</p>
      <div class="note">${t('wx_collect_how')}${perGuest ? '' : ` ${t('wx_note_guests')}`}</div></div>`;
  }
  const stat = {};
  BUCKETS.forEach(([k, test]) => {
    const list = rows.filter(test);
    // median of the day-versus-usual ratios: one big event day does not tip a whole weather type
    stat[k] = { n: list.length, v: median(list.map((x) => x.v)), r: median(list.map((x) => x.r)) };
  });
  const unit = perGuest ? t('wx_per_guest') : t('wx_per_day');
  const lab = (k) => t('wx_b_' + k);
  const sentences = PAIRS.map(([a, b]) => {
    const A = stat[a]; const B = stat[b];
    if (A.n < MIN_DAYS || B.n < MIN_DAYS) {
      const short = A.n < MIN_DAYS ? [a, A.n] : [b, B.n];
      return `<li class="muted">${t('wx_need', { b: lab(short[0]), n: short[1], m: MIN_DAYS })}</li>`;
    }
    const diff = (A.r / B.r - 1) * 100;
    if (Math.abs(diff) < 10) return `<li>${t('wx_no_diff', { a: lab(a), b: lab(b), na: A.n, nb: B.n })}</li>`;
    return `<li>${t(diff > 0 ? 'wx_more' : 'wx_less', { a: lab(a), b: lab(b), p: fmt.pct(Math.abs(diff)), u: unit, na: A.n, nb: B.n })}</li>`;
  }).join('');

  const fmtV = (v) => (v == null ? '–' : perGuest ? `${fmt.num(v)} g` : fmt.kg(v, 1));
  const fmtR = (r, n) => (r == null || n < MIN_DAYS ? '<span class="muted">–</span>'
    : Math.abs(r - 1) < 0.005 ? '0%'
      : `<span class="${r > 1.05 ? 'bad-text' : r < 0.95 ? 'good-text' : ''}">${r >= 1 ? '+' : '−'}${fmt.pct(Math.abs(r - 1) * 100)}</span>`);
  const icon = { warm: '☀', mild: '⛅', cold: '❄', rain: '🌧', dry: '☁' };
  return `<div class="card">${head}
    <p class="small muted" style="margin-top:-6px">${t('wx_sub', { n: rows.length })}</p>
    <ul class="wx-findings">${sentences}</ul>
    <div class="table-wrap"><table class="wx-table"><thead><tr><th>${t('wx_weather')}</th><th class="right">${t('wx_days')}</th>
      <th class="right">${t('wx_avg')} (${perGuest ? `g ${t('per_guest_short')}` : `kg ${t('per_day')}`})</th><th class="right">${t('wx_vs_usual')}</th></tr></thead>
      <tbody>${BUCKETS.map(([k]) => `<tr><td>${icon[k]} ${lab(k)} <span class="muted small">${t('wx_def_' + k)}</span></td>
        <td class="right num">${stat[k].n}</td><td class="right num">${stat[k].n ? fmtV(stat[k].v) : '–'}</td><td class="right num">${fmtR(stat[k].r, stat[k].n)}</td></tr>`).join('')}</tbody></table></div>
    <div class="note">${t('wx_note')}${perGuest ? '' : ` ${t('wx_note_guests')}`}</div>
  </div>`;
}
