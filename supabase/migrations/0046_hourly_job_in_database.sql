-- 0046: the hourly job is started by the database itself (pg_cron + pg_net) instead of only by GitHub.
--
-- Why: GitHub's scheduled workflows are best effort. On a quiet repository the hourly keepalive.yml
-- was started only every 6 to 8 hours, so the morning system check reported the hourly job as not
-- running (4 November 2026). pg_cron runs inside Postgres and keeps to the clock.
--
-- keepalive.yml stays as a backup: the daily function is idempotent, so an extra call does no harm.
--
-- Local tests (PGlite) do not have pg_cron or pg_net; there this migration does nothing.

do $migration$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice '0046: pg_cron / pg_net not available, hourly job not scheduled in the database';
    return;
  end if;

  create extension if not exists pg_net;
  create extension if not exists pg_cron;

  -- Replace an earlier version of the job if this migration is run again.
  perform cron.unschedule(jobid) from cron.job where jobname = 'waste-log-hourly';

  -- Minute 7 of every hour, same as keepalive.yml. The daily function needs no key
  -- (keepalive.yml calls it the same way).
  perform cron.schedule(
    'waste-log-hourly',
    '7 * * * *',
    $job$
      select net.http_post(
        url := 'https://melrcbypzdndyixevdqp.supabase.co/functions/v1/daily',
        headers := '{"Content-Type": "application/json"}'::jsonb,
        body := '{}'::jsonb,
        timeout_milliseconds := 60000
      );
    $job$
  );
end
$migration$;
