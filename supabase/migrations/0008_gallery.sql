-- 0008  Photo gallery: waste records with a photo, heaviest first (visual impact)
create or replace function public.gallery(
  p_org bigint default null, p_restaurant bigint default null, p_from date default null, p_to date default null,
  p_category bigint default null, p_limit int default 24, p_offset int default 0, p_lang text default 'nl')
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
  v_res jsonb;
begin
  if p_restaurant is not null and not (p_restaurant = any (app.restaurant_ids())) then
    raise exception 'Restaurant not found' using errcode = 'P0002';
  end if;
  with base as (
    select w.* from public.waste_records w
     where w.organization_id = v_org and w.deleted_at is null and w.photo_path is not null
       and (p_restaurant is null or w.restaurant_id = p_restaurant)
       and (p_from is null or w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam'))
       and (p_to is null or w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam'))
       and (p_category is null or w.waste_category_id = p_category)
  ), page as (
    select b.* from base b order by b.weight_kg desc, b.recorded_at desc
     limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'total_kg', (select coalesce(sum(weight_kg), 0) from base),
    'total_value', (select coalesce(sum(purchase_value), 0) from base),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', w.id, 'photo_path', w.photo_path, 'recorded_at', w.recorded_at, 'restaurant_name', r.name,
        'product_name', w.product_name, 'category', app.lbl(c.labels, p_lang), 'category_color', c.color,
        'reason', app.lbl(rs.labels, p_lang), 'weight_kg', w.weight_kg, 'weight_source', w.weight_source,
        'purchase_value', w.purchase_value, 'co2e_kg', w.co2e_kg, 'note', w.note, 'user_name', u.name)
        order by w.weight_kg desc, w.recorded_at desc)
      from page w
      join public.restaurants r on r.id = w.restaurant_id
      join public.waste_categories c on c.id = w.waste_category_id
      join public.waste_reasons rs on rs.id = w.reason_id
      left join public.users u on u.id = w.user_id), '[]'::jsonb)
  ) into v_res;
  return v_res;
end $$;

create index if not exists waste_photo_weight_idx on public.waste_records (organization_id, weight_kg desc)
  where photo_path is not null and deleted_at is null;

revoke execute on function public.gallery(bigint, bigint, date, date, bigint, int, int, text) from anon, public;
grant execute on function public.gallery(bigint, bigint, date, date, bigint, int, int, text) to authenticated;
