-- 0036  "Most costly products" (dashboard) and "Thrown away most" (weekly e-mail) only list avoidable waste.
-- Inedible trim (peel, seeds, bones) is shown as one line under the table instead.
do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.dashboard(bigint, bigint, date, date, text)'::regprocedure);
  n := replace(src, 'where product_name is not null group by 1 order by 3 desc limit 10',
                    'where product_name is not null and avoidable group by 1 order by 3 desc limit 10');
  if n = src then raise exception 'dashboard: pattern not found'; end if;
  execute n;

  src := pg_get_functiondef('app.weekly_report_data(bigint, bigint, date, text)'::regprocedure);
  n := replace(src, $q$and coalesce(p.name, w.product_name) is not null
         group by$q$, $q$and coalesce(p.name, w.product_name) is not null and app.reason_avoidable(w.reason_id)
         group by$q$);
  if n = src then raise exception 'weekly_report_data: pattern not found'; end if;
  execute n;
end $$;
