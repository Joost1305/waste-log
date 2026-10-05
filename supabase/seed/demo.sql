-- DEMO DATA for WASTE log. Everything created here is flagged is_demo = true and the
-- app shows a "DEMO DATA" banner for demo organizations. Names are fictional.
-- Run once in the SQL editor:   select app.seed_demo();
-- Remove all demo data again:   select app.remove_demo();

create or replace function app.seed_demo(p_days int default 180) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_org bigint; v_org2 bigint; v_r2 bigint;
  r record; p record; d date; v_today date := app.local_date(now()); v_start date;
  v_soup_change date;
  u_admin uuid; u_mams uuid; u_mdh uuid; u_st1 uuid; u_st2 uuid; u_b uuid;
  v_inv bigint; v_inv_no int := 1000; v_total numeric; v_qty numeric; v_ppk numeric;
  v_guests int; v_dow int; v_tmean numeric; v_rain numeric; v_progress numeric; v_n int; v_kg numeric;
  v_reason text; v_moment text; v_hour int; v_menu bigint; v_user uuid; v_rate numeric; v_prod int; v_cnt int := 0;
  v_cat_codes text[]; v_weights numeric[]; v_pick int; v_total_w numeric; x numeric; i int; j int;
  v_base numeric; v_amsbase numeric;
