-- 0044  Page access per role: the organization admin ticks which pages each role sees in the menu.
-- Stored on the organization as { "employee": ["records", ...], "restaurant_manager": [...] }: the pages HIDDEN for that role.
-- Empty object = everyone sees what their rank allows (the old behaviour). Super admins are never restricted.
-- This hides pages; what a user may read is still decided by Row Level Security.
alter table public.organizations add column if not exists hidden_pages jsonb not null default '{}'::jsonb;

-- Postgres does not allow subqueries in a check constraint, so the shape check lives in a function.
create or replace function app.valid_hidden_pages(j jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(j) = 'object'
     and not exists (
       select 1 from jsonb_each(j) e
        where e.key not in ('employee', 'restaurant_manager')
           or jsonb_typeof(e.value) <> 'array'
           or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(e.value) = 'array' then e.value else '[]'::jsonb end) v
                       where v not in ('records', 'gallery', 'interventions', 'leaderboard', 'dashboard')))
$$;
grant execute on function app.valid_hidden_pages(jsonb) to authenticated;

do $do$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_hidden_pages_shape') then
    alter table public.organizations add constraint organizations_hidden_pages_shape check (app.valid_hidden_pages(hidden_pages));
  end if;
end $do$;

-- app_meta: the organization carries the full setting, and the top level carries the list for the signed-in user
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.app_meta(bigint, text)'::regprocedure);
  if position('''hidden_pages''' in d) = 0 then
    if position('''sales_enabled'', o.sales_enabled' in d) = 0 or position('''permissions'', jsonb_build_object(' in d) = 0 then
      raise exception 'app_meta: pattern not found';
    end if;
    d := replace(d, '''sales_enabled'', o.sales_enabled',
                    '''sales_enabled'', o.sales_enabled, ''hidden_pages'', o.hidden_pages');
    d := replace(d, '''permissions'', jsonb_build_object(',
      '''hidden_pages'', case when v_rank >= 100 then ''[]''::jsonb else coalesce((select o.hidden_pages -> u.role
                       from public.organizations o, public.users u where o.id = v_org and u.id = auth.uid()), ''[]''::jsonb) end,
    ''permissions'', jsonb_build_object(');
    execute d;
  end if;
end $do$;
