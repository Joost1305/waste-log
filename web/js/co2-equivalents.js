// CO2 equivalents: turn "12 kg CO2-eq" into something people picture, like "2 beef steaks"
// or "63 km by car". No imports, so the logic can be tested without a browser.
//
// Every factor is kg CO2-eq per unit and has a source. Where a factor rests on an assumption
// (how much energy an oven uses), the assumption is written out, so anyone can check it.
// These are indications for comparison, never measurements.

const CEF = 'CO2emissiefactoren.nl, 2026';
const CEF_URL = 'https://co2emissiefactoren.nl/factoren/';

export const EQUIVALENTS = [
  {
    code: 'car_km', unit: 'km', per_unit: 0.19, kitchen: false,
    source: `${CEF}: average passenger car, 0.190 kg per km`, source_url: `${CEF_URL}2026/13/personenvervoer/`,
  },
  {
    code: 'home_oven', unit: 'hour', per_unit: 0.29, kitchen: true,
    source: `Electric home oven at 200 °C, assumed 1.2 kWh per hour × Dutch grid mix 0.244 kg per kWh (${CEF})`,
    source_url: `${CEF_URL}2026/11/elektriciteit/`,
  },
  {
    code: 'combi_oven', unit: 'hour', per_unit: 1.22, kitchen: true,
    source: `Electric combi oven (6 × GN 1/1) in use, assumed 5 kWh per hour × Dutch grid mix 0.244 kg per kWh (${CEF})`,
    source_url: `${CEF_URL}2026/11/elektriciteit/`,
  },
  {
    code: 'shower', unit: 'count', per_unit: 0.62, kitchen: false,
    source: `Hot shower of 10 minutes on a gas boiler: 80 litres heated by 28 °C ≈ 0.29 m³ gas × 2.134 kg per m³ (${CEF})`,
    source_url: `${CEF_URL}2026/10/brandstoffen-energieopwekking/`,
  },
  {
    code: 'steak', unit: 'count', per_unit: 5.33, kitchen: true,
    source: 'Beef steak of 200 g: RIVM, beef steak 26.7 kg per kg (via Klimaatplein, CO2 footprint of food for catering)',
    source_url: 'https://www.rivm.nl/voeding/duurzaam-voedsel/database-milieubelasting-voedingsmiddelen',
  },
  {
    code: 'flight_paris', unit: 'count', per_unit: 100, kitchen: false,
    source: `Flight Amsterdam–Paris one way, about 430 km × 0.234 kg per passenger-km (${CEF})`,
    source_url: `${CEF_URL}2026/13/personenvervoer/`,
  },
];

const byCode = Object.fromEntries(EQUIVALENTS.map((e) => [e.code, e]));

// Round to a number that reads well: 0.4 → 0.4, 3.26 → 3, 47 → 45, 1234 → 1,200
export function niceNumber(n) {
  if (!(n > 0)) return 0;
  if (n < 1) return Math.round(n * 10) / 10;
  if (n < 10) return Math.round(n);
  if (n < 100) return Math.round(n / 5) * 5;
  const p = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

// One equivalent for a CO2 amount. Hours below one become minutes.
export function equivalent(kgCo2, code) {
  const e = byCode[code];
  if (!e || !(kgCo2 > 0)) return null;
  let count = kgCo2 / e.per_unit;
  let unit = e.unit;
  if (unit === 'hour' && count < 1) { count *= 60; unit = 'minute'; }
  return { code, unit, raw: count, count: niceNumber(count) };
}

// Does this count read naturally? "0.2 flights" or "4,000 showers" do not.
function readable(eq) {
  if (!eq || eq.count <= 0) return false;
  if (eq.unit === 'km') return eq.raw >= 1 && eq.raw <= 20000;
  if (eq.unit === 'minute') return eq.raw >= 5;
  if (eq.unit === 'hour') return eq.raw <= 500;
  return eq.raw >= 1 && eq.raw <= 2000; // countable things: steaks, showers, flights
}

// The range in which a number reads best, per unit
const IDEAL = { count: [2, 50], hour: [1, 24], minute: [10, 59], km: [2, 500] };

// Which equivalents to show for an amount.
//   kitchen: true  → prefer kitchen images (ovens, steaks), handy on the register screen
//   rotate:  true  → a random readable one (so a repeated message does not become wallpaper)
//   max:     how many, different codes, kitchen and everyday mixed when max > 1
// Below 0.05 kg nothing is shown: "≈ 15 seconds of oven" helps nobody.
export function pickEquivalents(kgCo2, { kitchen = false, rotate = false, max = 1, random = Math.random } = {}) {
  if (!(kgCo2 >= 0.05)) return [];
  const all = EQUIVALENTS.map((e) => equivalent(kgCo2, e.code)).filter(readable);
  if (!all.length) return [];
  // Prefer numbers big enough to feel and small enough to picture; outside the range,
  // the further away, the lower the preference
  const score = (q) => {
    const [lo, hi] = IDEAL[q.unit];
    return q.raw < lo ? Math.log10(lo / q.raw) : q.raw > hi ? Math.log10(q.raw / hi) : 0;
  };
  const isKitchen = (q) => byCode[q.code].kitchen;
  const order = (list) => (rotate ? shuffle(list.filter((q) => score(q) === 0), random).concat(list.filter((q) => score(q) > 0).sort((a, b) => score(a) - score(b)))
    : [...list].sort((a, b) => score(a) - score(b)));
  const first = order(all.filter((q) => isKitchen(q) === kitchen));
  const second = order(all.filter((q) => isKitchen(q) !== kitchen));
  const out = [];
  if (max === 1) out.push(...(first.length ? first : second).slice(0, 1));
  else {
    // Alternate: one from the preferred group, one from the other, then fill up
    const a = [...first]; const b = [...second];
    while (out.length < max && (a.length || b.length)) {
      if (a.length) out.push(a.shift());
      if (out.length < max && b.length) out.push(b.shift());
    }
  }
  return out;
}

// Text for one equivalent. `t` and `fmtNum` are passed in by the page (translations, number format).
export function describeEquivalent(eq, t, fmtNum) {
  if (!eq) return '';
  const n = fmtNum(eq.count, eq.count < 1 ? 1 : 0);
  const one = eq.count === 1;
  const key = eq.unit === 'minute' ? `eq_${eq.code}_min` : `eq_${eq.code}${one ? '_one' : ''}`;
  return t(key, { n });
}

// "≈ 2 beef steaks · 56 km by car", or '' when the amount is too small
export function equivalentsLine(kgCo2, t, fmtNum, opts) {
  const list = pickEquivalents(kgCo2, opts);
  return list.length ? `≈ ${list.map((q) => describeEquivalent(q, t, fmtNum)).join(' · ')}` : '';
}

function shuffle(list, random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
