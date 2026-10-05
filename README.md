# WASTE log

Food waste registration and insight for hospitality kitchens. Kitchen staff register waste
in about ten seconds on a phone; managers see where waste comes from, what it costs and
whether targets are met.

**Live setup:** web app on GitHub Pages, data in Supabase (Postgres + Auth + Storage +
Edge Functions), daily ping via GitHub Actions. No server to maintain, free tiers only.

```
Phone / tablet / laptop ──► GitHub Pages (web/)  ──►  Supabase
                                                      ├─ Auth         logins
                                                      ├─ Postgres     data + Row Level Security + business logic
                                                      ├─ Storage      waste photos (private, per organization)
                                                      └─ Edge Functions
                                                           admin-users    create / change users
                                                           identify-food  AI photo suggestion (optional)
                                                           daily          weather + keep project active
GitHub Actions: deploy on push · daily keepalive ping
```

## Where things are

| Path | What |
|---|---|
| `web/` | The web app (plain JavaScript, no build step). `web/js/config.js` holds the Supabase URL and public key |
| `supabase/migrations/` | Database: schema, security rules, logic, storage, setup functions |
| `supabase/seed/demo.sql` | Demo data (`select app.seed_demo();`) and removal (`select app.remove_demo();`) |
| `supabase/functions/` | Edge functions |
| `test/` | Security and logic tests on a local Postgres (`npm test`) |
| `.github/workflows/` | Pages deploy and daily keepalive |

## Security in one paragraph

Every table has Row Level Security. What a user can see follows from their profile in the
database, never from the app: org admins see their whole organization, managers and
employees only their assigned restaurants, employees only their own waste records. Prices,
CO₂ and validation are calculated by a database trigger, so the app cannot send wrong values.
Users and roles can only be changed through the `admin-users` edge function, which re-checks
permissions. Photos are private and only reachable through short-lived signed links. Every
change is written to an audit log. `npm test` runs the isolation tests against the real migrations.

## Demo accounts (password `demo1234`)

| Role | Email |
|---|---|
| Organization Admin | `orgadmin@hth.demo` |
| Manager Amsterdam (Amsterdam Restaurant, Brasserie ZINQ) | `manager.amsterdam@hth.demo` |
| Manager Den Haag (The Hague Restaurant, Le Début) | `manager.denhaag@hth.demo` |
| Student (Amsterdam Restaurant) | `student@hth.demo` |
| Super Admin | `admin@platform.demo` |
| Other organization, for isolation checks | `admin@bistro.demo` |

All demo records are flagged and the app shows a **DEMO DATA** banner.

## Going live with a real kitchen

In the Supabase SQL editor:

```sql
-- 1. Create the real organization, first restaurant and your admin login
select app.bootstrap('Hotelschool The Hague', 'Amsterdam Restaurant', 'Amsterdam', 52.37, 4.90,
                     'you@hotelschool.nl', 'choose-a-long-password', 'Your Name');

-- 2. Remove the demo data when you no longer need it.
--    First paste and run the app.remove_demo() function from supabase/seed/demo.sql (once), then:
select app.remove_demo();
```

Then set `SHOW_DEMO_LOGINS = false` in `web/js/config.js`, sign in, and add products,
suppliers, dishes and users under **Settings**.

## Optional: AI photo suggestions

In Supabase: **Edge Functions → Secrets**, add `ANTHROPIC_API_KEY`. Without it, photos are
still saved and staff pick the product themselves. AI never blocks saving.

## Development

```bash
npm install
npm test                         # security + logic tests on local Postgres (PGlite)
python3 -m http.server -d web    # open http://localhost:8000 (uses the live Supabase project)
```

Database changes: add a new file in `supabase/migrations/` and apply it to the project.
