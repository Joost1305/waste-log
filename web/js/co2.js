// CO2 explanation: how the number is calculated and where the factors come from.
// Opened by clicking any CO2 figure. Factors and sources come from the database.
import { api, esc, fmt, openModal, toastError, state } from './core.js';
import { t } from './i18n.js';
import { EQUIVALENTS, equivalent, describeEquivalent, pickEquivalents } from './co2-equivalents.js';

let cache = null;

// record (optional): { weight_kg, co2e_kg, waste_category_id } to show this registration's own calculation
// total (optional): a CO2 amount (kg) shown on the page, translated into everyday comparisons
export async function showCo2Info(record, given, total) {
  // `given`: factors handed in by a page that has them already (the public page, where visitors are not signed in)
  try {
    if (!given && !cache) cache = (await api('/co2-factors')).data;
  } catch (e) { toastError(e); return; }
  const factors = given || cache;
  const sources = [...new Map(factors.filter((f) => f.co2e_source).map((f) => [f.co2e_source + (f.co2e_source_url || ''), f])).values()];
  const ex = factors.find((f) => f.code === 'vegetables') || factors[0];
  const own = record && factors.find((f) => f.id === record.waste_category_id);
  // The factor this registration actually used (its product's own RIVM value, or the category value)
  const prod = record && record.product_id && state.meta ? (state.meta.products || []).find((x) => x.id === record.product_id) : null;
  const usedF = record && Number(record.weight_kg) > 0 ? Number(record.co2e_kg) / Number(record.weight_kg) : null;
  openModal(`
    <h2>${t('co2_title')}</h2>
    <p>${t('co2_method')}</p>
    ${own ? `<div class="note" style="margin:0 0 12px">${t('co2_this', { w: fmt.kg(record.weight_kg, 2), f: fmt.num(usedF ?? own.co2e_per_kg, 2), r: fmt.kg(record.co2e_kg, 2) })}
        ${prod && prod.co2e_per_kg ? `<br><span class="small">${t('co2_from_product', { p: esc(prod.name) })}: ${esc(prod.co2e_source || '')}</span>`
          : usedF != null && Math.abs(usedF - Number(own.co2e_per_kg)) > 0.01 ? `<br><span class="small">${t('co2_from_product_any')}</span>`
          : `<br><span class="small">${t('co2_from_category')}</span>`}</div>`
      : ex ? `<p class="small muted">${t('co2_example', { cat: esc(ex.label.toLowerCase()), f: fmt.num(ex.co2e_per_kg, 1), r: fmt.num(ex.co2e_per_kg * 2, 1) })}</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>${t('category')}</th><th class="right">${t('co2_factor')}</th></tr></thead><tbody>
      ${factors.map((f) => `<tr${own && own.id === f.id ? ' class="row-hl"' : ''}><td><span class="dot" style="background:${esc(f.color || '#999')}"></span>${esc(f.label)}</td>
        <td class="right num">${fmt.num(f.co2e_per_kg, 1)}</td></tr>`).join('')}
    </tbody></table></div>
    <h3 style="margin-top:16px">${t('co2_source')}</h3>
    ${sources.length ? sources.map((s) => `<p class="small">${esc(s.co2e_source)}
      ${s.co2e_source_url ? `<br><a href="${esc(s.co2e_source_url)}" target="_blank" rel="noopener">${t('co2_open_source')} &#8599;</a>` : ''}</p>`).join('') : `<p class="small muted">–</p>`}
    <p class="small muted">${t('co2_licence')}</p>
    <div class="note">${t('co2_caveat')}</div>
    ${equivalentsHtml(record ? Number(record.co2e_kg) : total)}
    <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
}

// "What does this mean?": the amount in everyday terms, the comparison table and its sources
function equivalentsHtml(kg) {
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const mine = kg > 0 ? pickEquivalents(kg, { kitchen: true, max: 4 }) : [];
  const unitText = (e) => cap(describeEquivalent({ ...equivalent(e.per_unit, e.code), count: 1 }, t, fmt.num));
  return `
    <h3 style="margin-top:18px">${t('eq_title')}</h3>
    <p class="small">${t('eq_intro')}</p>
    ${mine.length ? `<p><strong>${fmt.kg(kg, kg < 10 ? 1 : 0)} CO₂-eq</strong>. ${t('eq_this')}:</p>
      <ul>${mine.map((q) => `<li>${esc(describeEquivalent(q, t, fmt.num))}</li>`).join('')}</ul>` : ''}
    <div class="table-wrap"><table><thead><tr><th>${t('eq_compare')}</th><th class="right">${t('eq_factor')}</th></tr></thead><tbody>
      ${EQUIVALENTS.map((e) => `<tr><td>${esc(unitText(e))}</td><td class="right num">${fmt.num(e.per_unit, 2)}</td></tr>`).join('')}
    </tbody></table></div>
    <details style="margin-top:8px"><summary class="small">${t('eq_sources')}</summary>
      ${EQUIVALENTS.map((e) => `<p class="small">${esc(e.source)}<br><a href="${esc(e.source_url)}" target="_blank" rel="noopener">${t('co2_open_source')} &#8599;</a></p>`).join('')}
    </details>`;
}

export function resetCo2Cache() { cache = null; }
