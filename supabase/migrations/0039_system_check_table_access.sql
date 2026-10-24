-- Morning check: every table in public must have RLS on, be reachable for
-- authenticated + service_role, and not be open to anon (not logged in).
-- From 30 Oct 2026 Supabase no longer grants new tables automatically.
create or replace function app.table_access_issues()
returns jsonb
language sql stable security definer
set search_path to ''
as $$
  with t as (
    select c.oid, c.relname as name, c.relrowsecurity as rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'p')
  ),
  issues as (
    select name, 'RLS off' as problem from t where not rls
    union all
    select name, 'no access for logged-in users (grant missing)' from t
     where not has_table_privilege('authenticated', oid, 'SELECT')
    union all
    select name, 'no access for service_role (grant missing)' from t
     where not has_table_privilege('service_role', oid, 'SELECT')
    union all
    select name, 'open to anon (not logged in)' from t
     where has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE')
  )
  select coalesce(jsonb_agg(jsonb_build_object('table', name, 'problem', problem) order by name), '[]'::jsonb)
    from issues
$$;
revoke all on function app.table_access_issues() from public, anon, authenticated;

create or replace function public.system_check_inputs(p_from timestamp with time zone, p_to timestamp with time zone)
returns jsonb
language sql stable security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'changes', app.important_changes(p_from, p_to),
    'changes_all', (select count(*) from public.audit_log a where a.created_at >= p_from and a.created_at < p_to),
    'gaps', app.system_gaps(),
    'weather_missing', app.weather_missing_today(),
    'hourly_last_run', (select last_run_at from public.job_runs where job = 'hourly'),
    'last_check', (select run_at from public.system_checks order by run_at desc limit 1),
    'table_access', app.table_access_issues())
$function$;
