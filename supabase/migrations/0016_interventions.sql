-- 0016  Interventions with before/after effect, and a best-practice library with attachments.
-- An intervention is a change a restaurant makes (smaller soup batches, new portion size, a staff briefing).
-- The app measures its effect from the waste records: the same number of days before and after the start date,
-- per guest when guest counts exist, otherwise per day, and compared with the organization's other restaurants
-- in the same weeks (so a quiet holiday week does not look like a success).
-- A best practice is a short story (problem, solution, result) that every user in the organization can read,
-- with an optional photo or PDF.

-- ---------------------------------------------------------------- best practices: attachment
alter table public.best_practices
  add column if not exists attachment_path text,
  add column if not exists attachment_name text,
  add column if not exists attachment_type text;

-- Publishing stamps who published and when
create or replace function app.bp_publish() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'published' and (tg_op = 'INSERT' or old.status is distinct from 'published') then
    new.published_at := coalesce(new.published_at, now());
    new.approved_by := coalesce(new.approved_by, auth.uid());
  end if;
  if tg_op = 'INSERT' then new.author_user_id := coalesce(new.author_user_id, auth.uid()); end if;
  return new;
end $$;
create or replace trigger bp_publish before insert or update on public.best_practices for each row execute function app.bp_publish();

-- interventions: created_by
create or replace function app.set_created_by() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;
create or replace trigger set_created_by before insert on public.interventions for each row execute function app.set_created_by();

-- ---------------------------------------------------------------- permissions
-- Managers write only for their own restaurants; organization-wide best practices need an org admin.
-- Everyone in the organization (students too) can read published best practices.
alter policy interventions_insert on public.interventions
  with check ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
alter policy interventions_update on public.interventions
  using ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()))
  with check (app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));

alter policy best_practices_insert on public.best_practices
  with check ((select app.rank()) >= 30 and app.in_org(organization_id)
              and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)));
alter policy best_practices_update on public.best_practices
  using ((select app.rank()) >= 30 and app.in_org(organization_id)
         and (restaurant_id = any (app.restaurant_ids()) or (restaurant_id is null and (select app.rank()) >= 50)))
  with check (app.in_org(organization_id));
create policy best_practices_select_published on public.best_practices for select to authenticated
  using (status = 'published' and deleted_at is null and app.in_org(organization_id));

-- ---------------------------------------------------------------- attachments (photo or PDF)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy documents_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and app.rank() >= 30 and (
    (storage.foldername(objects.name))[1] = 'org-' || (app.org())::text
    or (app.is_super() and exists (select 1 from public.organizations o
         where o.deleted_at is null and 'org-' || o.id::text = (storage.foldername(objects.name))[1]))));
create policy documents_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and ((storage.foldername(objects.name))[1] = 'org-' || (app.org())::text or app.is_super()));

-- ---------------------------------------------------------------- effect calculation
-- Waste in one window for a set of restaurants, within the intervention's focus (category, reason, dish).
create or replace function app.window_stats(p_org bigint, p_rids bigint[], p_cat bigint, p_reason bigint, p_menu bigint,
                                            p_from date, p_to date)
returns jsonb language sql stable security definer set search_path = '' as $$
  with w as (
    select app.local_date(w.recorded_at) d, w.restaurant_id, w.weight_kg kg, w.purchase_value val
      from public.waste_records w
     where w.organization_id = p_org and w.restaurant_id = any (p_rids) and w.deleted_at is null
       and w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam')
       and w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam')
       and (p_cat is null or w.waste_category_id = p_cat)
       and (p_reason is null or w.reason_id = p_reason)
       and (p_menu is null or w.menu_item_id = p_menu)),
  c as (
    select c.restaurant_id, c.date, c.guests from public.daily_covers c
     where c.restaurant_id = any (p_rids) and c.date between p_from and p_to and c.guests > 0)
  select jsonb_build_object(
    'from', p_from, 'to', p_to, 'days', p_to - p_from + 1,
    'kg', round(coalesce((select sum(kg) from w), 0), 2),
    'value', round(coalesce((select sum(val) from w), 0), 2),
    'records', (select count(*) from w),
    'active_days', (select count(distinct d) from w),
    'kg_per_day', round(coalesce((select sum(kg) from w), 0) / (p_to - p_from + 1), 3),
    'guests', coalesce((select sum(guests) from c), 0),
    'g_per_guest', (select case when sum(c.guests) > 0 then round(
        coalesce((select sum(w.kg) from w join c c2 on c2.restaurant_id = w.restaurant_id and c2.date = w.d), 0) * 1000 / sum(c.guests), 1) end
        from c))
$$;

create or replace function app.intervention_effect(p_id bigint, p_days int default 28, p_weekly boolean default true)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  i       public.interventions%rowtype;
  v_today date := app.local_date(now());
  v_days  int := greatest(7, least(coalesce(p_days, 28), 90));
  a_from date; a_to date; b_from date; b_to date;
  v_ctrl  bigint[];
  b jsonb; a jsonb; cb jsonb; ca jsonb;
  v_metric text; v_change numeric; v_ctrl_change numeric; v_day_change numeric; v_guest_change numeric;
  v_saved numeric; v_weekly jsonb; v_status text;
