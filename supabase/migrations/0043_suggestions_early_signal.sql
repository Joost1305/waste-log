-- 0043: early signal in suggested interventions.
-- With little data the rules of 0042 stay quiet (they wait for 3 registrations or 3 days). Then the card was empty.
-- Now, for a restaurant without any rule-based suggestion, the biggest avoidable product of the window is shown as
-- rule 'early': at least 0.5 kg, with its number of registrations, so the page can say honestly how thin it is.
-- It is not shown when an active or planned intervention already names that product.
-- Patches intervention_suggestions by text replacement and stops when the expected text is not found.

do $mig$
declare
  v_def text := pg_get_functiondef('public.intervention_suggestions(bigint, bigint, int, text)'::regprocedure);
  v_old text := '  select coalesce(jsonb_agg(z.j order by (z.j->>''score'')::numeric desc), ''[]''::jsonb) into v_out';
  v_new text := $new$  -- Early signal: restaurants without any suggestion get their biggest avoidable product (rule 'early')
  insert into _s (rule, restaurant_id, product_name, waste_category_id, reason_id, reason_code, kg, value, share_pct, records, days, score)
  select 'early', p.restaurant_id, p.product_name, p.cat, p.reason_id, p.reason_code, p.kg, p.val,
         round(p.kg / t.kg * 100, 1), p.n, p.nd, (p.val + p.kg) / 100
    from (select distinct on (restaurant_id) restaurant_id, product_name, kg, val, n, nd, cat, reason_id, reason_code
            from (select restaurant_id, product_name, sum(kg) kg, sum(val) val, count(*) n, count(distinct d) nd,
                         mode() within group (order by waste_category_id) cat,
                         mode() within group (order by reason_id) reason_id,
                         mode() within group (order by reason_code) reason_code
                    from _sw where product_name is not null group by 1, 2) g
           where kg >= 0.5
             and not exists (select 1 from _s s where s.restaurant_id = g.restaurant_id)
             and not exists (select 1 from public.interventions i
                              where i.restaurant_id = g.restaurant_id and i.deleted_at is null and i.status in ('active', 'planned')
                                and (i.end_date is null or i.end_date >= v_to)
                                and position(lower(g.product_name) in lower(i.title)) > 0)
           order by restaurant_id, val + kg desc) p
    join (select restaurant_id, sum(kg) kg from _sw group by 1) t on t.restaurant_id = p.restaurant_id
   where t.kg > 0;

$new$;
begin
  if position(v_old in v_def) = 0 then raise exception '0043: expected text not found in intervention_suggestions'; end if;
  execute replace(v_def, v_old, v_new || v_old);
end $mig$;
