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
  // Cost explanation: the euros per price source add up to the total waste cost
  assert.ok(d.valuation_mix.every((v) => v.value != null));
  assert.ok(Math.abs(d.valuation_mix.reduce((a, v) => a + Number(v.value), 0) - d.totals.value) < 0.05);
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

test('gallery: heaviest photos first, only within scope', async () => {
  for (const kg of [0.4, 3.2, 1.1]) {
    await as(db, U['student@hth'], ({ q }) => q(
      `insert into waste_records (restaurant_id, waste_category_id, reason_id, weight_kg, user_id, photo_path)
       values ($1, $2, $3, $4, auth.uid(), $5)`, [ID.ams, ID.prepared, ID.spoilage, kg, `org-${ID.hth}/2026-10/test-${kg}.jpg`]));
  }
  const g = await as(db, U['orgadmin@hth'], async ({ one }) => (await one('select gallery() g')).g);
  const w = g.rows.map((r) => Number(r.weight_kg));
  assert.deepEqual(w.slice(0, 3), [3.2, 1.1, 0.4]);
  const b = await as(db, U['admin@bistro'], async ({ one }) => (await one('select gallery() g')).g);
  assert.equal(b.total, 0);
});

test('gallery sorting: lightest first, by category, and invalid sort falls back to heaviest', async () => {
  const light = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select gallery(p_sort => 'lightest') g`)).g);
  const lw = light.rows.map((r) => Number(r.weight_kg));
  assert.deepEqual(lw, [...lw].sort((a, b) => a - b));
  const cat = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select gallery(p_sort => 'category', p_limit => 100) g`)).g);
  const order = cat.rows.map((r) => r.waste_category_id);
  const seen = []; for (const c of order) if (seen[seen.length - 1] !== c) seen.push(c);
  assert.equal(new Set(seen).size, seen.length);            // each category forms one block
  assert.ok(cat.rows[0].user_id && cat.rows[0].created_at);  // needed for delete rights in the app
  const bad = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select gallery(p_sort => 'x; drop') g`)).g);
  assert.equal(bad.sort, 'heaviest');
});

test('export: records and guests within scope only', async () => {
  const e = await as(db, U['orgadmin@hth'], async ({ one }) => (await one('select export_data() e')).e);
  const n = (await db.query('select count(*)::int n from waste_records where organization_id = $1 and deleted_at is null', [ID.hth])).rows[0].n;
  assert.equal(e.records.length, n);
  assert.ok(e.records[0].recorded_local && 'co2e_per_kg' in e.records[0]);
  assert.ok(e.covers.length > 0);
  const m = await as(db, U['manager.amsterdam@hth'], async ({ one }) => (await one('select export_data() e')).e);
  assert.ok(m.records.every((r) => ['Amsterdam Restaurant', 'Brasserie ZINQ'].includes(r.restaurant)));
  const s = await as(db, U['student@hth'], async ({ one }) => (await one('select export_data() e')).e);
  assert.ok(s.records.every((r) => r.user === 'Noah Bakker (demo)'));
  const b = await as(db, U['admin@bistro'], async ({ one }) => (await one('select export_data() e')).e);
  assert.ok(!b.records.some((r) => r.restaurant === 'Amsterdam Restaurant'));
});

test('targets: period week/month/year, editable by org admins only, dashboard uses the period window', async () => {
  const tg = (await db.query(`select id from targets where organization_id = $1 and deleted_at is null limit 1`, [ID.hth])).rows[0];
  await as(db, U['orgadmin@hth'], ({ q }) => q(`update targets set period = 'week', baseline_kg = 200, target_kg = 150 where id = $1`, [tg.id]));
  const d = await as(db, U['orgadmin@hth'], async ({ one }) => (await one('select dashboard() d')).d);
  assert.equal(d.target.period, 'week');
  assert.equal(d.target.window.days, 7);
  assert.equal(Number(d.target.baseline_kg), 200);
  await assert.rejects(as(db, U['orgadmin@hth'], ({ q }) => q(`update targets set period = 'decade' where id = $1`, [tg.id])));
  const m = await as(db, U['manager.amsterdam@hth'], async ({ q }) => q(`update targets set baseline_kg = 999 where id = $1 returning id`, [tg.id]));
  assert.equal(m.length, 0);
});

test('bulk delete: managers soft-delete several records, employees only their own of today', async () => {
  const ids = (await db.query(`select id from waste_records where organization_id = $1 and restaurant_id = $2 and deleted_at is null order by id limit 3`, [ID.hth, ID.ams])).rows.map((r) => r.id);
  const del = await as(db, U['manager.amsterdam@hth'], async ({ q }) => q(`update waste_records set deleted_at = now() where id = any($1) returning id`, [ids]));
  assert.equal(del.length, 3);
  const other = (await db.query(`select id from waste_records where organization_id = $1 and deleted_at is null and user_id <> $2 limit 2`, [ID.hth, U['student@hth']])).rows.map((r) => r.id);
  const s = await as(db, U['student@hth'], async ({ q }) => q(`update waste_records set deleted_at = now() where id = any($1) returning id`, [other]));
  assert.equal(s.length, 0);
});

test('CO2 factors carry a source and English is the default language', async () => {
  const c = await as(db, U['student@hth'], async ({ q }) => q(`select co2e_per_kg, co2e_source, co2e_source_url from waste_categories where organization_id is null`));
  assert.ok(c.length > 0 && c.every((r) => r.co2e_source && r.co2e_source_url));
  const lang = (await db.query(`select column_default from information_schema.columns where table_name = 'users' and column_name = 'language'`)).rows[0];
  assert.match(lang.column_default, /'en'/);
});

test('user logins: org admins see last login of their own organization only', async () => {
  await db.query(`update auth.users set last_sign_in_at = now() - interval '1 hour' where email = 'student@hth.demo'`);
  const rows = await as(db, U['orgadmin@hth'], ({ q }) => q('select * from user_logins()'));
  assert.ok(rows.length >= 5);
  assert.ok(rows.find((r) => r.id === U['student@hth']).last_sign_in_at);
  const b = await as(db, U['admin@bistro'], ({ q }) => q('select * from user_logins()'));
  assert.ok(!b.some((r) => r.id === U['student@hth']));
  const m = await as(db, U['manager.amsterdam@hth'], ({ q }) => q('select * from user_logins()'));
  assert.equal(m.length, 0);
});

test('top products: whole kitchen for an employee, only own restaurants', async () => {
  const s = await as(db, U['student@hth'], ({ q }) => q('select * from top_products($1, 60, 12)', [ID.ams]));
  assert.ok(s.length > 0 && s.length <= 12);
  const counts = s.map((r) => Number(r.n));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  // more than the student's own records: it is the kitchen's list
  const own = (await db.query(`select count(distinct product_id)::int n from waste_records where user_id = $1 and restaurant_id = $2 and product_id is not null`, [U['student@hth'], ID.ams])).rows[0].n;
  assert.ok(s.length >= Math.min(own, 12));
  const other = await as(db, U['student@hth'], ({ q }) => q('select * from top_products($1)', [ID.hague]));
  assert.equal(other.length, 0);
  const bistro = await as(db, U['admin@bistro'], ({ q }) => q('select * from top_products($1)', [ID.ams]));
  assert.equal(bistro.length, 0);
});

test('photo upload: own organization folder only; super admin may use any existing organization', async () => {
  const up = (uid, path) => as(db, uid, ({ q }) => q(`insert into storage.objects (bucket_id, name, owner_id) values ('waste-photos', $1, auth.uid()::text)`, [path]).then(() => [1]));
  assert.equal((await up(U['student@hth'], `org-${ID.hth}/2026-10/a.jpg`)).length, 1);
  await assert.rejects(up(U['student@hth'], `org-${ID.bistro}/2026-10/b.jpg`));
  assert.equal((await up(U['admin@platform'], `org-${ID.hth}/2026-10/c.jpg`)).length, 1);
  assert.equal((await up(U['admin@platform'], `org-${ID.bistro}/2026-10/d.jpg`)).length, 1);
  await assert.rejects(up(U['admin@platform'], `org-99999/2026-10/e.jpg`));
});

test('product names follow the language: English name when set, Dutch otherwise', async () => {
  await db.query(`update products set name_en = 'Tomatoes (EN)' where id = $1`, [ID.tomato]);
  const en = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select app_meta(null, 'en') m`)).m);
  const nl = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select app_meta(null, 'nl') m`)).m);
  assert.equal(en.products.find((p) => p.id === ID.tomato).name, 'Tomatoes (EN)');
  assert.equal(nl.products.find((p) => p.id === ID.tomato).name, 'Tomatoes');
  assert.equal(en.products.find((p) => p.id === ID.tomato).name_nl, 'Tomatoes');
  const l = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select list_waste(null, null, null, null, null, null, false, 500, 0, 'en') l`)).l);
  assert.ok(l.rows.some((r) => r.product_id === ID.tomato && r.product_name === 'Tomatoes (EN)'));
  const d = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select dashboard(null, null, current_date - 60, current_date, 'en') d`)).d);
  assert.ok(Array.isArray(d.top_products));
  const e = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select export_data(null, null, null, null, null, null, false, 'en') e`)).e);
  assert.ok(e.records.some((r) => r.product === 'Tomatoes (EN)'));
});

