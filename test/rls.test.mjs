// Security and logic tests against the real migrations on a local Postgres (PGlite).
// Run: npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, as, userId } from './harness.mjs';

let db; const U = {}; const ID = {};

before(async () => {
  db = await createDb();
  for (const e of ['admin@platform.demo', 'orgadmin@hth.demo', 'manager.amsterdam@hth.demo', 'manager.denhaag@hth.demo',
    'student@hth.demo', 'admin@bistro.demo']) U[e.split('@')[0] + '@' + e.split('@')[1].split('.')[0]] = await userId(db, e);
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  ID.hth = (await one(`select id from organizations where slug = 'hotelschool-the-hague-demo'`)).id;
  ID.bistro = (await one(`select id from organizations where slug = 'demo-bistro-group'`)).id;
  ID.ams = (await one(`select id from restaurants where name = 'Amsterdam Restaurant'`)).id;
  ID.hague = (await one(`select id from restaurants where name = 'The Hague Restaurant'`)).id;
  ID.bistroRest = (await one(`select id from restaurants where organization_id = $1`, [ID.bistro])).id;
  ID.tomato = (await one(`select id from products where name = 'Tomatoes'`)).id;
  ID.soup = (await one(`select id from products where name = 'Vegetable soup'`)).id;
  ID.prepared = (await one(`select id from waste_categories where code = 'prepared' and organization_id is null`)).id;
  ID.spoilage = (await one(`select id from waste_reasons where code = 'spoilage' and organization_id is null`)).id;
  ID.hthRecord = (await one(`select id from waste_records where organization_id = $1 and restaurant_id = $2 limit 1`, [ID.hth, ID.hague])).id;
});

const insertWaste = (o) => [`insert into waste_records (restaurant_id, product_id, product_name, waste_category_id, reason_id, weight_kg, entered_unit, user_id, photo_path)
  values ($1, $2, $3, $4, $5, $6, 'kg', auth.uid(), $7) returning *`,
[o.restaurant_id, o.product_id ?? null, o.product_name ?? null, o.waste_category_id ?? null, o.reason_id, o.weight_kg, o.photo_path ?? null]];

test('anonymous visitors cannot read anything', async () => {
  await assert.rejects(as(db, null, ({ q }) => q('select * from waste_records limit 1')));
  await assert.rejects(as(db, null, ({ q }) => q('select * from users limit 1')));
});

test('tenant isolation: another organization never sees Hotelschool data', async () => {
  await as(db, U['admin@bistro'], async ({ q, one }) => {
    assert.equal((await q('select id from waste_records where organization_id = $1', [ID.hth])).length, 0);
    assert.equal((await q('select id from restaurants where organization_id = $1', [ID.hth])).length, 0);
    assert.equal((await q('select id from products where organization_id = $1', [ID.hth])).length, 0);
    assert.equal((await q('select id from users where organization_id = $1', [ID.hth])).length, 0);
    assert.equal((await q('select id from organizations where id = $1', [ID.hth])).length, 0);
    const own = await q('select restaurant_id from waste_records');
    assert.ok(own.length > 0 && own.every((r) => r.restaurant_id === ID.bistroRest));
    // update / soft delete of a foreign record touches nothing
    const upd = await q('update waste_records set note = $1 where id = $2 returning id', ['x', ID.hthRecord]);
    assert.equal(upd.length, 0);
    // RPCs ignore a foreign organization id for non-super users
    const meta = (await one('select app_meta($1) m', [ID.hth])).m;
    assert.equal(meta.organization.id, ID.bistro);
    const list = (await one('select list_waste($1) l', [ID.hth])).l;
    assert.ok(list.rows.every((r) => r.restaurant_id === ID.bistroRest));
  });
  // cannot write into a Hotelschool restaurant
  await assert.rejects(as(db, U['admin@bistro'], ({ q }) => q(...insertWaste({ restaurant_id: ID.ams, waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 1 }))));
  // cannot use a Hotelschool product in its own restaurant
  await assert.rejects(as(db, U['admin@bistro'], ({ q }) => q(...insertWaste({ restaurant_id: ID.bistroRest, product_id: ID.tomato, reason_id: ID.spoilage, weight_kg: 1 }))), /Unknown product/);
});

test('restaurant scope: Amsterdam manager cannot see or write The Hague', async () => {
  await as(db, U['manager.amsterdam@hth'], async ({ q }) => {
    assert.equal((await q('select id from waste_records where restaurant_id = $1', [ID.hague])).length, 0);
  });
  await assert.rejects(as(db, U['manager.amsterdam@hth'], ({ q }) => q(...insertWaste({ restaurant_id: ID.hague, waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 1 }))));
  await assert.rejects(as(db, U['manager.amsterdam@hth'], ({ one }) => one('select dashboard(null, $1) d', [ID.hague])), /Restaurant not found/);
});

test('roles: employees see only their own records, no dashboard, no catalog writes, no user changes', async () => {
  await as(db, U['student@hth'], async ({ q }) => {
    const rows = await q('select user_id from waste_records');
    assert.ok(rows.length > 0 && rows.every((r) => r.user_id === U['student@hth']));
    assert.equal((await q('select id from users')).length, 1);           // only themselves
    assert.equal((await q('select id from targets')).length, 0);
  });
  await assert.rejects(as(db, U['student@hth'], ({ one }) => one('select dashboard() d')), /Not allowed/);
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(`insert into products (name, waste_category_id) values ('X', $1)`, [ID.prepared])));
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(`update users set role = 'org_admin' where id = auth.uid()`)));
  await assert.rejects(as(db, U['manager.amsterdam@hth'], ({ q }) => q(`insert into targets (name, baseline_kg, target_kg, start_date) values ('t', 10, 5, current_date)`)));
});

