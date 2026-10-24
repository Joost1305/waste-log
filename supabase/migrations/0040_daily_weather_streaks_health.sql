-- 0040  Missing days, daily dashboard data (summary line, reference-line chart, weather card),
--       registration streaks and usage health per location.
--
-- Missing days: a day without any registration is "no data", never "zero waste".
--   dashboard:     kg per day and the change versus the previous period are per registered day;
--                  guests only count on days that were registered (otherwise waste per guest looks too low)
--   interventions: the same for the before/after windows

-- Days on which a restaurant registered anything (any category)
create or replace function app.registered_days(p_org bigint, p_rids bigint[], p_from date, p_to date)
returns int language sql stable security definer set search_path = '' as $$
  select count(distinct app.local_date(w.recorded_at))::int from public.waste_records w
   where w.organization_id = p_org and w.restaurant_id = any (p_rids) and w.deleted_at is null
     and w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at <  ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam')
$$;
revoke execute on function app.registered_days(bigint, bigint[], date, date) from public, anon;
grant execute on function app.registered_days(bigint, bigint[], date, date) to authenticated, service_role;

do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, $q$'kg_per_day', round(t.kg / app.open_days_between(v_rids, v_from, v_to), 2), 'open_days', app.open_days_between(v_rids, v_from, v_to)$q$,
    $q$'kg_per_day', round(t.kg / greatest(1, app.registered_days(v_org, v_rids, v_from, v_to)), 2), 'open_days', app.open_days_between(v_rids, v_from, v_to), 'registered_days', app.registered_days(v_org, v_rids, v_from, v_to)$q$);
  if n = src then raise exception 'dashboard kg_per_day: pattern not found'; end if;
  src := n;
  n := replace(src, $q$'change_kg_pct', case when v_prev.kg > 0 then round((t.kg - v_prev.kg) / v_prev.kg * 100, 1) end$q$,
    $q$'change_kg_pct', case when v_prev.kg > 0 then round(((t.kg / greatest(1, app.registered_days(v_org, v_rids, v_from, v_to)))
         - (v_prev.kg / greatest(1, app.registered_days(v_org, v_rids, v_pfrom, v_pto))))
         / (v_prev.kg / greatest(1, app.registered_days(v_org, v_rids, v_pfrom, v_pto))) * 100, 1) end$q$);
  if n = src then raise exception 'dashboard change: pattern not found'; end if;
  src := n;
  n := replace(src, $q$analyze _w; analyze _c;$q$,
    $q$delete from _c where not exists (select 1 from _w where _w.restaurant_id = _c.restaurant_id and _w.d = _c.date);
  analyze _w; analyze _c;$q$);
  if n = src then raise exception 'dashboard guests: pattern not found'; end if;
  execute n;

  src := pg_get_functiondef('app.window_stats(bigint, bigint[], bigint, bigint, bigint, date, date)'::regprocedure);
  n := replace(src, $q$'kg_per_day', round(coalesce((select sum(kg) from w), 0) / app.open_days_between(p_rids, p_from, p_to), 3),$q$,
    $q$'kg_per_day', round(coalesce((select sum(kg) from w), 0) / greatest(1, app.registered_days(p_org, p_rids, p_from, p_to)), 3),
    'registered_days', app.registered_days(p_org, p_rids, p_from, p_to),$q$);
  if n = src then raise exception 'window_stats kg_per_day: pattern not found'; end if;
  src := n;
  n := replace(src, $q$where c.restaurant_id = any (p_rids) and c.date between p_from and p_to and c.guests > 0)$q$,
    $q$where c.restaurant_id = any (p_rids) and c.date between p_from and p_to and c.guests > 0
       and exists (select 1 from public.waste_records x where x.organization_id = p_org and x.restaurant_id = c.restaurant_id and x.deleted_at is null
                     and x.recorded_at >= (c.date::timestamp at time zone 'Europe/Amsterdam')
                     and x.recorded_at <  ((c.date + 1)::timestamp at time zone 'Europe/Amsterdam')))$q$);
  if n = src then raise exception 'window_stats guests: pattern not found'; end if;
  execute n;
end $$;

