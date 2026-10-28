# Architecture

Updated 28 October 2026, after migration 0043. Source of truth is the code in the
`Joost1305/waste-log` repo; this document describes what is actually built.

## 1. Product architecture

```
Phone / tablet / laptop
        │
        ▼
GitHub Pages: web/  (plain JavaScript, no build step)
        │  supabase-js (Auth + PostgREST RPC + Storage + Edge Functions)
        ▼
Supabase project "waste-log" (eu-central-1)
 ├─ Auth            logins, invitations, password links
 ├─ Postgres        all data, Row Level Security, business logic as SQL functions and triggers
 ├─ Storage         private buckets: waste photos and invoices, one folder per organization
 └─ Edge Functions  admin-users · identify-food · read-invoice · suggest-ideas · daily · weekly-report · system-check

GitHub Actions
 ├─ pages.yml         deploy web/ on every push to main
 ├─ keepalive.yml     every hour: calls the daily function (weather, weekly e-mails, keeps the free project awake)
 └─ system-check.yml  every morning before service: morning system check, the job fails when something is red
```

**No own server.** The browser talks to Supabase directly. `web/js/backend.js` keeps an
`/api/...`-style router inside the browser, so pages call `api('/dashboard')` etc. and the
router maps that onto Supabase RPCs and tables.

**Principle: complexity at the back.** The kitchen screen asks what, weight, reason, save.
Prices, CO₂, validation, weather and AI happen in the database and edge functions.

**Principle: DATA + RULES + AI.** Figures are computed from records. AI is always a
suggestion, validated, labelled as such, and never needed to save a record.

## 2. Technology choices

| Choice | Why |
|---|---|
| Supabase (Postgres, Auth, Storage, Edge Functions) | No server to maintain, free tier, security in the database itself |
| Plain JavaScript modules, no build step | Runs anywhere, nothing to break, fast on old kitchen tablets |
| GitHub Pages | Free hosting, deploy on push |
| Chart.js, pdf.js (self-hosted in `web/vendor/`) | No CDN dependency |
| Anthropic Claude (vision) in edge functions | Photo recognition and invoice reading; app works without a key |
| Open-Meteo | Free weather without API key |
| PGlite for tests | `npm test` runs all migrations on a local Postgres and checks security and logic |

## 3. Roles and permissions

Roles have a rank; Row Level Security checks the rank and the restaurants a user is assigned to.

| Role | Rank | Sees |
|---|---|---|
| Employee / Student | 10 | Assigned restaurants; only own waste records |
| Restaurant Manager | 30 | Assigned restaurants: all records, dashboard, catalog, guests, invoices |
| Organization Admin | 50 | Whole organization: also restaurants, users, targets, organization settings, audit log |
| Super Admin | 100 | All organizations, new organizations, system check |

Users and roles can only be changed through the `admin-users` edge function, which re-checks
permissions. A user can never grant a role above their own.

## 4. Security and multi-tenancy

- Every table has Row Level Security; what a user sees follows from their profile in the database, never from the app.
- Every tenant table has `organization_id`; restaurant data also `restaurant_id`.
- Prices, CO₂ and validation are set by a database trigger, so the app cannot send wrong values.
- Photos and invoices are private, reachable only through short-lived signed links.
- Every change goes to `audit_log`.
- The morning system check verifies that every public table has RLS on and no anonymous access (0039).
- Demo organizations hold flagged demo data and show a DEMO DATA banner.

## 5. Data model

Schema in `supabase/migrations/` (0001 to 0043). Groups:

- **Tenancy:** organizations, restaurants (incl. `open_days`, coordinates), roles, users, user_restaurants, sections, audit_log
- **Taxonomy:** waste_categories (+ CO₂ factor), categories, waste_reasons (avoidable or not; inedible trim counts in kg and CO₂ but not in euros)
- **Purchasing:** suppliers, products (prices, CO₂ per product from RIVM, English name), invoices, invoice_items
- **Sales (optional per organization):** sales_reports, sales_lines, sales_groups, sales_item_links
- **Menu and guests:** menu_items, menu_waste, daily_covers
- **Waste:** waste_records (weight, weight source: weighed / scale photo / AI estimate, valuation, CO₂, photo, AI suggestion and whether it was accepted)
- **Context:** weather_records
- **Improvement loop:** targets (week / month / year, baseline), interventions, framework_principles + intervention_principles (SENSE), best_practices, prevention_ideas, leaderboard_awards, industry_examples
- **Reporting:** report_subscriptions (weekly e-mail), impact_reports (public page)
- **Research (tables ready, no screens yet):** research_projects, research_groups, research_participants, questionnaires, questionnaire_questions, questionnaire_responses
- **Operations:** system_checks, job_runs

## 6. Pages

| Route | Who | What |
|---|---|---|
| `#/register` | everyone | Register waste; quick buttons from most-registered products; today's weather and team streak in the header; kitchen mode |
| `#/records` | everyone (own) / managers (all) | List with filters, weather per day, correct or delete |
| `#/gallery` | everyone | Waste photos, heaviest first; filter estimated vs weighed; inedible trim hidden by default; slideshow; impact poster (managers and up) |
| `#/dashboard` | managers and up | Summary line, KPIs, daily chart, by category / reason / product / section, weather and waste, print, Excel export |
| `#/interventions` | everyone | Suggested interventions (managers and up), interventions with before/after effect, best-practice library |
| `#/leaderboard` | when switched on | Sections within a restaurant, prevention ideas |
| `#/settings/...` | per permission | Products, suppliers, invoices, menu, guests per day, targets, restaurants, users, sales, weekly e-mail, leaderboard, export, organization, audit, organizations, system check |
| `#/profile` | everyone | Name, language, password |
| `#/impact` | public, by link | Aggregated waste trend of a restaurant or organization |

