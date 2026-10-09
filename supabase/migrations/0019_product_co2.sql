-- 0019  CO2 per product from RIVM, and estimated prices marked as such.
-- Source: RIVM, Database milieubelasting voedingsmiddelen, version 23 September 2024 (cradle to distribution),
-- open data under CC BY 4.0: https://www.rivm.nl/voeding/duurzaam-voedsel/database-milieubelasting-voedingsmiddelen
-- A registration uses the product's own factor when it has one (and the category was not changed),
-- otherwise the category factor: the median of the RIVM values of the WASTE log products in that category.

alter table public.products
  add column if not exists co2e_per_kg numeric(8,3),
  add column if not exists co2e_source text,
  add column if not exists price_estimated boolean not null default false;

-- Registration: product factor first, category factor as fallback
do $do$
declare d text;
begin
  d := pg_get_functiondef('app.waste_before()'::regprocedure);
  if position('new.co2e_kg := round(v_co2 * new.weight_kg, 2);' in d) > 0 then
    d := replace(d, 'new.co2e_kg := round(v_co2 * new.weight_kg, 2);',
      'new.co2e_kg := round(coalesce((select p.co2e_per_kg from public.products p where p.id = new.product_id and p.waste_category_id = new.waste_category_id and p.co2e_per_kg > 0), v_co2) * new.weight_kg, 2);');
    execute d;
  elsif position('p.co2e_per_kg from public.products p' in d) = 0 then
    raise exception 'waste_before: pattern not found';
  end if;
end $do$;

-- Category factors and their source (platform defaults): median of the RIVM products in each category
update public.waste_categories set co2e_per_kg = x.f,
       co2e_source = 'RIVM, Database milieubelasting voedingsmiddelen (version 23 September 2024, cradle to distribution). '
                  || 'Category value: median of the RIVM values of the products in this category. Products with their own RIVM value use that value.',
       co2e_source_url = 'https://www.rivm.nl/voeding/duurzaam-voedsel/database-milieubelasting-voedingsmiddelen'
  from (values ('vegetables', 0.51), ('fruit', 0.33), ('meat', 8.22), ('fish', 3.51), ('dairy', 5.0), ('bread', 1.07),
               ('starch', 1.23), ('prepared', 2.25), ('other', 1.77)) x(code, f)
 where waste_categories.organization_id is null and waste_categories.code = x.code;

-- app_meta: products carry their CO2 factor and source (for the CO2 explanation of a registration)
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.app_meta(bigint, text)'::regprocedure);
  if position('''co2e_per_kg'', p.co2e_per_kg' in d) = 0 then
    if position('''is_quick_pick'', p.is_quick_pick)' in d) = 0 then raise exception 'app_meta: pattern not found'; end if;
    d := replace(d, '''is_quick_pick'', p.is_quick_pick)',
      '''is_quick_pick'', p.is_quick_pick, ''co2e_per_kg'', p.co2e_per_kg, ''co2e_source'', p.co2e_source)');
    execute d;
  end if;
end $do$;
