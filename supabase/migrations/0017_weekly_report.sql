-- 0017  Weekly impact e-mail per restaurant (or one overview for the whole organization).
-- Settings › Weekly e-mail: a list of recipients per restaurant, language, on/off.
-- Every Monday morning the daily job sends last week's numbers (Monday to Sunday) to each list.
-- Managers manage the lists of their own restaurants; the organization-wide overview needs an org admin.

create table if not exists public.report_subscriptions (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint references public.restaurants(id),          -- null = all restaurants together
  recipients       text[] not null default '{}',
  language         text not null default 'en' check (language in ('en', 'nl')),
  is_active        boolean not null default true,
  last_sent_week   date,
  last_sent_at     timestamptz,
  last_status      text,
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create unique index if not exists report_subscriptions_one
  on public.report_subscriptions (organization_id, coalesce(restaurant_id, 0)) where deleted_at is null;

-- Clean the recipient list (trim, lower case, no doubles) and check every address
create or replace function app.report_subscription_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare bad text;
begin
  new.recipients := coalesce(array(select distinct lower(btrim(x)) from unnest(new.recipients) x where btrim(x) <> '' order by 1), '{}');
  select x into bad from unnest(new.recipients) x where x !~ '^[^@\s,;<>]+@[^@\s,;<>]+\.[a-z]{2,}$' limit 1;
  if bad is not null then raise exception 'Invalid e-mail address: %', bad using errcode = '22023'; end if;
  if cardinality(new.recipients) > 25 then raise exception 'At most 25 recipients per list' using errcode = '22023'; end if;
  if new.restaurant_id is not null and not exists (select 1 from public.restaurants r
       where r.id = new.restaurant_id and r.organization_id = new.organization_id) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
create or replace trigger default_org before insert on public.report_subscriptions for each row execute function app.default_org();
create or replace trigger report_subscription_check before insert or update on public.report_subscriptions
  for each row execute function app.report_subscription_check();
create or replace trigger touch_updated_at before update on public.report_subscriptions for each row execute function app.touch_updated_at();
create or replace trigger audit after insert or update on public.report_subscriptions for each row execute function app.audit_row();

alter table public.report_subscriptions enable row level security;
grant select, insert, update on public.report_subscriptions to authenticated;
create policy report_subscriptions_select on public.report_subscriptions for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id)
         and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)));
create policy report_subscriptions_insert on public.report_subscriptions for insert to authenticated
  with check ((select app.rank()) >= 30 and app.in_org(organization_id)
              and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)));
create policy report_subscriptions_update on public.report_subscriptions for update to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id)
         and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)))
  with check (app.in_org(organization_id)
              and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)));