test('public impact page: anonymous visitors see only enabled restaurants, no prices or people', async () => {
  const slug = (await db.query(`select slug from organizations where id = $1`, [ID.hth])).rows[0].slug;
  const rs = (await db.query(`select slug, public_impact_enabled from restaurants where organization_id = $1 order by id`, [ID.hth])).rows;
  const on = rs.find((r) => r.public_impact_enabled);
  const page = await as(db, null, async ({ one }) => (await one(`select public_impact($1, $2, 'en') p`, [slug, on.slug])).p);
  assert.ok(page && page.last30 && Array.isArray(page.trend) && page.categories.length > 0);
  const text = JSON.stringify(page);
  assert.ok(!/"(purchase_value|value|potential_sales_value|unit_cost_per_kg|user|user_name|email|photo_path)"\s*:/.test(text), 'no prices, users or photos');
  await db.query(`update restaurants set public_impact_enabled = false where organization_id = $1 and slug = $2`, [ID.hth, on.slug]);
  const hidden = await as(db, null, async ({ one }) => (await one(`select public_impact($1, $2) p`, [slug, on.slug])).p);
  assert.equal(hidden, null);
  await db.query(`update restaurants set public_impact_enabled = true where organization_id = $1 and slug = $2`, [ID.hth, on.slug]);
  const org = await as(db, null, async ({ one }) => (await one(`select public_impact($1) p`, [slug])).p);
  assert.equal(org.scope, 'organization');
  assert.ok(org.restaurants.every((r) => rs.find((x) => x.slug === r.slug).public_impact_enabled));
  const nope = await as(db, null, async ({ one }) => (await one(`select public_impact('does-not-exist') p`)).p);
  assert.equal(nope, null);
  await assert.rejects(as(db, null, ({ q }) => q('select * from waste_records limit 1')));
});

