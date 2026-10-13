-- 0030  Gallery: filter on estimated weights (AI, from the photo) versus measured ones (typed in or scale).
drop function if exists public.gallery(bigint, bigint, date, date, bigint, int, int, text, text);
create or replace function public.gallery(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null,
  p_category bigint default null, p_limit int default 24, p_offset int default 0, p_lang text default 'nl',
  p_sort text default 'heaviest', p_weight text default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
  v_sort text := case when p_sort in ('heaviest', 'lightest', 'category', 'newest') then p_sort else 'heaviest' end;
  v_res jsonb;
begin
  if p_restaurant is not null and not (p_restaurant = any (app.restaurant_ids())) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  with base as (
    select w.*, c.sort_order cat_order from public.waste_records w
      join public.waste_categories c on c.id = w.waste_category_id
     where w.organization_id = v_org and w.deleted_at is null and w.photo_path is not null
       and (p_restaurant is null or w.restaurant_id = p_restaurant)
       and (p_from is null or w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam'))
       and (p_to is null or w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam'))
       and (p_category is null or w.waste_category_id = p_category)
       -- 'estimate' = weight estimated by the AI from the photo; 'measured' = typed in or read from the scale
       and (p_weight is null or (p_weight = 'estimate' and w.weight_source = 'estimate')
            or (p_weight = 'measured' and w.weight_source is distinct from 'estimate'))
  ), ranked as (
    select b.*, row_number() over (order by
        case when v_sort = 'category' then b.cat_order end,
        case when v_sort = 'category' then b.waste_category_id end,
        case when v_sort in ('heaviest', 'category') then b.weight_kg end desc,
        case when v_sort = 'lightest' then b.weight_kg end asc,
        b.recorded_at desc, b.id desc) rn
      from base b
  ), page as (
    select * from ranked where rn > greatest(p_offset, 0) and rn <= greatest(p_offset, 0) + least(greatest(p_limit, 1), 100)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'total_kg', (select coalesce(sum(weight_kg), 0) from base),
    'total_value', (select coalesce(sum(purchase_value), 0) from base),
    'sort', v_sort,
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'photo_path', w.photo_path, 'recorded_at', w.recorded_at, 'restaurant_name', r.name,
        'product_name', coalesce(case when p_lang = 'en' then pr.name_en end, w.product_name), 'waste_category_id', w.waste_category_id,
        'category', app.lbl(c.labels, p_lang), 'category_color', c.color,
        'reason', app.lbl(rs.labels, p_lang), 'weight_kg', w.weight_kg, 'weight_source', w.weight_source,
        'purchase_value', w.purchase_value, 'co2e_kg', w.co2e_kg, 'note', w.note, 'user_name', u.name,
        'user_id', w.user_id, 'created_at', w.created_at)
        order by w.rn)
      from page w
      left join public.products pr on pr.id = w.product_id
      join public.restaurants r on r.id = w.restaurant_id
      join public.waste_categories c on c.id = w.waste_category_id
      join public.waste_reasons rs on rs.id = w.reason_id
      left join public.users u on u.id = w.user_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;
revoke execute on function public.gallery(bigint, bigint, date, date, bigint, int, int, text, text, text) from anon, public;
grant execute on function public.gallery(bigint, bigint, date, date, bigint, int, int, text, text, text) to authenticated;
