-- 0047  Smart suggestions for "What is thrown away?": three likely products instead of a grid of twelve.
-- Looks at the last 60 days of this restaurant and scores each product by its registrations, where a registration
-- counts more when it was at the same moment of the day (breakfast / lunch / dinner, same split as the app),
-- on the same weekday, and recently (half-life about two weeks). Rules only, no AI: fast, free and explainable.
-- Security definer like top_products (0011): an employee only sees their own records but gets the kitchen's
-- suggestions. Returns product ids and a score only, and only for restaurants the caller may use.
create or replace function public.suggest_products(p_restaurant bigint, p_at timestamptz default now(), p_limit int default 3)
returns table (product_id bigint, score numeric)
language sql stable security definer set search_path = '' as $$
  with ctx as (
    select (p_at at time zone 'Europe/Amsterdam') as local_at
  ), slot as (
    select extract(isodow from local_at)::int as dow,
           case when (extract(hour from local_at) * 60 + extract(minute from local_at)) < 630 then 1
                when (extract(hour from local_at) * 60 + extract(minute from local_at)) < 840 then 2
                else 3 end as moment
      from ctx
  ), recs as (
    select w.product_id,
           (w.recorded_at at time zone 'Europe/Amsterdam') as local_at,
           extract(epoch from (p_at - w.recorded_at)) / 86400.0 as age_days
      from public.waste_records w
      join public.products p on p.id = w.product_id and p.is_active and p.deleted_at is null
     where p_restaurant = any (app.restaurant_ids())
       and w.restaurant_id = p_restaurant
       and w.deleted_at is null
       and w.product_id is not null
       and w.recorded_at <= p_at
       and w.recorded_at >= p_at - interval '60 days'
  )
  select r.product_id,
         round(sum(
           power(0.5, greatest(r.age_days, 0) / 14.0)
           * case when (case when (extract(hour from r.local_at) * 60 + extract(minute from r.local_at)) < 630 then 1
                             when (extract(hour from r.local_at) * 60 + extract(minute from r.local_at)) < 840 then 2
                             else 3 end) = sl.moment then 2.0 else 1.0 end
           * case when extract(isodow from r.local_at)::int = sl.dow then 1.5 else 1.0 end
         )::numeric, 3) as score
    from recs r cross join slot sl
   group by r.product_id
   order by score desc, r.product_id
   limit least(greatest(p_limit, 1), 12)
$$;

revoke execute on function public.suggest_products(bigint, timestamptz, int) from anon, public;
grant execute on function public.suggest_products(bigint, timestamptz, int) to authenticated;
