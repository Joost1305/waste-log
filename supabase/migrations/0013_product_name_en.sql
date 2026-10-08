-- 0013  Product names in two languages: products.name (Dutch, as imported) and products.name_en (English).
-- Lists, gallery, dashboard and export show the English name when the user's language is English and one exists.
-- Registrations keep the name stored at the time (product_name); the English name is looked up through product_id.
alter table public.products add column if not exists name_en text;

create or replace function public.app_meta(p_org bigint default null, p_lang text default 'nl')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org  bigint := app.effective_org(p_org);
  v_rank int := app.rank();
  v_rids bigint[] := app.restaurant_ids();
begin
  if v_rank = 0 then raise exception 'Not signed in' using errcode = '42501'; end if;
  return jsonb_build_object(
    'user', (select jsonb_build_object('id', u.id, 'name', u.name, 'email', u.email, 'role', u.role,
                                       'language', u.language, 'organization_id', u.organization_id)
               from public.users u where u.id = auth.uid()),
    'organization', (select jsonb_build_object('id', o.id, 'name', o.name, 'currency', o.currency,
                       'default_value_per_kg', o.default_value_per_kg, 'default_language', o.default_language, 'is_demo', o.is_demo)
                       from public.organizations o where o.id = v_org),
    'restaurants', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'city', r.city, 'is_demo', r.is_demo) order by r.name)
                       from public.restaurants r where r.organization_id = v_org and r.id = any (v_rids)), '[]'),
    'waste_categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'label', app.lbl(c.labels, p_lang),
                       'color', c.color, 'co2e_per_kg', c.co2e_per_kg) order by c.sort_order)
                       from public.waste_categories c where (c.organization_id is null or c.organization_id = v_org) and c.is_active), '[]'),
    'subcategories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'waste_category_id', c.waste_category_id, 'code', c.code,
                       'label', app.lbl(c.labels, p_lang)) order by c.sort_order)
                       from public.categories c where c.organization_id is null or c.organization_id = v_org), '[]'),
    'waste_reasons', coalesce((select jsonb_agg(jsonb_build_object('id', w.id, 'code', w.code, 'label', app.lbl(w.labels, p_lang)) order by w.sort_order)
                       from public.waste_reasons w where (w.organization_id is null or w.organization_id = v_org) and w.is_active), '[]'),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', coalesce(case when p_lang = 'en' then p.name_en end, p.name),
                       'name_nl', p.name, 'name_en', p.name_en, 'waste_category_id', p.waste_category_id,
                       'category_id', p.category_id, 'default_supplier_id', p.default_supplier_id,
                       'purchase_price_per_kg', p.purchase_price_per_kg, 'is_quick_pick', p.is_quick_pick)
                       order by coalesce(case when p_lang = 'en' then p.name_en end, p.name))
                       from public.products p where p.organization_id = v_org and p.is_active and p.deleted_at is null), '[]'),
    'suppliers', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name) order by s.name)
                       from public.suppliers s where s.organization_id = v_org and s.deleted_at is null), '[]'),
    'menu_items', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name, 'restaurant_id', m.restaurant_id) order by m.name)
                       from public.menu_items m where m.organization_id = v_org and m.is_active and m.deleted_at is null), '[]'),
    'locations', '["kitchen","storage","buffet","service","bar","pastry"]'::jsonb,
    'moments', '["breakfast","lunch","dinner","event","prep","closing"]'::jsonb,
    'permissions', jsonb_build_object(
      'dashboard', v_rank >= 30, 'catalog', v_rank >= 30, 'edit_any_waste', v_rank >= 30,
      'users', v_rank >= 50, 'restaurants', v_rank >= 50, 'targets', v_rank >= 50,
      'org_settings', v_rank >= 50, 'audit', v_rank >= 50, 'organizations', v_rank >= 100)
  );
end $$;

create or replace function public.list_waste(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null,
  p_category bigint default null, p_reason bigint default null, p_mine boolean default false,
  p_limit int default 50, p_offset int default 0, p_lang text default 'nl')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
  v_res jsonb;
