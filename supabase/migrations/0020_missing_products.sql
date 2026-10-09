-- 0020  Missing products: names that were typed in (or taken over from the AI) without a product from the list.
-- Settings › Products › Missing products lists them with how often and how much, so the list grows with what
-- the kitchens actually throw away. Read with the caller's own rights (managers see their restaurants).
create or replace function public.missing_products(p_org bigint default null, p_days int default 90)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x ->> 'records')::int desc, (x ->> 'kg')::numeric desc), '[]'::jsonb) from (
    select jsonb_build_object(
             'name', mode() within group (order by btrim(w.product_name)),
             'records', count(*), 'kg', round(sum(w.weight_kg), 2),
             'last', max(w.recorded_at),
             'waste_category_id', mode() within group (order by w.waste_category_id),
             'from_ai', count(*) filter (where w.ai_suggestion ->> 'product_name' = w.product_name) > 0,
             'restaurants', count(distinct w.restaurant_id)) x
      from public.waste_records w
     where w.organization_id = app.effective_org(p_org) and w.deleted_at is null and w.product_id is null
       and nullif(btrim(w.product_name), '') is not null
       and w.recorded_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 366)))
       and not exists (select 1 from public.products p where p.organization_id = w.organization_id and p.deleted_at is null
                        and (lower(p.name) = lower(btrim(w.product_name)) or lower(p.name_en) = lower(btrim(w.product_name))))
     group by lower(btrim(w.product_name))
     limit 200) q
$$;
revoke execute on function public.missing_products(bigint, int) from public, anon;
grant execute on function public.missing_products(bigint, int) to authenticated;

-- Link past registrations with this name to the product (managers, their own restaurants; RLS decides)
create or replace function public.link_missing_product(p_product bigint, p_name text, p_org bigint default null)
returns int language plpgsql volatile security invoker set search_path = '' as $$
declare n int;
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  update public.waste_records w set product_id = p_product
   where w.organization_id = app.effective_org(p_org) and w.deleted_at is null and w.product_id is null
     and lower(btrim(w.product_name)) = lower(btrim(p_name))
     and exists (select 1 from public.products p where p.id = p_product and p.organization_id = w.organization_id and p.deleted_at is null);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.link_missing_product(bigint, text, bigint) from public, anon;
grant execute on function public.link_missing_product(bigint, text, bigint) to authenticated;
