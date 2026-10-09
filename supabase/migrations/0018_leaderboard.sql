-- 0018  Leaderboard between sections of a restaurant (bakery, salad bar, pizza ...), switchable per organization.
-- Points are NOT for fewer kilos alone (that would reward not registering). They are for:
--   showing up      10 per day the section registered something
--   quality         per registration 1, +1 with a photo, +1 when weighed (not estimated); at most 10 registrations a day count
--   prevention      5 per idea "how could this have been prevented?" (at most 3 a day), +25 when the admin adopts it
--   improvement     up to 50 for less waste per guest than the section's own 4 weeks before,
--                   only for sections that registered on at least 80% of the days the restaurant was open
-- Switched off (organizations.leaderboard_enabled = false): no section choice, no prevention question, no points, no page.

alter table public.organizations
  add column if not exists leaderboard_enabled boolean not null default false,
  add column if not exists leaderboard_prize text,
  add column if not exists leaderboard_period text not null default 'week',
  add column if not exists leaderboard_season_start date;
do $$ begin
  alter table public.organizations add constraint organizations_leaderboard_period_check check (leaderboard_period in ('week', 'month'));
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- sections
create table if not exists public.sections (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  name             text not null check (length(btrim(name)) between 1 and 60),
  sort_order       int not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create unique index if not exists sections_name_unique on public.sections (restaurant_id, lower(name)) where deleted_at is null;
create or replace trigger org_from_restaurant before insert or update on public.sections for each row execute function app.org_from_restaurant();
create or replace trigger touch_updated_at before update on public.sections for each row execute function app.touch_updated_at();
create or replace trigger audit after insert or update on public.sections for each row execute function app.audit_row();
alter table public.sections enable row level security;
grant select, insert, update on public.sections to authenticated;
create policy sections_select on public.sections for select to authenticated using (app.in_org(organization_id));
create policy sections_insert on public.sections for insert to authenticated
  with check ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
create policy sections_update on public.sections for update to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()))
  with check (app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));

alter table public.waste_records add column if not exists section_id bigint references public.sections(id);
create index if not exists waste_records_section_idx on public.waste_records (section_id, recorded_at) where section_id is not null;

create or replace function app.waste_section_check() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.section_id is not null and (tg_op = 'INSERT' or new.section_id is distinct from old.section_id or new.restaurant_id is distinct from old.restaurant_id)
     and not exists (select 1 from public.sections s where s.id = new.section_id and s.restaurant_id = new.restaurant_id and s.deleted_at is null) then
    raise exception 'Section does not belong to this restaurant' using errcode = '22023';
  end if;
  return new;
end $$;
create or replace trigger waste_section_check before insert or update on public.waste_records for each row execute function app.waste_section_check();

-- ---------------------------------------------------------------- prevention ideas
create table if not exists public.prevention_ideas (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  section_id       bigint references public.sections(id),
  waste_record_id  bigint references public.waste_records(id),
  user_id          uuid references public.users(id),
  text             text not null,
  status           text not null default 'new' check (status in ('new', 'adopted', 'rejected')),
  review_note      text,
  reviewed_by      uuid references public.users(id),
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists prevention_ideas_rest_idx on public.prevention_ideas (restaurant_id, created_at);

create or replace function app.prevention_idea_before() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  if tg_op = 'INSERT' then
    new.text := btrim(coalesce(new.text, ''));
    if length(new.text) < 3 then raise exception 'Write a short idea' using errcode = '22023'; end if;
    if length(new.text) > 500 then raise exception 'At most 500 characters' using errcode = '22023'; end if;
    new.user_id := auth.uid();
    new.status := 'new'; new.reviewed_by := null; new.reviewed_at := null;
    if new.waste_record_id is not null then
      select w.organization_id, w.restaurant_id, w.section_id, w.user_id into r from public.waste_records w
       where w.id = new.waste_record_id and w.deleted_at is null;
      if not found then raise exception 'Registration not found' using errcode = 'P0002'; end if;
      if r.user_id is distinct from auth.uid() and app.rank() < 30 then raise exception 'Not your registration' using errcode = '42501'; end if;
      new.organization_id := r.organization_id; new.restaurant_id := r.restaurant_id; new.section_id := r.section_id;
    else
      select x.organization_id into new.organization_id from public.restaurants x where x.id = new.restaurant_id;
    end if;
    if not coalesce((select o.leaderboard_enabled from public.organizations o where o.id = new.organization_id), false) then
      raise exception 'The leaderboard is switched off' using errcode = '42501';
    end if;
  else
    -- Only the review fields change after sending
    new.text := old.text; new.user_id := old.user_id; new.organization_id := old.organization_id;
    new.restaurant_id := old.restaurant_id; new.section_id := old.section_id; new.waste_record_id := old.waste_record_id;
    new.created_at := old.created_at;
    if new.status is distinct from old.status then new.reviewed_by := auth.uid(); new.reviewed_at := now(); end if;
  end if;
  return new;
end $$;
create or replace trigger prevention_idea_before before insert or update on public.prevention_ideas for each row execute function app.prevention_idea_before();
create or replace trigger touch_updated_at before update on public.prevention_ideas for each row execute function app.touch_updated_at();
create or replace trigger audit after insert or update on public.prevention_ideas for each row execute function app.audit_row();
alter table public.prevention_ideas enable row level security;
grant select, insert, update on public.prevention_ideas to authenticated;
create policy prevention_ideas_select on public.prevention_ideas for select to authenticated
  using (user_id = (select auth.uid())
         or ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()))
         or (status = 'adopted' and deleted_at is null and app.in_org(organization_id)));
