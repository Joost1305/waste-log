-- 0023  Dashboard: waste per section (e.g. the food court counters). Only restaurants that have sections;
-- registrations there without a section are shown as one "no section" row (section_id null).
do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, 'select w.restaurant_id, w.waste_category_id, w.reason_id,', 'select w.restaurant_id, w.section_id, w.waste_category_id, w.reason_id,');
  n := replace(n, $q$    'by_supplier', coalesce(($q$, $q$    'by_section', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.sid, 'name', s.name, 'restaurant_id', g.rid, 'restaurant', r.name,
               'kg', round(g.kg, 2), 'value', round(g.val, 2), 'records', g.n,
               'share_pct', case when t.kg > 0 then round(g.kg / t.kg * 100, 1) end) order by g.sid is null, g.kg desc)
        from (select w.restaurant_id rid, w.section_id sid, sum(w.weight_kg) kg, sum(w.purchase_value) val, count(*) n
                from _w w
               where exists (select 1 from public.sections x where x.restaurant_id = w.restaurant_id and x.deleted_at is null)
               group by 1, 2) g
        join public.restaurants r on r.id = g.rid
        left join public.sections s on s.id = g.sid), '[]'),
    'by_supplier', coalesce(($q$);
  if position('w.section_id' in n) = 0 or position('by_section' in n) = 0 then raise exception 'dashboard: pattern not found'; end if;
  execute n;
end $$;
