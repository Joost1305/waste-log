-- 0031  Sales reports from the till (turnover group report, Excel/CSV or PDF).
-- Settings › Sales: upload one or more reports (usually one per day). The app keeps the lines (item, group,
-- quantity, revenue incl./excl. VAT), and per restaurant which till groups are food, drinks or other, and
-- which groups count as guests (Le Début: the menus). Single-day reports then fill "guests per day".
-- Settings › Dishes: till items are linked to the app's dishes once. The dashboard shows waste as % of food
-- sales, waste per 100 dishes sold and, per dish, sold versus wasted.
-- All writes go through the functions below (managers of the restaurant and up); the tables are read-only.

alter table public.daily_covers add column if not exists source text not null default 'manual'
  check (source in ('manual', 'sales'));

create table if not exists public.sales_reports (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  period_from      date not null,
  period_to        date not null,
  file_name        text,
  total_incl       numeric(12,2),
  total_excl       numeric(12,2),
  line_count       int not null default 0,
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check (period_to >= period_from and period_to - period_from <= 400)
);
create unique index if not exists sales_reports_one on public.sales_reports (restaurant_id, period_from, period_to) where deleted_at is null;
create index if not exists sales_reports_period on public.sales_reports (restaurant_id, period_from, period_to) where deleted_at is null;

create table if not exists public.sales_lines (
  id               bigint generated always as identity primary key,
  report_id        bigint not null references public.sales_reports(id) on delete cascade,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  group_name       text not null default '',
  group_code       text,
  item_name        text not null,
  item_code        text,
  qty              numeric(12,2) not null default 0,
  incl             numeric(12,2) not null default 0,
  excl             numeric(12,2) not null default 0
);
create index if not exists sales_lines_report on public.sales_lines (report_id);
create index if not exists sales_lines_item on public.sales_lines (organization_id, item_name);

create table if not exists public.sales_groups (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  group_name       text not null,
  kind             text not null default 'food' check (kind in ('food', 'drink', 'other')),
  counts_guests    boolean not null default false,
  unique (restaurant_id, group_name)
);

-- Till item -> dish (or ignored). Keyed by the item name as the till prints it, per organization.
create table if not exists public.sales_item_links (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  item_name        text not null,
  menu_item_id     bigint references public.menu_items(id),
  ignored          boolean not null default false,
  updated_at       timestamptz not null default now(),
  unique (organization_id, item_name)
);

-- Read access: managers (and up) of the organization; restaurant-bound rows only for their restaurants
alter table public.sales_reports enable row level security;
alter table public.sales_lines enable row level security;
alter table public.sales_groups enable row level security;
alter table public.sales_item_links enable row level security;
grant select on public.sales_reports, public.sales_lines, public.sales_groups, public.sales_item_links to authenticated;
create policy sales_reports_select on public.sales_reports for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
create policy sales_lines_select on public.sales_lines for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
create policy sales_groups_select on public.sales_groups for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id) and restaurant_id = any (app.restaurant_ids()));
create policy sales_item_links_select on public.sales_item_links for select to authenticated
  using ((select app.rank()) >= 30 and app.in_org(organization_id));

-- ---------------------------------------------------------------- helpers
-- First guess of a till group: drinks by name, a few known non-food groups, the rest food
create or replace function app.sales_group_kind(p_name text) returns text
language sql immutable set search_path = '' as $$
  select case
    when lower(p_name) ~ '(drink|dranken|beverage|wine|wijn|spirit|soft|bier|beer|coffee|koffie|tea\M|thee|juice|smoothie|water|cocktail|aperitif|liqueur|likeur|pairing)' then 'drink'
    when lower(p_name) ~ '(no group|packages|deposit|statiegeld|voucher|cadeau|gift|discount|korting|service)' then 'other'
    else 'food' end
$$;