## 7. Dashboard rules

- **A day without registrations is no data, never zero waste.** It is left out of every average and reported as "open days without registrations".
- **Closed days do not count** (0041). Days outside `restaurants.open_days` are never in an average and never the "best day". Waste logged on a closed day stays in the total kilos.
- With several restaurants selected, a weekday counts as open when at least one of them is open.
- "Per registered day" = kilos on open, registered days divided by the number of those days. The summary line and the Total waste card use the same calculation.
- Best day: lowest waste (per guest when guest numbers are there for most days), only days with at least half the usual number of registrations, at least 3 candidate days.
- Guests only count on days that were registered, otherwise waste per guest looks too low.
- Baseline per day is derived from the target's baseline per week, month or year and the share of open weekdays.

Daily figures come from `dashboard_daily` (one row per calendar day, with `open`, registrations, kg, avoidable kg, guests, weather); totals from `dashboard`.

## 8. Weather

- **Collected by** the `daily` edge function, every hour via `keepalive.yml`: yesterday and today from Open-Meteo for every restaurant with coordinates, only when the organization has weather switched on (Settings › Organization). Stored in `weather_records`.
- **Shown in:** the Register header (today's weather), a weather column in Records, rain days shaded in the dashboard's daily chart (weather in the tooltip), and the "Weather and waste" card on the dashboard.
- **Weather and waste card:** avoidable waste only; each day is compared with what is usual for that weekday; buckets warm / mild / cold and rain / dry. It shows "still collecting" until there are at least 20 comparable days, 3 registered days per weekday and 5 days per weather type.

## 9. AI

| Function | Edge function | Status |
|---|---|---|
| Recognise food and estimate or read weight from a photo | `identify-food` | Live with `ANTHROPIC_API_KEY` |
| Read supplier invoices (PDF, photo, Excel/CSV) | `read-invoice` | Live with key; manager checks every line |
| Suggested interventions from rules | `intervention_suggestions` (SQL, 0042) | Live, no AI |
| AI ideas for a suggestion | `suggest-ideas` | Live with key; numbers recomputed server-side, ideas with invented figures dropped |

- Without a key the functions answer `{ available: false }` and the app continues manually.
- Output is validated and mapped onto the organization's own categories and products; unknown output is discarded.
- The suggestion and whether the user accepted or corrected it are stored with the record.

## 10. Scheduled jobs and monitoring

- **Hourly (`daily`):** weather, weekly impact e-mails on the chosen weekdays or dates, heartbeat for the system check. Idempotent.
- **Morning system check (`system-check`):** tests every connection, lists important setting changes of the last 24 hours and gaps in the data, stores the result (Settings › System check). Red makes the GitHub job fail, which sends an e-mail.

## 11. Roadmap

| Phase | Content | Status |
|---|---|---|
| 1 | Auth, organizations, restaurants, users, waste registration, dashboard, targets | Done |
| 2 | AI photo recognition, invoice upload and reading, CO₂ per product, sales reports | Done (sales optional per organization) |
| 3 | Interventions and effect, best practices, leaderboard, weekly e-mail, rule-based suggestions with AI ideas | Done |
| 4 | Research mode: projects, test/control groups, questionnaires, anonymised export | Tables ready, no screens |
| 5 | Public impact page, weather correlation, external integrations (scales, POS) | Impact page and weather card done; integrations not built |

## 12. Changing the database

New migrations go in `supabase/migrations/` with the next number. Several later migrations
patch an existing function by text replacement (`pg_get_functiondef` + `replace`) and stop
with an error when the expected text is not found, so they must be applied in order.
Run `npm test` before pushing; apply the migration to the live project after the push.

## 13. Suggested interventions and impact poster

**Suggested interventions** (`intervention_suggestions`, 0042) look at the last 28 days of avoidable waste per
restaurant and flag five patterns: one product is 15% or more of the kilos (`product`) or of the euros (`costly`),
one product spoils or expires on 3 or more different days (`spoilage`), one dish comes back as plate waste 3 or more
times (`plate`), one open weekday is 1.5 times or more the other open days (`weekday`). Patterns already covered by an
active or planned intervention (same dish, or the product name in its title) are left out. Each suggestion carries
up to 2 examples: a published best practice of the organization with the same reason first, then industry examples.
The Interventions page shows at most 3, never two about the same thing, each with a "Start this" button that fills
in a new intervention (title, why, restaurant, reason, category or dish). Numbers come from the rules only.

When the rules find nothing for a restaurant (too little data), the biggest avoidable product of the window is shown
as an **early signal** (rule `early`, 0043), with the number of registrations it is based on.

**Ask AI for ideas** calls the `suggest-ideas` edge function. It does not trust the browser: it calls
`intervention_suggestions` again as the signed-in user, picks the matching suggestion, adds up to 2 recent photos of
that product or dish, and asks Claude for 2 or 3 concrete interventions. Ideas are labelled as AI; any idea that
contains a figure not present in the facts (other than clock times and small counts) is discarded. "Start this" on an
idea fills in its title and description.

**Impact poster** (`web/js/poster.js`, gallery) prints one A4 page for this or last month. Blame-free by design:
we-language, no names or sections, the good news first (only when waste per day fell 3% or more, otherwise the
number of registrations), a question under the heaviest photo, reasons instead of people, one thing we are trying
now, and an empty box for ideas.
