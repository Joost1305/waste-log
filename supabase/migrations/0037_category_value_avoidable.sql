-- 0037  Dashboard "By category": the euros only count avoidable waste (kilos and CO2 still include inedible trim).
do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, 'from (select waste_category_id id, sum(weight_kg) kg, sum(purchase_value) val, sum(co2e_kg) co2, count(*) n from _w group by 1) g',
                    'from (select waste_category_id id, sum(weight_kg) kg, sum(case when avoidable then purchase_value else 0 end) val, sum(co2e_kg) co2, count(*) n from _w group by 1) g');
  if n = src then raise exception 'dashboard: pattern not found'; end if;
  execute n;
end $$;