begin
  select * into i from public.interventions x where x.id = p_id and x.deleted_at is null;
  if not found or not app.can_see_intervention(i.organization_id) then return null; end if;

  a_from := i.start_date;
  a_to := least(coalesce(i.end_date, v_today), v_today, a_from + v_days - 1);
  b_to := a_from - 1;
  b_from := a_from - v_days;
  v_status := case when a_from > v_today then 'planned' when a_to - a_from + 1 < 7 then 'too_early' else 'ok' end;

  b := app.window_stats(i.organization_id, array[i.restaurant_id], i.scope_waste_category_id, i.scope_reason_id, i.scope_menu_item_id, b_from, b_to);
  if v_status <> 'planned' then
    a := app.window_stats(i.organization_id, array[i.restaurant_id], i.scope_waste_category_id, i.scope_reason_id, i.scope_menu_item_id, a_from, a_to);
  end if;

  if v_status = 'ok' then
    v_day_change := case when (b ->> 'kg_per_day')::numeric > 0
      then round(((a ->> 'kg_per_day')::numeric - (b ->> 'kg_per_day')::numeric) / (b ->> 'kg_per_day')::numeric * 100, 1) end;
    v_guest_change := case when (b ->> 'g_per_guest') is not null and (a ->> 'g_per_guest') is not null and (b ->> 'g_per_guest')::numeric > 0
      then round(((a ->> 'g_per_guest')::numeric - (b ->> 'g_per_guest')::numeric) / (b ->> 'g_per_guest')::numeric * 100, 1) end;
    -- Per guest is fairer (busy weeks make more waste); per day when guest counts are missing
    v_metric := case when v_guest_change is not null then 'per_guest' else 'per_day' end;
    v_change := coalesce(v_guest_change, v_day_change);
    v_saved := round(((b ->> 'kg_per_day')::numeric - (a ->> 'kg_per_day')::numeric) * (a ->> 'days')::int, 1);

    -- Comparison group: the organization's other restaurants, same weeks, same focus
    v_ctrl := array(select r.id from public.restaurants r
                     where r.organization_id = i.organization_id and r.id <> i.restaurant_id and r.deleted_at is null);
    if cardinality(v_ctrl) > 0 then
      cb := app.window_stats(i.organization_id, v_ctrl, i.scope_waste_category_id, i.scope_reason_id, i.scope_menu_item_id, b_from, b_to);
      ca := app.window_stats(i.organization_id, v_ctrl, i.scope_waste_category_id, i.scope_reason_id, i.scope_menu_item_id, a_from, a_to);
      v_ctrl_change := case
        when v_metric = 'per_guest' and (cb ->> 'g_per_guest') is not null and (ca ->> 'g_per_guest') is not null and (cb ->> 'g_per_guest')::numeric > 0
          then round(((ca ->> 'g_per_guest')::numeric - (cb ->> 'g_per_guest')::numeric) / (cb ->> 'g_per_guest')::numeric * 100, 1)
        when (cb ->> 'kg_per_day')::numeric > 0
          then round(((ca ->> 'kg_per_day')::numeric - (cb ->> 'kg_per_day')::numeric) / (cb ->> 'kg_per_day')::numeric * 100, 1) end;
    end if;
  end if;

  if p_weekly then
    select coalesce(jsonb_agg(jsonb_build_object(
             'week', g.wk, 'phase', case when g.wk + 6 < a_from then 'before' when g.wk >= a_from then 'after' else 'start' end,
             'days', least(g.wk + 6, v_today) - g.wk + 1,
             'kg', round(coalesce(k.kg, 0), 2),
             'g_per_guest', case when cv.guests > 0 then round(coalesce(k.kg_c, 0) * 1000 / cv.guests, 0) end) order by g.wk), '[]'::jsonb)
      into v_weekly
      from (select generate_series(date_trunc('week', b_from - 28)::date, date_trunc('week', least(a_to, v_today))::date, interval '7 days')::date wk) g
      left join lateral (
        select sum(w.weight_kg) kg,
               sum(w.weight_kg) filter (where exists (select 1 from public.daily_covers c
                 where c.restaurant_id = w.restaurant_id and c.date = app.local_date(w.recorded_at) and c.guests > 0)) kg_c
          from public.waste_records w
         where w.restaurant_id = i.restaurant_id and w.deleted_at is null
           and w.recorded_at >= (g.wk::timestamp at time zone 'Europe/Amsterdam')
           and w.recorded_at < ((g.wk + 7)::timestamp at time zone 'Europe/Amsterdam')
           and (i.scope_waste_category_id is null or w.waste_category_id = i.scope_waste_category_id)
           and (i.scope_reason_id is null or w.reason_id = i.scope_reason_id)
           and (i.scope_menu_item_id is null or w.menu_item_id = i.scope_menu_item_id)) k on true
      left join lateral (
        select sum(c.guests) guests from public.daily_covers c
         where c.restaurant_id = i.restaurant_id and c.date between g.wk and g.wk + 6 and c.guests > 0) cv on true
     where g.wk <= v_today;
  end if;

  return jsonb_build_object(
    'status', v_status, 'window_days', v_days,
    'before', b, 'after', a,
    'metric', v_metric, 'change_pct', v_change,
    'change_per_day_pct', v_day_change, 'change_per_guest_pct', v_guest_change,
    'control_change_pct', v_ctrl_change, 'control_restaurants', coalesce(cardinality(v_ctrl), 0),
    'net_change_pct', case when v_change is not null and v_ctrl_change is not null then round(v_change - v_ctrl_change, 1) end,
    'saved_kg', v_saved,
    'saved_value', case when v_saved is not null and (b ->> 'kg')::numeric > 0
                     then round(v_saved * (b ->> 'value')::numeric / (b ->> 'kg')::numeric, 0) end,
    -- fewer than 5 registrations on either side: the percentage says little yet
    'low_data', v_status = 'ok' and ((b ->> 'records')::int < 5 or (a ->> 'records')::int < 5),
    'weekly', v_weekly);
