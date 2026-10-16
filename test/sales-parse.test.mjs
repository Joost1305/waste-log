// The till report reader, on rows as an Excel export gives them (dates as serial numbers, numbers as numbers)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTurnoverRows, toNumber } from '../web/js/sales-parse.js';

test('sales reader: groups, items, period and totals from Excel rows', () => {
  const rows = [
    ['Turnover group report'],
    ['Start date:', 45606.25],            // 10-11-2024 06:00
    ['End date:', 45607],                 // 11-11-2024 00:00 -> one day
    ['Name', 'ID', 'Total', 'Incl. VAT', 'Excl. VAT', 'Incl. VAT'],
    ['Cappuccino', 4, 6, 13.2, 12.12, 13.2],
    ['Espresso', 9, 6, 10.8, 9.9, 10.8],
    ['Hot Drinks', 2, 12, 24, 22.02, 24],
    ['Beverage 4.50', 350, 200, 900, 826, 900],
    ['Beverage low', 1, 200, 900, 826, 900],
    ['Exp Main course Meat *', 935, 67, 0, 0, 0],
    ['Main course', 36, 67, 0, 0, 0],
    ['Total', '', 279, 924, 848.02, 924],
  ];
  const r = parseTurnoverRows(rows);
  assert.deepEqual(r.period, { from: '2024-11-10', to: '2024-11-10' });
  assert.equal(r.lines.length, 4);
  assert.deepEqual(r.warnings, []);
  const bev = r.lines.find((l) => l.item_name === 'Beverage 4.50');
  assert.equal(bev.group_name, 'Beverage low'); assert.equal(bev.qty, 200); assert.equal(bev.excl, 826);
  assert.equal(r.lines.find((l) => l.item_name === 'Exp Main course Meat *').group_name, 'Main course');
});

test('sales reader: text dates, a week, decimal commas', () => {
  const r = parseTurnoverRows([
    ['Start date: 10-11-2024 06:00'], ['End date: 16-11-2024 00:00'],
    ['Soep', '12', '3', '13,50', '12,39', '13,50'], ['Food', '24', '3', '13,50', '12,39', '13,50'],
  ]);
  assert.deepEqual(r.period, { from: '2024-11-10', to: '2024-11-15' });
  assert.equal(r.lines[0].incl, 13.5);
  assert.equal(toNumber('1,098.00'), 1098); assert.equal(toNumber('1.098,50'), 1098.5);
});
