-- 0010  Last login and invitation status per user, for the Users list (org admins only).
-- Reads auth.users, which the app cannot read directly, so this is security definer with its own checks.
create or replace function public.user_logins(p_org bigint default null)
returns table (id uuid, last_sign_in_at timestamptz, invited_at timestamptz, confirmed boolean)
language sql stable security definer set search_path = '' as $$
  select u.id, a.last_sign_in_at, a.invited_at, (a.email_confirmed_at is not null) confirmed
    from public.users u
    join auth.users a on a.id = u.id
   where app.rank() >= 50
     and u.organization_id = app.effective_org(p_org)
     and u.deleted_at is null
$$;

revoke execute on function public.user_logins(bigint) from anon, public;
grant execute on function public.user_logins(bigint) to authenticated;
