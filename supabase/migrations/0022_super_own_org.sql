-- 0022  A super admin without an explicit organization works in their own organization first
-- (before: the first organization by name).
create or replace function app.effective_org(p_org bigint)
returns bigint language sql stable security definer set search_path = '' as $$
  select case when app.is_super()
    then coalesce(p_org,
                  (select u.organization_id from public.users u join public.organizations o on o.id = u.organization_id
                    where u.id = auth.uid() and o.deleted_at is null),
                  (select o.id from public.organizations o where o.deleted_at is null order by o.name limit 1))
    else app.org() end
$$;
