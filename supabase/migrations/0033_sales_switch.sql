-- 0033  Sales is an option per organization (Settings › Organization), off by default.
-- Off: no Settings › Sales, no "Link till items", no sales figures on the dashboard; guests are entered by hand.
alter table public.organizations add column if not exists sales_enabled boolean not null default false;

do $do$
declare d text;
begin
  d := pg_get_functiondef('public.app_meta(bigint, text)'::regprocedure);
  if position('''sales_enabled''' in d) = 0 then
    if position('''leaderboard_prize'', o.leaderboard_prize' in d) = 0 then raise exception 'app_meta: pattern not found'; end if;
    d := replace(d, '''leaderboard_prize'', o.leaderboard_prize', '''leaderboard_prize'', o.leaderboard_prize, ''sales_enabled'', o.sales_enabled');
    execute d;
  end if;
end $do$;
