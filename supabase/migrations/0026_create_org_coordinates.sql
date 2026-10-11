-- 0026  New organization: restaurants may carry coordinates (looked up from the place name in the form), for the weather.
do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.create_organization(jsonb)'::regprocedure);
  n := replace(src, 'insert into public.restaurants (organization_id, name, slug, city, timezone, open_days, public_impact_enabled, is_demo)',
                    'insert into public.restaurants (organization_id, name, slug, city, latitude, longitude, timezone, open_days, public_impact_enabled, is_demo)');
  n := replace(n, 'nullif(btrim(r ->> ''city''), ''''), ''Europe/Amsterdam'', v_days, false, false)',
                  'nullif(btrim(r ->> ''city''), ''''),
            case when (r ->> ''latitude'') ~ ''^-?[0-9.]+$'' and abs((r ->> ''latitude'')::numeric) <= 90 then (r ->> ''latitude'')::double precision end,
            case when (r ->> ''longitude'') ~ ''^-?[0-9.]+$'' and abs((r ->> ''longitude'')::numeric) <= 180 then (r ->> ''longitude'')::double precision end,
            ''Europe/Amsterdam'', v_days, false, false)');
  if position('latitude' in n) = 0 or position('r ->> ''longitude''' in n) = 0 then raise exception 'create_organization: pattern not found'; end if;
  execute n;
end $$;
