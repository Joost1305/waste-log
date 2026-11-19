// Smart suggestions on the register screen (0047): moment of the day and weekday count, other restaurants never leak.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, userId } from './harness.mjs';

let db; const U = {}; const ID = {};
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
const suggest = (uid, rid, at) => as(db, uid, ({ q }) => q(`select product_id, score from suggest_products($1, $2::timestamptz, 3)`, [rid, at]));

before(async () => {
  db = await createDb();
  U.mgr = await userId(db, 'manager.denhaag@hth.demo');
  U.ams = await userId(db, 'manager.amsterdam@hth.demo');
  ID.hague = (await one(`select id from restaurants where name = 'The Hague Restaurant'`)).id;
  ID.tomato = (await one(`select id from products where name = 'Tomatoes'`)).id;
  ID.other = (await one(`select id from products where name <> 'Tomatoes' and organization_id = (select organization_id from restaurants where id = $1) and is_active and deleted_at is null order by id limit 1`, [ID.hague])).id;
  ID.reason = (await one(`select id from waste_reasons where code = 'spoilage' and organization_id is null`)).id;
  // A fresh restaurant so the seed data does not interfere
  const org = (await one(`select organization_id o from restaurants where id = $1`, [ID.hague])).o;
  ID.r = (await one(`insert into restaurants (organization_id, name, slug) values ($1, 'Suggest Test', 'suggest-test') returning id`, [org])).id;
  await db.query(`insert into user_restaurants (user_id, restaurant_id) values ($1, $2) on conflict do nothing`, [U.mgr, ID.r]);
  // Tomatoes thrown away at breakfast (08:00), the other product at dinner (19:00), on the same days
  for (const ago of [1, 2, 3, 4]) {
    for (const [pid, hour] of [[ID.tomato, 8], [ID.other, 19]]) {
      await db.query(`insert into waste_records (restaurant_id, product_id, reason_id, weight_kg, entered_unit, user_id, recorded_at)
        values ($1, $2, $3, 1, 'kg', $4, ((current_date - $5::int)::timestamp + make_interval(hours => $6::int)) at time zone 'Europe/Amsterdam')`,
        [ID.r, pid, ID.reason, U.mgr, ago, hour]);
    }
  }
});

const at = (hour) => `${new Date().toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:00:00+01:00`;

test('suggest: breakfast puts the breakfast product first, dinner the dinner product', async () => {
  const morning = await suggest(U.mgr, ID.r, at(8));
  const evening = await suggest(U.mgr, ID.r, at(19));
  assert.equal(Number(morning[0].product_id), ID.tomato);
  assert.equal(Number(evening[0].product_id), ID.other);
  assert.ok(morning.length <= 3);
});

test('suggest: nothing from a restaurant the user may not use', async () => {
  const rows = await suggest(U.ams, ID.r, at(8));
  assert.equal(rows.length, 0);
});
