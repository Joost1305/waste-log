-- 0003  Business logic in the database: waste validation + valuation, API functions
-- RPC functions run as the calling user (security invoker), so Row Level Security
-- applies to every query inside them.

-- ---------------------------------------------------------------
-- Waste record: validation and valuation on every insert / update
--
-- Purchase value per kg, most specific wins:
--   invoice  weighted average price_per_kg of invoice lines for the product, last 90 days
--   product  purchase_price_per_kg on the product
--   default  organization default value per kg
-- ---------------------------------------------------------------
create or replace function app.waste_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_rank   int  := app.rank();
  v_org    bigint;
  v_pprice numeric; v_psales numeric; v_pname text; v_pcat bigint; v_psub bigint; v_psup bigint;
  v_inv    numeric;
  v_method text := 'default';
  v_cost   numeric;
  v_msales numeric; v_mportion numeric;
  v_co2    numeric;
begin
  select r.organization_id into v_org from public.restaurants r where r.id = new.restaurant_id and r.deleted_at is null;
  if v_org is null then raise exception 'Restaurant not found'; end if;
  new.organization_id := v_org;

  if tg_op = 'INSERT' then
    if v_uid is not null then new.user_id := v_uid; end if;
    new.created_at := now();
  else
    new.user_id := old.user_id;
    new.created_at := old.created_at;
    new.is_demo := old.is_demo;
    -- A soft delete only sets deleted_at: nothing to recalculate.
    if new.deleted_at is not null and old.deleted_at is null then return new; end if;
    if old.deleted_at is not null then raise exception 'Record not found'; end if;
  end if;

  -- What was wasted
  if new.product_id is not null then
    select p.name, p.waste_category_id, p.category_id, p.default_supplier_id, p.purchase_price_per_kg, p.sales_price_per_kg
      into v_pname, v_pcat, v_psub, v_psup, v_pprice, v_psales
      from public.products p where p.id = new.product_id and p.organization_id = v_org and p.deleted_at is null;
    if not found then raise exception 'Unknown product'; end if;
    new.product_name := v_pname;
    new.waste_category_id := coalesce(new.waste_category_id, v_pcat);
    new.category_id := coalesce(new.category_id, v_psub);
    new.supplier_id := coalesce(new.supplier_id, v_psup);
  end if;
  new.product_name := nullif(trim(new.product_name), '');
  if new.waste_category_id is null then raise exception 'Choose a product or a category'; end if;

  -- Referenced ids must belong to this organization (or be platform defaults)
  select c.co2e_per_kg into v_co2 from public.waste_categories c
   where c.id = new.waste_category_id and (c.organization_id is null or c.organization_id = v_org);
  if not found then raise exception 'Unknown category'; end if;
  if new.category_id is not null and not exists (select 1 from public.categories c where c.id = new.category_id and (c.organization_id is null or c.organization_id = v_org)) then
    raise exception 'Unknown subcategory'; end if;
  if not exists (select 1 from public.waste_reasons w where w.id = new.reason_id and (w.organization_id is null or w.organization_id = v_org)) then
    raise exception 'Unknown reason'; end if;
  if new.menu_item_id is not null then
    select m.sales_price, m.portion_size_g into v_msales, v_mportion
      from public.menu_items m where m.id = new.menu_item_id and m.organization_id = v_org and m.deleted_at is null;
    if not found then raise exception 'Unknown dish'; end if;
  end if;
  if new.supplier_id is not null and not exists (select 1 from public.suppliers s where s.id = new.supplier_id and s.organization_id = v_org and s.deleted_at is null) then
    raise exception 'Unknown supplier'; end if;

  -- Date checks (skipped for system/seed inserts without a signed-in user)
  if v_uid is not null and (tg_op = 'INSERT' or new.recorded_at is distinct from old.recorded_at) then
    if new.recorded_at > now() + interval '10 minutes' then raise exception 'Date is in the future'; end if;
    if new.recorded_at < now() - (case when v_rank >= 30 then interval '366 days' else interval '7 days' end) then
      raise exception 'Date is too long ago (max % days)', case when v_rank >= 30 then 366 else 7 end;
    end if;
  end if;

  -- Photos must live in this organization's folder
  if new.photo_path is not null and new.photo_path not like ('org-' || v_org || '/%') then
    raise exception 'Invalid photo';
  end if;
  if tg_op = 'UPDATE' and v_uid is not null then
    new.photo_path := old.photo_path;          -- photo cannot be swapped afterwards
    new.ai_suggestion := old.ai_suggestion;
    new.ai_accepted := old.ai_accepted;
  end if;
  new.ai_confidence := case when new.ai_suggestion ? 'confidence'
    then least(greatest((new.ai_suggestion ->> 'confidence')::numeric, 0), 1) end;

  -- Valuation
  if new.product_id is not null then
    select sum(ii.price_per_kg * ii.quantity_kg) / nullif(sum(ii.quantity_kg), 0) into v_inv
      from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
     where ii.organization_id = v_org and ii.product_id = new.product_id and i.deleted_at is null
       and i.status in ('extracted', 'confirmed') and ii.price_per_kg is not null and ii.quantity_kg > 0
       and i.invoice_date between app.local_date(new.recorded_at) - 90 and app.local_date(new.recorded_at);
    if v_inv > 0 then v_method := 'invoice'; v_cost := round(v_inv, 4);
    elsif v_pprice > 0 then v_method := 'product'; v_cost := v_pprice;
    end if;
  end if;
  if v_method = 'default' then
    select o.default_value_per_kg into v_cost from public.organizations o where o.id = v_org;
  end if;
  new.valuation_method := v_method;
  new.unit_cost_per_kg := v_cost;
  new.purchase_value := round(v_cost * new.weight_kg, 2);
  new.potential_sales_value := case
    when v_psales > 0 then round(v_psales * new.weight_kg, 2)
    when v_msales > 0 and v_mportion > 0 then round(new.weight_kg * 1000 / v_mportion * v_msales, 2)
  end;
  new.co2e_kg := round(v_co2 * new.weight_kg, 2);
  return new;