begin
  if exists (select 1 from public.organizations where slug = 'hotelschool-the-hague-demo') then
    return 'Demo data already present';
  end if;
  perform setseed(0.20261005);
  v_start := v_today - p_days;
  v_soup_change := v_today - 45;

  -- Platform admin (demo)
  perform app.create_login('admin@platform.demo', 'demo1234', 'Platform Admin (demo)', 'super_admin', null, '{}', 'en');

  insert into public.organizations (name, slug, default_value_per_kg, default_language, is_demo)
  values ('Hotelschool The Hague (demo)', 'hotelschool-the-hague-demo', 6.50, 'nl', true) returning id into v_org;

  create temporary table _rest (key text, id bigint, name text, guests int, scale numeric) on commit drop;
  insert into _rest values ('ams', null, 'Amsterdam Restaurant', 140, 1.15), ('dh', null, 'The Hague Restaurant', 160, 1.25),
                           ('zinq', null, 'Brasserie ZINQ', 70, 0.7), ('debut', null, 'Le Début', 45, 0.5);
  for r in select * from _rest loop
    insert into public.restaurants (organization_id, name, slug, city, latitude, longitude, public_impact_enabled, is_demo)
    values (v_org, r.name, r.key, case when r.key = 'ams' then 'Amsterdam' else 'Den Haag' end,
            case r.key when 'ams' then 52.3676 when 'dh' then 52.0907 when 'zinq' then 52.0950 else 52.0880 end,
            case r.key when 'ams' then 4.9041 when 'dh' then 4.2786 when 'zinq' then 4.2900 else 4.2850 end, true, true)
    returning id into v_n;
    update _rest set id = v_n where key = r.key;
  end loop;

  u_admin := app.create_login('orgadmin@hth.demo', 'demo1234', 'Eva Jansen (demo)', 'org_admin', v_org);
  u_mams := app.create_login('manager.amsterdam@hth.demo', 'demo1234', 'Mark de Boer (demo)', 'restaurant_manager', v_org,
                             array(select id from _rest where key in ('ams', 'zinq')));
  u_mdh := app.create_login('manager.denhaag@hth.demo', 'demo1234', 'Lisa Visser (demo)', 'restaurant_manager', v_org,
                            array(select id from _rest where key in ('dh', 'debut')));
  u_st1 := app.create_login('student@hth.demo', 'demo1234', 'Noah Bakker (demo)', 'employee', v_org,
                            array(select id from _rest where key = 'ams'));
  u_st2 := app.create_login('student.denhaag@hth.demo', 'demo1234', 'Sara El Amrani (demo)', 'employee', v_org,
                            array(select id from _rest where key in ('dh', 'zinq', 'debut')));

  insert into public.framework_principles (organization_id, framework_code, code, labels, sort_order) values
    (v_org, 'SENSE', 'seasonal', '{"en":"Seasonal","nl":"Seizoensgebonden"}', 0),
    (v_org, 'SENSE', 'ethical', '{"en":"Ethical","nl":"Ethisch"}', 1),
    (v_org, 'SENSE', 'nutritional', '{"en":"Nutritional","nl":"Voedzaam"}', 2),
    (v_org, 'SENSE', 'supportive', '{"en":"Supportive","nl":"Ondersteunend"}', 3),
    (v_org, 'SENSE', 'enjoyable', '{"en":"Enjoyable","nl":"Plezierig"}', 4);

  create temporary table _sup (key text, id bigint) on commit drop;
  insert into _sup (key) values ('sligro'), ('hanos'), ('bidfood'), ('farm'), ('bakery'), ('fish');
  for r in select * from _sup loop
    insert into public.suppliers (organization_id, name, is_demo)
    values (v_org, case r.key when 'sligro' then 'Sligro' when 'hanos' then 'Hanos' when 'bidfood' then 'Bidfood'
                   when 'farm' then 'Boerderij De Groene Hoek' when 'bakery' then 'Bakkerij Vermeer' else 'Vishandel Scheveningen' end, true)
    returning id into v_n;
    update _sup set id = v_n where key = r.key;
  end loop;

  create temporary table _prod (name text, cat text, sub text, sup text, price numeric, sales numeric, quick boolean,
                                lo numeric, hi numeric, menu text, id bigint, cat_id bigint) on commit drop;
  insert into _prod (name, cat, sub, sup, price, sales, quick, lo, hi, menu) values
    ('Tomatoes','vegetables','fruiting','farm',2.80,null,true,0.3,2.5,null), ('Lettuce','vegetables','leafy','farm',3.40,null,true,0.2,1.8,'Caesar salad'),
    ('Carrots','vegetables','roots','farm',1.20,null,false,0.3,2.0,null), ('Onions','vegetables','roots','sligro',1.10,null,false,0.2,1.5,null),
    ('Bell peppers','vegetables','fruiting','sligro',4.20,null,false,0.2,1.2,null), ('Spinach','vegetables','leafy','farm',6.50,null,false,0.1,0.9,null),
    ('Potatoes','starch',null,'farm',0.95,null,true,0.5,4.0,null), ('Rice (cooked)','starch',null,'hanos',2.10,null,true,0.5,3.5,null),
    ('Pasta (cooked)','starch',null,'hanos',1.90,null,false,0.4,3.0,null), ('Chicken breast','meat','poultry','sligro',8.40,null,true,0.2,2.0,null),
    ('Beef mince','meat','beef','sligro',9.80,null,false,0.2,1.5,null), ('Pork belly','meat','pork','hanos',11.50,null,false,0.2,1.2,null),
    ('Salmon','fish',null,'fish',24.00,null,false,0.1,0.8,'Fish of the day'), ('Cod','fish',null,'fish',19.50,null,false,0.1,0.7,'Fish of the day'),
    ('Milk','dairy','milk','bidfood',1.15,null,false,0.5,3.0,null), ('Cream','dairy','milk','bidfood',4.60,null,false,0.2,1.2,null),
    ('Cheese','dairy','cheese','bidfood',12.00,null,false,0.1,0.8,null), ('Eggs','dairy','eggs','bidfood',3.90,null,false,0.1,1.0,null),
    ('Bread','bread',null,'bakery',3.20,null,true,0.5,3.5,null), ('Croissants','bread',null,'bakery',7.50,null,false,0.2,1.5,'Breakfast buffet'),
    ('Apples','fruit',null,'farm',2.20,null,false,0.2,1.5,null), ('Melon','fruit',null,'sligro',2.60,null,false,0.3,2.0,'Breakfast buffet'),
    ('Strawberries','fruit',null,'farm',8.00,null,false,0.1,0.8,null), ('Vegetable soup','prepared','soup',null,1.80,9.00,true,1.0,6.0,'Vegetable soup'),
    ('Chicken curry','prepared','mains',null,4.50,18.00,false,0.5,3.5,'Chicken curry'), ('Lasagna','prepared','mains',null,4.20,16.00,false,0.5,3.0,'Lasagna'),
    ('Buffet leftovers','prepared','buffet',null,null,null,true,1.0,6.0,'Breakfast buffet'), ('Plate waste (mixed)','prepared',null,null,null,null,true,0.5,4.0,null),
    ('Sauces','prepared','sauce',null,null,null,false,0.2,1.5,null);
  for p in select * from _prod loop
    insert into public.products (organization_id, name, waste_category_id, category_id, default_supplier_id, purchase_price_per_kg,
                                 sales_price_per_kg, is_quick_pick, is_demo)
    values (v_org, p.name, (select id from public.waste_categories where code = p.cat and organization_id is null),
            (select id from public.categories where code = p.sub and organization_id is null),
            (select id from _sup where key = p.sup), p.price, p.sales, p.quick, true)
    returning id into v_n;
    update _prod set id = v_n, cat_id = (select id from public.waste_categories where code = p.cat and organization_id is null) where name = p.name;
  end loop;

  create temporary table _menu (name text, id bigint) on commit drop;
  insert into public.menu_items (organization_id, name, portion_size_g, sales_price, cost_price, is_demo)
  select v_org, m.n, m.g, m.s, m.c, true from (values ('Vegetable soup',300,7.5,1.2), ('Chicken curry',400,17.5,4.1), ('Caesar salad',280,14.0,3.2),
    ('Lasagna',380,16.5,3.6), ('Mushroom risotto',350,16.0,3.0), ('Fish of the day',220,24.0,7.5), ('Breakfast buffet',450,18.5,5.0),
    ('Dessert of the day',150,8.5,1.8)) m(n, g, s, c);
  insert into _menu select name, id from public.menu_items where organization_id = v_org;

  -- Weekly invoices per supplier per restaurant (valuation level 3, supplier waste rate)
  d := v_start;
  while d <= v_today loop
    for r in select * from _rest loop
      for p in select distinct sup from _prod where sup is not null loop
        insert into public.invoices (organization_id, restaurant_id, supplier_id, invoice_number, invoice_date, status, is_demo, original_filename)
        values (v_org, r.id, (select id from _sup where key = p.sup), 'DEMO-' || v_inv_no, d + floor(random() * 3)::int, 'confirmed', true, 'demo-invoice.pdf')
        returning id into v_inv;
        v_inv_no := v_inv_no + 1; v_total := 0;
        insert into public.invoice_items (invoice_id, organization_id, product_id, description, quantity, unit, quantity_kg, unit_price, price_per_kg, line_total, category, confidence)
        select v_inv, v_org, pr.id, pr.name, q.qty, 'kg', q.qty, q.ppk, q.ppk, round(q.qty * q.ppk, 2), pr.cat, 1
          from _prod pr cross join lateral (select round(((8 + random() * 22) * r.scale * case when pr.cat in ('meat','fish') then 0.5 else 1 end)::numeric) qty,
                                                   round((pr.price * (0.92 + random() * 0.20))::numeric, 2) ppk) q
         where pr.sup = p.sup;
        update public.invoices set total_amount = (select sum(line_total) from public.invoice_items where invoice_id = v_inv) where id = v_inv;
      end loop;
    end loop;
    d := d + 7;
  end loop;

  -- Daily data
  d := v_start;
  while d <= v_today loop
    v_dow := extract(dow from d);
    v_tmean := 10.5 + 8 * sin(((extract(doy from d) - 110) / 365.0) * 2 * pi()) + (random() * 6 - 3);
    v_rain := case when random() < 0.45 then round((0.2 + random() * 11.8)::numeric, 1) else 0 end;
    v_progress := (d - v_start)::numeric / greatest(p_days, 1);
    for r in select * from _rest loop
      insert into public.weather_records (restaurant_id, date, temp_mean_c, temp_max_c, temp_min_c, rainfall_mm, condition, humidity_pct, source)
      values (r.id, d, round(v_tmean, 1), round(v_tmean + 4, 1), round(v_tmean - 4, 1), v_rain,
              case when v_rain > 5 then 'rain' when v_rain > 0 then 'cloudy' when random() < 0.5 then 'clear' else 'cloudy' end,
              round(60 + random() * 32), 'demo');
      continue when (r.key = 'debut' and v_dow in (0, 1)) or (r.key = 'zinq' and v_dow = 0);
      v_guests := round(r.guests * case when v_dow in (0, 6) then 0.75 else 1 end * (0.85 + random() * 0.30));
      insert into public.daily_covers (organization_id, restaurant_id, date, guests, is_demo) values (v_org, r.id, d, v_guests, true);
      -- Production log for three dishes
      for i in 1..3 loop
        v_rate := (array[0.16, 0.09, 0.08])[i] * (0.7 + random() * 0.6);
        if i = 1 and r.key = 'ams' and d >= v_soup_change then v_rate := v_rate * 0.6; end if;
        v_prod := round(v_guests * (array[0.35, 0.18, 0.15])[i] * (0.9 + random() * 0.2));
        insert into public.menu_waste (organization_id, restaurant_id, menu_item_id, date, portions_produced, portions_sold, portions_wasted, is_demo)
        values (v_org, r.id, (select id from _menu where name = (array['Vegetable soup', 'Chicken curry', 'Lasagna'])[i]), d,
                v_prod, v_prod - round(v_prod * v_rate), round(v_prod * v_rate), true);
      end loop;
      -- Waste records
      v_n := greatest(2, round((4 + random() * 5) * r.scale));
      for j in 1..v_n loop
        -- weighted product pick: prepared 3, vegetables 2.2, bread/starch 2, others 1
        select * into p from _prod
         order by -ln(1 - random()) / case cat when 'prepared' then 3 when 'vegetables' then 2.2 when 'bread' then 2 when 'starch' then 2 else 1 end
         limit 1;
        v_kg := (p.lo + random() * (p.hi - p.lo)) * (1 - 0.18 * v_progress) * case when v_tmean > 22 then 1.15 else 1 end;
        if p.name = 'Vegetable soup' and r.key = 'ams' and d >= v_soup_change then v_kg := v_kg * 0.62; end if;
        v_kg := round(v_kg, 2);
        x := random();
        v_reason := case p.cat
          when 'vegetables' then case when x < .29 then 'spoilage' when x < .58 then 'preparation' when x < .72 then 'overproduction' when x < .86 then 'storage' when x < .93 then 'expired' else 'damaged' end
          when 'fruit' then case when x < .5 then 'spoilage' when x < .7 then 'overproduction' when x < .9 then 'damaged' else 'plate' end
          when 'meat' then case when x < .3 then 'overproduction' when x < .6 then 'expired' when x < .8 then 'preparation' when x < .9 then 'storage' else 'ordering' end
          when 'fish' then case when x < .375 then 'expired' when x < .625 then 'overproduction' when x < .875 then 'preparation' else 'storage' end
          when 'dairy' then case when x < .5 then 'expired' when x < .7 then 'spoilage' when x < .9 then 'overproduction' else 'ordering' end
          when 'bread' then case when x < .6 then 'overproduction' when x < .8 then 'plate' else 'expired' end
          when 'starch' then case when x < .6 then 'overproduction' when x < .9 then 'plate' else 'preparation' end
          else case when x < .55 then 'overproduction' when x < .91 then 'plate' else 'spoilage' end end;
        x := random();
        v_moment := case
          when v_reason = 'plate' then case when x < .43 then 'lunch' when x < .86 then 'dinner' else 'breakfast' end
          when v_reason = 'preparation' then 'prep'
          when v_reason = 'overproduction' then case when x < .33 then 'lunch' when x < .55 then 'dinner' when x < .77 then 'breakfast' else 'closing' end
          else case when x < .6 then 'closing' else 'prep' end end;
        v_hour := case v_moment when 'breakfast' then 7 when 'prep' then 9 when 'lunch' then 12 when 'dinner' then 19 else 20 end;
        continue when (d + make_interval(hours => v_hour, mins => floor(random() * 59)::int)) at time zone 'Europe/Amsterdam' > now();
        v_user := case r.key when 'ams' then (array[u_st1, u_mams])[1 + floor(random() * 2)::int]
                             when 'zinq' then (array[u_st2, u_mams])[1 + floor(random() * 2)::int]
                             else (array[u_st2, u_mdh])[1 + floor(random() * 2)::int] end;
        insert into public.waste_records (organization_id, restaurant_id, user_id, recorded_at, product_id, waste_category_id, reason_id,
                                          menu_item_id, weight_kg, entered_unit, location, moment, is_demo)
        values (v_org, r.id, v_user, (d + make_interval(hours => v_hour, mins => floor(random() * 59)::int)) at time zone 'Europe/Amsterdam',
                p.id, p.cat_id, (select id from public.waste_reasons where code = v_reason and organization_id is null),
                (select id from _menu where name = p.menu), v_kg, case when v_kg < 1 then 'g' else 'kg' end,
                case when v_reason = 'plate' then 'service' when v_reason in ('storage', 'expired') then 'storage' else 'kitchen' end,
                v_moment, true);
        v_cnt := v_cnt + 1;
      end loop;
    end loop;
    d := d + 1;
  end loop;

  -- Targets: baseline = first 30 days measured, goal 25% (organization) / 20% (Amsterdam) less
  select sum(weight_kg) into v_base from public.waste_records where organization_id = v_org and app.local_date(recorded_at) < v_start + 30;
  select sum(weight_kg) into v_amsbase from public.waste_records
   where organization_id = v_org and restaurant_id = (select id from _rest where key = 'ams') and app.local_date(recorded_at) < v_start + 30;
  insert into public.targets (organization_id, restaurant_id, name, baseline_kg, target_kg, start_date, created_by) values
    (v_org, null, 'SENSE 2026: 25% less food waste', round(v_base, -1), round(round(v_base, -1) * 0.75), v_start, u_admin),
    (v_org, (select id from _rest where key = 'ams'), 'Amsterdam: 20% less waste', round(v_amsbase / 5) * 5, round(round(v_amsbase / 5) * 5 * 0.8), v_start, u_admin);

  insert into public.interventions (organization_id, restaurant_id, title, reason, type, start_date, responsible_user_id, responsible_label,
                                    scope_menu_item_id, expected_change_pct, status, created_by, is_demo)
  values (v_org, (select id from _rest where key = 'ams'), 'Reduce soup batch size', 'High leftover volume after lunch', 'operational',
          v_soup_change, u_mams, 'Restaurant Manager', (select id from _menu where name = 'Vegetable soup'), -15, 'active', u_mams, true);

  -- Second organization, to demonstrate tenant isolation
  insert into public.organizations (name, slug, default_value_per_kg, default_language, is_demo)
  values ('Demo Bistro Group', 'demo-bistro-group', 7.00, 'en', true) returning id into v_org2;
  insert into public.restaurants (organization_id, name, slug, city, latitude, longitude, is_demo)
  values (v_org2, 'Bistro Noord', 'bistro-noord', 'Utrecht', 52.09, 5.12, true) returning id into v_r2;
  u_b := app.create_login('admin@bistro.demo', 'demo1234', 'Bistro Admin (demo)', 'org_admin', v_org2, '{}', 'en');
  for i in 0..19 loop
    insert into public.waste_records (organization_id, restaurant_id, user_id, recorded_at, product_name, waste_category_id, reason_id, weight_kg, is_demo)
    values (v_org2, v_r2, u_b, now() - make_interval(days => i, hours => 2), 'Mixed leftovers',
            (select id from public.waste_categories where code = 'prepared' and organization_id is null),
            (select id from public.waste_reasons where code = 'overproduction' and organization_id is null), round((0.3 + random() * 2.7)::numeric, 2), true);
  end loop;

  return format('DEMO DATA created: %s waste records over %s days', v_cnt, p_days);