-- ---------------------------------------------------------------
-- Daily series for the dashboard: one row per calendar day, far enough back for the previous period,
-- the 4-week average and a year of weather comparisons. Days without registrations have n = 0;
-- the page treats an open day with n = 0 as "no data".
-- Guests only count for restaurants that registered that day.
-- ---------------------------------------------------------------
create or replace function public.dashboard_daily(p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org   bigint := app.effective_org(p_org);
  v_today date := app.local_date(now());
  v_to    date := least(coalesce(p_to, app.local_date(now())), app.local_date(now()));
  v_from  date;
  v_start date;
  v_rids  bigint[];
  v_dows  smallint[];
  v_days  jsonb;
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  v_from := coalesce(p_from, v_to - 83);
  v_rids := array(select r.id from public.restaurants r where r.organization_id = v_org and r.deleted_at is null and r.id = any (app.restaurant_ids()));
  if p_restaurant is not null then
    if not (p_restaurant = any (v_rids)) then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
    v_rids := array[p_restaurant];
  end if;
  v_start := least(v_from - (v_to - v_from + 1) - 7, v_to - 364);
  v_dows := coalesce((select array_agg(distinct x) from public.restaurants r, unnest(r.open_days) x where r.id = any (v_rids)), '{1,2,3,4,5,6,7}'::smallint[]);

  with days as (select g::date d from generate_series(v_start, v_to, interval '1 day') g),
  wr as (
    select w.restaurant_id, app.local_date(w.recorded_at) d, sum(w.weight_kg) kg,
           sum(case when app.reason_avoidable(w.reason_id) then w.weight_kg else 0 end) akg, count(*) n
      from public.waste_records w
     where w.organization_id = v_org and w.restaurant_id = any (v_rids) and w.deleted_at is null
       and w.recorded_at >= (v_start::timestamp at time zone 'Europe/Amsterdam')
       and w.recorded_at <  ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')
     group by 1, 2),
  w as (select d, sum(kg) kg, sum(akg) akg, sum(n) n from wr group by 1),
  c as (
    select c.date d, sum(c.guests) guests from public.daily_covers c
      join wr on wr.restaurant_id = c.restaurant_id and wr.d = c.date
     where c.restaurant_id = any (v_rids) and c.date between v_start and v_to and c.guests > 0
     group by 1),
  x as (
    select x.date d, round(avg(x.temp_max_c), 1) tmax, round(avg(x.temp_mean_c), 1) tmean, round(avg(x.rainfall_mm), 1) rain,
           mode() within group (order by x.condition) cond
      from public.weather_records x
     where x.restaurant_id = any (v_rids) and x.date between v_start and v_to
     group by 1)
  select jsonb_agg(jsonb_build_object(
           'd', days.d, 'open', extract(isodow from days.d)::smallint = any (v_dows),
           'n', coalesce(w.n, 0), 'kg', round(coalesce(w.kg, 0), 2), 'akg', round(coalesce(w.akg, 0), 2),
           'guests', c.guests, 'tmax', x.tmax, 'tmean', x.tmean, 'rain', x.rain, 'cond', x.cond) order by days.d)
    into v_days
    from days left join w on w.d = days.d left join c on c.d = days.d left join x on x.d = days.d;

  return jsonb_build_object('from', v_from, 'to', v_to, 'today', v_today, 'start', v_start,
    'open_dows', to_jsonb(v_dows), 'restaurants', cardinality(v_rids), 'days', coalesce(v_days, '[]'::jsonb));
end $$;
revoke execute on function public.dashboard_daily(bigint, bigint, date, date) from public, anon;
grant execute on function public.dashboard_daily(bigint, bigint, date, date) to authenticated;

-- ---------------------------------------------------------------
-- Registration streak per restaurant: open days in a row with at least one registration.
-- Closed days are skipped (a weekend does not break a Monday-to-Friday streak); today does not
-- break the streak while it is still going. Also returns when 7 / 30 / 100 days in a row were first reached.
-- ---------------------------------------------------------------
create or replace function public.registration_streak(p_restaurant bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := app.local_date(now());
  v_dows  smallint[];
  v_name  text;
  v_days  date[];
  v_run   int := 0; v_best int := 0;
  v_e7 date; v_e30 date; v_e100 date;
  d date;
begin
  if app.rank() = 0 or not (p_restaurant = any (app.restaurant_ids())) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select r.open_days, r.name into v_dows, v_name from public.restaurants r where r.id = p_restaurant;
  v_days := array(select distinct app.local_date(w.recorded_at) from public.waste_records w
                   where w.restaurant_id = p_restaurant and w.deleted_at is null
                     and w.recorded_at >= ((v_today - 420)::timestamp at time zone 'Europe/Amsterdam') order by 1);
  if cardinality(v_days) > 0 then
    for d in select g::date from generate_series(v_days[1], v_today, interval '1 day') g loop
      if d = any (v_days) then
        v_run := v_run + 1;
        v_best := greatest(v_best, v_run);
        if v_run = 7 and v_e7 is null then v_e7 := d; end if;
        if v_run = 30 and v_e30 is null then v_e30 := d; end if;
        if v_run = 100 and v_e100 is null then v_e100 := d; end if;
      elsif d = v_today or not (extract(isodow from d)::smallint = any (v_dows)) then
        null;                       -- still today, or closed: neither counts nor breaks
      else
        v_run := 0;
      end if;
    end loop;
  end if;
  return jsonb_build_object('restaurant_id', p_restaurant, 'restaurant', v_name, 'current', v_run, 'best', v_best,
    'today', v_today = any (v_days), 'last', v_days[cardinality(v_days)],
    'earned', jsonb_build_object('7', v_e7, '30', v_e30, '100', v_e100));
end $$;
revoke execute on function public.registration_streak(bigint) from public, anon;
grant execute on function public.registration_streak(bigint) to authenticated;

-- ---------------------------------------------------------------
-- Usage health per location (and per section): when did they last register, and how many open days
-- have gone by since. 0-3 open days missed: active; 4-13: slipping; 14 or more, or never: inactive.
-- Today does not count as missed.
-- ---------------------------------------------------------------
create or replace function public.usage_health(p_org bigint default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org   bigint := app.effective_org(p_org);
  v_today date := app.local_date(now());
  v_res   jsonb;
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  with r as (
    select r.id, r.name, r.open_days from public.restaurants r
     where r.organization_id = v_org and r.deleted_at is null and r.id = any (app.restaurant_ids())),
  w as (
    select w.restaurant_id, w.section_id, app.local_date(w.recorded_at) d
      from public.waste_records w
     where w.organization_id = v_org and w.deleted_at is null and w.restaurant_id in (select id from r)
       and w.recorded_at >= ((v_today - 400)::timestamp at time zone 'Europe/Amsterdam')),
  rs as (
    select r.id, r.name, r.open_days,
           (select max(d) from w where w.restaurant_id = r.id) last_d,
           (select count(*) from w where w.restaurant_id = r.id and w.d > v_today - 30) regs_30,
           (select count(distinct d) from w where w.restaurant_id = r.id and w.d > v_today - 30 and w.d < v_today) days_30,
           (select count(*) from generate_series(v_today - 29, v_today - 1, interval '1 day') g
             where extract(isodow from g)::smallint = any (r.open_days)) open_30
      from r),
  rs2 as (
    select rs.*,
           case when rs.last_d is null then null else
             (select count(*) from generate_series(rs.last_d + 1, v_today - 1, interval '1 day') g
               where extract(isodow from g)::smallint = any (rs.open_days)) end missed
      from rs)
  select coalesce(jsonb_agg(jsonb_build_object(
           'restaurant_id', rs2.id, 'name', rs2.name, 'last', rs2.last_d, 'missed', rs2.missed,
           'registrations_30', rs2.regs_30, 'days_30', rs2.days_30, 'open_30', rs2.open_30,
           'status', case when rs2.last_d is null or rs2.missed >= 14 then 'inactive' when rs2.missed >= 4 then 'slipping' else 'active' end,
           'sections', coalesce((
             select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'last', sl.last_d,
                      'missed', case when sl.last_d is null then null else
                        (select count(*) from generate_series(sl.last_d + 1, v_today - 1, interval '1 day') g
                          where extract(isodow from g)::smallint = any (rs2.open_days)) end) order by s.sort_order, s.name)
               from public.sections s
               left join lateral (select max(w.d) last_d from w where w.section_id = s.id) sl on true
              where s.restaurant_id = rs2.id and s.is_active and s.deleted_at is null), '[]'::jsonb))
           order by rs2.name), '[]'::jsonb)
    into v_res from rs2;
  return jsonb_build_object('today', v_today, 'rows', v_res);
end $$;
revoke execute on function public.usage_health(bigint) from public, anon;
grant execute on function public.usage_health(bigint) to authenticated;
