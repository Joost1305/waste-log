-- 0029  The hourly job leaves a heartbeat for the morning system check.
-- The job asks for the due weekly e-mails every run; that call now also records the time.
create or replace function public.weekly_reports_due()
returns jsonb language sql volatile security definer set search_path = '' as $$
  -- Heartbeat: the hourly job asks for this every run
  insert into public.job_runs (job, last_run_at) values ('hourly', now())
    on conflict (job) do update set last_run_at = excluded.last_run_at;
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

revoke execute on function public.weekly_reports_due() from public, anon, authenticated;
grant execute on function public.weekly_reports_due() to service_role;
