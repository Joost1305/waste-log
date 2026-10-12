-- 0028  Morning system check.
-- Every morning (and on request) the system-check function tests the connections the app depends on,
-- lists the important changes of the last 24 hours and looks for gaps in the data. The result is
-- stored here and shown to super admins under Settings › System check. A red result also makes the
-- scheduled GitHub job fail, so GitHub e-mails the owner.
--
-- To say "price 14.95 -> 8.72" the change log now also keeps, for updates, which fields changed
-- (old and new value).

-- ---------------------------------------------------------------- change log: old and new values
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := to_jsonb(new);
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_action text := lower(tg_op);
  v_org bigint;
  v_changes jsonb;
begin
  -- Bulk revaluation (invoices) does not log one line per touched registration
  if tg_table_name = 'waste_records' and tg_op = 'UPDATE' and current_setting('app.revalue', true) = 'on' then return new; end if;
  if tg_op = 'UPDATE' and (o ->> 'deleted_at') is null and (j ->> 'deleted_at') is not null then v_action := 'delete'; end if;
  if tg_op = 'INSERT' then v_action := 'create'; end if;
  v_org := case when tg_table_name = 'organizations' then (j ->> 'id')::bigint else (j ->> 'organization_id')::bigint end;
  -- Fields that changed (not for registrations: those are not settings), short values only
  if tg_op = 'UPDATE' and tg_table_name <> 'waste_records' then
    select jsonb_object_agg(k, jsonb_build_array(
             case when jsonb_typeof(o -> k) = 'string' then to_jsonb(left(o ->> k, 120)) else o -> k end,
             case when jsonb_typeof(j -> k) = 'string' then to_jsonb(left(j ->> k, 120)) else j -> k end))
      into v_changes
      from (select k from jsonb_object_keys(j) k
             where k not in ('updated_at', 'created_at', 'last_sign_in_at', 'last_sent_at', 'last_sent_week', 'last_sent_on', 'last_status')
               and (o -> k) is distinct from (j -> k)
             limit 15) x;
    -- Nothing that matters changed: no log line
    if v_changes is null and v_action = 'update' then return new; end if;
  end if;
  insert into public.audit_log (organization_id, user_id, action, entity, entity_id, details)
  values (v_org, auth.uid(), v_action, tg_table_name, j ->> 'id',
          (case tg_table_name
            when 'waste_records' then jsonb_build_object('kg', j -> 'weight_kg', 'restaurant_id', j -> 'restaurant_id')
            when 'users' then jsonb_build_object('email', j -> 'email', 'name', j -> 'name', 'role', j -> 'role', 'is_active', j -> 'is_active')
            else jsonb_build_object('name', coalesce(j -> 'name', j -> 'title'))
          end) || case when v_changes is not null then jsonb_build_object('changes', v_changes) else '{}'::jsonb end);
  return new;
end $$;

-- ---------------------------------------------------------------- results and the hourly job's heartbeat
create table if not exists public.system_checks (
  id          bigint generated always as identity primary key,
  run_at      timestamptz not null default now(),
  trigger     text not null default 'schedule' check (trigger in ('schedule', 'manual')),
  status      text not null check (status in ('ok', 'warn', 'fail')),
  checks      jsonb not null default '[]',      -- [{ key, status, detail, ms }]
  changes     jsonb not null default '[]',      -- important changes since the previous check
  changes_all int not null default 0,           -- all logged changes in the same window
  gaps        jsonb not null default '[]',      -- [{ key, org, count, items }]
  window_from timestamptz,
  window_to   timestamptz
);
create index if not exists system_checks_run_idx on public.system_checks (run_at desc);
alter table public.system_checks enable row level security;
grant select on public.system_checks to authenticated;
create policy system_checks_select on public.system_checks for select to authenticated using (app.is_super());

create table if not exists public.job_runs (
  job         text primary key,
  last_run_at timestamptz not null default now(),
  details     jsonb
);
alter table public.job_runs enable row level security;
grant select on public.job_runs to authenticated;
create policy job_runs_select on public.job_runs for select to authenticated using (app.is_super());

-- ---------------------------------------------------------------- important changes
-- Settings that change how the app behaves or what things cost. Registrations, guest counts and
-- ideas are not in here (they are daily work, not settings).
create or replace function app.important_changes(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'at', a.created_at, 'org', o.name, 'user', coalesce(u.name, u.email, case when a.user_id is null then 'system' end),
           'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id,
           'name', coalesce(a.details ->> 'name', a.details ->> 'email', r.name),
           'changes', a.details -> 'changes') order by a.created_at desc), '[]'::jsonb)
    from public.audit_log a
    left join public.organizations o on o.id = a.organization_id
    left join public.users u on u.id = a.user_id
    left join public.restaurants r on a.entity = 'report_subscriptions' and r.id = (
      select s.restaurant_id from public.report_subscriptions s where s.id::text = a.entity_id)
   where a.created_at >= p_from and a.created_at < p_to
     and (o.id is null or not o.is_demo)
     and (
       a.entity in ('users', 'organizations', 'restaurants', 'sections', 'report_subscriptions', 'targets')
       or (a.entity in ('products', 'suppliers') and a.action in ('create', 'delete'))
       or (a.entity = 'products' and a.details -> 'changes' ?| array['purchase_price_per_kg', 'waste_category_id', 'name', 'is_active', 'default_supplier_id', 'co2e_per_kg'])
     )
