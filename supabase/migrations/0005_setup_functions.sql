-- 0005  Setup functions for administrators (SQL editor / service role only, never callable from the app)

-- Create a login (Supabase Auth user + profile + restaurant assignment).
create or replace function app.create_login(
  p_email text, p_password text, p_name text, p_role text, p_org bigint, p_restaurants bigint[] default '{}',
  p_language text default 'nl', p_id uuid default gen_random_uuid())
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(p_email));
begin
  if length(p_password) < 8 then raise exception 'Password must be at least 8 characters'; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, email_change, email_change_token_new, recovery_token)
  values ('00000000-0000-0000-0000-000000000000', p_id, 'authenticated', 'authenticated', v_email,
          extensions.crypt(p_password, extensions.gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p_name), now(), now(), '', '', '', '');
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), p_id, p_id::text, jsonb_build_object('sub', p_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());
  insert into public.users (id, organization_id, role, email, name, language)
  values (p_id, case when p_role = 'super_admin' then null else p_org end, p_role, v_email, p_name, p_language);
  insert into public.user_restaurants (user_id, restaurant_id) select p_id, unnest(p_restaurants);
  return p_id;
end $$;

-- Clean start for a real organization: organization + first restaurant + first admin.
-- Example (SQL editor):
--   select app.bootstrap('Hotelschool The Hague', 'Amsterdam Restaurant', 'Amsterdam', 52.37, 4.90,
--                        'you@hotelschool.nl', 'a-long-password', 'Your Name');
create or replace function app.bootstrap(
  p_org_name text, p_restaurant_name text, p_city text, p_lat double precision, p_lon double precision,
  p_admin_email text, p_admin_password text, p_admin_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_org bigint; v_rest bigint; v_user uuid; v_slug text;
begin
  v_slug := trim(both '-' from regexp_replace(lower(p_org_name), '[^a-z0-9]+', '-', 'g'));
  insert into public.organizations (name, slug) values (p_org_name, v_slug) returning id into v_org;
  insert into public.restaurants (organization_id, name, slug, city, latitude, longitude)
  values (v_org, p_restaurant_name, trim(both '-' from regexp_replace(lower(p_restaurant_name), '[^a-z0-9]+', '-', 'g')), p_city, p_lat, p_lon)
  returning id into v_rest;
  v_user := app.create_login(p_admin_email, p_admin_password, p_admin_name, 'org_admin', v_org);
  return jsonb_build_object('organization_id', v_org, 'restaurant_id', v_rest, 'admin_user_id', v_user);
end $$;

revoke execute on function app.create_login(text, text, text, text, bigint, bigint[], text, uuid) from public, anon, authenticated;
revoke execute on function app.bootstrap(text, text, text, double precision, double precision, text, text, text) from public, anon, authenticated;
