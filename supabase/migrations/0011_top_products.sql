-- 0011  Automatic quick buttons: the products a restaurant registered most in the last N days.
-- Security definer so an employee (who only sees their own records) still gets the whole kitchen's top list.
-- Returns only product ids and counts, no personal data, and only for restaurants the caller may use.
create or replace function public.top_products(p_restaurant bigint, p_days int default 30, p_limit int default 12)
returns table (product_id bigint, n bigint)
language sql stable security definer set search_path = '' as $$
  select w.product_id, count(*) n
    from public.waste_records w
    join public.products p on p.id = w.product_id and p.is_active and p.deleted_at is null
   where p_restaurant = any (app.restaurant_ids())
     and w.restaurant_id = p_restaurant
     and w.deleted_at is null
     and w.product_id is not null
     and w.recorded_at >= now() - make_interval(days => least(greatest(p_days, 1), 365))
   group by w.product_id
   order by count(*) desc, max(w.recorded_at) desc
   limit least(greatest(p_limit, 1), 30)
$$;

revoke execute on function public.top_products(bigint, int, int) from anon, public;
grant execute on function public.top_products(bigint, int, int) to authenticated;
