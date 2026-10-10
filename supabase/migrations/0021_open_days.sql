-- 0021  Opening days per restaurant (ISO weekday 1 = Monday … 7 = Sunday).
-- "Per day" figures (dashboard, interventions, leaderboard improvement) divide by open days instead of
-- calendar days, so a Monday-to-Friday kitchen is not diluted by weekends it is closed.
alter table public.restaurants add column if not exists open_days smallint[] not null default '{1,2,3,4,5,6,7}';
alter table public.restaurants add constraint restaurants_open_days_check
  check (cardinality(open_days) between 1 and 7 and open_days <@ '{1,2,3,4,5,6,7}'::smallint[]);

-- Days between two dates on which at least one of the restaurants is open (at least 1, to divide safely)
create or replace function app.open_days_between(p_rids bigint[], p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select greatest(1, count(*)::int)
    from generate_series(p_from, p_to, interval '1 day') d
   where extract(isodow from d)::smallint = any (coalesce(
           (select array_agg(distinct x) from public.restaurants r, unnest(r.open_days) x where r.id = any (p_rids)),
           '{1,2,3,4,5,6,7}'::smallint[]))
$$;
revoke execute on function app.open_days_between(bigint[], date, date) from public, anon;
grant execute on function app.open_days_between(bigint[], date, date) to authenticated, service_role;

do $$
declare src text; n text;
begin
  -- dashboard: kg per day
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, $q$'kg_per_day', round(t.kg / v_span, 2)$q$, $q$'kg_per_day', round(t.kg / app.open_days_between(v_rids, v_from, v_to), 2), 'open_days', app.open_days_between(v_rids, v_from, v_to)$q$);
  if n = src then raise exception 'dashboard: pattern not found'; end if;
  execute n;

  -- interventions: before/after windows per open day
  src := pg_get_functiondef('app.window_stats(bigint, bigint[], bigint, bigint, bigint, date, date)'::regprocedure);
  n := replace(src, $q$/ (p_to - p_from + 1), 3)$q$, $q$/ app.open_days_between(p_rids, p_from, p_to), 3)$q$);
  n := replace(n, $q$'active_days', (select count(distinct d) from w),$q$, $q$'active_days', (select count(distinct d) from w), 'open_days', app.open_days_between(p_rids, p_from, p_to),$q$);
  if n = src then raise exception 'window_stats: pattern not found'; end if;
  execute n;

  -- leaderboard: improvement compares kg per open day (last 4 weeks vs this period)
  src := pg_get_functiondef('public.leaderboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, $q$else round(((a.base_kg / 28) - (a.kg / (v_end - v_from + 1))) / (a.base_kg / 28) * 100, 0) end end change_pct$q$,
    $q$else round(((a.base_kg / app.open_days_between(array[v_rest], v_from - 28, v_from - 1)) - (a.kg / app.open_days_between(array[v_rest], v_from, v_end))) / (a.base_kg / app.open_days_between(array[v_rest], v_from - 28, v_from - 1)) * 100, 0) end end change_pct$q$);
  if n = src then raise exception 'leaderboard: pattern not found'; end if;
  execute n;
end $$;