begin
  if p_restaurant is not null and not (p_restaurant = any (app.restaurant_ids())) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  with base as (
    select w.* from public.waste_records w
     where w.organization_id = v_org and w.deleted_at is null
       and (p_restaurant is null or w.restaurant_id = p_restaurant)
       and (p_from is null or app.local_date(w.recorded_at) >= p_from)
       and (p_to is null or app.local_date(w.recorded_at) <= p_to)
       and (p_category is null or w.waste_category_id = p_category)
       and (p_reason is null or w.reason_id = p_reason)
       and (not p_mine or w.user_id = auth.uid())
  ), page as (
    select b.* from base b order by b.recorded_at desc, b.id desc
     limit least(greatest(p_limit, 1), 500) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'total_kg', (select coalesce(sum(weight_kg), 0) from base),
    'total_value', (select coalesce(sum(purchase_value), 0) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'restaurant_id', w.restaurant_id, 'restaurant_name', r.name, 'recorded_at', w.recorded_at,
        'product_id', w.product_id, 'product_name', coalesce(case when p_lang = 'en' then pr.name_en end, w.product_name), 'waste_category_id', w.waste_category_id,
        'category', app.lbl(c.labels, p_lang), 'category_color', c.color, 'category_id', w.category_id,
        'reason_id', w.reason_id, 'reason', app.lbl(rs.labels, p_lang), 'menu_item_id', w.menu_item_id, 'menu_item_name', m.name,
        'supplier_id', w.supplier_id, 'supplier_name', s.name, 'weight_kg', w.weight_kg, 'entered_unit', w.entered_unit, 'weight_source', w.weight_source,
        'location', w.location, 'moment', w.moment, 'note', w.note, 'photo_path', w.photo_path, 'has_photo', w.photo_path is not null,
        'ai_confidence', w.ai_confidence, 'ai_accepted', w.ai_accepted, 'valuation_method', w.valuation_method,
        'unit_cost_per_kg', w.unit_cost_per_kg, 'purchase_value', w.purchase_value, 'potential_sales_value', w.potential_sales_value,
        'co2e_kg', w.co2e_kg, 'is_demo', w.is_demo, 'user_id', w.user_id, 'user_name', u.name, 'created_at', w.created_at)
        order by w.recorded_at desc, w.id desc)
      from page w
      left join public.products pr on pr.id = w.product_id
      join public.restaurants r on r.id = w.restaurant_id
      join public.waste_categories c on c.id = w.waste_category_id
      join public.waste_reasons rs on rs.id = w.reason_id
      left join public.menu_items m on m.id = w.menu_item_id
      left join public.suppliers s on s.id = w.supplier_id
      left join public.users u on u.id = w.user_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

create or replace function public.gallery(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null,
  p_category bigint default null, p_limit int default 24, p_offset int default 0, p_lang text default 'nl',
  p_sort text default 'heaviest')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
  v_sort text := case when p_sort in ('heaviest', 'lightest', 'category', 'newest') then p_sort else 'heaviest' end;
  v_res jsonb;
