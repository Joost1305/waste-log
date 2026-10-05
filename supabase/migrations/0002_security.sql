-- 0002  Security: helper functions, Row Level Security, triggers, audit
--
-- Rules
-- - Every table has RLS on. Nothing is readable or writable without a matching policy.
-- - Tenant scope is derived from the signed-in user's profile (public.users), never from the client.
-- - Org admins see every restaurant of their organization; managers and employees only
--   restaurants assigned to them; employees only their own waste records.
-- - Users, roles and restaurant assignments are changed only by the admin-users edge function
--   (service role), which re-checks permissions.

-- ---------------------------------------------------------------
-- Helper functions (schema app, security definer to avoid RLS recursion)
-- ---------------------------------------------------------------
create or replace function app.role() returns text
language sql stable security definer set search_path = '' as $$
  select u.role from public.users u
   where u.id = auth.uid() and u.is_active and u.deleted_at is null
$$;

create or replace function app.rank() returns int
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.rank from public.users u join public.roles r on r.code = u.role
                    where u.id = auth.uid() and u.is_active and u.deleted_at is null), 0)
$$;

create or replace function app.org() returns bigint
language sql stable security definer set search_path = '' as $$
  select u.organization_id from public.users u
   where u.id = auth.uid() and u.is_active and u.deleted_at is null
$$;

create or replace function app.is_super() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(app.role() = 'super_admin', false)
$$;

-- Restaurants the current user may work with.
create or replace function app.restaurant_ids() returns bigint[]
language sql stable security definer set search_path = '' as $$
  select case
    when app.is_super() then
      array(select r.id from public.restaurants r where r.deleted_at is null)
    when app.rank() >= 50 then
      array(select r.id from public.restaurants r where r.organization_id = app.org() and r.deleted_at is null)
    when app.rank() > 0 then
      array(select r.id from public.user_restaurants ur join public.restaurants r on r.id = ur.restaurant_id
             where ur.user_id = auth.uid() and r.organization_id = app.org() and r.deleted_at is null)
    else '{}'::bigint[]
  end
$$;

create or replace function app.in_org(p_org bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.is_super() or (p_org is not null and p_org = app.org())
$$;

-- Organization an RPC works on: super admins may choose, everyone else gets their own.
create or replace function app.effective_org(p_org bigint) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when app.is_super()
    then coalesce(p_org, (select o.id from public.organizations o where o.deleted_at is null order by o.name limit 1))
    else app.org() end
$$;

-- Number of restaurants in an organization, regardless of the caller's scope (used to decide
-- whether an organization-wide target applies to what the caller sees).
create or replace function app.org_restaurant_count(p_org bigint) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.restaurants r where r.organization_id = p_org and r.deleted_at is null
$$;