$$;

-- All logged changes in a window (the full list in the app, one tap away)
create or replace function public.system_check_all_changes(p_check bigint)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c record;
begin
  if not app.is_super() then raise exception 'Not allowed' using errcode = '42501'; end if;
  select window_from, window_to into c from public.system_checks where id = p_check;
  if not found then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
           'at', a.created_at, 'org', o.name, 'user', coalesce(u.name, u.email, case when a.user_id is null then 'system' end),
           'action', a.action, 'entity', a.entity, 'entity_id', a.entity_id,
           'name', coalesce(a.details ->> 'name', a.details ->> 'email'), 'changes', a.details -> 'changes',
           'kg', a.details -> 'kg') order by a.created_at desc)
      from (select * from public.audit_log a where a.created_at >= c.window_from and a.created_at < c.window_to
             order by a.created_at desc limit 1000) a
      left join public.organizations o on o.id = a.organization_id
      left join public.users u on u.id = a.user_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- gaps in the data (orange, never an alert)
create or replace function app.system_gaps() returns jsonb
language sql stable security definer set search_path = '' as $$
  with orgs as (select id, name, weather_enabled from public.organizations where deleted_at is null and not is_demo),
  no_price as (
    select o.name org, count(*) n, (array_agg(p.name order by p.name))[1:8] items
      from public.products p join orgs o on o.id = p.organization_id
     where p.deleted_at is null and p.is_active and p.purchase_price_per_kg is null
     group by o.name),
  quiet as (
    -- Restaurants that registered in the last 30 days but not at all on their last 3 open days
    select o.name org, r.name restaurant
      from public.restaurants r join orgs o on o.id = r.organization_id
     where r.deleted_at is null
       and exists (select 1 from public.waste_records w where w.restaurant_id = r.id and w.deleted_at is null
                    and w.recorded_at >= now() - interval '30 days')
       and not exists (select 1 from public.waste_records w where w.restaurant_id = r.id and w.deleted_at is null
                        and app.local_date(w.recorded_at) >= (
                          select min(d)::date from (select d from generate_series(app.local_date(now()) - 14, app.local_date(now()) - 1, interval '1 day') d
                                                     where extract(isodow from d)::smallint = any (r.open_days)
                                                     order by d desc limit 3) x))),
  no_coords as (
    select o.name org, r.name restaurant from public.restaurants r join orgs o on o.id = r.organization_id
     where r.deleted_at is null and o.weather_enabled and (r.latitude is null or r.longitude is null)),
  no_dates as (
    select o.name org, coalesce(r.name, 'all restaurants') list
      from public.report_subscriptions s join orgs o on o.id = s.organization_id
      left join public.restaurants r on r.id = s.restaurant_id
     where s.deleted_at is null and s.is_active and s.schedule_mode = 'dates'
       and not exists (select 1 from unnest(s.send_dates) d where d >= app.local_date(now())))
  select coalesce((select jsonb_agg(jsonb_build_object('key', 'no_price', 'org', org, 'count', n, 'items', to_jsonb(items))) from no_price), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('key', 'quiet', 'org', org, 'items', jsonb_build_array(restaurant))) from quiet), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('key', 'no_coords', 'org', org, 'items', jsonb_build_array(restaurant))) from no_coords), '[]'::jsonb)
      || coalesce((select jsonb_agg(jsonb_build_object('key', 'no_dates', 'org', org, 'items', jsonb_build_array(list))) from no_dates), '[]'::jsonb)
$$;

-- Weather: restaurants (real organizations, weather on, with coordinates) without today's record
create or replace function app.weather_missing_today() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(r.name), '[]'::jsonb)
    from public.restaurants r join public.organizations o on o.id = r.organization_id
   where r.deleted_at is null and o.deleted_at is null and not o.is_demo and o.weather_enabled
     and r.latitude is not null and r.longitude is not null
     and not exists (select 1 from public.weather_records w where w.restaurant_id = r.id and w.date = app.local_date(now()))
$$;

-- Only the service role (the check itself) runs these
revoke execute on function app.important_changes(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function app.system_gaps() from public, anon, authenticated;
revoke execute on function app.weather_missing_today() from public, anon, authenticated;
grant execute on function app.important_changes(timestamptz, timestamptz) to service_role;
grant execute on function app.system_gaps() to service_role;
grant execute on function app.weather_missing_today() to service_role;
revoke execute on function public.system_check_all_changes(bigint) from public, anon;
grant execute on function public.system_check_all_changes(bigint) to authenticated;

-- The check reaches these through RPC wrappers in the public schema (the app schema is not exposed)
create or replace function public.system_check_inputs(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'changes', app.important_changes(p_from, p_to),
    'changes_all', (select count(*) from public.audit_log a where a.created_at >= p_from and a.created_at < p_to),
    'gaps', app.system_gaps(),
    'weather_missing', app.weather_missing_today(),
    'hourly_last_run', (select last_run_at from public.job_runs where job = 'hourly'),
    'last_check', (select run_at from public.system_checks order by run_at desc limit 1))
$$;
revoke execute on function public.system_check_inputs(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.system_check_inputs(timestamptz, timestamptz) to service_role;
