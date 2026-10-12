-- 0027  Weekly e-mail schedule per list.
-- Settings › Weekly e-mail: tick the days of the week and the hour, or switch to a calendar and
-- pick the exact dates (the calendar then replaces the weekly days). Each e-mail covers the
-- 7 days before the send day; on a Monday that is exactly last week, Monday to Sunday.
-- The sending job now runs every hour and sends each list at most once per day.

alter table public.report_subscriptions
  add column if not exists schedule_mode text not null default 'weekly' check (schedule_mode in ('weekly', 'dates')),
  add column if not exists send_days smallint[] not null default '{1}',
  add column if not exists send_hour smallint not null default 7 check (send_hour between 0 and 23),
  add column if not exists send_dates date[] not null default '{}',
  add column if not exists last_sent_on date;

-- Lists that already went out keep their history: the day they were last sent
update public.report_subscriptions
   set last_sent_on = app.local_date(last_sent_at)
 where last_sent_on is null and last_sent_week is not null and last_sent_at is not null;

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
  -- Schedule: days of the week (1 = Monday ... 7 = Sunday) or a list of dates, plus the hour (Amsterdam time)
  new.send_days := coalesce(array(select distinct d from unnest(new.send_days) d where d between 1 and 7 order by 1), '{}');
  new.send_dates := coalesce(array(select distinct d from unnest(new.send_dates) d where d is not null order by 1), '{}');
  if new.schedule_mode = 'weekly' and cardinality(new.send_days) = 0 then
    raise exception 'Choose at least one day' using errcode = '22023';
  end if;
  if cardinality(new.send_dates) > 200 then raise exception 'At most 200 dates' using errcode = '22023'; end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;

-- Report content for the 7 days starting p_week
create or replace function app.weekly_report_data(p_org bigint, p_restaurant bigint, p_week date, p_lang text default 'en')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  -- p_week is the first day of the 7 days the e-mail covers (a Monday for the classic weekly e-mail)
  v_from date := p_week;
  v_to   date := p_week + 6;
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
    'week_from', v_from, 'week_to', v_to, 'week_number', extract(week from v_to)::int,
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

-- The 7 days before today (Amsterdam time): the period an e-mail sent today covers
create or replace function app.report_window_start() returns date
language sql stable set search_path = '' as $$
  select app.local_date(now()) - 7
$$;

-- Preview in the app: what an e-mail sent today would contain
create or replace function public.weekly_report_preview(p_id bigint, p_week date default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select app.weekly_report_data(s.organization_id, s.restaurant_id, coalesce(p_week, app.report_window_start()), s.language)
         || jsonb_build_object('subscription_id', s.id, 'recipients', s.recipients, 'language', s.language)
    from public.report_subscriptions s where s.id = p_id and s.deleted_at is null
$$;

-- For the sending job (service role only): lists whose send moment has come today and that were not sent today
create or replace function public.weekly_reports_due()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(app.weekly_report_data(s.organization_id, s.restaurant_id, app.report_window_start(), s.language)
           || jsonb_build_object('subscription_id', s.id, 'recipients', s.recipients, 'language', s.language)), '[]'::jsonb)
    from public.report_subscriptions s
    join public.organizations o on o.id = s.organization_id and o.deleted_at is null
   cross join lateral (select now() at time zone 'Europe/Amsterdam' as t) n
   where s.deleted_at is null and s.is_active and cardinality(s.recipients) > 0
     and (s.last_sent_on is null or s.last_sent_on < n.t::date)
     and extract(hour from n.t) >= s.send_hour
     and case when s.schedule_mode = 'dates' then n.t::date = any (s.send_dates)
              else extract(isodow from n.t)::smallint = any (s.send_days) end
     and (s.restaurant_id is null or exists (select 1 from public.restaurants r where r.id = s.restaurant_id and r.deleted_at is null))
$$;

-- After sending: remember the day (one e-mail per list per day)
create or replace function public.weekly_report_mark(p_id bigint, p_week date, p_status text)
returns void language sql volatile security definer set search_path = '' as $$
  update public.report_subscriptions
     set last_status = left(p_status, 300), last_sent_at = case when p_week is not null then now() else last_sent_at end,
         last_sent_week = coalesce(p_week, last_sent_week),
         last_sent_on = case when p_week is not null then app.local_date(now()) else last_sent_on end
   where id = p_id
$$;

grant execute on function app.report_window_start() to authenticated;
grant execute on function app.weekly_report_data(bigint, bigint, date, text) to authenticated;
revoke execute on function public.weekly_reports_due() from public, anon, authenticated;
revoke execute on function public.weekly_report_mark(bigint, date, text) from public, anon, authenticated;
grant execute on function public.weekly_reports_due() to service_role;
grant execute on function public.weekly_report_mark(bigint, date, text) to service_role;