create or replace function app.lbl(p jsonb, p_lang text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(p ->> p_lang, p ->> 'en', p ->> 'nl')
$$;

create or replace function app.local_date(p timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (p at time zone 'Europe/Amsterdam')::date
$$;

grant usage on schema app to authenticated;
grant execute on all functions in schema app to authenticated;

-- ---------------------------------------------------------------
-- Grants: anon gets nothing; authenticated gets table access, filtered by RLS
-- ---------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
grant select, insert, update on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
-- No hard deletes from the client (soft delete via deleted_at)
revoke delete on all tables in schema public from authenticated;
grant delete on public.daily_covers to authenticated;

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------
-- organizations
create policy org_select on public.organizations for select to authenticated
  using (app.in_org(id));
create policy org_update on public.organizations for update to authenticated
  using ((select app.rank()) >= 50 and app.in_org(id)) with check ((select app.rank()) >= 50 and app.in_org(id));
create policy org_insert on public.organizations for insert to authenticated
  with check ((select app.is_super()));

-- roles: readable reference data
create policy roles_select on public.roles for select to authenticated using (true);

-- restaurants
create policy rest_select on public.restaurants for select to authenticated
  using (id = any ((select app.restaurant_ids())::bigint[]) or ((select app.rank()) >= 50 and app.in_org(organization_id)));
create policy rest_insert on public.restaurants for insert to authenticated
  with check ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy rest_update on public.restaurants for update to authenticated
  using (((select app.rank()) >= 50 and app.in_org(organization_id))
         or ((select app.rank()) >= 30 and id = any ((select app.restaurant_ids())::bigint[])))
  with check (app.in_org(organization_id));

-- users: yourself; managers and admins see colleagues in their organization. Writes only via edge function.
create policy users_select on public.users for select to authenticated
  using (id = (select auth.uid()) or ((select app.rank()) >= 30 and app.in_org(organization_id)));
revoke insert, update on public.users from authenticated;

create policy ur_select on public.user_restaurants for select to authenticated
  using (user_id = (select auth.uid())
         or ((select app.rank()) >= 30 and restaurant_id in (select r.id from public.restaurants r where app.in_org(r.organization_id))));
revoke insert, update on public.user_restaurants from authenticated;

-- shared taxonomies: platform rows (organization_id null) + own organization's rows
do $$
declare t text;
begin
  foreach t in array array['waste_categories','categories','waste_reasons','best_practice_categories'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (organization_id is null or app.in_org(organization_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check ((select app.rank()) >= 50 and organization_id is not null and app.in_org(organization_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using ((select app.rank()) >= 50 and organization_id is not null and app.in_org(organization_id)) with check (organization_id is not null and app.in_org(organization_id))', t);
  end loop;
end $$;

-- organization-owned catalog: everyone in the org reads, managers+ write
do $$
declare t text;
begin
  foreach t in array array['suppliers','products','menu_items','framework_principles'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (app.in_org(organization_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check ((select app.rank()) >= 30 and app.in_org(organization_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using ((select app.rank()) >= 30 and app.in_org(organization_id)) with check (app.in_org(organization_id))', t);
  end loop;
end $$;

-- managers+ only: purchasing, improvement loop
do $$
declare t text;
begin
  foreach t in array array['invoices','invoice_items','interventions','best_practices'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using ((select app.rank()) >= 30 and app.in_org(organization_id))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check ((select app.rank()) >= 30 and app.in_org(organization_id))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using ((select app.rank()) >= 30 and app.in_org(organization_id)) with check (app.in_org(organization_id))', t);
  end loop;
end $$;

create policy ip_select on public.intervention_principles for select to authenticated
  using (exists (select 1 from public.interventions i where i.id = intervention_id and (select app.rank()) >= 30 and app.in_org(i.organization_id)));
create policy ip_write on public.intervention_principles for insert to authenticated
  with check (exists (select 1 from public.interventions i where i.id = intervention_id and (select app.rank()) >= 30 and app.in_org(i.organization_id)));

-- targets: managers read, org admins write
create policy targets_select on public.targets for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id));
create policy targets_insert on public.targets for insert to authenticated
  with check ((select app.rank()) >= 50 and app.in_org(organization_id)
              and (restaurant_id is null or restaurant_id = any ((select app.restaurant_ids())::bigint[])));
create policy targets_update on public.targets for update to authenticated
  using ((select app.rank()) >= 50 and app.in_org(organization_id)) with check (app.in_org(organization_id));

-- restaurant-level data: by restaurant scope
create policy covers_select on public.daily_covers for select to authenticated
  using (restaurant_id = any ((select app.restaurant_ids())::bigint[]));
create policy covers_insert on public.daily_covers for insert to authenticated
  with check ((select app.rank()) >= 30 and restaurant_id = any ((select app.restaurant_ids())::bigint[]));
create policy covers_update on public.daily_covers for update to authenticated
  using ((select app.rank()) >= 30 and restaurant_id = any ((select app.restaurant_ids())::bigint[]))
  with check (restaurant_id = any ((select app.restaurant_ids())::bigint[]));
create policy covers_delete on public.daily_covers for delete to authenticated
  using ((select app.rank()) >= 30 and restaurant_id = any ((select app.restaurant_ids())::bigint[]));

create policy mw_select on public.menu_waste for select to authenticated
  using (restaurant_id = any ((select app.restaurant_ids())::bigint[]));
create policy mw_insert on public.menu_waste for insert to authenticated
  with check ((select app.rank()) >= 30 and restaurant_id = any ((select app.restaurant_ids())::bigint[]));
create policy mw_update on public.menu_waste for update to authenticated
  using ((select app.rank()) >= 30 and restaurant_id = any ((select app.restaurant_ids())::bigint[]))
  with check (restaurant_id = any ((select app.restaurant_ids())::bigint[]));

create policy weather_select on public.weather_records for select to authenticated
  using (restaurant_id = any ((select app.restaurant_ids())::bigint[]));
revoke insert, update on public.weather_records from authenticated;

-- waste records
create policy waste_select on public.waste_records for select to authenticated
  using (restaurant_id = any ((select app.restaurant_ids())::bigint[])
         and ((select app.rank()) >= 30 or user_id = (select auth.uid())));
create policy waste_insert on public.waste_records for insert to authenticated
  with check (restaurant_id = any ((select app.restaurant_ids())::bigint[]) and user_id = (select auth.uid()));
create policy waste_update on public.waste_records for update to authenticated
  using (restaurant_id = any ((select app.restaurant_ids())::bigint[])
         and ((select app.rank()) >= 30
              or (user_id = (select auth.uid()) and app.local_date(created_at) = app.local_date(now()))))
  with check (restaurant_id = any ((select app.restaurant_ids())::bigint[]));

-- research (org admins)
create policy rp_all_select on public.research_projects for select to authenticated using ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy rp_all_insert on public.research_projects for insert to authenticated with check ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy rp_all_update on public.research_projects for update to authenticated using ((select app.rank()) >= 50 and app.in_org(organization_id)) with check (app.in_org(organization_id));
do $$
declare t text;
begin
  foreach t in array array['research_groups','research_participants'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (exists (select 1 from public.research_projects p where p.id = research_project_id and (select app.rank()) >= 50 and app.in_org(p.organization_id)))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (exists (select 1 from public.research_projects p where p.id = research_project_id and (select app.rank()) >= 50 and app.in_org(p.organization_id)))', t);
    execute format('create policy %1$s_update on public.%1$I for update to authenticated using (exists (select 1 from public.research_projects p where p.id = research_project_id and (select app.rank()) >= 50 and app.in_org(p.organization_id)))', t);
  end loop;
end $$;
create policy q_select on public.questionnaires for select to authenticated using ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy q_insert on public.questionnaires for insert to authenticated with check ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy q_update on public.questionnaires for update to authenticated using ((select app.rank()) >= 50 and app.in_org(organization_id)) with check (app.in_org(organization_id));
do $$
declare t text;
begin
  foreach t in array array['questionnaire_questions','questionnaire_responses'] loop
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (exists (select 1 from public.questionnaires q where q.id = questionnaire_id and (select app.rank()) >= 50 and app.in_org(q.organization_id)))', t);
    execute format('create policy %1$s_insert on public.%1$I for insert to authenticated with check (exists (select 1 from public.questionnaires q where q.id = questionnaire_id and (select app.rank()) >= 50 and app.in_org(q.organization_id)))', t);
  end loop;
end $$;
create policy impact_select on public.impact_reports for select to authenticated using ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy impact_insert on public.impact_reports for insert to authenticated with check ((select app.rank()) >= 50 and app.in_org(organization_id));

-- audit log: read by org admins, written only by triggers
create policy audit_select on public.audit_log for select to authenticated
  using ((select app.rank()) >= 50 and app.in_org(organization_id));
revoke insert, update on public.audit_log from authenticated;

-- ---------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- Fill organization_id with the user's organization when the client leaves it out.
create or replace function app.default_org() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.organization_id is null then new.organization_id := app.org(); end if;
  return new;
end $$;

-- Restaurant-level rows always take the organization of their restaurant.
create or replace function app.org_from_restaurant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  select r.organization_id into new.organization_id from public.restaurants r where r.id = new.restaurant_id;
  if new.organization_id is null then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
  return new;
end $$;

-- Audit: who changed what. Soft deletes are logged as "delete".
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  j jsonb := to_jsonb(new);
  v_action text := lower(tg_op);
  v_org bigint;
begin
  if tg_op = 'UPDATE' and (to_jsonb(old) ->> 'deleted_at') is null and (j ->> 'deleted_at') is not null then v_action := 'delete'; end if;
  if tg_op = 'INSERT' then v_action := 'create'; end if;
  v_org := case when tg_table_name = 'organizations' then (j ->> 'id')::bigint else (j ->> 'organization_id')::bigint end;
  insert into public.audit_log (organization_id, user_id, action, entity, entity_id, details)
  values (v_org, auth.uid(), v_action, tg_table_name, j ->> 'id',
          case tg_table_name
            when 'waste_records' then jsonb_build_object('kg', j -> 'weight_kg', 'restaurant_id', j -> 'restaurant_id')
            when 'users' then jsonb_build_object('email', j -> 'email', 'role', j -> 'role', 'is_active', j -> 'is_active')
            else jsonb_build_object('name', coalesce(j -> 'name', j -> 'title'))
          end);
  return new;
end $$;

do $$
declare t text;
begin
  for t in select c.table_name from information_schema.columns c
            where c.table_schema = 'public' and c.column_name = 'updated_at' loop
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function app.touch_updated_at()', t);
  end loop;
  foreach t in array array['suppliers','products','menu_items','invoices','targets','framework_principles','interventions',
                           'best_practices','research_projects','questionnaires','impact_reports'] loop
    execute format('create trigger default_org before insert on public.%I for each row execute function app.default_org()', t);
  end loop;
  foreach t in array array['daily_covers','menu_waste'] loop
    execute format('create trigger org_from_restaurant before insert or update on public.%I for each row execute function app.org_from_restaurant()', t);
  end loop;
  foreach t in array array['organizations','restaurants','users','suppliers','products','menu_items','targets','waste_records',
                           'daily_covers','interventions','best_practices','research_projects'] loop
    execute format('create trigger audit after insert or update on public.%I for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- Restaurants: organization defaults to the user's own.
create trigger default_org before insert on public.restaurants for each row execute function app.default_org();