-- The intervention effect is also used by the weekly e-mail, which runs without a signed-in user
-- (service role). Signed-in users still need to be a manager in the same organization.
create or replace function app.can_see_intervention(p_org bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  -- No signed-in user: only the sending job gets here (the app schema and these functions are not open to visitors)
  select auth.uid() is null or (app.in_org(p_org) and app.rank() >= 30)
$$;

-- ---------------------------------------------------------------- report content
-- Last complete week: Monday to Sunday before the current week (Amsterdam time)
create or replace function app.last_full_week() returns date
language sql stable set search_path = '' as $$
  select (date_trunc('week', app.local_date(now()))::date - 7)
$$;

create or replace function app.weekly_report_data(p_org bigint, p_restaurant bigint, p_week date, p_lang text default 'en')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_from date := date_trunc('week', p_week)::date;
  v_to   date := date_trunc('week', p_week)::date + 6;
  v_rids bigint[];
  v_org  record;
  v_rest text;
  cur jsonb; prev jsonb; avg4 jsonb;
  v_target jsonb; v_tdays int; v_tcur numeric;
begin
  if not app.can_see_intervention(p_org) then return null; end if;
  select o.id, o.name, o.currency into v_org from public.organizations o where o.id = p_org and o.deleted_at is null;
  if not found then return null; end if;
  if p_restaurant is not null then
    select r.name into v_rest from public.restaurants r where r.id = p_restaurant and r.organization_id = p_org and r.deleted_at is null;
    if not found then return null; end if;
    v_rids := array[p_restaurant];
  else
    v_rids := array(select r.id from public.restaurants r where r.organization_id = p_org and r.deleted_at is null);
  end if;

  cur  := app.window_stats(p_org, v_rids, null, null, null, v_from, v_to);
  prev := app.window_stats(p_org, v_rids, null, null, null, v_from - 7, v_from - 1);
  avg4 := app.window_stats(p_org, v_rids, null, null, null, v_from - 28, v_from - 1);

  select jsonb_build_object('name', tg.name, 'period', tg.period, 'baseline_kg', tg.baseline_kg, 'target_kg', tg.target_kg)
    into v_target from public.targets tg
   where tg.organization_id = p_org and tg.deleted_at is null and tg.start_date <= v_to and (tg.end_date is null or tg.end_date >= v_to)
     and ((p_restaurant is not null and tg.restaurant_id = p_restaurant) or (p_restaurant is null and tg.restaurant_id is null))
   order by tg.start_date desc, tg.id desc limit 1;
  if v_target is not null then
    v_tdays := app.period_days(v_target ->> 'period');
    select coalesce(sum(w.weight_kg), 0) into v_tcur from public.waste_records w
     where w.restaurant_id = any (v_rids) and w.deleted_at is null
       and w.recorded_at >= ((v_to - (v_tdays - 1))::timestamp at time zone 'Europe/Amsterdam')
       and w.recorded_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam');
    v_target := v_target || jsonb_build_object('current_kg', round(v_tcur, 1), 'window_days', v_tdays,
      'progress_pct', greatest(0, least(100, round(((v_target ->> 'baseline_kg')::numeric - v_tcur)
                        / nullif((v_target ->> 'baseline_kg')::numeric - (v_target ->> 'target_kg')::numeric, 0) * 100, 0))),
      'achieved', v_tcur <= (v_target ->> 'target_kg')::numeric);
  end if;

  return jsonb_build_object(
    'organization', v_org.name, 'currency', v_org.currency, 'restaurant', v_rest, 'scope', case when p_restaurant is null then 'organization' else 'restaurant' end,
    'week_from', v_from, 'week_to', v_to, 'week_number', extract(week from v_from)::int,
    'this_week', cur, 'previous_week', prev,
    'avg4_kg', round((avg4 ->> 'kg')::numeric / 4, 1), 'avg4_g_per_guest', avg4 -> 'g_per_guest',
    'change_kg_pct', case when (prev ->> 'kg')::numeric > 0
      then round(((cur ->> 'kg')::numeric - (prev ->> 'kg')::numeric) / (prev ->> 'kg')::numeric * 100, 0) end,
    'co2e_kg', (select round(coalesce(sum(w.co2e_kg), 0), 0) from public.waste_records w
                 where w.restaurant_id = any (v_rids) and w.deleted_at is null
                   and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
                   and w.recorded_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')),
    'top_products', coalesce((select jsonb_agg(x order by (x ->> 'kg')::numeric desc) from (
        select jsonb_build_object('name', coalesce(case when p_lang = 'en' then p.name_en end, p.name, w.product_name),
                 'kg', round(sum(w.weight_kg), 1), 'value', round(sum(w.purchase_value), 0), 'records', count(*)) x
          from public.waste_records w left join public.products p on p.id = w.product_id
         where w.restaurant_id = any (v_rids) and w.deleted_at is null
           and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
           and w.recorded_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')
           and coalesce(p.name, w.product_name) is not null
         group by coalesce(case when p_lang = 'en' then p.name_en end, p.name, w.product_name)
         order by sum(w.weight_kg) desc limit 3) q), '[]'::jsonb),
    'top_reasons', coalesce((select jsonb_agg(jsonb_build_object('name', app.lbl(rs.labels, p_lang), 'pct', g.pct) order by g.kg desc)
        from (select w.reason_id id, sum(w.weight_kg) kg, round(sum(w.weight_kg) / nullif(sum(sum(w.weight_kg)) over (), 0) * 100, 0) pct
                from public.waste_records w
               where w.restaurant_id = any (v_rids) and w.deleted_at is null
                 and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
                 and w.recorded_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')
               group by 1 order by 2 desc limit 3) g join public.waste_reasons rs on rs.id = g.id), '[]'::jsonb),
    'by_restaurant', case when p_restaurant is null then coalesce((select jsonb_agg(jsonb_build_object('name', r.name,
                 'kg', (ws.s ->> 'kg')::numeric, 'records', (ws.s ->> 'records')::int, 'days', (ws.s ->> 'active_days')::int,
                 'g_per_guest', ws.s -> 'g_per_guest') order by (ws.s ->> 'kg')::numeric desc)
          from public.restaurants r
          cross join lateral (select app.window_stats(p_org, array[r.id], null, null, null, v_from, v_to) s) ws
         where r.id = any (v_rids)), '[]'::jsonb) end,
    'target', v_target,
    'interventions', coalesce((select jsonb_agg(jsonb_build_object('title', i.title, 'restaurant', r.name,
                 'effect', app.intervention_effect(i.id, 28, false) - 'before' - 'after' - 'weekly') order by i.start_date desc)
        from public.interventions i join public.restaurants r on r.id = i.restaurant_id
       where i.restaurant_id = any (v_rids) and i.deleted_at is null and i.status in ('planned', 'active')
         and i.start_date <= v_to and (i.end_date is null or i.end_date >= v_from)), '[]'::jsonb),
    'best_practices', coalesce((select jsonb_agg(jsonb_build_object('title', b.title, 'restaurant', r.name, 'result_change_pct', b.result_change_pct)
                 order by b.published_at desc)
        from public.best_practices b left join public.restaurants r on r.id = b.restaurant_id
       where b.organization_id = p_org and b.deleted_at is null and b.status = 'published'
         and b.published_at >= ((v_to - 13)::timestamp at time zone 'Europe/Amsterdam')
         and b.published_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')), '[]'::jsonb)
  );
end $$;

-- Preview in the app (only lists the user may manage)
create or replace function public.weekly_report_preview(p_id bigint, p_week date default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select app.weekly_report_data(s.organization_id, s.restaurant_id, coalesce(p_week, app.last_full_week()), s.language)
         || jsonb_build_object('subscription_id', s.id, 'recipients', s.recipients, 'language', s.language)
    from public.report_subscriptions s where s.id = p_id and s.deleted_at is null
$$;

-- For the sending job (service role only): lists due for last week, with their content
create or replace function public.weekly_reports_due()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.weekly_report_data(s.organization_id, s.restaurant_id, app.last_full_week(), s.language)
           || jsonb_build_object('subscription_id', s.id, 'recipients', s.recipients, 'language', s.language)), '[]'::jsonb)
    from public.report_subscriptions s
    join public.organizations o on o.id = s.organization_id and o.deleted_at is null
   where s.deleted_at is null and s.is_active and cardinality(s.recipients) > 0
     and (s.last_sent_week is null or s.last_sent_week < app.last_full_week())
     and (s.restaurant_id is null or exists (select 1 from public.restaurants r where r.id = s.restaurant_id and r.deleted_at is null))
$$;

create or replace function public.weekly_report_mark(p_id bigint, p_week date, p_status text)
returns void language sql volatile security definer set search_path = '' as $$
  update public.report_subscriptions
     set last_status = left(p_status, 300), last_sent_at = case when p_week is not null then now() else last_sent_at end,
         last_sent_week = coalesce(p_week, last_sent_week)
   where id = p_id
$$;

grant execute on function app.report_subscription_check() to authenticated;
grant execute on function app.can_see_intervention(bigint) to authenticated;
grant execute on function app.last_full_week() to authenticated;
grant execute on function app.weekly_report_data(bigint, bigint, date, text) to authenticated;
revoke execute on function public.weekly_report_preview(bigint, date) from public, anon;
grant execute on function public.weekly_report_preview(bigint, date) to authenticated;
revoke execute on function public.weekly_reports_due() from public, anon, authenticated;
revoke execute on function public.weekly_report_mark(bigint, date, text) from public, anon, authenticated;
grant execute on function public.weekly_reports_due() to service_role;
grant execute on function public.weekly_report_mark(bigint, date, text) to service_role;
