-- 0042: suggested interventions, found by rules in the waste records (no AI).
-- Looks at the last p_days days of avoidable waste per restaurant and flags patterns:
--   product      one product is a large share of the avoidable kilos
--   weekday      one open weekday is clearly heavier than the other open weekdays
--   spoilage     the same product spoils or expires on several different days
--   plate        one dish keeps coming back as plate waste
--   costly       one product is a large share of the euros, while not already flagged by kilos
-- Each suggestion carries its size (kg, euros, share), what an intervention would focus on, and up to two
-- examples: published best practices of the organization first, then industry examples with the same reason.
-- Patterns already covered by an active or planned intervention with the same focus are left out.
-- Runs as the caller, so Row Level Security decides what is seen. Managers and up.

create or replace function public.intervention_suggestions(p_org bigint default null, p_restaurant bigint default null,
                                                           p_days int default 28, p_lang text default 'en')
returns jsonb
language plpgsql
set search_path to ''
as $$
declare
  v_org   bigint := app.effective_org(p_org);
  v_to    date := app.local_date(now());
  v_days  int := least(greatest(coalesce(p_days, 28), 14), 120);
  v_from  date;
  v_rids  bigint[];
  v_out   jsonb;
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  v_from := v_to - (v_days - 1);
  v_rids := array(select r.id from public.restaurants r
                   where r.organization_id = v_org and r.deleted_at is null and r.id = any (app.restaurant_ids())
                     and (p_restaurant is null or r.id = p_restaurant));

  create temporary table if not exists _s (
    rule text, restaurant_id bigint, product_name text, menu_item_id bigint, waste_category_id bigint,
    reason_id bigint, reason_code text, dow int, kg numeric, value numeric, share_pct numeric,
    records int, days int, base_kg numeric, score numeric) on commit drop;
  truncate _s;

  -- avoidable waste in the window, on any day (closed-day waste is still waste)
  create temporary table if not exists _sw on commit drop as
    select w.restaurant_id, w.product_name, w.menu_item_id, w.waste_category_id, w.reason_id, x.code reason_code,
           app.local_date(w.recorded_at) d, w.weight_kg kg, coalesce(w.purchase_value, 0) val
      from public.waste_records w join public.waste_reasons x on x.id = w.reason_id
     where false;
  truncate _sw;
  insert into _sw
    select w.restaurant_id, w.product_name, w.menu_item_id, w.waste_category_id, w.reason_id, x.code,
           app.local_date(w.recorded_at), w.weight_kg, coalesce(w.purchase_value, 0)
      from public.waste_records w join public.waste_reasons x on x.id = w.reason_id
     where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null and x.avoidable
       and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
       and w.recorded_at <  ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam');

  -- Rule: one product is at least 15% of the restaurant's avoidable kilos
  insert into _s (rule, restaurant_id, product_name, waste_category_id, reason_id, reason_code, kg, value, share_pct, records, days, score)
  select 'product', p.restaurant_id, p.product_name, p.cat, p.reason_id, p.reason_code, p.kg, p.val,
         round(p.kg / t.kg * 100, 1), p.n, p.nd, p.val + p.kg
    from (select restaurant_id, product_name, sum(kg) kg, sum(val) val, count(*) n, count(distinct d) nd,
                 mode() within group (order by waste_category_id) cat,
                 mode() within group (order by reason_id) reason_id,
                 mode() within group (order by reason_code) reason_code
            from _sw where product_name is not null group by 1, 2) p
    join (select restaurant_id, sum(kg) kg from _sw group by 1) t on t.restaurant_id = p.restaurant_id
   where t.kg > 0 and p.kg / t.kg >= 0.15 and p.n >= 3 and p.kg >= 3;

  -- Rule: one product is at least 15% of the euros, and not already flagged by kilos
  insert into _s (rule, restaurant_id, product_name, waste_category_id, reason_id, reason_code, kg, value, share_pct, records, days, score)
  select 'costly', p.restaurant_id, p.product_name, p.cat, p.reason_id, p.reason_code, p.kg, p.val,
         round(p.val / t.val * 100, 1), p.n, p.nd, p.val
    from (select restaurant_id, product_name, sum(kg) kg, sum(val) val, count(*) n, count(distinct d) nd,
                 mode() within group (order by waste_category_id) cat,
                 mode() within group (order by reason_id) reason_id,
                 mode() within group (order by reason_code) reason_code
            from _sw where product_name is not null group by 1, 2) p
    join (select restaurant_id, sum(val) val from _sw group by 1) t on t.restaurant_id = p.restaurant_id
   where t.val > 0 and p.val / t.val >= 0.15 and p.n >= 3 and p.val >= 25
     and not exists (select 1 from _s s where s.rule = 'product' and s.restaurant_id = p.restaurant_id and s.product_name = p.product_name);

  -- Rule: the same product spoils, expires or is stored wrong on at least 3 different days
  insert into _s (rule, restaurant_id, product_name, waste_category_id, reason_id, reason_code, kg, value, records, days, score)
  select 'spoilage', restaurant_id, product_name, mode() within group (order by waste_category_id),
         mode() within group (order by reason_id), mode() within group (order by reason_code),
         sum(kg), sum(val), count(*), count(distinct d), sum(val) + sum(kg)
    from _sw
   where product_name is not null and reason_code in ('spoilage', 'expired', 'storage')
   group by restaurant_id, product_name
  having count(distinct d) >= 3 and sum(kg) >= 1;

  -- Rule: one dish keeps coming back as plate waste
  insert into _s (rule, restaurant_id, menu_item_id, reason_id, reason_code, kg, value, records, days, score)
  select 'plate', restaurant_id, menu_item_id, min(reason_id), 'plate', sum(kg), sum(val), count(*), count(distinct d), sum(val) + sum(kg)
    from _sw
   where menu_item_id is not null and reason_code = 'plate'
   group by restaurant_id, menu_item_id
  having count(*) >= 3 and sum(kg) >= 2;

  -- Rule: one open weekday is at least 1.5 times the average of the other open weekdays (per registered day)
  insert into _s (rule, restaurant_id, dow, reason_id, reason_code, kg, value, days, base_kg, score)
  select 'weekday', g.restaurant_id, g.dow, g.reason_id, g.reason_code, round(g.kg_day, 2), round(g.val_day, 2), g.nd,
         round(o.kg_day, 2), (g.kg_day - o.kg_day) * g.nd * greatest(g.val_day / nullif(g.kg_day, 0), 1)
    from (select restaurant_id, extract(isodow from d)::int dow, sum(kg) / count(distinct d) kg_day, sum(val) / count(distinct d) val_day,
                 count(distinct d) nd, mode() within group (order by reason_id) reason_id, mode() within group (order by reason_code) reason_code
            from _sw group by 1, 2) g
    join lateral (select sum(kg) / nullif(count(distinct d), 0) kg_day from _sw x
                   where x.restaurant_id = g.restaurant_id and extract(isodow from x.d)::int <> g.dow
                     and extract(isodow from x.d)::smallint = any (app.open_dows(array[g.restaurant_id]))) o on true
   where g.dow::smallint = any (app.open_dows(array[g.restaurant_id]))
     and g.nd >= 3 and o.kg_day > 0 and g.kg_day >= 1.5 * o.kg_day and g.kg_day >= 2;

  -- Leave out what an active or planned intervention already focuses on
  delete from _s s using public.interventions i
   where i.restaurant_id = s.restaurant_id and i.deleted_at is null and i.status in ('active', 'planned')
     and (i.end_date is null or i.end_date >= v_to)
     and ((s.menu_item_id is not null and i.scope_menu_item_id = s.menu_item_id)
       or (s.rule = 'weekday' and i.scope_reason_id = s.reason_id and i.scope_waste_category_id is null and i.scope_menu_item_id is null)
       or (s.product_name is not null and position(lower(s.product_name) in lower(i.title)) > 0));

  select coalesce(jsonb_agg(z.j order by (z.j->>'score')::numeric desc), '[]'::jsonb) into v_out
    from (select jsonb_build_object(
            'rule', s.rule, 'restaurant_id', s.restaurant_id, 'restaurant_name', r.name,
            'product_name', s.product_name, 'menu_item_id', s.menu_item_id, 'menu_item', m.name,
            'waste_category_id', s.waste_category_id, 'reason_id', s.reason_id, 'reason_code', s.reason_code,
            'reason', (select app.lbl(wr.labels, p_lang) from public.waste_reasons wr where wr.id = s.reason_id),
            'dow', s.dow, 'kg', round(s.kg, 1), 'value', round(s.value, 0), 'share_pct', s.share_pct,
            'records', s.records, 'days', s.days, 'base_kg', s.base_kg, 'period_days', v_days,
            'score', round(s.score, 2),
            'examples', coalesce((
              select jsonb_agg(e) from (
                (select jsonb_build_object('kind', 'own', 'id', b.id, 'title', b.title, 'result_change_pct', b.result_change_pct) e
                   from public.best_practices b join public.interventions bi on bi.id = b.intervention_id
                  where b.organization_id = v_org and b.deleted_at is null and b.status = 'published'
                    and bi.scope_reason_id is not null and bi.scope_reason_id = s.reason_id
                  order by b.result_change_pct nulls last, b.id desc limit 1)
                union all
                (select jsonb_build_object('kind', 'industry', 'id', ie.id, 'code', ie.code, 'who', ie.who,
                        'title', coalesce(ie.title->>p_lang, ie.title->>'en'), 'result_change_pct', ie.result_change_pct) e
                   from public.industry_examples ie
                  where ie.is_active and s.reason_code = any (ie.reason_codes)
                  order by array_position(ie.reason_codes, s.reason_code), ie.sort_order limit 2)
              ) q), '[]'::jsonb)) j
            from _s s join public.restaurants r on r.id = s.restaurant_id
            left join public.menu_items m on m.id = s.menu_item_id
           order by s.score desc limit 10) z;
  return v_out;
end $$;

revoke all on function public.intervention_suggestions(bigint, bigint, int, text) from public, anon;
grant execute on function public.intervention_suggestions(bigint, bigint, int, text) to authenticated, service_role;
