// Suggested interventions (0042): rules on the waste records, permissions, and hiding what is already covered.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, userId } from './harness.mjs';

let db; const U = {}; const ID = {};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const suggest = (uid, restaurant = null) => as(db, uid, ({ one: o }) => o(`select intervention_suggestions(null, $1, 28, 'en') s`, [restaurant])).then((r) => r.s);

before(async () => {
  db = await createDb();
  U.mgrHague = await userId(db, 'manager.denhaag@hth.demo');
  U.mgrAms = await userId(db, 'manager.amsterdam@hth.demo');
  U.student = await userId(db, 'student@hth.demo');
  ID.hague = (await one(`select id from restaurants where name = 'The Hague Restaurant'`)).id;
  ID.ams = (await one(`select id from restaurants where name = 'Amsterdam Restaurant'`)).id;
  ID.tomato = (await one(`select id from products where name = 'Tomatoes'`)).id;
  ID.spoilage = (await one(`select id from waste_reasons where code = 'spoilage' and organization_id is null`)).id;
  // Tomatoes spoil in The Hague on four different days
  for (const ago of [2, 5, 9, 13]) {
    await db.query(`insert into waste_records (restaurant_id, product_id, reason_id, weight_kg, entered_unit, user_id, recorded_at)
      values ($1, $2, $3, 3, 'kg', $4, now() - make_interval(days => $5))`, [ID.hague, ID.tomato, ID.spoilage, U.mgrHague, ago]);
  }
});

test('suggestions: employees are not allowed', async () => {
  await assert.rejects(suggest(U.student), /Not allowed/);
});

test('suggestions: recurring spoilage of one product is found, with examples', async () => {
  const s = await suggest(U.mgrHague, ID.hague);
  const tom = s.find((x) => x.rule === 'spoilage' && x.product_name === 'Tomatoes');
  assert.ok(tom, 'spoilage suggestion for tomatoes');
  assert.ok(tom.days >= 4 && Number(tom.kg) >= 12);
  assert.ok(Array.isArray(tom.examples));
  assert.ok(s.length <= 10);
  assert.ok(s.every((x) => x.restaurant_id === ID.hague));
});

test('suggestions: a manager never sees another restaurant', async () => {
  const s = await suggest(U.mgrAms);
  assert.ok(s.every((x) => x.restaurant_id !== ID.hague));
});

test('suggestions: an active intervention on the same product hides the suggestion', async () => {
  await db.query(`insert into interventions (organization_id, restaurant_id, title, start_date, status)
    select organization_id, id, 'Order Tomatoes smaller and more often', current_date - 1, 'active' from restaurants where id = $1`, [ID.hague]);
  const s = await suggest(U.mgrHague, ID.hague);
  assert.ok(!s.find((x) => x.product_name === 'Tomatoes'));
});

test('suggestions: with little data the biggest product shows as an early signal', async () => {
  const org = (await one(`select organization_id o from restaurants where id = $1`, [ID.hague])).o;
  const rid = (await one(`insert into restaurants (organization_id, name, slug) values ($1, 'Pop-up Test', 'pop-up-test') returning id`, [org])).id;
  const admin = await userId(db, 'orgadmin@hth.demo');
  for (const ago of [1, 3]) {
    await db.query(`insert into waste_records (restaurant_id, product_id, reason_id, weight_kg, entered_unit, user_id, recorded_at)
      values ($1, $2, $3, 1.5, 'kg', $4, now() - make_interval(days => $5))`, [rid, ID.tomato, ID.spoilage, admin, ago]);
  }
  const s = await suggest(admin, rid);
  assert.equal(s.length, 1);
  assert.equal(s[0].rule, 'early');
  assert.equal(s[0].product_name, 'Tomatoes');
  assert.equal(s[0].records, 2);
});
