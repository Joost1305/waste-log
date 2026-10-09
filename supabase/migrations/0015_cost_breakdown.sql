-- 0015  Waste cost explanation: the dashboard's valuation mix now also gives the euros per price source
-- (invoice price, product price, default price), so the "Waste cost" figure can show how it is calculated.
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
      select jsonb_agg(jsonb_build_object('method', valuation_method, 'records', n, 'kg', kg, 'value', val))
        from (select valuation_method, count(*) n, round(sum(weight_kg), 2) kg, round(sum(purchase_value), 2) val from _w group by 1) q), '[]'),
    'target', v_target
  );
  return v_res;
end $$;