begin
  if p_restaurant is not null and not (p_restaurant = any (app.restaurant_ids())) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  with base as (
    select w.*, c.sort_order cat_order from public.waste_records w
      join public.waste_categories c on c.id = w.waste_category_id
     where w.organization_id = v_org and w.deleted_at is null and w.photo_path is not null
       and (p_restaurant is null or w.restaurant_id = p_restaurant)
       and (p_from is null or w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam'))
       and (p_to is null or w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam'))
       and (p_category is null or w.waste_category_id = p_category)
  ), ranked as (
    select b.*, row_number() over (order by
        case when v_sort = 'category' then b.cat_order end,
        case when v_sort = 'category' then b.waste_category_id end,
        case when v_sort in ('heaviest', 'category') then b.weight_kg end desc,
        case when v_sort = 'lightest' then b.weight_kg end asc,
        b.recorded_at desc, b.id desc) rn
      from base b
  ), page as (
    select * from ranked where rn > greatest(p_offset, 0) and rn <= greatest(p_offset, 0) + least(greatest(p_limit, 1), 100)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'total_kg', (select coalesce(sum(weight_kg), 0) from base),
    'total_value', (select coalesce(sum(purchase_value), 0) from base),
    'sort', v_sort,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'photo_path', w.photo_path, 'recorded_at', w.recorded_at, 'restaurant_name', r.name,
        'product_name', coalesce(case when p_lang = 'en' then pr.name_en end, w.product_name), 'waste_category_id', w.waste_category_id,
        'category', app.lbl(c.labels, p_lang), 'category_color', c.color,
        'reason', app.lbl(rs.labels, p_lang), 'weight_kg', w.weight_kg, 'weight_source', w.weight_source,
        'purchase_value', w.purchase_value, 'co2e_kg', w.co2e_kg, 'note', w.note, 'user_name', u.name,
        'user_id', w.user_id, 'created_at', w.created_at)
        order by w.rn)
      from page w
      left join public.products pr on pr.id = w.product_id
      join public.restaurants r on r.id = w.restaurant_id
      join public.waste_categories c on c.id = w.waste_category_id
      join public.waste_reasons rs on rs.id = w.reason_id
      left join public.users u on u.id = w.user_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

create or replace function public.export_data(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null,
  p_category bigint default null, p_reason bigint default null, p_mine boolean default false, p_lang text default 'nl')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
begin
  if p_restaurant is not null and not (p_restaurant = any (app.restaurant_ids())) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'records', coalesce((select jsonb_agg(x order by x ->> 'recorded_local', (x ->> 'id')::bigint) from (
      select jsonb_build_object(
        'id', w.id,
        'recorded_local', to_char(w.recorded_at at time zone 'Europe/Amsterdam', 'YYYY-MM-DD"T"HH24:MI:SS'),
        'restaurant', r.name, 'product', coalesce(case when p_lang = 'en' then pr.name_en end, w.product_name),
        'category', app.lbl(c.labels, p_lang), 'subcategory', app.lbl(sc.labels, p_lang),
        'reason', app.lbl(rs.labels, p_lang), 'dish', m.name, 'supplier', s.name,
        'location', w.location, 'moment', w.moment,
        'weight_kg', w.weight_kg, 'entered_unit', w.entered_unit, 'weight_source', w.weight_source,
        'valuation_method', w.valuation_method, 'unit_cost_per_kg', w.unit_cost_per_kg,
        'purchase_value', w.purchase_value, 'potential_sales_value', w.potential_sales_value,
        'co2e_per_kg', c.co2e_per_kg, 'co2e_kg', w.co2e_kg,
        'has_photo', w.photo_path is not null, 'ai_accepted', w.ai_accepted,
        'user', u.name, 'note', w.note, 'is_demo', w.is_demo) x
        from public.waste_records w
        join public.restaurants r on r.id = w.restaurant_id
        join public.waste_categories c on c.id = w.waste_category_id
        join public.waste_reasons rs on rs.id = w.reason_id
        left join public.categories sc on sc.id = w.category_id
        left join public.menu_items m on m.id = w.menu_item_id
        left join public.suppliers s on s.id = w.supplier_id
        left join public.users u on u.id = w.user_id
        left join public.products pr on pr.id = w.product_id
       where w.organization_id = v_org and w.deleted_at is null
         and (p_restaurant is null or w.restaurant_id = p_restaurant)
         and (p_from is null or w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam'))
         and (p_to is null or w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam'))
         and (p_category is null or w.waste_category_id = p_category)
         and (p_reason is null or w.reason_id = p_reason)
         and (not p_mine or w.user_id = auth.uid())
       limit 100000) q), '[]'::jsonb),
    'covers', coalesce((select jsonb_agg(jsonb_build_object('date', dc.date, 'restaurant', r.name, 'guests', dc.guests)
                         order by dc.date, r.name)
        from public.daily_covers dc join public.restaurants r on r.id = dc.restaurant_id
       where r.organization_id = v_org
         and (p_restaurant is null or dc.restaurant_id = p_restaurant)
         and (p_from is null or dc.date >= p_from) and (p_to is null or dc.date <= p_to)), '[]'::jsonb)
  );
end $$;

create or replace function public.dashboard(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null, p_lang text default 'nl')
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_org   bigint := app.effective_org(p_org);
  v_to    date := coalesce(p_to, app.local_date(now()));
  v_from  date := coalesce(p_from, coalesce(p_to, app.local_date(now())) - 83);
  v_span  int;
  v_pto   date; v_pfrom date;
  v_rids  bigint[];
  v_all   int;
  t       record;
  v_prev  record;
  v_guests numeric; v_kg_c numeric;
  v_target jsonb;
  v_today date := app.local_date(now());
  v_tcur  numeric;
  v_tdays int;
  v_res   jsonb;
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  v_span := v_to - v_from + 1;
  v_pto := v_from - 1; v_pfrom := v_pto - (v_span - 1);
  v_rids := array(select r.id from public.restaurants r where r.organization_id = v_org and r.id = any (app.restaurant_ids()));
  if p_restaurant is not null then
    if not (p_restaurant = any (v_rids)) then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
    v_rids := array[p_restaurant];
  end if;

  create temporary table _w on commit drop as
  select w.restaurant_id, w.waste_category_id, w.reason_id, w.supplier_id, w.menu_item_id,
         coalesce(case when p_lang = 'en' then (select pr.name_en from public.products pr where pr.id = w.product_id) end, w.product_name) product_name,
         w.weight_kg, w.purchase_value, w.co2e_kg, w.potential_sales_value, (w.photo_path is not null) has_photo,
         w.valuation_method, w.weight_source, app.local_date(w.recorded_at) d
    from public.waste_records w
   where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
     and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at <  ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam');
  create temporary table _c on commit drop as
  select c.restaurant_id, c.date, c.guests from public.daily_covers c
   where c.restaurant_id = any (v_rids) and c.date between v_from and v_to;
  analyze _w; analyze _c;

  select count(*) records, coalesce(sum(weight_kg), 0) kg, coalesce(sum(purchase_value), 0) val,
         coalesce(sum(co2e_kg), 0) co2, coalesce(sum(potential_sales_value), 0) sales,
         count(*) filter (where has_photo) with_photo, count(*) filter (where valuation_method <> 'default') priced
    into t from _w;
  select coalesce(sum(w.weight_kg), 0) kg, coalesce(sum(w.purchase_value), 0) val into v_prev
    from public.waste_records w
   where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
     and w.recorded_at >= (v_pfrom::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at <  ((v_pto + 1)::timestamp at time zone 'Europe/Amsterdam');
  select coalesce(sum(guests), 0) into v_guests from _c;
  select coalesce(sum(w.weight_kg), 0) into v_kg_c from _w w join _c c on c.restaurant_id = w.restaurant_id and c.date = w.d;

  -- Target: restaurant target when filtered, otherwise organization-wide (only if the user sees all restaurants).
  -- The current value covers the target's own period: last 7, 30 or 365 days.
  v_all := app.org_restaurant_count(v_org);
  select jsonb_build_object('id', tg.id, 'name', tg.name, 'restaurant_name', r.name, 'baseline_kg', tg.baseline_kg, 'target_kg', tg.target_kg,
           'period', tg.period, 'reduction_goal_pct', round((tg.baseline_kg - tg.target_kg) / tg.baseline_kg * 100, 1))
    into v_target
    from public.targets tg left join public.restaurants r on r.id = tg.restaurant_id
   where tg.organization_id = v_org and tg.deleted_at is null and tg.start_date <= v_today and (tg.end_date is null or tg.end_date >= v_today)
     and ((p_restaurant is not null and tg.restaurant_id = p_restaurant)
          or (p_restaurant is null and tg.restaurant_id is null and cardinality(v_rids) >= v_all))
   order by tg.start_date desc, tg.id desc limit 1;
  if v_target is not null then
    v_tdays := app.period_days(v_target ->> 'period');
    select coalesce(sum(w.weight_kg), 0) into v_tcur from public.waste_records w
     where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
       and w.recorded_at >= ((v_today - (v_tdays - 1))::timestamp at time zone 'Europe/Amsterdam');
    v_target := v_target || jsonb_build_object(
      'current_kg', round(v_tcur, 1),
      'window', jsonb_build_object('from', v_today - (v_tdays - 1), 'to', v_today, 'days', v_tdays),
      'progress_pct', greatest(0, round(((v_target ->> 'baseline_kg')::numeric - v_tcur)
                        / ((v_target ->> 'baseline_kg')::numeric - (v_target ->> 'target_kg')::numeric) * 100, 1)),
      'achieved', v_tcur <= (v_target ->> 'target_kg')::numeric);
  end if;

  v_res := jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_span, 'previous', jsonb_build_object('from', v_pfrom, 'to', v_pto)),
    'totals', jsonb_build_object(
      'records', t.records, 'kg', round(t.kg, 2), 'value', round(t.val, 2), 'co2e_kg', round(t.co2, 2),
      'potential_sales_value', round(t.sales, 2), 'kg_per_day', round(t.kg / v_span, 2),
      'g_per_guest', case when v_guests > 0 then round(v_kg_c * 1000 / v_guests, 1) end,
      'guests', v_guests, 'previous_kg', round(v_prev.kg, 2), 'previous_value', round(v_prev.val, 2),
      'change_kg_pct', case when v_prev.kg > 0 then round((t.kg - v_prev.kg) / v_prev.kg * 100, 1) end,
      'outlets', (select count(distinct restaurant_id) from _w)),
    'data_quality', jsonb_build_object(
      'photo_pct', case when t.records > 0 then round(t.with_photo::numeric / t.records * 100, 1) end,
      'priced_pct', case when t.records > 0 then round(t.priced::numeric / t.records * 100, 1) end,
      'estimated_kg_pct', case when t.kg > 0 then round((select coalesce(sum(weight_kg), 0) from _w where weight_source = 'estimate') / t.kg * 100, 1) end),
    'by_category', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', app.lbl(c.labels, p_lang), 'color', c.color,
               'kg', round(g.kg, 2), 'value', round(g.val, 2), 'co2e_kg', round(g.co2, 2), 'records', g.n) order by g.kg desc)
        from (select waste_category_id id, sum(weight_kg) kg, sum(purchase_value) val, sum(co2e_kg) co2, count(*) n from _w group by 1) g
        join public.waste_categories c on c.id = g.id), '[]'),
    'by_reason', coalesce((
      select jsonb_agg(jsonb_build_object('id', rs.id, 'name', app.lbl(rs.labels, p_lang),
               'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n) order by g.kg desc)
        from (select reason_id id, sum(weight_kg) kg, sum(purchase_value) val, count(*) n from _w group by 1) g
        join public.waste_reasons rs on rs.id = g.id), '[]'),
    'by_restaurant', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n,
               'guests', coalesce(cg.guests, 0),
               'g_per_guest', case when cg.guests > 0 then round(coalesce(kc.kg, 0) * 1000 / cg.guests, 1) end) order by g.kg desc)
        from (select restaurant_id id, sum(weight_kg) kg, sum(purchase_value) val, count(*) n from _w group by 1) g
        join public.restaurants r on r.id = g.id
        left join (select restaurant_id id, sum(guests) guests from _c group by 1) cg on cg.id = g.id
        left join (select w.restaurant_id id, sum(w.weight_kg) kg from _w w join _c c on c.restaurant_id = w.restaurant_id and c.date = w.d group by 1) kc
          on kc.id = g.id), '[]'),
    'by_supplier', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n,
               'purchased_kg', coalesce(p.kg, 0), 'purchased_value', coalesce(p.val, 0),
               'waste_rate_pct', case when p.kg > 0 then round(g.kg / p.kg * 100, 1) end) order by g.kg desc)
        from (select supplier_id id, sum(weight_kg) kg, sum(purchase_value) val, count(*) n from _w where supplier_id is not null group by 1) g
        join public.suppliers s on s.id = g.id
        left join (select i.supplier_id id, sum(ii.quantity_kg) kg, sum(ii.line_total) val
                     from public.invoices i join public.invoice_items ii on ii.invoice_id = i.id
                    where i.organization_id = v_org and i.deleted_at is null
                      and (i.restaurant_id = any (v_rids) or i.restaurant_id is null)
                      and i.invoice_date between v_from and v_to
                    group by 1) p on p.id = g.id), '[]'),
    'by_menu_item', coalesce((
      select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', m.id, 'name', m.name, 'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n,
                 'portions_produced', coalesce(pr.produced, 0), 'portions_wasted', coalesce(pr.wasted, 0),
                 'waste_rate_pct', case when pr.produced > 0 then round(pr.wasted::numeric / pr.produced * 100, 1) end) x
          from (select menu_item_id id, sum(weight_kg) kg, sum(purchase_value) val, count(*) n from _w where menu_item_id is not null group by 1) g
          join public.menu_items m on m.id = g.id
          left join (select mw.menu_item_id id, sum(mw.portions_produced) produced, sum(mw.portions_wasted) wasted
                       from public.menu_waste mw
                      where mw.restaurant_id = any (v_rids) and mw.date between v_from and v_to group by 1) pr on pr.id = g.id
         order by g.kg desc limit 10) q), '[]'),
    'top_products', coalesce((
      select jsonb_agg(jsonb_build_object('name', g.name, 'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n) order by g.val desc)
        from (select product_name name, sum(weight_kg) kg, sum(purchase_value) val, count(*) n from _w
               where product_name is not null group by 1 order by 3 desc limit 10) g), '[]'),
    'trend', coalesce((
      select jsonb_agg(jsonb_build_object('week', g.wk, 'kg', round(g.kg, 2), 'value', round(g.val, 2), 'guests', coalesce(cw.guests, 0)) order by g.wk)
        from (select date_trunc('week', d)::date wk, sum(weight_kg) kg, sum(purchase_value) val from _w group by 1) g
        left join (select date_trunc('week', date)::date wk, sum(guests) guests from _c group by 1) cw on cw.wk = g.wk
       where g.wk >= v_from and g.wk + 6 <= v_to), '[]'),
    'valuation_mix', coalesce((
      select jsonb_agg(jsonb_build_object('method', valuation_method, 'records', n, 'kg', kg))
        from (select valuation_method, count(*) n, round(sum(weight_kg), 2) kg from _w group by 1) q), '[]'),
    'target', v_target
  );
  return v_res;
end $$;