end $$;

grant execute on function app.window_stats(bigint, bigint[], bigint, bigint, bigint, date, date) to authenticated;
grant execute on function app.intervention_effect(bigint, int, boolean) to authenticated;
grant execute on function app.bp_publish() to authenticated;
grant execute on function app.set_created_by() to authenticated;

-- ---------------------------------------------------------------- RPCs for the page
create or replace function public.interventions_list(p_org bigint default null, p_lang text default 'en')
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'restaurant_id', i.restaurant_id, 'restaurant_name', r.name,
      'title', i.title, 'reason', i.reason, 'description', i.description, 'type', i.type,
      'start_date', i.start_date, 'end_date', i.end_date, 'status', i.status,
      'responsible_label', i.responsible_label, 'expected_change_pct', i.expected_change_pct,
      'scope_waste_category_id', i.scope_waste_category_id, 'scope_reason_id', i.scope_reason_id, 'scope_menu_item_id', i.scope_menu_item_id,
      'scope_category', (select app.lbl(c.labels, p_lang) from public.waste_categories c where c.id = i.scope_waste_category_id),
      'scope_reason', (select app.lbl(x.labels, p_lang) from public.waste_reasons x where x.id = i.scope_reason_id),
      'scope_menu_item', (select m.name from public.menu_items m where m.id = i.scope_menu_item_id),
      'can_edit', i.restaurant_id = any (app.restaurant_ids()),
      'best_practice_id', (select b.id from public.best_practices b where b.intervention_id = i.id and b.deleted_at is null order by b.id limit 1),
      'effect', app.intervention_effect(i.id, 28, false)) order by i.start_date desc, i.id desc), '[]'::jsonb)
    from public.interventions i join public.restaurants r on r.id = i.restaurant_id
   where i.organization_id = app.effective_org(p_org) and i.deleted_at is null
$$;

create or replace function public.intervention_effect(p_id bigint, p_days int default 28)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select app.intervention_effect(i.id, p_days, true) from public.interventions i where i.id = p_id and i.deleted_at is null
$$;

-- Best practices: managers see drafts too, everyone else only published ones
create or replace function public.best_practices_list(p_org bigint default null, p_lang text default 'en')
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'categories', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'code', c.code, 'label', app.lbl(c.labels, p_lang)) order by c.sort_order)
        from public.best_practice_categories c where c.organization_id is null or c.organization_id = app.effective_org(p_org)), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'restaurant_id', b.restaurant_id, 'restaurant_name', r.name,
        'intervention_id', b.intervention_id, 'intervention_title', i.title,
        'category_id', b.category_id, 'category', app.lbl(c.labels, p_lang),
        'author_name', u.name, 'title', b.title, 'problem', b.problem, 'solution', b.solution, 'result', b.result,
        'result_change_pct', b.result_change_pct, 'status', b.status, 'published_at', b.published_at, 'created_at', b.created_at,
        'attachment_path', b.attachment_path, 'attachment_name', b.attachment_name, 'attachment_type', b.attachment_type,
        'can_edit', app.rank() >= 30 and (b.restaurant_id = any (app.restaurant_ids()) or (b.restaurant_id is null and app.rank() >= 50)))
        order by (b.status <> 'published'), coalesce(b.published_at, b.created_at) desc)
        from public.best_practices b
        left join public.restaurants r on r.id = b.restaurant_id
        left join public.interventions i on i.id = b.intervention_id
        left join public.best_practice_categories c on c.id = b.category_id
        left join public.users u on u.id = b.author_user_id
       where b.organization_id = app.effective_org(p_org) and b.deleted_at is null and app.rank() > 0
         and (b.status = 'published' or app.rank() >= 30)), '[]'::jsonb))
$$;

revoke execute on function public.interventions_list(bigint, text) from public, anon;
revoke execute on function public.intervention_effect(bigint, int) from public, anon;
revoke execute on function public.best_practices_list(bigint, text) from public, anon;
grant execute on function public.interventions_list(bigint, text) to authenticated;
grant execute on function public.intervention_effect(bigint, int) to authenticated;
grant execute on function public.best_practices_list(bigint, text) to authenticated;