-- Managers of this restaurant (or org admins) may change its sales data
create or replace function app.can_manage_restaurant(p_restaurant bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select app.rank() >= 30 and p_restaurant = any (app.restaurant_ids())
$$;

-- Guests per day from single-day reports: the quantity in the groups that count as guests.
-- Hand-entered guest counts are never overwritten.
create or replace function app.sales_refresh_covers(p_restaurant bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare v_org bigint; n int := 0;
begin
  select organization_id into v_org from public.restaurants where id = p_restaurant;
  -- Remove guest counts that came from sales but no longer have a source
  delete from public.daily_covers c
   where c.restaurant_id = p_restaurant and c.source = 'sales'
     and not exists (select 1 from public.sales_reports r where r.restaurant_id = p_restaurant and r.deleted_at is null
                      and r.period_from = c.date and r.period_to = c.date
                      and exists (select 1 from public.sales_groups g where g.restaurant_id = p_restaurant and g.counts_guests));
  with day as (
    select r.period_from d, round(coalesce(sum(l.qty), 0))::int guests
      from public.sales_reports r
      join public.sales_lines l on l.report_id = r.id
      join public.sales_groups g on g.restaurant_id = r.restaurant_id and g.group_name = l.group_name and g.counts_guests
     where r.restaurant_id = p_restaurant and r.deleted_at is null and r.period_from = r.period_to
     group by r.period_from)
  insert into public.daily_covers (organization_id, restaurant_id, date, guests, source)
  select v_org, p_restaurant, d, guests, 'sales' from day
  on conflict (restaurant_id, date) do update set guests = excluded.guests, source = 'sales'
    where public.daily_covers.source = 'sales';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- import, delete, settings
-- p: { restaurant_id, period_from, period_to, file_name, lines: [{ group_name, group_code, item_name, item_code, qty, incl, excl }] }
-- A report for the same restaurant and period replaces the earlier one.
create or replace function public.import_sales(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rest bigint := (p ->> 'restaurant_id')::bigint;
  v_from date := (p ->> 'period_from')::date;
  v_to date := coalesce((p ->> 'period_to')::date, (p ->> 'period_from')::date);
  v_org bigint; v_id bigint; v_old bigint; v_lines int; v_new_groups int;
begin
  if not app.can_manage_restaurant(v_rest) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_from is null then raise exception 'The report has no date' using errcode = '22023'; end if;
  if jsonb_typeof(p -> 'lines') <> 'array' or jsonb_array_length(p -> 'lines') = 0 then
    raise exception 'The report has no lines' using errcode = '22023';
  end if;
  if jsonb_array_length(p -> 'lines') > 5000 then raise exception 'Too many lines' using errcode = '22023'; end if;
  select organization_id into v_org from public.restaurants where id = v_rest and deleted_at is null;

  update public.sales_reports set deleted_at = now()
   where restaurant_id = v_rest and period_from = v_from and period_to = v_to and deleted_at is null
   returning id into v_old;

  insert into public.sales_reports (organization_id, restaurant_id, period_from, period_to, file_name, created_by)
  values (v_org, v_rest, v_from, v_to, left(p ->> 'file_name', 200), auth.uid()) returning id into v_id;

  insert into public.sales_lines (report_id, organization_id, restaurant_id, group_name, group_code, item_name, item_code, qty, incl, excl)
  select v_id, v_org, v_rest, left(coalesce(btrim(l ->> 'group_name'), ''), 120), left(l ->> 'group_code', 40),
         left(btrim(l ->> 'item_name'), 160), left(l ->> 'item_code', 40),
         coalesce((l ->> 'qty')::numeric, 0), coalesce((l ->> 'incl')::numeric, 0), coalesce((l ->> 'excl')::numeric, 0)
    from jsonb_array_elements(p -> 'lines') l
   where coalesce(btrim(l ->> 'item_name'), '') <> '';
  get diagnostics v_lines = row_count;

  update public.sales_reports r set line_count = v_lines,
         total_incl = (select sum(incl) from public.sales_lines where report_id = v_id),
         total_excl = (select sum(excl) from public.sales_lines where report_id = v_id)
   where r.id = v_id;

  insert into public.sales_groups (organization_id, restaurant_id, group_name, kind)
  select distinct v_org, v_rest, l.group_name, app.sales_group_kind(l.group_name)
    from public.sales_lines l where l.report_id = v_id
  on conflict (restaurant_id, group_name) do nothing;
  get diagnostics v_new_groups = row_count;

  perform app.sales_refresh_covers(v_rest);
  return jsonb_build_object('id', v_id, 'replaced', v_old is not null, 'lines', v_lines, 'new_groups', v_new_groups);
end $$;

create or replace function public.delete_sales_report(p_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
declare v_rest bigint;
begin
  select restaurant_id into v_rest from public.sales_reports where id = p_id and deleted_at is null;
  if v_rest is null or not app.can_manage_restaurant(v_rest) then raise exception 'Not allowed' using errcode = '42501'; end if;
  update public.sales_reports set deleted_at = now() where id = p_id;
  perform app.sales_refresh_covers(v_rest);
end $$;

create or replace function public.set_sales_group(p_id bigint, p_kind text, p_counts_guests boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_rest bigint;
begin
  select restaurant_id into v_rest from public.sales_groups where id = p_id;
  if v_rest is null or not app.can_manage_restaurant(v_rest) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if p_kind not in ('food', 'drink', 'other') then raise exception 'Unknown kind' using errcode = '22023'; end if;
  update public.sales_groups set kind = p_kind, counts_guests = coalesce(p_counts_guests, false) where id = p_id;
  perform app.sales_refresh_covers(v_rest);
end $$;

-- Link a till item to a dish (p_menu_item), or mark it as not a dish (p_ignored), or undo (both empty)
create or replace function public.link_sales_item(p_item_name text, p_menu_item bigint, p_ignored boolean default false) returns void
language plpgsql security definer set search_path = '' as $$
declare v_org bigint := app.org();
begin
  if app.rank() < 30 then raise exception 'Not allowed' using errcode = '42501'; end if;
  if app.is_super() then v_org := coalesce((select organization_id from public.menu_items where id = p_menu_item),
                                           (select organization_id from public.sales_lines where item_name = p_item_name limit 1)); end if;
  if p_menu_item is not null and not exists (select 1 from public.menu_items m where m.id = p_menu_item and m.organization_id = v_org and m.deleted_at is null) then
    raise exception 'Dish not found' using errcode = 'P0002';
  end if;
  if p_menu_item is null and not coalesce(p_ignored, false) then
    delete from public.sales_item_links where organization_id = v_org and item_name = p_item_name;
    return;
  end if;
  insert into public.sales_item_links (organization_id, item_name, menu_item_id, ignored)
  values (v_org, p_item_name, p_menu_item, coalesce(p_ignored, false) and p_menu_item is null)
  on conflict (organization_id, item_name) do update
    set menu_item_id = excluded.menu_item_id, ignored = excluded.ignored, updated_at = now();
end $$;

-- Till items in food groups, with what was sold and how they are linked (for Settings › Dishes)
create or replace function public.sales_items(p_org bigint default null) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x.unlinked desc, x.qty desc), '[]'::jsonb) from (
    select l.item_name, max(l.item_code) item_code, sum(l.qty) qty,
           round(sum(l.incl) / nullif(sum(l.qty) filter (where l.incl > 0), 0), 2) avg_price,
           array_agg(distinct r.name) restaurants,
           array_agg(distinct l.group_name) groups,
           k.menu_item_id, coalesce(k.ignored, false) ignored,
           (k.id is null) unlinked
      from public.sales_lines l
      join public.sales_reports rep on rep.id = l.report_id and rep.deleted_at is null
      join public.restaurants r on r.id = l.restaurant_id
      join public.sales_groups g on g.restaurant_id = l.restaurant_id and g.group_name = l.group_name and g.kind = 'food'
      left join public.sales_item_links k on k.organization_id = l.organization_id and k.item_name = l.item_name
     where l.organization_id = app.effective_org(p_org) and app.rank() >= 30 and l.restaurant_id = any (app.restaurant_ids())
     group by l.item_name, k.menu_item_id, k.ignored, k.id) x
$$;

-- ---------------------------------------------------------------- dashboard figures
-- Sales of reports that overlap [from, to] count for the share of their days inside the window; waste counts
-- only on days a report covers, so a week without a report does not make the percentage look better.
create or replace function public.sales_summary(p_org bigint default null, p_restaurant bigint default null,
                                                p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org bigint := app.effective_org(p_org);
  v_from date := coalesce(p_from, app.local_date(now()) - 27);
  v_to date := coalesce(p_to, app.local_date(now()));
  v_rids bigint[];
  v_res jsonb;
begin
  if app.rank() < 30 or not app.in_org(v_org) then raise exception 'Not allowed' using errcode = '42501'; end if;
  v_rids := array(select r.id from public.restaurants r where r.organization_id = v_org and r.deleted_at is null
                     and r.id = any (app.restaurant_ids()) and (p_restaurant is null or r.id = p_restaurant));
  with rep as (
    select r.*, (least(r.period_to, v_to) - greatest(r.period_from, v_from) + 1)::numeric
                / (r.period_to - r.period_from + 1) share
      from public.sales_reports r
     where r.restaurant_id = any (v_rids) and r.deleted_at is null and r.period_from <= v_to and r.period_to >= v_from),
  days as (
    select distinct rep.restaurant_id, d::date d from rep,
      generate_series(greatest(rep.period_from, v_from), least(rep.period_to, v_to), interval '1 day') d),
  lines as (
    select l.*, rep.share, g.kind, k.menu_item_id, coalesce(k.ignored, false) ignored
      from rep join public.sales_lines l on l.report_id = rep.id
      left join public.sales_groups g on g.restaurant_id = l.restaurant_id and g.group_name = l.group_name
      left join public.sales_item_links k on k.organization_id = l.organization_id and k.item_name = l.item_name),
  waste as (
    select w.* from public.waste_records w join days on days.restaurant_id = w.restaurant_id and days.d = app.local_date(w.recorded_at)
     where w.deleted_at is null),
  dish_sold as (
    select menu_item_id, sum(qty * share) sold, sum(excl * share) revenue from lines
     where kind = 'food' and menu_item_id is not null group by menu_item_id),
  dish_waste as (
    select menu_item_id, sum(weight_kg) kg, sum(purchase_value) value, count(*) n from waste where menu_item_id is not null group by menu_item_id),
  totals as (
    select coalesce(sum(excl * share) filter (where kind = 'food'), 0) food_excl,
           coalesce(sum(incl * share) filter (where kind = 'food'), 0) food_incl,
           coalesce(sum(excl * share), 0) all_excl,
           coalesce(sum(qty * share) filter (where kind = 'food' and menu_item_id is not null), 0) dishes_sold,
           coalesce(sum(qty * share) filter (where kind = 'food' and menu_item_id is null and not ignored and qty > 0), 0) unlinked_qty
      from lines)
  select jsonb_build_object(
    'has_sales', exists (select 1 from rep),
    'from', v_from, 'to', v_to,
    'report_count', (select count(*) from rep),
    'days_covered', (select count(*) from (select distinct d from days) x),
    'window_days', v_to - v_from + 1,
    'food_sales_excl', round(t.food_excl, 2), 'food_sales_incl', round(t.food_incl, 2), 'sales_excl', round(t.all_excl, 2),
    'waste_kg', (select round(coalesce(sum(weight_kg), 0), 2) from waste),
    'waste_value', (select round(coalesce(sum(purchase_value), 0), 2) from waste),
    'waste_pct_of_food_sales', case when t.food_excl > 0 then round((select coalesce(sum(purchase_value), 0) from waste) / t.food_excl * 100, 2) end,
    'dishes_sold', round(t.dishes_sold), 'unlinked_qty', round(t.unlinked_qty),
    'waste_kg_per_100_dishes', case when t.dishes_sold > 0 then round((select coalesce(sum(weight_kg), 0) from waste) / t.dishes_sold * 100, 2) end,
    'dishes', coalesce((select jsonb_agg(jsonb_build_object(
        'menu_item_id', m.id, 'name', m.name, 'portion_g', m.portion_size_g,
        'sold', round(coalesce(s.sold, 0)), 'revenue', round(coalesce(s.revenue, 0), 2),
        'waste_kg', round(coalesce(dw.kg, 0), 2), 'waste_value', round(coalesce(dw.value, 0), 2), 'registrations', coalesce(dw.n, 0),
        'waste_per_100', case when s.sold > 0 then round(coalesce(dw.kg, 0) / s.sold * 100, 2) end,
        'waste_pct', case when s.sold > 0 and m.portion_size_g > 0 then round(coalesce(dw.kg, 0) / (s.sold * m.portion_size_g / 1000) * 100, 1) end)
        order by coalesce(dw.kg, 0) desc, coalesce(s.sold, 0) desc)
      from public.menu_items m
      left join dish_sold s on s.menu_item_id = m.id
      left join dish_waste dw on dw.menu_item_id = m.id
     where m.organization_id = v_org and (s.menu_item_id is not null or dw.menu_item_id is not null)), '[]'::jsonb)
  ) into v_res from totals t;
  return v_res;
end $$;

revoke execute on function app.sales_refresh_covers(bigint) from public, anon, authenticated;
grant execute on function app.sales_group_kind(text) to authenticated;
grant execute on function app.can_manage_restaurant(bigint) to authenticated;
revoke execute on function public.import_sales(jsonb) from public, anon;
revoke execute on function public.delete_sales_report(bigint) from public, anon;
revoke execute on function public.set_sales_group(bigint, text, boolean) from public, anon;
revoke execute on function public.link_sales_item(text, bigint, boolean) from public, anon;
revoke execute on function public.sales_items(bigint) from public, anon;
revoke execute on function public.sales_summary(bigint, bigint, date, date) from public, anon;
grant execute on function public.import_sales(jsonb) to authenticated;
grant execute on function public.delete_sales_report(bigint) to authenticated;
grant execute on function public.set_sales_group(bigint, text, boolean) to authenticated;
grant execute on function public.link_sales_item(text, bigint, boolean) to authenticated;
grant execute on function public.sales_items(bigint) to authenticated;
grant execute on function public.sales_summary(bigint, bigint, date, date) to authenticated;