end $$;

create trigger waste_before before insert or update on public.waste_records
  for each row execute function app.waste_before();

-- ---------------------------------------------------------------
-- RPC: everything the app needs at start
-- ---------------------------------------------------------------
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
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'waste_category_id', p.waste_category_id,
                       'category_id', p.category_id, 'default_supplier_id', p.default_supplier_id,
                       'purchase_price_per_kg', p.purchase_price_per_kg, 'is_quick_pick', p.is_quick_pick) order by p.name)
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

-- ---------------------------------------------------------------
-- RPC: waste list with labels and totals
-- ---------------------------------------------------------------
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
        'product_id', w.product_id, 'product_name', w.product_name, 'waste_category_id', w.waste_category_id,
        'category', app.lbl(c.labels, p_lang), 'category_color', c.color, 'category_id', w.category_id,
        'reason_id', w.reason_id, 'reason', app.lbl(rs.labels, p_lang), 'menu_item_id', w.menu_item_id, 'menu_item_name', m.name,
        'supplier_id', w.supplier_id, 'supplier_name', s.name, 'weight_kg', w.weight_kg, 'entered_unit', w.entered_unit,
        'location', w.location, 'moment', w.moment, 'note', w.note, 'photo_path', w.photo_path, 'has_photo', w.photo_path is not null,
        'ai_confidence', w.ai_confidence, 'ai_accepted', w.ai_accepted, 'valuation_method', w.valuation_method,
        'unit_cost_per_kg', w.unit_cost_per_kg, 'purchase_value', w.purchase_value, 'potential_sales_value', w.potential_sales_value,
        'co2e_kg', w.co2e_kg, 'is_demo', w.is_demo, 'user_id', w.user_id, 'user_name', u.name, 'created_at', w.created_at)
        order by w.recorded_at desc, w.id desc)
      from page w
      join public.restaurants r on r.id = w.restaurant_id
      join public.waste_categories c on c.id = w.waste_category_id
      join public.waste_reasons rs on rs.id = w.reason_id
      left join public.menu_items m on m.id = w.menu_item_id
      left join public.suppliers s on s.id = w.supplier_id
      left join public.users u on u.id = w.user_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