test('nobody can grant themselves rights or call setup functions', async () => {
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`update users set role = 'super_admin' where id = auth.uid()`)));
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`select app.create_login('x@x.nl','longpassword','X','super_admin',null)`)));
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`select app.seed_demo()`)));
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`insert into audit_log (action, entity) values ('x','y')`)));
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`delete from waste_records where id = $1`, [ID.hthRecord])));
});

test('valuation: invoice price > product price > organization default; grams stored as kg', async () => {
  await as(db, U['student@hth'], async ({ q }) => {
    const [a] = await q(...insertWaste({ restaurant_id: ID.ams, product_id: ID.tomato, reason_id: ID.spoilage, weight_kg: 1.5 }));
    assert.equal(a.valuation_method, 'invoice');
    assert.equal(a.organization_id, ID.hth);
    assert.equal(a.user_id, U['student@hth']);
    const [b] = await q(...insertWaste({ restaurant_id: ID.ams, product_id: ID.soup, reason_id: ID.spoilage, weight_kg: 2 }));
    assert.equal(b.valuation_method, 'product');
    assert.equal(Number(b.purchase_value), 3.6);
    assert.equal(Number(b.potential_sales_value), 18);
    const [c] = await q(...insertWaste({ restaurant_id: ID.ams, product_name: 'Mixed buffet', waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 2 }));
    assert.equal(c.valuation_method, 'default');
    assert.equal(Number(c.purchase_value), 13);
    assert.equal(Number(c.co2e_kg), 8);
  });
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(...insertWaste({ restaurant_id: ID.ams, reason_id: ID.spoilage, weight_kg: 1 }))), /Choose a product or a category/);
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(...insertWaste({ restaurant_id: ID.ams, waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 900 }))));
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(...insertWaste({ restaurant_id: ID.ams, waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 1, photo_path: `org-${ID.bistro}/x.jpg` }))), /Invalid photo/);
});

test('employees may correct or soft-delete only their own records of today', async () => {
  const rec = await as(db, U['student@hth'], async ({ q }) => (await q(...insertWaste({ restaurant_id: ID.ams, waste_category_id: ID.prepared, reason_id: ID.spoilage, weight_kg: 1 })))[0]);
  await as(db, U['student@hth'], async ({ q }) => {
    const r = await q('update waste_records set weight_kg = 2 where id = $1 returning purchase_value', [rec.id]);
    assert.equal(Number(r[0].purchase_value), 13);   // valuation recalculated
    const old = await q(`update waste_records set note = 'x' where user_id = auth.uid() and created_at < now() - interval '2 days' returning id`);
    assert.equal(old.length, 0);
    await q('update waste_records set deleted_at = now() where id = $1', [rec.id]);
    const after = (await q('select list_waste(null, null, null, null, null, null, true, 500) l'))[0].l;
    assert.ok(!after.rows.some((r) => r.id === rec.id));
  });
});

test('dashboard totals match the records and respect scope', async () => {
  const d = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select dashboard(null, null, current_date - 50, current_date) d`)).d);
  const s = (await db.query(`select sum(weight_kg) kg from waste_records where organization_id = $1 and deleted_at is null
                              and app.local_date(recorded_at) between current_date - 50 and current_date`, [ID.hth])).rows[0];
  assert.ok(Math.abs(d.totals.kg - Number(s.kg)) < 0.05);
  assert.ok(Math.abs(d.by_category.reduce((a, c) => a + c.kg, 0) - Number(s.kg)) < 0.05);
  assert.ok(d.target && d.target.baseline_kg > d.target.target_kg);
  assert.ok(d.trend.length >= 5);
  // A manager who does not see every restaurant gets no organization-wide target
  const m = await as(db, U['manager.amsterdam@hth'], async ({ one }) => (await one('select dashboard() d')).d);
  assert.equal(m.target, null);
  assert.ok(m.by_restaurant.every((r) => ['Amsterdam Restaurant', 'Brasserie ZINQ'].includes(r.name)));
});

test('super admin can switch organization', async () => {
  const meta = await as(db, U['admin@platform'], async ({ one }) => (await one('select app_meta($1) m', [ID.bistro])).m);
  assert.equal(meta.organization.id, ID.bistro);
  assert.equal(meta.restaurants.length, 1);
});

test('audit log records changes and is readable only by org admins', async () => {
  const n = await as(db, U['orgadmin@hth'], async ({ q }) => (await q(`select count(*)::int n from audit_log where entity = 'waste_records'`))[0].n);
  assert.ok(n > 0);
  const m = await as(db, U['manager.amsterdam@hth'], async ({ q }) => (await q('select count(*)::int n from audit_log'))[0].n);
  assert.equal(m, 0);
});

test('weight source: AI estimate is stored, and a later correction makes it manual', async () => {
  const rec = await as(db, U['student@hth'], async ({ q }) => (await q(
    `insert into waste_records (restaurant_id, waste_category_id, reason_id, weight_kg, user_id, weight_source)
     values ($1, $2, $3, 1.5, auth.uid(), 'estimate') returning id, weight_source`, [ID.ams, ID.prepared, ID.spoilage]))[0]);
  assert.equal(rec.weight_source, 'estimate');
  const after = await as(db, U['student@hth'], async ({ q }) => (await q(
    'update waste_records set weight_kg = 1.2 where id = $1 returning weight_source', [rec.id]))[0]);
  assert.equal(after.weight_source, 'manual');
  const d = await as(db, U['orgadmin@hth'], async ({ one }) => (await one('select dashboard() d')).d);
  assert.ok('estimated_kg_pct' in d.data_quality);
});
