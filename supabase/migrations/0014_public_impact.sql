-- 0014  Public impact page: anyone with the link can see a restaurant's (or the organization's) waste trend,
-- without signing in. Only restaurants with "Public impact page" switched on are shown.
-- Shows kilos, kilos per guest, CO2, categories, reasons and target progress. Never prices, names of people or photos.
create or replace function public.public_impact(p_org_slug text, p_restaurant_slug text default null, p_lang text default 'en')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org   public.organizations%rowtype;
  v_rids  bigint[];
  v_today date := app.local_date(now());
  v_from30 date := v_today - 29;
  v_prev30 date := v_today - 59;
  v_from90 date := v_today - 89;
  v_target jsonb;
  v_tdays int;
  v_tcur numeric;
begin
  select * into v_org from public.organizations o where o.slug = p_org_slug and o.deleted_at is null;
  if not found then return null; end if;
  v_rids := array(select r.id from public.restaurants r
                   where r.organization_id = v_org.id and r.deleted_at is null and r.public_impact_enabled
                     and (p_restaurant_slug is null or r.slug = p_restaurant_slug));
  if cardinality(v_rids) = 0 then return null; end if;

  -- Target: the restaurant's own target on a restaurant page; the organization-wide target on the organization page
  select jsonb_build_object('name', tg.name, 'period', tg.period, 'baseline_kg', tg.baseline_kg, 'target_kg', tg.target_kg,
           'reduction_goal_pct', round((tg.baseline_kg - tg.target_kg) / tg.baseline_kg * 100, 1))
    into v_target
    from public.targets tg
   where tg.organization_id = v_org.id and tg.deleted_at is null and tg.start_date <= v_today and (tg.end_date is null or tg.end_date >= v_today)
     and ((p_restaurant_slug is not null and tg.restaurant_id = v_rids[1]) or (p_restaurant_slug is null and tg.restaurant_id is null))
   order by tg.start_date desc, tg.id desc limit 1;
  if v_target is not null then
    v_tdays := app.period_days(v_target ->> 'period');
    select coalesce(sum(w.weight_kg), 0) into v_tcur from public.waste_records w
     where w.restaurant_id = any (v_rids) and w.deleted_at is null
       and w.recorded_at >= ((v_today - (v_tdays - 1))::timestamp at time zone 'Europe/Amsterdam');
    v_target := v_target || jsonb_build_object('current_kg', round(v_tcur, 1), 'window_days', v_tdays,
      'progress_pct', greatest(0, least(100, round(((v_target ->> 'baseline_kg')::numeric - v_tcur)
                        / ((v_target ->> 'baseline_kg')::numeric - (v_target ->> 'target_kg')::numeric) * 100, 0))),
      'achieved', v_tcur <= (v_target ->> 'target_kg')::numeric);
  end if;

  return jsonb_build_object(
    'organization', v_org.name,
    'is_demo', v_org.is_demo,
    'scope', case when p_restaurant_slug is null then 'organization' else 'restaurant' end,
    'restaurants', (select jsonb_agg(jsonb_build_object('name', r.name, 'slug', r.slug, 'city', r.city) order by r.name)
                      from public.restaurants r where r.id = any (v_rids)),
    'updated', v_today,
    'last30', (select jsonb_build_object(
        'kg', round(coalesce(sum(w.weight_kg) filter (where w.recorded_at >= (v_from30::timestamp at time zone 'Europe/Amsterdam')), 0), 1),
        'co2e_kg', round(coalesce(sum(w.co2e_kg) filter (where w.recorded_at >= (v_from30::timestamp at time zone 'Europe/Amsterdam')), 0), 1),
        'records', count(*) filter (where w.recorded_at >= (v_from30::timestamp at time zone 'Europe/Amsterdam')),
        'prev_kg', round(coalesce(sum(w.weight_kg) filter (where w.recorded_at < (v_from30::timestamp at time zone 'Europe/Amsterdam')), 0), 1))
        from public.waste_records w
       where w.restaurant_id = any (v_rids) and w.deleted_at is null
         and w.recorded_at >= (v_prev30::timestamp at time zone 'Europe/Amsterdam')),
    'per_guest_30', (select case when sum(c.guests) > 0 then round(
        (select coalesce(sum(w.weight_kg), 0) from public.waste_records w
          join public.daily_covers c2 on c2.restaurant_id = w.restaurant_id and c2.date = app.local_date(w.recorded_at)
         where w.restaurant_id = any (v_rids) and w.deleted_at is null and app.local_date(w.recorded_at) >= v_from30) * 1000 / sum(c.guests), 0) end
        from public.daily_covers c where c.restaurant_id = any (v_rids) and c.date >= v_from30),
    'trend', coalesce((select jsonb_agg(jsonb_build_object('week', g.wk, 'kg', round(g.kg, 1),
                 'g_per_guest', case when cw.guests > 0 then round(g.kg_c * 1000 / cw.guests, 0) end) order by g.wk)
        from (select date_trunc('week', app.local_date(w.recorded_at))::date wk, sum(w.weight_kg) kg,
                     sum(w.weight_kg) filter (where exists (select 1 from public.daily_covers c
                        where c.restaurant_id = w.restaurant_id and c.date = app.local_date(w.recorded_at))) kg_c
                from public.waste_records w
               where w.restaurant_id = any (v_rids) and w.deleted_at is null
                 and w.recorded_at >= ((date_trunc('week', v_today)::date - 84)::timestamp at time zone 'Europe/Amsterdam')
                 and w.recorded_at < (date_trunc('week', v_today)::date::timestamp at time zone 'Europe/Amsterdam')
               group by 1) g
        left join (select date_trunc('week', c.date)::date wk, sum(c.guests) guests from public.daily_covers c
                    where c.restaurant_id = any (v_rids) group by 1) cw on cw.wk = g.wk), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('name', app.lbl(c.labels, p_lang), 'color', c.color,
                 'kg', round(g.kg, 1), 'pct', round(g.kg / nullif(g.total, 0) * 100, 0)) order by g.kg desc)
        from (select w.waste_category_id id, sum(w.weight_kg) kg, sum(sum(w.weight_kg)) over () total
                from public.waste_records w
               where w.restaurant_id = any (v_rids) and w.deleted_at is null and app.local_date(w.recorded_at) >= v_from90
               group by 1) g join public.waste_categories c on c.id = g.id), '[]'::jsonb),
    'reasons', coalesce((select jsonb_agg(jsonb_build_object('name', app.lbl(rs.labels, p_lang),
                 'pct', round(g.kg / nullif(g.total, 0) * 100, 0)) order by g.kg desc)
        from (select w.reason_id id, sum(w.weight_kg) kg, sum(sum(w.weight_kg)) over () total
                from public.waste_records w
               where w.restaurant_id = any (v_rids) and w.deleted_at is null and app.local_date(w.recorded_at) >= v_from90
               group by 1 order by 2 desc limit 5) g join public.waste_reasons rs on rs.id = g.id), '[]'::jsonb),
    'target', v_target,
    -- CO2 factors and their source, for the "how is CO2 calculated" explanation
    'co2_factors', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'label', app.lbl(c.labels, p_lang), 'color', c.color,
                 'co2e_per_kg', c.co2e_per_kg, 'co2e_source', c.co2e_source, 'co2e_source_url', c.co2e_source_url) order by c.sort_order)
        from public.waste_categories c where (c.organization_id is null or c.organization_id = v_org.id) and c.is_active), '[]'::jsonb)
  );
end $$;

revoke execute on function public.public_impact(text, text, text) from public;
grant execute on function public.public_impact(text, text, text) to anon, authenticated;

-- For the link in Settings: the organization's slug
create or replace function public.my_org_slug(p_org bigint default null)
returns text language sql stable security definer set search_path = '' as $$
  select o.slug from public.organizations o where o.id = app.effective_org(p_org) and app.rank() >= 30
$$;
revoke execute on function public.my_org_slug(bigint) from public, anon;
grant execute on function public.my_org_slug(bigint) to authenticated;