end $$;

-- Remove every demo organization with all its data and demo logins.
create or replace function app.remove_demo() returns text
language plpgsql security definer set search_path = '' as $$
declare v_orgs bigint[] := array(select id from public.organizations where is_demo);
begin
  delete from public.questionnaire_responses where questionnaire_id in (select id from public.questionnaires where organization_id = any (v_orgs));
  delete from public.questionnaire_questions where questionnaire_id in (select id from public.questionnaires where organization_id = any (v_orgs));
  delete from public.questionnaires where organization_id = any (v_orgs);
  delete from public.research_participants where research_project_id in (select id from public.research_projects where organization_id = any (v_orgs));
  delete from public.research_groups where research_project_id in (select id from public.research_projects where organization_id = any (v_orgs));
  delete from public.intervention_principles where intervention_id in (select id from public.interventions where organization_id = any (v_orgs));
  delete from public.best_practices where organization_id = any (v_orgs);
  delete from public.interventions where organization_id = any (v_orgs);
  delete from public.research_projects where organization_id = any (v_orgs);
  delete from public.impact_reports where organization_id = any (v_orgs);
  delete from public.waste_records where organization_id = any (v_orgs);
  delete from public.invoice_items where organization_id = any (v_orgs);
  delete from public.invoices where organization_id = any (v_orgs);
  delete from public.menu_waste where organization_id = any (v_orgs);
  delete from public.daily_covers where organization_id = any (v_orgs);
  delete from public.weather_records where restaurant_id in (select id from public.restaurants where organization_id = any (v_orgs));
  delete from public.targets where organization_id = any (v_orgs);
  delete from public.products where organization_id = any (v_orgs);
  delete from public.menu_items where organization_id = any (v_orgs);
  delete from public.suppliers where organization_id = any (v_orgs);
  delete from public.framework_principles where organization_id = any (v_orgs);
  delete from public.user_restaurants where restaurant_id in (select id from public.restaurants where organization_id = any (v_orgs));
  delete from auth.users where id in (select id from public.users where organization_id = any (v_orgs) or email like '%.demo');
  delete from public.restaurants where organization_id = any (v_orgs);
  delete from public.audit_log where organization_id = any (v_orgs);
  delete from public.organizations where id = any (v_orgs);
  return 'Demo data removed';
end $$;

revoke execute on function app.seed_demo(int) from public, anon, authenticated;
revoke execute on function app.remove_demo() from public, anon, authenticated;
