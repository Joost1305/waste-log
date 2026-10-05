-- WASTE log: Food Waste Management & Learning Platform
-- 0001  Schema (PostgreSQL / Supabase)
-- Multi-tenant: every tenant-owned table carries organization_id.
-- Users are Supabase Auth users; public.users holds their profile, role and organization.

create extension if not exists pgcrypto with schema extensions;

-- Private schema for helper functions (not exposed through the API)
create schema if not exists app;

-- ---------------------------------------------------------------
-- Tenancy, users and access
-- ---------------------------------------------------------------
create table public.organizations (
  id                    bigint generated always as identity primary key,
  name                  text not null,
  slug                  text not null unique,
  currency              text not null default 'EUR',
  default_language      text not null default 'nl',
  default_value_per_kg  numeric(10,2) not null default 6.50 check (default_value_per_kg > 0),   -- valuation level 1
  weather_enabled       boolean not null default true,
  settings              jsonb not null default '{}',
  is_demo               boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);

create table public.roles (
  code  text primary key,          -- super_admin | org_admin | restaurant_manager | employee
  name  text not null,
  rank  int not null               -- higher = more rights
);
insert into public.roles (code, name, rank) values
  ('super_admin', 'Super Admin', 100),
  ('org_admin', 'Organization Admin', 50),
  ('restaurant_manager', 'Restaurant Manager', 30),
  ('employee', 'Employee / Student', 10);

create table public.restaurants (
  id                     bigint generated always as identity primary key,
  organization_id        bigint not null references public.organizations(id),
  name                   text not null,
  slug                   text not null,
  city                   text,
  latitude               double precision check (latitude between -90 and 90),
  longitude              double precision check (longitude between -180 and 180),
  timezone               text not null default 'Europe/Amsterdam',
  public_impact_enabled  boolean not null default false,
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz,
  unique (organization_id, slug)
);

create table public.users (
  id               uuid primary key references auth.users(id) on delete cascade,
  organization_id  bigint references public.organizations(id),   -- null only for super_admin
  role             text not null references public.roles(code),
  email            text not null unique,
  name             text not null,
  language         text not null default 'nl',
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check (role = 'super_admin' or organization_id is not null)
);

create table public.user_restaurants (
  user_id        uuid not null references public.users(id) on delete cascade,
  restaurant_id  bigint not null references public.restaurants(id),
  primary key (user_id, restaurant_id)
);

-- ---------------------------------------------------------------
-- Taxonomies (organization_id null = platform default)
-- labels = {"en": "...", "nl": "...", "fy": "..."}
-- ---------------------------------------------------------------
create table public.waste_categories (
  id               bigint generated always as identity primary key,
  organization_id  bigint references public.organizations(id),
  code             text not null,
  labels           jsonb not null,
  co2e_per_kg      numeric(8,2) not null default 2.5,
  color            text,
  sort_order       int not null default 0,
  is_active        boolean not null default true
);

create table public.categories (       -- subcategories
  id                 bigint generated always as identity primary key,
  organization_id    bigint references public.organizations(id),
  waste_category_id  bigint not null references public.waste_categories(id),
  code               text not null,
  labels             jsonb not null,
  sort_order         int not null default 0
);

create table public.waste_reasons (
  id               bigint generated always as identity primary key,
  organization_id  bigint references public.organizations(id),
  code             text not null,
  labels           jsonb not null,
  sort_order       int not null default 0,
  is_active        boolean not null default true
);

