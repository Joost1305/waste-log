// CO2 explanation: how the number is calculated and where the factors come from.
// Opened by clicking any CO2 figure. Factors and sources come from the database.
import { api, esc, fmt, openModal, toastError } from './core.js';
import { t } from './i18n.js';

let cache = null;

// record (optional): { weight_kg, co2e_kg, waste_category_id } to show this registration's own calculation
export async function showCo2Info(record) {
  try {
    if (!cache) cache = (await api('/co2-factors')).data;
  } catch (e) { toastError(e); return; }
  const factors = cache;
  const sources = [...new Map(factors.filter((f) => f.co2e_source).map((f) => [f.co2e_source + (f.co2e_source_url || ''), f])).values()];
  const ex = factors.find((f) => f.code === 'vegetables') || factors[0];
  const own = record && factors.find((f) => f.id === record.waste_category_id);
  openModal(`
    <h2>${t('co2_title')}</h2>
    <p>${t('co2_method')}</p>
    ${own ? `<div class="note" style="margin:0 0 12px">${t('co2_this', { w: fmt.kg(record.weight_kg, 2), f: fmt.num(own.co2e_per_kg, 1), r: fmt.kg(record.co2e_kg, 2) })}</div>`
      : ex ? `<p class="small muted">${t('co2_example', { cat: esc(ex.label.toLowerCase()), f: fmt.num(ex.co2e_per_kg, 1), r: fmt.num(ex.co2e_per_kg * 2, 1) })}</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>${t('category')}</th><th class="right">${t('co2_factor')}</th></tr></thead><tbody>
      ${factors.map((f) => `<tr${own && own.id === f.id ? ' class="row-hl"' : ''}><td><span class="dot" style="background:${esc(f.color || '#999')}"></span>${esc(f.label)}</td>
        <td class="right num">${fmt.num(f.co2e_per_kg, 1)}</td></tr>`).join('')}
    </tbody></table></div>
    <h3 style="margin-top:16px">${t('co2_source')}</h3>
    ${sources.length ? sources.map((s) => `<p class="small">${esc(s.co2e_source)}
      ${s.co2e_source_url ? `<br><a href="${esc(s.co2e_source_url)}" target="_blank" rel="noopener">${t('co2_open_source')} &#8599;</a>` : ''}</p>`).join('') : `<p class="small muted">–</p>`}
    <div class="note">${t('co2_caveat')}</div>
    <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
}

export function resetCo2Cache() { cache = null; }
