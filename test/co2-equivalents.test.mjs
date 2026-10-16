// CO2 equivalents: readable numbers, sensible choices, nothing for tiny amounts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EQUIVALENTS, niceNumber, equivalent, pickEquivalents, describeEquivalent, equivalentsLine } from '../web/js/co2-equivalents.js';

const t = (key, vars) => `${key}:${vars ? vars.n : ''}`;
const num = (n, d = 0) => n.toFixed(d);

test('every equivalent has a factor and a source', () => {
  for (const e of EQUIVALENTS) {
    assert.ok(e.per_unit > 0, e.code);
    assert.ok(e.source && e.source_url.startsWith('https://'), e.code);
  }
});

test('niceNumber rounds to numbers that read well', () => {
  assert.equal(niceNumber(0.43), 0.4);
  assert.equal(niceNumber(3.4), 3);
  assert.equal(niceNumber(47), 45);
  assert.equal(niceNumber(1234), 1200);
  assert.equal(niceNumber(0), 0);
});

test('a 200 g beef steak equals about one steak', () => {
  assert.equal(equivalent(5.33, 'steak').count, 1);
});

test('oven time below an hour becomes minutes', () => {
  const q = equivalent(0.5, 'combi_oven');
  assert.equal(q.unit, 'minute');
  assert.equal(q.count, 25);
});

test('tiny amounts show nothing', () => {
  assert.deepEqual(pickEquivalents(0.01), []);
  assert.equal(equivalentsLine(0, t, num), '');
  assert.equal(equivalentsLine(NaN, t, num), '');
});

test('kitchen mode prefers kitchen images', () => {
  const [q] = pickEquivalents(3, { kitchen: true });
  assert.ok(['home_oven', 'combi_oven', 'steak'].includes(q.code), q.code);
});

test('large amounts pick large images, never "0.2 flights" or thousands of showers', () => {
  const list = pickEquivalents(2500, { max: 2 });
  assert.equal(list.length, 2);
  for (const q of list) assert.ok(q.raw >= 1 && q.raw <= 20000, `${q.code} ${q.raw}`);
  assert.ok(!pickEquivalents(2, { max: 6 }).some((q) => q.code === 'flight_paris'));
});

test('max 2 mixes a kitchen and an everyday image', () => {
  const list = pickEquivalents(40, { kitchen: true, max: 2 });
  const kitchen = new Set(EQUIVALENTS.filter((e) => e.kitchen).map((e) => e.code));
  assert.ok(kitchen.has(list[0].code));
  assert.ok(!kitchen.has(list[1].code));
});

test('rotate gives different images over time', () => {
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const codes = new Set(Array.from({ length: 30 }, () => pickEquivalents(6, { kitchen: true, rotate: true, random })[0].code));
  assert.ok(codes.size > 1);
});

test('singular text for one', () => {
  assert.equal(describeEquivalent(equivalent(5.33, 'steak'), t, num), 'eq_steak_one:1');
  assert.equal(describeEquivalent(equivalent(16, 'steak'), t, num), 'eq_steak:3');
});
