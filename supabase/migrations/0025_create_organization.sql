-- 0025  New organization in one step (platform admin only): the organization, its restaurants with open days
-- and sections, and optionally a copy of another organization's product list (names, categories, prices,
-- CO2 per kg and sources) and suppliers. The first admin is invited afterwards through the admin-users function.
-- p: { name, default_language?, default_value_per_kg?, restaurants: [{ name, city?, open_days?, sections?: [text] }],
--      copy_products_from?, copy_suppliers? }
create or replace function public.create_organization(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_lang text := coalesce(nullif(p ->> 'default_language', ''), 'en');
  v_val  numeric := coalesce(nullif(p ->> 'default_value_per_kg', '')::numeric, 6.5);
  v_src  bigint := nullif(p ->> 'copy_products_from', '')::bigint;
  v_org  bigint; v_slug text; v_rest bigint;
  r jsonb; s text; v_days smallint[]; i int;
  v_rests int := 0; v_secs int := 0; v_prods int := 0; v_sups int := 0;
begin
  if not app.is_super() then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_name = '' or length(v_name) > 120 then raise exception 'Name is required' using errcode = '22023'; end if;
  if exists (select 1 from public.organizations o where lower(o.name) = lower(v_name) and o.deleted_at is null) then
    raise exception 'An organization with this name already exists' using errcode = '23505'; end if;
  if v_lang not in ('en', 'nl') then v_lang := 'en'; end if;
  if v_val <= 0 or v_val > 1000 then raise exception 'Default value per kg is not plausible' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p -> 'restaurants', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p -> 'restaurants', '[]'::jsonb)) = 0 then
    raise exception 'Add at least one restaurant' using errcode = '22023'; end if;
  if v_src is not null and not exists (select 1 from public.organizations o where o.id = v_src and o.deleted_at is null) then
    raise exception 'Unknown organization to copy from' using errcode = '22023'; end if;

  v_slug := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  if v_slug = '' then v_slug := 'org'; end if;
  i := 1;
  while exists (select 1 from public.organizations o where o.slug = v_slug || case when i = 1 then '' else '-' || i end) loop i := i + 1; end loop;
  v_slug := v_slug || case when i = 1 then '' else '-' || i end;

  insert into public.organizations (name, slug, default_language, default_value_per_kg, is_demo, leaderboard_enabled)
  values (v_name, v_slug, v_lang, v_val, false, false) returning id into v_org;

  for r in select * from jsonb_array_elements(p -> 'restaurants') loop
    continue when nullif(btrim(r ->> 'name'), '') is null;
    select coalesce(array_agg(distinct x::smallint order by x::smallint), '{1,2,3,4,5,6,7}')
      into v_days from jsonb_array_elements_text(coalesce(r -> 'open_days', '[1,2,3,4,5,6,7]'::jsonb)) x
     where x ~ '^[1-7]$';
    if cardinality(v_days) = 0 then v_days := '{1,2,3,4,5,6,7}'; end if;
    insert into public.restaurants (organization_id, name, slug, city, timezone, open_days, public_impact_enabled, is_demo)
    values (v_org, left(btrim(r ->> 'name'), 120),
            trim(both '-' from regexp_replace(lower(btrim(r ->> 'name')), '[^a-z0-9]+', '-', 'g')) || '-' || substr(md5(random()::text), 1, 4),
            nullif(btrim(r ->> 'city'), ''), 'Europe/Amsterdam', v_days, false, false)
    returning id into v_rest;
    v_rests := v_rests + 1;
    i := 0;
    for s in select btrim(x) from jsonb_array_elements_text(coalesce(r -> 'sections', '[]'::jsonb)) x where btrim(x) <> '' loop
      i := i + 1;
      insert into public.sections (organization_id, restaurant_id, name, sort_order, is_active) values (v_org, v_rest, left(s, 60), i, true);
      v_secs := v_secs + 1;
    end loop;
  end loop;
  if v_rests = 0 then raise exception 'Add at least one restaurant' using errcode = '22023'; end if;

  if v_src is not null then
    if coalesce((p ->> 'copy_suppliers')::boolean, false) then
      insert into public.suppliers (organization_id, name, contact, is_demo)
      select v_org, s.name, s.contact, false from public.suppliers s where s.organization_id = v_src and s.deleted_at is null;
      get diagnostics v_sups = row_count;
    end if;
    insert into public.products (organization_id, name, name_en, labels, waste_category_id, purchase_price_per_kg, sales_price_per_kg,
                                 is_quick_pick, is_active, is_demo, co2e_per_kg, co2e_source, price_estimated, default_supplier_id)
    select v_org, pr.name, pr.name_en, pr.labels, pr.waste_category_id, pr.purchase_price_per_kg, pr.sales_price_per_kg,
           pr.is_quick_pick, true, false, pr.co2e_per_kg, pr.co2e_source, pr.price_estimated,
           (select s2.id from public.suppliers s1 join public.suppliers s2 on s2.organization_id = v_org and s2.deleted_at is null and lower(s2.name) = lower(s1.name)
             where s1.id = pr.default_supplier_id limit 1)
      from public.products pr
     where pr.organization_id = v_src and pr.deleted_at is null and pr.is_active;
    get diagnostics v_prods = row_count;
  end if;

  return jsonb_build_object('id', v_org, 'slug', v_slug, 'restaurants', v_rests, 'sections', v_secs, 'products', v_prods, 'suppliers', v_sups,
                            'restaurant_ids', (select jsonb_agg(x.id order by x.id) from public.restaurants x where x.organization_id = v_org));
end $$;
revoke execute on function public.create_organization(jsonb) from public, anon;
grant execute on function public.create_organization(jsonb) to authenticated;
