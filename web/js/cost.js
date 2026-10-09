// Waste cost explanation: how the euro figure is calculated and where the prices come from.
// Opened by clicking the "Waste cost" figure on the dashboard.
import { esc, fmt, openModal } from './core.js';
import { t } from './i18n.js';

const ORDER = ['invoice', 'product', 'default'];
const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);

// mix: dashboard valuation_mix [{method, records, kg, value}]; total: total value; defaultPerKg: organization default
export function showCostInfo(mix, total, defaultPerKg) {
  const rows = ORDER.map((m) => (mix || []).find((x) => x.method === m) || { method: m, records: 0, kg: 0, value: 0 });
  const sum = Number(total) || rows.reduce((a, r) => a + Number(r.value || 0), 0);
  const dflt = rows.find((r) => r.method === 'default');
  const dfltShare = sum > 0 ? (Number(dflt.value) / sum) * 100 : 0;
  openModal(`
    <h2>${t('cost_title')}</h2>
    <p>${t('cost_method')}</p>
    <ol class="small" style="padding-left:18px;margin:0 0 12px">
      <li>${t('cost_src_invoice')}</li>
      <li>${t('cost_src_product')}</li>
      <li>${t('cost_src_default', { v: esc(fmt.money(defaultPerKg, 2)) })}</li>
    </ol>
    <div class="table-wrap"><table><thead><tr><th>${t('cost_source')}</th><th class="right">kg</th>
      <th class="right">${t('cost_avg')}</th><th class="right">${t('kpi_cost')}</th><th class="right">%</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${cap(t('val_' + r.method))}</td><td class="right num">${fmt.kg(r.kg, 0)}</td>
        <td class="right num">${Number(r.kg) > 0 ? fmt.money(Number(r.value) / Number(r.kg), 2) : '–'}</td>
        <td class="right num">${fmt.money(r.value)}</td>
        <td class="right num">${sum > 0 ? fmt.pct((Number(r.value) / sum) * 100, 0) : '–'}</td></tr>`).join('')}
      <tr><td><strong>${t('cost_total')}</strong></td><td class="right num"><strong>${fmt.kg(rows.reduce((a, r) => a + Number(r.kg || 0), 0), 0)}</strong></td><td></td>
        <td class="right num"><strong>${fmt.money(sum)}</strong></td><td></td></tr>
    </tbody></table></div>
    ${dfltShare >= 10 ? `<div class="note">${t('cost_default_note', { p: fmt.pct(dfltShare, 0) })}</div>` : ''}
    <div class="note">${t('cost_caveat')}</div>
    <div class="modal-actions"><button data-close>${t('close')}</button></div>`);
}
