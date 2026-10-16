-- 0034  Inedible trim: peel, seeds, stalks and bones are registered (kg and CO2 count) but are not money
-- that could have been saved. A new reason "Inedible trim" marks them; reasons get an "avoidable" flag.
--   dashboard:  totals.unavoidable_kg / unavoidable_value, by_reason[].avoidable
--   weekly e-mail data: unavoidable { kg, value }
--   leaderboard: the improvement score only looks at avoidable kg (registering trim never costs points)
-- Also: when a supplier is deleted, products no longer point to it as their default supplier
-- (a deleted default supplier blocked saving a registration).

alter table public.waste_reasons add column if not exists avoidable boolean not null default true;

update public.waste_reasons set sort_order = sort_order + 1
 where organization_id is null and sort_order >= 4 and code <> 'inedible'
   and not exists (select 1 from public.waste_reasons x where x.code = 'inedible' and x.organization_id is null);
insert into public.waste_reasons (code, labels, sort_order, avoidable)
select 'inedible', '{"en":"Inedible trim (peel, seeds, bones)","nl":"Niet-eetbaar snijafval (schil, pitten, botten)"}'::jsonb, 4, false
 where not exists (select 1 from public.waste_reasons x where x.code = 'inedible' and x.organization_id is null);

create or replace function app.reason_avoidable(p_reason bigint) returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select r.avoidable from public.waste_reasons r where r.id = p_reason), true)
$$;
grant execute on function app.reason_avoidable(bigint) to authenticated;

do $$
declare src text; n text;
begin
  -- app_meta: reasons carry their avoidable flag
  src := pg_get_functiondef('public.app_meta(bigint, text)'::regprocedure);
  n := replace(src, $q$jsonb_build_object('id', w.id, 'code', w.code, 'label', app.lbl(w.labels, p_lang))$q$,
                    $q$jsonb_build_object('id', w.id, 'code', w.code, 'label', app.lbl(w.labels, p_lang), 'avoidable', w.avoidable)$q$);
  if n = src then raise exception 'app_meta: pattern not found'; end if;
  execute n;

  -- dashboard
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, $q$w.weight_kg, w.purchase_value, w.co2e_kg, w.potential_sales_value, (w.photo_path is not null) has_photo,$q$,
                    $q$w.weight_kg, w.purchase_value, w.co2e_kg, w.potential_sales_value, (w.photo_path is not null) has_photo,
         app.reason_avoidable(w.reason_id) avoidable,$q$);
  n := replace(n, $q$'outlets', (select count(distinct restaurant_id) from _w)),$q$,
                  $q$'outlets', (select count(distinct restaurant_id) from _w),
      'unavoidable_kg', (select round(coalesce(sum(weight_kg), 0), 2) from _w where not avoidable),
      'unavoidable_value', (select round(coalesce(sum(purchase_value), 0), 2) from _w where not avoidable)),$q$);
  n := replace(n, $q$jsonb_build_object('id', rs.id, 'name', app.lbl(rs.labels, p_lang),
               'kg'$q$, $q$jsonb_build_object('id', rs.id, 'name', app.lbl(rs.labels, p_lang), 'avoidable', rs.avoidable,
               'kg'$q$);
  if position('unavoidable_value' in n) = 0 or position('app.reason_avoidable(w.reason_id) avoidable' in n) = 0
     or position($q$'avoidable', rs.avoidable$q$ in n) = 0 then raise exception 'dashboard: pattern not found'; end if;
  execute n;

  -- leaderboard: improvement on avoidable kg only
  src := pg_get_functiondef('public.leaderboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, $q$select w.section_id, app.local_date(w.recorded_at) d, w.weight_kg,$q$,
                    $q$select w.section_id, app.local_date(w.recorded_at) d, case when app.reason_avoidable(w.reason_id) then w.weight_kg else 0 end weight_kg,$q$);
  n := replace(n, $q$select w.section_id, sum(w.weight_kg) kg from public.waste_records w$q$,
                  $q$select w.section_id, sum(case when app.reason_avoidable(w.reason_id) then w.weight_kg else 0 end) kg from public.waste_records w$q$);
  if (length(n) - length(replace(n, 'app.reason_avoidable', ''))) / length('app.reason_avoidable') <> 2 then
    raise exception 'leaderboard: pattern not found'; end if;
  execute n;

  -- weekly e-mail data
  src := pg_get_functiondef('app.weekly_report_data(bigint, bigint, date, text)'::regprocedure);
  n := replace(src, $q$'this_week', cur, 'previous_week', prev,$q$,
                    $q$'this_week', cur, 'previous_week', prev,
    'unavoidable', (select jsonb_build_object('kg', round(coalesce(sum(w.weight_kg), 0), 1), 'value', round(coalesce(sum(w.purchase_value), 0), 2))
                      from public.waste_records w join public.waste_reasons x on x.id = w.reason_id
                     where not x.avoidable and w.restaurant_id = any (v_rids) and w.deleted_at is null
                       and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam')
                       and w.recorded_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')),$q$);
  if n = src then raise exception 'weekly_report_data: pattern not found'; end if;
  execute n;
end $$;

-- A deleted supplier is no longer anyone's default supplier
create or replace function app.supplier_deleted() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    update public.products set default_supplier_id = null where default_supplier_id = new.id;
  end if;
  return new;
end $$;
create or replace trigger supplier_deleted after update of deleted_at on public.suppliers
  for each row execute function app.supplier_deleted();
update public.products p set default_supplier_id = null
  from public.suppliers s where s.id = p.default_supplier_id and s.deleted_at is not null;
