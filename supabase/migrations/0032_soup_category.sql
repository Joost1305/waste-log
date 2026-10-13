-- 0032  Soup as its own waste category (it was part of "Prepared food").
-- Appears everywhere categories are used: registering, dashboard, interventions, gallery, exports, AI.
-- CO2: same method as the other categories (0019): the median of the RIVM values of the products in the
-- category. The product "Soep" (RIVM: clear soups with meat and vegetables, meal soup with pulses and meat)
-- is the only one, so its value is the category value.
insert into public.waste_categories (organization_id, code, labels, co2e_per_kg, color, sort_order, co2e_source, co2e_source_url)
select null, 'soup', '{"en":"Soup","nl":"Soep"}'::jsonb, 2.66, '#0f8f8f', 8,
       'RIVM, Database milieubelasting voedingsmiddelen (version 23 September 2024, cradle to distribution). '
       || 'Category value: median of the RIVM values of the products in this category (soups with meat and vegetables, meal soup). Products with their own RIVM value use that value.',
       'https://www.rivm.nl/voeding/duurzaam-voedsel/database-milieubelasting-voedingsmiddelen'
 where not exists (select 1 from public.waste_categories where organization_id is null and code = 'soup');

-- "Other" stays last
update public.waste_categories set sort_order = 9 where organization_id is null and code = 'other' and sort_order < 9;

-- Soup products move to the new category, and so do their registrations (CO2 is recalculated by the trigger)
update public.products p set waste_category_id = (select id from public.waste_categories where organization_id is null and code = 'soup')
 where p.deleted_at is null and lower(p.name) in ('soep', 'soup')
   and p.waste_category_id = (select id from public.waste_categories where organization_id is null and code = 'prepared');
update public.waste_records w set waste_category_id = p.waste_category_id
  from public.products p
 where p.id = w.product_id and lower(p.name) in ('soep', 'soup') and w.waste_category_id <> p.waste_category_id;
