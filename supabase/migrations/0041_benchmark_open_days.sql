-- 0041  Closed days are not part of the averages or the benchmark.
--
-- A Monday-to-Friday kitchen sometimes logs a little on a Saturday (someone clears the fridge).
-- That waste is real and stays in the totals, but such a day is not a normal working day:
-- it must not pull "kg per registered day" down, and it must never become the "best day".
-- From now on "registered days" means: open days (restaurants.open_days) with at least one registration.
-- With several restaurants selected a day counts as open when at least one of them is open that weekday
-- (the same rule as app.open_days_between and dashboard_daily.open_dows).

-- Weekdays on which at least one of the restaurants is open
create or replace function app.open_dows(p_rids bigint[])
returns smallint[] language sql stable security definer set search_path = '' as $$
  select coalesce((select array_agg(distinct x) from public.restaurants r, unnest(r.open_days) x where r.id = any (p_rids)),
                  '{1,2,3,4,5,6,7}'::smallint[])
$$;
revoke execute on function app.open_dows(bigint[]) from public, anon;
grant execute on function app.open_dows(bigint[]) to authenticated, service_role;

-- Open days with at least one registration
create or replace function app.open_registered_days(p_org bigint, p_rids bigint[], p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select count(distinct app.local_date(w.recorded_at))::int from public.waste_records w
   where w.organization_id = p_org and w.restaurant_id = any (p_rids) and w.deleted_at is null
     and w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at <  ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam')
     and extract(isodow from app.local_date(w.recorded_at))::smallint = any (app.open_dows(p_rids))
$$;
revoke execute on function app.open_registered_days(bigint, bigint[], date, date) from public, anon;
grant execute on function app.open_registered_days(bigint, bigint[], date, date) to authenticated, service_role;

-- Kilos registered on open days
create or replace function app.open_registered_kg(p_org bigint, p_rids bigint[], p_from date, p_to date)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(w.weight_kg), 0) from public.waste_records w
   where w.organization_id = p_org and w.restaurant_id = any (p_rids) and w.deleted_at is null
     and w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at <  ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam')
     and extract(isodow from app.local_date(w.recorded_at))::smallint = any (app.open_dows(p_rids))
$$;
revoke execute on function app.open_registered_kg(bigint, bigint[], date, date) from public, anon;
grant execute on function app.open_registered_kg(bigint, bigint[], date, date) to authenticated, service_role;

do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);

  -- kg per registered day: open days only (closed-day kilos still count in the total)
  n := replace(src,
    $q$'kg_per_day', round(t.kg / greatest(1, app.registered_days(v_org, v_rids, v_from, v_to)), 2), 'open_days', app.open_days_between(v_rids, v_from, v_to), 'registered_days', app.registered_days(v_org, v_rids, v_from, v_to)$q$,
    $q$'kg_per_day', round(app.open_registered_kg(v_org, v_rids, v_from, v_to) / greatest(1, app.open_registered_days(v_org, v_rids, v_from, v_to)), 2), 'open_days', app.open_days_between(v_rids, v_from, v_to), 'registered_days', app.open_registered_days(v_org, v_rids, v_from, v_to)$q$);
  if n = src then raise exception 'dashboard kg_per_day: pattern not found'; end if;
  src := n;

  -- change versus the previous period: the same rule on both sides
  n := replace(src,
    $q$'change_kg_pct', case when v_prev.kg > 0 then round(((t.kg / greatest(1, app.registered_days(v_org, v_rids, v_from, v_to)))
         - (v_prev.kg / greatest(1, app.registered_days(v_org, v_rids, v_pfrom, v_pto))))
         / (v_prev.kg / greatest(1, app.registered_days(v_org, v_rids, v_pfrom, v_pto))) * 100, 1) end$q$,
    $q$'change_kg_pct', case when app.open_registered_kg(v_org, v_rids, v_pfrom, v_pto) > 0 then round(((app.open_registered_kg(v_org, v_rids, v_from, v_to) / greatest(1, app.open_registered_days(v_org, v_rids, v_from, v_to)))
         - (app.open_registered_kg(v_org, v_rids, v_pfrom, v_pto) / greatest(1, app.open_registered_days(v_org, v_rids, v_pfrom, v_pto))))
         / (app.open_registered_kg(v_org, v_rids, v_pfrom, v_pto) / greatest(1, app.open_registered_days(v_org, v_rids, v_pfrom, v_pto))) * 100, 1) end$q$);
  if n = src then raise exception 'dashboard change: pattern not found'; end if;
  execute n;
end $$;