-- ---------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------
create table public.suppliers (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  name             text not null,
  contact          text,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table public.products (
  id                     bigint generated always as identity primary key,
  organization_id        bigint not null references public.organizations(id),
  name                   text not null,
  labels                 jsonb,
  waste_category_id      bigint references public.waste_categories(id),
  category_id            bigint references public.categories(id),
  default_supplier_id    bigint references public.suppliers(id),
  purchase_price_per_kg  numeric(10,2) check (purchase_price_per_kg >= 0),   -- valuation level 2
  sales_price_per_kg     numeric(10,2) check (sales_price_per_kg >= 0),
  is_quick_pick          boolean not null default false,
  is_active              boolean not null default true,
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create table public.invoices (
  id                 bigint generated always as identity primary key,
  organization_id    bigint not null references public.organizations(id),
  restaurant_id      bigint references public.restaurants(id),
  supplier_id        bigint references public.suppliers(id),
  invoice_number     text,
  invoice_date       date,
  file_path          text,
  original_filename  text,
  status             text not null default 'uploaded' check (status in ('uploaded','extracted','confirmed','failed')),
  extraction_raw     jsonb,
  total_amount       numeric(12,2),
  uploaded_by        uuid references public.users(id),
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

create table public.invoice_items (
  id               bigint generated always as identity primary key,
  invoice_id       bigint not null references public.invoices(id) on delete cascade,
  organization_id  bigint not null references public.organizations(id),
  product_id       bigint references public.products(id),
  description      text not null,
  quantity         numeric(12,3),
  unit             text,
  quantity_kg      numeric(12,3),          -- normalised for waste-rate analysis
  unit_price       numeric(12,4),
  price_per_kg     numeric(12,4),          -- valuation level 3
  line_total       numeric(12,2),
  category         text,
  confidence       numeric(4,3),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Menu and guests
-- ---------------------------------------------------------------
create table public.menu_items (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint references public.restaurants(id),     -- null = all restaurants
  name             text not null,
  labels           jsonb,
  portion_size_g   numeric(8,1) check (portion_size_g > 0),
  sales_price      numeric(10,2),
  cost_price       numeric(10,2),
  is_active        boolean not null default true,
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table public.menu_waste (        -- daily production log per dish
  id                 bigint generated always as identity primary key,
  organization_id    bigint not null references public.organizations(id),
  restaurant_id      bigint not null references public.restaurants(id),
  menu_item_id       bigint not null references public.menu_items(id),
  date               date not null,
  portions_produced  int,
  portions_sold      int,
  portions_wasted    int,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (restaurant_id, menu_item_id, date)
);

create table public.daily_covers (      -- guests per day, for "waste per guest"
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint not null references public.restaurants(id),
  date             date not null,
  guests           int not null check (guests >= 0),
  is_demo          boolean not null default false,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (restaurant_id, date)
);

-- ---------------------------------------------------------------
-- Waste records (core)
-- ---------------------------------------------------------------
create table public.waste_records (
  id                     bigint generated always as identity primary key,
  organization_id        bigint not null references public.organizations(id),
  restaurant_id          bigint not null references public.restaurants(id),
  user_id                uuid references public.users(id),
  recorded_at            timestamptz not null default now(),
  product_id             bigint references public.products(id),
  product_name           text,
  waste_category_id      bigint not null references public.waste_categories(id),
  category_id            bigint references public.categories(id),
  reason_id              bigint not null references public.waste_reasons(id),
  menu_item_id           bigint references public.menu_items(id),
  supplier_id            bigint references public.suppliers(id),
  weight_kg              numeric(10,3) not null check (weight_kg > 0 and weight_kg <= 500),
  entered_unit           text not null default 'kg' check (entered_unit in ('g','kg')),
  location               text,
  moment                 text,
  note                   text check (length(note) <= 1000),
  photo_path             text,
  ai_suggestion          jsonb,
  ai_confidence          numeric(4,3),
  ai_accepted            boolean,
  valuation_method       text not null default 'default' check (valuation_method in ('default','product','invoice')),
  unit_cost_per_kg       numeric(10,4) not null default 0,
  purchase_value         numeric(12,2) not null default 0,
  production_cost        numeric(12,2),
  labour_cost            numeric(12,2),
  energy_cost            numeric(12,2),
  potential_sales_value  numeric(12,2),
  co2e_kg                numeric(10,2),
  is_demo                boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  deleted_at             timestamptz
);
create index waste_org_date_idx  on public.waste_records (organization_id, recorded_at) where deleted_at is null;
create index waste_rest_date_idx on public.waste_records (restaurant_id, recorded_at) where deleted_at is null;
create index waste_user_idx      on public.waste_records (user_id, recorded_at);

create table public.weather_records (
  id             bigint generated always as identity primary key,
  restaurant_id  bigint not null references public.restaurants(id),
  date           date not null,
  temp_mean_c    numeric(5,1),
  temp_max_c     numeric(5,1),
  temp_min_c     numeric(5,1),
  rainfall_mm    numeric(6,1),
  condition      text,
  humidity_pct   numeric(5,1),
  source         text,
  created_at     timestamptz not null default now(),
  unique (restaurant_id, date)
);

-- ---------------------------------------------------------------
-- Improvement loop
-- ---------------------------------------------------------------
create table public.targets (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint references public.restaurants(id),       -- null = whole organization
  name             text not null,
  period           text not null default 'month',
  baseline_kg      numeric(12,1) not null check (baseline_kg > 0),
  target_kg        numeric(12,1) not null check (target_kg >= 0),
  start_date       date not null,
  end_date         date,
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  check (target_kg < baseline_kg)
);

create table public.framework_principles (   -- configurable, e.g. SENSE
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  framework_code   text not null,
  code             text not null,
  labels           jsonb not null,
  description      text,
  sort_order       int not null default 0
);

create table public.research_projects (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  name             text not null,
  description      text,
  design           text,
  status           text not null default 'draft' check (status in ('draft','running','closed')),
  created_by       uuid references public.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);

create table public.interventions (
  id                      bigint generated always as identity primary key,
  organization_id         bigint not null references public.organizations(id),
  restaurant_id           bigint not null references public.restaurants(id),
  research_project_id     bigint references public.research_projects(id),
  title                   text not null,
  reason                  text,
  description             text,
  type                    text,
  start_date              date not null,
  end_date                date,
  responsible_user_id     uuid references public.users(id),
  responsible_label       text,
  scope_waste_category_id bigint references public.waste_categories(id),
  scope_menu_item_id      bigint references public.menu_items(id),
  scope_reason_id         bigint references public.waste_reasons(id),
  expected_change_pct     numeric(6,1),
  actual_change_pct       numeric(6,1),
  status                  text not null default 'planned' check (status in ('planned','active','completed','stopped')),
  created_by              uuid references public.users(id),
  is_demo                 boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  deleted_at              timestamptz
);

create table public.intervention_principles (
  intervention_id  bigint not null references public.interventions(id) on delete cascade,
  principle_id     bigint not null references public.framework_principles(id),
  primary key (intervention_id, principle_id)
);

create table public.best_practice_categories (
  id               bigint generated always as identity primary key,
  organization_id  bigint references public.organizations(id),
  code             text not null,
  labels           jsonb not null,
  sort_order       int not null default 0
);

create table public.best_practices (
  id                 bigint generated always as identity primary key,
  organization_id    bigint not null references public.organizations(id),
  restaurant_id      bigint references public.restaurants(id),
  intervention_id    bigint references public.interventions(id),
  category_id        bigint references public.best_practice_categories(id),
  author_user_id     uuid references public.users(id),
  title              text not null,
  problem            text,
  solution           text,
  result             text,
  result_change_pct  numeric(6,1),
  status             text not null default 'draft' check (status in ('draft','pending','published')),
  approved_by        uuid references public.users(id),
  published_at       timestamptz,
  show_on_impact     boolean not null default false,
  is_demo            boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

-- ---------------------------------------------------------------
-- Research mode
-- ---------------------------------------------------------------
create table public.research_groups (
  id                   bigint generated always as identity primary key,
  research_project_id  bigint not null references public.research_projects(id) on delete cascade,
  code                 text not null check (code in ('test','control')),
  name                 text not null
);

create table public.research_participants (
  id                   bigint generated always as identity primary key,
  research_project_id  bigint not null references public.research_projects(id) on delete cascade,
  restaurant_id        bigint not null references public.restaurants(id),
  group_id             bigint references public.research_groups(id),
  anonymous_code       text not null,
  is_participant       boolean not null default true,
  baseline_start       date,
  baseline_end         date,
  intervention_start   date,
  intervention_end     date,
  followup_start       date,
  followup_end         date,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (research_project_id, restaurant_id)
);

create table public.questionnaires (
  id                   bigint generated always as identity primary key,
  organization_id      bigint not null references public.organizations(id),
  research_project_id  bigint references public.research_projects(id),
  title                text not null,
  phase                text check (phase in ('baseline','midpoint','endline')),
  status               text not null default 'draft',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);

create table public.questionnaire_questions (
  id                bigint generated always as identity primary key,
  questionnaire_id  bigint not null references public.questionnaires(id) on delete cascade,
  sort_order        int not null default 0,
  type              text not null check (type in ('multiple_choice','likert','yes_no','numeric','open_text')),
  labels            jsonb not null,
  options           jsonb,
  required          boolean not null default false
);

create table public.questionnaire_responses (
  id                bigint generated always as identity primary key,
  questionnaire_id  bigint not null references public.questionnaires(id),
  question_id       bigint not null references public.questionnaire_questions(id),
  participant_id    bigint references public.research_participants(id),
  restaurant_id     bigint references public.restaurants(id),
  respondent_code   text not null,           -- anonymous, never a user id
  phase             text,
  value_text        text,
  value_number      numeric,
  submitted_at      timestamptz not null default now()
);

create table public.impact_reports (
  id               bigint generated always as identity primary key,
  organization_id  bigint not null references public.organizations(id),
  restaurant_id    bigint references public.restaurants(id),
  period_start     date not null,
  period_end       date not null,
  data             jsonb not null,           -- aggregated figures only
  is_public        boolean not null default false,
  slug             text unique,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------
create table public.audit_log (
  id               bigint generated always as identity primary key,
  organization_id  bigint references public.organizations(id),
  user_id          uuid,
  action           text not null,
  entity           text not null,
  entity_id        text,
  details          jsonb,
  created_at       timestamptz not null default now()
);
create index audit_org_idx on public.audit_log (organization_id, created_at desc);

-- ---------------------------------------------------------------
-- Reference data: platform default categories, reasons, best practice categories
-- Colors: validated categorical palette, assigned in fixed order.
-- ---------------------------------------------------------------
insert into public.waste_categories (code, labels, co2e_per_kg, color, sort_order) values
  ('vegetables', '{"en":"Vegetables","nl":"Groenten"}', 2.0, '#2a78d6', 0),
  ('fruit',      '{"en":"Fruit","nl":"Fruit"}', 1.4, '#eb6834', 1),
  ('meat',       '{"en":"Meat","nl":"Vlees"}', 20.0, '#1baf7a', 2),
  ('fish',       '{"en":"Fish & seafood","nl":"Vis & schaaldieren"}', 6.0, '#eda100', 3),
  ('dairy',      '{"en":"Dairy & eggs","nl":"Zuivel & eieren"}', 6.5, '#e87ba4', 4),
  ('bread',      '{"en":"Bread & bakery","nl":"Brood & banket"}', 1.6, '#008300', 5),
  ('starch',     '{"en":"Rice, pasta & potatoes","nl":"Rijst, pasta & aardappel"}', 2.2, '#4a3aa7', 6),
  ('prepared',   '{"en":"Prepared food","nl":"Bereid voedsel"}', 4.0, '#e34948', 7),
  ('other',      '{"en":"Other","nl":"Overig"}', 2.5, '#8a8f8d', 8);

insert into public.waste_reasons (code, labels, sort_order) values
  ('overproduction', '{"en":"Overproduction","nl":"Overproductie"}', 0),
  ('spoilage',       '{"en":"Spoilage","nl":"Bedorven"}', 1),
  ('expired',        '{"en":"Expired","nl":"Over datum"}', 2),
  ('preparation',    '{"en":"Preparation waste","nl":"Bereidingsafval"}', 3),
  ('plate',          '{"en":"Plate waste","nl":"Bordrestjes"}', 4),
  ('storage',        '{"en":"Storage problem","nl":"Opslagprobleem"}', 5),
  ('ordering',       '{"en":"Incorrect ordering","nl":"Verkeerd besteld"}', 6),
  ('damaged',        '{"en":"Damaged product","nl":"Beschadigd product"}', 7),
  ('other',          '{"en":"Other","nl":"Overig"}', 8);

insert into public.categories (waste_category_id, code, labels, sort_order)
select wc.id, s.code, s.labels::jsonb, s.ord from (values
  ('vegetables','leafy','{"en":"Leafy greens","nl":"Bladgroenten"}',0),
  ('vegetables','roots','{"en":"Root vegetables","nl":"Wortelgroenten"}',1),
  ('vegetables','fruiting','{"en":"Fruiting vegetables","nl":"Vruchtgroenten"}',2),
  ('meat','poultry','{"en":"Poultry","nl":"Gevogelte"}',0),
  ('meat','beef','{"en":"Beef","nl":"Rund"}',1),
  ('meat','pork','{"en":"Pork","nl":"Varken"}',2),
  ('dairy','cheese','{"en":"Cheese","nl":"Kaas"}',0),
  ('dairy','milk','{"en":"Milk & cream","nl":"Melk & room"}',1),
  ('dairy','eggs','{"en":"Eggs","nl":"Eieren"}',2),
  ('prepared','soup','{"en":"Soup","nl":"Soep"}',0),
  ('prepared','sauce','{"en":"Sauce","nl":"Saus"}',1),
  ('prepared','mains','{"en":"Main course","nl":"Hoofdgerecht"}',2),
  ('prepared','buffet','{"en":"Buffet leftovers","nl":"Buffetresten"}',3)
) as s(cat, code, labels, ord) join public.waste_categories wc on wc.code = s.cat and wc.organization_id is null;

insert into public.best_practice_categories (code, labels, sort_order) values
  ('purchasing','{"en":"Purchasing","nl":"Inkoop"}',0), ('storage','{"en":"Storage","nl":"Opslag"}',1),
  ('production','{"en":"Production","nl":"Productie"}',2), ('service','{"en":"Service","nl":"Service"}',3),
  ('menu','{"en":"Menu design","nl":"Menu-ontwerp"}',4), ('guest','{"en":"Guest behaviour","nl":"Gastgedrag"}',5),
  ('training','{"en":"Training","nl":"Training"}',6), ('reuse','{"en":"Reuse & donation","nl":"Hergebruik & donatie"}',7);