test('interventions: own restaurants only, before/after effect with comparison group', async () => {
  const start = (await db.query(`select (current_date - 21)::text d`)).rows[0].d;
  // Amsterdam manager may add one for Amsterdam, not for The Hague
  const iv = await as(db, U['manager.amsterdam@hth'], ({ one }) => one(
    `insert into interventions (restaurant_id, title, start_date, status, scope_reason_id) values ($1, 'Smaller batches', $2, 'active', $3) returning *`,
    [ID.ams, start, ID.spoilage]));
  assert.equal(iv.organization_id, ID.hth);
  await assert.rejects(as(db, U['manager.amsterdam@hth'], ({ q }) => q(
    `insert into interventions (restaurant_id, title, start_date) values ($1, 'Not mine', current_date)`, [ID.hague])));
  // Effect: same number of days before and after, comparison with the other restaurants
  const e = await as(db, U['manager.amsterdam@hth'], async ({ one }) => (await one('select intervention_effect($1, 28) e', [iv.id])).e);
  assert.equal(e.status, 'ok');
  assert.equal(e.before.days, 28);
  assert.equal(e.after.days, 22);
  assert.ok(e.control_restaurants >= 1);
  assert.ok(Array.isArray(e.weekly) && e.weekly.some((w) => w.phase === 'before') && e.weekly.some((w) => w.phase === 'after'));
  const s = (await db.query(`select coalesce(sum(weight_kg), 0) kg from waste_records where restaurant_id = $1 and reason_id = $2 and deleted_at is null
     and app.local_date(recorded_at) between $3::date - 28 and $3::date - 1`, [ID.ams, ID.spoilage, start])).rows[0];
  assert.ok(Math.abs(e.before.kg - Number(s.kg)) < 0.05);
  // List with effect summary; students see no interventions
  const l = await as(db, U['orgadmin@hth'], async ({ one }) => (await one(`select interventions_list(null, 'en') l`)).l);
  const mine = l.find((x) => x.id === iv.id);
  assert.ok(mine && mine.effect.status === 'ok' && mine.effect.weekly === null && mine.scope_reason === 'Spoilage');
  const st = await as(db, U['student@hth'], async ({ one }) => (await one(`select interventions_list() l`)).l);
  assert.deepEqual(st, []);
  // Other organization sees nothing and gets no effect
  const other = await as(db, U['admin@bistro'], async ({ one }) => (await one('select intervention_effect($1) e', [iv.id])).e);
  assert.equal(other, null);
});

