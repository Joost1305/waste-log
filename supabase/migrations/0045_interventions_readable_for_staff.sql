-- 0045  Everyone in the organization (students too) can read the organization's interventions and their effect.
-- Kitchen staff learn from what their kitchens tried; writing stays with managers (insert/update policies unchanged).
-- interventions_list: can_edit now also needs manager rank, so a student assigned to a restaurant gets a read-only list.
alter policy interventions_select on public.interventions
  using ((select app.rank()) >= 10 and (organization_id = (select app.org()) or (select app.is_super())));

do $do$
declare src text; n text;
begin
  src := pg_get_functiondef('public.interventions_list(bigint, text)'::regprocedure);
  n := replace(src, $q$'can_edit', i.restaurant_id = any (app.restaurant_ids()),$q$,
                    $q$'can_edit', app.rank() >= 30 and i.restaurant_id = any (app.restaurant_ids()),$q$);
  if n = src then raise exception 'interventions_list: pattern not found'; end if;
  execute n;
end $do$;