create policy prevention_ideas_insert on public.prevention_ideas for insert to authenticated
  with check (user_id = (select auth.uid()) and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
-- Reviewing (adopt / not adopt) is for the organization admin
create policy prevention_ideas_update on public.prevention_ideas for update to authenticated
  using ((select app.rank()) >= 50 and app.in_org(organization_id)) with check (app.in_org(organization_id));

-- ---------------------------------------------------------------- winners
create table if not exists public.leaderboard_awards (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  section_id       bigint not null references public.sections(id),
  period_from      date not null,
  period_to        date not null,
  points           int,
  prize            text,
  note             text,
  awarded_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create unique index if not exists leaderboard_awards_one on public.leaderboard_awards (restaurant_id, period_from) where deleted_at is null;
create or replace function app.award_before() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.sections s where s.id = new.section_id and s.restaurant_id = new.restaurant_id) then
    raise exception 'Section does not belong to this restaurant' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then new.awarded_by := auth.uid(); end if;
  return new;
end $$;
create or replace trigger org_from_restaurant before insert or update on public.leaderboard_awards for each row execute function app.org_from_restaurant();
create or replace trigger award_before before insert or update on public.leaderboard_awards for each row execute function app.award_before();
create or replace trigger touch_updated_at before update on public.leaderboard_awards for each row execute function app.touch_updated_at();
create or replace trigger audit after insert or update on public.leaderboard_awards for each row execute function app.audit_row();
alter table public.leaderboard_awards enable row level security;
grant select, insert, update on public.leaderboard_awards to authenticated;
create policy leaderboard_awards_select on public.leaderboard_awards for select to authenticated using (app.in_org(organization_id));
create policy leaderboard_awards_insert on public.leaderboard_awards for insert to authenticated
  with check ((select app.rank()) >= 50 and app.in_org(organization_id));
create policy leaderboard_awards_update on public.leaderboard_awards for update to authenticated
  using ((select app.rank()) >= 50 and app.in_org(organization_id)) with check (app.in_org(organization_id));

grant execute on function app.waste_section_check() to authenticated;
grant execute on function app.prevention_idea_before() to authenticated;
grant execute on function app.award_before() to authenticated;

-- ---------------------------------------------------------------- app_meta: switch, prize and sections
do $do$
declare d text;
begin
  d := pg_get_functiondef('public.app_meta(bigint, text)'::regprocedure);
  if position('''leaderboard_enabled''' in d) = 0 then
    if position('''is_demo'', o.is_demo)' in d) = 0 or position('''locations'', ''["kitchen"' in d) = 0 then
      raise exception 'app_meta: pattern not found';
    end if;
    d := replace(d, '''is_demo'', o.is_demo)',
      '''is_demo'', o.is_demo, ''leaderboard_enabled'', o.leaderboard_enabled, ''leaderboard_prize'', o.leaderboard_prize)');
    d := replace(d, '''locations'', ''["kitchen"',
      '''sections'', coalesce((select jsonb_agg(jsonb_build_object(''id'', x.id, ''restaurant_id'', x.restaurant_id, ''name'', x.name) order by x.sort_order, x.name)
                       from public.sections x where x.organization_id = v_org and x.is_active and x.deleted_at is null and x.restaurant_id = any (v_rids)), ''[]''),
    ''locations'', ''["kitchen"');
    execute d;
  end if;
end $do$;

-- ---------------------------------------------------------------- scoring
create or replace function public.leaderboard(p_org bigint default null, p_restaurant bigint default null,
                                              p_from date default null, p_to date default null, p_lang text default 'en')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org    public.organizations%rowtype;
  v_today  date := app.local_date(now());
  v_rest   bigint;
  v_from   date; v_to date; v_end date;
  v_open   int;
  v_guests numeric; v_bguests numeric;
  v_rows   jsonb;
begin
  if app.rank() = 0 then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into v_org from public.organizations o where o.id = app.effective_org(p_org);
  if not found or not app.in_org(v_org.id) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if not v_org.leaderboard_enabled then return jsonb_build_object('enabled', false); end if;

  -- Restaurant: the one asked for, else the first of the user's restaurants that has sections
  select r.id into v_rest from public.restaurants r
   where r.organization_id = v_org.id and r.deleted_at is null and r.id = any (app.restaurant_ids())
     and (p_restaurant is null or r.id = p_restaurant)
     and exists (select 1 from public.sections s where s.restaurant_id = r.id and s.is_active and s.deleted_at is null)
   order by r.name limit 1;

  v_from := coalesce(p_from, case when v_org.leaderboard_period = 'month' then date_trunc('month', v_today)::date else date_trunc('week', v_today)::date end);
  v_to   := coalesce(p_to, case when v_org.leaderboard_period = 'month' then (date_trunc('month', v_today) + interval '1 month - 1 day')::date
                                else date_trunc('week', v_today)::date + 6 end);
  v_end  := least(v_to, v_today);

  if v_rest is not null then
    select count(distinct app.local_date(w.recorded_at)) into v_open from public.waste_records w
     where w.restaurant_id = v_rest and w.deleted_at is null
       and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam') and w.recorded_at < ((v_end + 1)::timestamp at time zone 'Europe/Amsterdam');
    select coalesce(sum(c.guests), 0) into v_guests from public.daily_covers c where c.restaurant_id = v_rest and c.date between v_from and v_end;
    select coalesce(sum(c.guests), 0) into v_bguests from public.daily_covers c where c.restaurant_id = v_rest and c.date between v_from - 28 and v_from - 1;

    with sec as (
      select s.id, s.name, s.sort_order from public.sections s where s.restaurant_id = v_rest and s.is_active and s.deleted_at is null),
    w as (
      select w.section_id, app.local_date(w.recorded_at) d, w.weight_kg,
             1 + (w.photo_path is not null)::int + (w.weight_source is distinct from 'estimate')::int q,
             (w.photo_path is not null)::int ph
        from public.waste_records w
       where w.restaurant_id = v_rest and w.deleted_at is null and w.section_id is not null
         and w.recorded_at >= (v_from::timestamp at time zone 'Europe/Amsterdam') and w.recorded_at < ((v_end + 1)::timestamp at time zone 'Europe/Amsterdam')),
    wq as (select section_id, d, q, row_number() over (partition by section_id, d order by q desc) rn from w),
    base as (
      select w.section_id, sum(w.weight_kg) kg from public.waste_records w
       where w.restaurant_id = v_rest and w.deleted_at is null and w.section_id is not null
         and w.recorded_at >= ((v_from - 28)::timestamp at time zone 'Europe/Amsterdam') and w.recorded_at < (v_from::timestamp at time zone 'Europe/Amsterdam')
       group by 1),
    ideas as (
      select i.section_id, app.local_date(i.created_at) d, i.status,
             row_number() over (partition by i.section_id, app.local_date(i.created_at) order by i.created_at) rn
        from public.prevention_ideas i
       where i.restaurant_id = v_rest and i.deleted_at is null and i.section_id is not null and i.status <> 'rejected'
         and i.created_at >= (v_from::timestamp at time zone 'Europe/Amsterdam') and i.created_at < ((v_end + 1)::timestamp at time zone 'Europe/Amsterdam')),
    agg as (
      select sec.id, sec.name, sec.sort_order,
             (select count(distinct d) from w where w.section_id = sec.id) days,
             (select count(*) from w where w.section_id = sec.id) regs,
             (select coalesce(sum(ph), 0) from w where w.section_id = sec.id) photos,
             (select coalesce(sum(weight_kg), 0) from w where w.section_id = sec.id) kg,
             (select coalesce(sum(q), 0) from wq where wq.section_id = sec.id and wq.rn <= 10) quality,
             (select count(*) from ideas where ideas.section_id = sec.id and ideas.rn <= 3) ideas_sent,
             (select count(*) from ideas where ideas.section_id = sec.id and ideas.status = 'adopted') ideas_adopted,
             coalesce((select kg from base where base.section_id = sec.id), 0) base_kg
        from sec),
    scored as (
      select a.*,
             case when a.base_kg > 0 then
               case when v_guests > 0 and v_bguests > 0
                 then round(((a.base_kg / v_bguests) - (a.kg / v_guests)) / (a.base_kg / v_bguests) * 100, 0)
                 else round(((a.base_kg / 28) - (a.kg / (v_end - v_from + 1))) / (a.base_kg / 28) * 100, 0) end end change_pct,
             v_open > 0 and a.days >= ceil(v_open * 0.8) eligible
        from agg a),
    final as (
      select s.*, s.days * 10 p_presence, s.quality p_quality, s.ideas_sent * 5 + s.ideas_adopted * 25 p_ideas,
             case when s.eligible and v_end - v_from + 1 >= 3 then least(50, greatest(0, coalesce(s.change_pct, 0)))::int else 0 end p_improvement
        from scored s)
    select coalesce(jsonb_agg(jsonb_build_object(
             'section_id', f.id, 'name', f.name,
             'points', f.p_presence + f.p_quality + f.p_ideas + f.p_improvement,
             'presence', f.p_presence, 'quality', f.p_quality, 'ideas', f.p_ideas, 'improvement', f.p_improvement,
             'days', f.days, 'open_days', v_open, 'registrations', f.regs,
             'photo_pct', case when f.regs > 0 then round(f.photos::numeric / f.regs * 100, 0) end,
             'ideas_sent', f.ideas_sent, 'ideas_adopted', f.ideas_adopted,
             'waste_change_pct', case when f.change_pct is not null then -f.change_pct end, 'eligible', f.eligible)
             order by f.p_presence + f.p_quality + f.p_ideas + f.p_improvement desc, f.regs desc, f.sort_order, f.name), '[]'::jsonb)
      into v_rows from final f;
  end if;

  return jsonb_build_object(
    'enabled', true, 'prize', v_org.leaderboard_prize, 'period', v_org.leaderboard_period,
    'season_start', v_org.leaderboard_season_start, 'from', v_from, 'to', v_to, 'today', v_today,
    'restaurant_id', v_rest,
    'restaurants', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name) order by r.name)
        from public.restaurants r where r.organization_id = v_org.id and r.deleted_at is null and r.id = any (app.restaurant_ids())
         and exists (select 1 from public.sections s where s.restaurant_id = r.id and s.is_active and s.deleted_at is null)), '[]'::jsonb),
    'rows', coalesce(v_rows, '[]'::jsonb),
    'idea_of_period', (select jsonb_build_object('text', i.text, 'section', s.name, 'date', app.local_date(i.created_at))
        from public.prevention_ideas i left join public.sections s on s.id = i.section_id
       where i.restaurant_id = v_rest and i.status = 'adopted' and i.deleted_at is null
         and i.created_at >= (v_from::timestamp at time zone 'Europe/Amsterdam') and i.created_at < ((v_to + 1)::timestamp at time zone 'Europe/Amsterdam')
       order by i.reviewed_at desc nulls last limit 1),
    'awards', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'section', s.name, 'from', a.period_from, 'to', a.period_to,
                 'points', a.points, 'prize', a.prize, 'note', a.note) order by a.period_from desc)
        from (select * from public.leaderboard_awards a where a.restaurant_id = v_rest and a.deleted_at is null order by a.period_from desc limit 12) a
        join public.sections s on s.id = a.section_id), '[]'::jsonb),
    'rules', jsonb_build_object('presence', 10, 'per_registration_max', 3, 'registrations_per_day', 10, 'idea', 5, 'ideas_per_day', 3,
                                'adopted', 25, 'improvement_max', 50, 'presence_min_pct', 80));
