-- Tables added after 0002_security still had default anon grants.
-- All their policies are authenticated-only, so anon never needed them.
revoke all on table
  public.industry_examples,
  public.job_runs,
  public.leaderboard_awards,
  public.prevention_ideas,
  public.report_subscriptions,
  public.sales_groups,
  public.sales_item_links,
  public.sales_lines,
  public.sales_reports,
  public.sections,
  public.system_checks
from anon;

-- Stop future tables in public from getting anon grants automatically.
alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