test('best practices: managers publish for their restaurant, everyone in the organization reads published ones', async () => {
  const bp = await as(db, U['manager.amsterdam@hth'], ({ one }) => one(
    `insert into best_practices (restaurant_id, title, problem, solution, status) values ($1, 'Soup in two batches', 'Soup left over', 'Cook half, then top up', 'published') returning *`, [ID.ams]));
  assert.ok(bp.published_at && bp.author_user_id === U['manager.amsterdam@hth']);
  const draft = await as(db, U['manager.amsterdam@hth'], ({ one }) => one(
    `insert into best_practices (restaurant_id, title, status) values ($1, 'Draft idea', 'draft') returning id`, [ID.ams]));
  await assert.rejects(as(db, U['manager.amsterdam@hth'], ({ q }) => q(
    `insert into best_practices (restaurant_id, title) values ($1, 'Not mine')`, [ID.hague])));
  await assert.rejects(as(db, U['student@hth'], ({ q }) => q(
    `insert into best_practices (restaurant_id, title) values ($1, 'Student')`, [ID.ams])));
  const st = await as(db, U['student@hth'], async ({ one }) => (await one(`select best_practices_list() l`)).l);
  assert.ok(st.rows.some((r) => r.id === bp.id && r.author_name && r.can_edit === false));
  assert.ok(!st.rows.some((r) => r.id === draft.id), 'students do not see drafts');
  assert.ok(st.categories.length >= 8);
  const hague = await as(db, U['manager.denhaag@hth'], async ({ one }) => (await one(`select best_practices_list() l`)).l);
  assert.ok(hague.rows.find((r) => r.id === bp.id).can_edit === false, 'other restaurants can read, not edit');
  const other = await as(db, U['admin@bistro'], async ({ one }) => (await one(`select best_practices_list() l`)).l);
  assert.ok(!other.rows.some((r) => r.id === bp.id));
});