end $$;

-- Ideas: the admin reviews; managers see their restaurants; everyone sees adopted ideas and their own
create or replace function public.prevention_ideas_list(p_org bigint default null, p_status text default null, p_lang text default 'en')
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'text', i.text, 'status', i.status, 'review_note', i.review_note, 'created_at', i.created_at, 'reviewed_at', i.reviewed_at,
      'restaurant', r.name, 'section', s.name,
      'user_name', case when app.rank() >= 30 or i.user_id = auth.uid() then u.name end,
      'mine', i.user_id = auth.uid(),
      'record', case when w.id is not null then jsonb_build_object('product', coalesce(case when p_lang = 'en' then p.name_en end, p.name, w.product_name),
                 'kg', w.weight_kg, 'reason', app.lbl(rs.labels, p_lang)) end) order by i.created_at desc), '[]'::jsonb)
    from public.prevention_ideas i
    join public.restaurants r on r.id = i.restaurant_id
    left join public.sections s on s.id = i.section_id
    left join public.users u on u.id = i.user_id
    left join public.waste_records w on w.id = i.waste_record_id
    left join public.products p on p.id = w.product_id
    left join public.waste_reasons rs on rs.id = w.reason_id
   where i.organization_id = app.effective_org(p_org) and i.deleted_at is null and app.rank() > 0
     and (p_status is null or i.status = p_status)
     and (i.user_id = auth.uid() or i.status = 'adopted'
          or (app.rank() >= 30 and i.restaurant_id = any (app.restaurant_ids())))
$$;

revoke execute on function public.leaderboard(bigint, bigint, date, date, text) from public, anon;
revoke execute on function public.prevention_ideas_list(bigint, text, text) from public, anon;
grant execute on function public.leaderboard(bigint, bigint, date, date, text) to authenticated;
grant execute on function public.prevention_ideas_list(bigint, text, text) to authenticated;