-- ---------------------------------------------------------------
-- RPC: management dashboard
-- ---------------------------------------------------------------
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
  v_guest record;
  v_target jsonb;
  v_today date := app.local_date(now());
  v_tcur  numeric;
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

  -- Working set for this request (temporary, dropped at the end of the transaction)
  create temporary table _w on commit drop as
  select w.* from public.waste_records w
   where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
     and app.local_date(w.recorded_at) between v_from and v_to;

  select count(*) records, coalesce(sum(weight_kg), 0) kg, coalesce(sum(purchase_value), 0) val,
         coalesce(sum(co2e_kg), 0) co2, coalesce(sum(potential_sales_value), 0) sales,
         count(*) filter (where photo_path is not null) with_photo, count(*) filter (where valuation_method <> 'default') priced
    into t from _w;
  select coalesce(sum(w.weight_kg), 0) kg, coalesce(sum(w.purchase_value), 0) val into v_prev
    from public.waste_records w
   where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
     and app.local_date(w.recorded_at) between v_pfrom and v_pto;
  -- Waste per guest only over restaurant-days where guests were recorded
  select coalesce((select sum(c.guests) from public.daily_covers c where c.restaurant_id = any (v_rids) and c.date between v_from and v_to), 0) guests,
         coalesce((select sum(w.weight_kg) from _w w join public.daily_covers c on c.restaurant_id = w.restaurant_id and c.date = app.local_date(w.recorded_at)), 0) kg
    into v_guest;

  -- Target: restaurant target when filtered, otherwise organization-wide (only if the user sees all restaurants)
  v_all := app.org_restaurant_count(v_org);
  select jsonb_build_object('id', tg.id, 'name', tg.name, 'restaurant_name', r.name, 'baseline_kg', tg.baseline_kg, 'target_kg', tg.target_kg,
           'reduction_goal_pct', round((tg.baseline_kg - tg.target_kg) / tg.baseline_kg * 100, 1))
    into v_target
    from public.targets tg left join public.restaurants r on r.id = tg.restaurant_id
   where tg.organization_id = v_org and tg.deleted_at is null and tg.start_date <= v_today and (tg.end_date is null or tg.end_date >= v_today)
     and ((p_restaurant is not null and tg.restaurant_id = p_restaurant)
          or (p_restaurant is null and tg.restaurant_id is null and cardinality(v_rids) >= v_all))
   order by tg.start_date desc limit 1;
  if v_target is not null then
    select coalesce(sum(w.weight_kg), 0) into v_tcur from public.waste_records w
     where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
       and app.local_date(w.recorded_at) between v_today - 29 and v_today;
    v_target := v_target || jsonb_build_object(
      'current_kg', round(v_tcur, 1),
      'window', jsonb_build_object('from', v_today - 29, 'to', v_today, 'label', 'last_30_days'),
      'progress_pct', greatest(0, round(((v_target ->> 'baseline_kg')::numeric - v_tcur)
                        / ((v_target ->> 'baseline_kg')::numeric - (v_target ->> 'target_kg')::numeric) * 100, 1)),
      'achieved', v_tcur <= (v_target ->> 'target_kg')::numeric);
  end if;

  v_res := jsonb_build_object(
    'period', jsonb_build_object('from', v_from, 'to', v_to, 'days', v_span, 'previous', jsonb_build_object('from', v_pfrom, 'to', v_pto)),
    'totals', jsonb_build_object(
      'records', t.records, 'kg', round(t.kg, 2), 'value', round(t.val, 2), 'co2e_kg', round(t.co2, 2),
      'potential_sales_value', round(t.sales, 2), 'kg_per_day', round(t.kg / v_span, 2),
      'g_per_guest', case when v_guest.guests > 0 then round(v_guest.kg * 1000 / v_guest.guests, 1) end,
      'guests', v_guest.guests, 'previous_kg', round(v_prev.kg, 2), 'previous_value', round(v_prev.val, 2),
      'change_kg_pct', case when v_prev.kg > 0 then round((t.kg - v_prev.kg) / v_prev.kg * 100, 1) end,
      'outlets', (select count(distinct restaurant_id) from _w)),
    'data_quality', jsonb_build_object(
      'photo_pct', case when t.records > 0 then round(t.with_photo::numeric / t.records * 100, 1) end,
      'priced_pct', case when t.records > 0 then round(t.priced::numeric / t.records * 100, 1) end),
    'by_category', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', c.id, 'name', app.lbl(c.labels, p_lang), 'color', c.color,
               'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2), 'records', count(*)) x
          from _w w join public.waste_categories c on c.id = w.waste_category_id group by c.id) q), '[]'),
    'by_reason', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', rs.id, 'name', app.lbl(rs.labels, p_lang),
               'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2), 'records', count(*)) x
          from _w w join public.waste_reasons rs on rs.id = w.reason_id group by rs.id) q), '[]'),
    'by_restaurant', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', r.id, 'name', r.name, 'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2),
               'records', count(*), 'guests', g.guests,
               'g_per_guest', case when g.guests > 0 then round(g.kg_c * 1000 / g.guests, 1) end) x
          from _w w join public.restaurants r on r.id = w.restaurant_id
          cross join lateral (select
              coalesce((select sum(c.guests) from public.daily_covers c where c.restaurant_id = r.id and c.date between v_from and v_to), 0) guests,
              coalesce((select sum(w2.weight_kg) from _w w2 join public.daily_covers c on c.restaurant_id = w2.restaurant_id
                         and c.date = app.local_date(w2.recorded_at) where w2.restaurant_id = r.id), 0) kg_c) g
         group by r.id, r.name, g.guests, g.kg_c) q), '[]'),
    'by_supplier', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', s.id, 'name', s.name, 'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2),
               'records', count(*), 'purchased_kg', p.kg, 'purchased_value', p.val,
               'waste_rate_pct', case when p.kg > 0 then round(sum(w.weight_kg) / p.kg * 100, 1) end) x
          from _w w join public.suppliers s on s.id = w.supplier_id
          cross join lateral (select coalesce(sum(ii.quantity_kg), 0) kg, coalesce(sum(ii.line_total), 0) val
                                from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id
                               where i.organization_id = v_org and i.supplier_id = s.id and i.deleted_at is null
                                 and (i.restaurant_id = any (v_rids) or i.restaurant_id is null)
                                 and i.invoice_date between v_from and v_to) p
         group by s.id, s.name, p.kg, p.val) q), '[]'),
    'by_menu_item', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('id', m.id, 'name', m.name, 'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2),
               'records', count(*), 'portions_produced', pr.produced, 'portions_wasted', pr.wasted,
               'waste_rate_pct', case when pr.produced > 0 then round(pr.wasted::numeric / pr.produced * 100, 1) end) x
          from _w w join public.menu_items m on m.id = w.menu_item_id
          cross join lateral (select coalesce(sum(mw.portions_produced), 0) produced, coalesce(sum(mw.portions_wasted), 0) wasted
                                from public.menu_waste mw where mw.menu_item_id = m.id and mw.restaurant_id = any (v_rids)
                                 and mw.date between v_from and v_to) pr
         group by m.id, m.name, pr.produced, pr.wasted order by sum(w.weight_kg) desc limit 10) q), '[]'),
    'top_products', coalesce((select jsonb_agg(x order by (x ->> 'value')::numeric desc) from (
        select jsonb_build_object('name', w.product_name, 'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2), 'records', count(*)) x
          from _w w where w.product_name is not null group by w.product_name order by sum(w.purchase_value) desc limit 10) q), '[]'),
    -- complete weeks only (Monday start), so a half week never looks like a drop
    'trend', coalesce((select jsonb_agg(x order by x ->> 'week') from (
        select jsonb_build_object('week', wk, 'kg', round(sum(w.weight_kg), 2), 'value', round(sum(w.purchase_value), 2),
               'guests', coalesce((select sum(c.guests) from public.daily_covers c where c.restaurant_id = any (v_rids) and c.date between wk and wk + 6), 0)) x
          from _w w cross join lateral (select date_trunc('week', app.local_date(w.recorded_at))::date wk) k
         where wk >= v_from and wk + 6 <= v_to group by wk) q), '[]'),
    'valuation_mix', coalesce((select jsonb_agg(jsonb_build_object('method', valuation_method, 'records', n, 'kg', kg)) from (
        select valuation_method, count(*) n, round(sum(weight_kg), 2) kg from _w group by valuation_method) q), '[]'),
    'target', v_target
  );
  return v_res;
end $$;

-- ---------------------------------------------------------------
-- RPC: own profile (name, language). Role and organization are never changed here.
-- ---------------------------------------------------------------
create or replace function public.update_my_profile(p_name text default null, p_language text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_language is not null and p_language not in ('nl', 'en', 'fy') then raise exception 'Unknown language'; end if;
  if p_name is not null and (length(trim(p_name)) = 0 or length(p_name) > 120) then raise exception 'Invalid name'; end if;
  update public.users set name = coalesce(trim(p_name), name), language = coalesce(p_language, language) where id = auth.uid();
  return (select jsonb_build_object('id', id, 'name', name, 'email', email, 'role', role, 'language', language, 'organization_id', organization_id)
            from public.users where id = auth.uid());
end $$;

revoke execute on function public.app_meta(bigint, text), public.list_waste(bigint, bigint, date, date, bigint, bigint, boolean, int, int, text),
  public.dashboard(bigint, bigint, date, date, text), public.update_my_profile(text, text) from anon, public;
grant execute on function public.app_meta(bigint, text), public.list_waste(bigint, bigint, date, date, bigint, bigint, boolean, int, int, text),
  public.dashboard(bigint, bigint, date, date, text), public.update_my_profile(text, text) to authenticated;
