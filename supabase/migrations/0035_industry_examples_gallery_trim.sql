-- 0035  1. Gallery: inedible trim is hidden by default (p_trim: null/'hide' = hide, 'show' = all, 'only' = only trim).
--          A new function next to the old one, so the old signature keeps working.
--       2. Industry examples: a short, curated list of published cases from elsewhere, shown under
--          Best practices › From the industry. Same for every organization, read-only in the app, always with a
--          source. Kept apart from the organization's own best practices (own measurements vs other people's claims).

do $$
declare src text; n text;
begin
  src := pg_get_functiondef('public.gallery(bigint, bigint, date, date, bigint, int, int, text, text, text)'::regprocedure);
  n := replace(src, 'FUNCTION public.gallery(', 'FUNCTION public.gallery_photos(');
  n := replace(n, 'p_weight text DEFAULT NULL::text)', 'p_weight text DEFAULT NULL::text, p_trim text DEFAULT NULL::text)');
  n := replace(n, $q$or (p_weight = 'measured' and w.weight_source is distinct from 'estimate'))$q$,
                  $q$or (p_weight = 'measured' and w.weight_source is distinct from 'estimate'))
       and (case coalesce(p_trim, 'hide') when 'show' then true
              when 'only' then not app.reason_avoidable(w.reason_id) else app.reason_avoidable(w.reason_id) end)$q$);
  if position('gallery_photos' in n) = 0 or position('p_trim text' in n) = 0 or position('reason_avoidable' in n) = 0 then
    raise exception 'gallery: pattern not found'; end if;
  execute n;
end $$;
revoke execute on function public.gallery_photos(bigint, bigint, date, date, bigint, int, int, text, text, text, text) from anon, public;
grant execute on function public.gallery_photos(bigint, bigint, date, date, bigint, int, int, text, text, text, text) to authenticated;

create table if not exists public.industry_examples (
  id                bigint generated always as identity primary key,
  code              text not null unique,
  who               text not null,
  place             text,
  year              text,
  category_id       bigint references public.best_practice_categories(id),
  title             jsonb not null,
  solution          jsonb not null,
  result            jsonb,
  result_change_pct numeric,
  source_name       text not null,
  source_url        text not null,
  reason_codes      text[] not null default '{}',
  sort_order        int not null default 0,
  is_active         boolean not null default true
);
alter table public.industry_examples enable row level security;
create policy industry_examples_read on public.industry_examples for select to authenticated using (is_active);
grant select on public.industry_examples to authenticated;

insert into public.industry_examples (code, who, place, year, category_id, title, solution, result, result_change_pct, source_name, source_url, reason_codes, sort_order)
select v.code, v.who, v.place, v.year, (select c.id from public.best_practice_categories c where c.code = v.cat and c.organization_id is null),
       v.title::jsonb, v.solution::jsonb, v.result::jsonb, v.pct, v.src, v.url, v.reasons, v.ord
from (values
  ('nassen', 'Het Nieuwe Nassen', 'Rotterdam, NL', '2025', 'training',
   '{"en":"Measure, share, repeat: 16 Rotterdam venues","nl":"Meten, delen, herhalen: 16 Rotterdamse zaken"}',
   '{"en":"Sixteen restaurants, hotels and event venues, including Hotel New York and Euromast, measured their food waste for six months with Wageningen University and discussed the results with their teams. About half turned out to be food that was prepared but never served.","nl":"Zestien restaurants, hotels en eventlocaties, waaronder Hotel New York en Euromast, maten een half jaar hun verspilling met Wageningen University en bespraken de uitkomsten met hun teams. Ongeveer de helft bleek bereid maar niet uitgeserveerd eten."}',
   '{"en":"From 68 to 43 g per guest: 37% less in six months.","nl":"Van 68 naar 43 gram per gast: 37% minder in zes maanden."}',
   -37, 'Samen Tegen Voedselverspilling', 'https://samentegenvoedselverspilling.nl/en/knowledge-base/rotterdamse-horeca-reduceert-voedselverspilling-met-nieuwe-nassen',
   '{overproduction}'::text[], 1),
  ('nwc020', 'No Waste Challenge 020', 'Amsterdam, NL', '2024', 'training',
   '{"en":"Show the team its own waste, every week","nl":"Laat het team elke week zijn eigen verspilling zien"}',
   '{"en":"Sixteen Amsterdam hotels, Hotelschool The Hague among them, measured their waste and shared the results, photos included, with the kitchen team every week. Food waste became part of the onboarding of new staff.","nl":"Zestien Amsterdamse hotels, waaronder Hotelschool The Hague, maten hun verspilling en deelden de resultaten, met foto''s, elke week met het keukenteam. Voedselverspilling werd onderdeel van de onboarding van nieuwe medewerkers."}',
   '{"en":"26% less on average, from a start of 71 g per guest. 47% of the waste was prepared food.","nl":"Gemiddeld 26% minder, vanaf een start van 71 gram per gast. 47% van de verspilling was bereid eten."}',
   -26, 'Samen Tegen Voedselverspilling', 'https://samentegenvoedselverspilling.nl/kennisbank/resultaten-no-waste-challenge-020',
   '{overproduction,plate}'::text[], 2),
  ('hilton', 'Hilton', '45 hotels, 14 countries', '2025', 'service',
   '{"en":"Smaller buffets, cooked to order","nl":"Kleinere buffetten, op bestelling bereid"}',
   '{"en":"Hilton measured plate waste and ran a campaign aimed at guests. During Green Ramadan 2025 the buffets were smaller and partly cooked to order.","nl":"Hilton mat het bordafval en voerde een campagne gericht op gasten. Tijdens Green Ramadan 2025 waren de buffetten kleiner en deels op bestelling bereid."}',
   '{"en":"26% less plate waste; 4.7 million meals a year kept out of the bin.","nl":"26% minder bordafval; 4,7 miljoen maaltijden per jaar niet in de bak."}',
   -26, 'Hilton Stories', 'https://stories.hilton.com/travel-with-purpose/hiltons-efforts-in-reducing-food-waste',
   '{plate,overproduction}'::text[], 3),
  ('langham', 'Langham Hospitality Group', 'Worldwide', '2026', 'menu',
   '{"en":"One by-product on the menu, in every kitchen","nl":"Eén reststroom op de kaart, in elke keuken"}',
   '{"en":"Langham made upcycling group policy instead of a project of one keen chef: every kitchen has to turn at least one by-product into a dish or drink that is sold.","nl":"Langham maakte upcyclen groepsbeleid in plaats van een project van één enthousiaste chef: elke keuken moet minstens één reststroom omzetten in een gerecht of drankje dat verkocht wordt."}',
   '{"en":"A standing assignment for every kitchen in the group.","nl":"Een vaste opdracht voor elke keuken in de groep."}',
   null, 'Rus Tourism News', 'https://www.rustourismnews.com/2026/07/16/langham-hospitality-group-tackles-food-waste-with-creative-upcycling-across-hotels/',
   '{preparation,inedible}'::text[], 4),
  ('cordis', 'Cordis Auckland', 'Auckland, NZ', '2026', 'production',
   '{"en":"Juice peel becomes marmalade on the same buffet","nl":"Schil van de jus wordt marmelade op hetzelfde buffet"}',
   '{"en":"The fresh juice station leaves peel and pulp every morning. It now becomes a marmalade compote served with the yoghurt on the same breakfast buffet.","nl":"De vers geperste jus levert elke ochtend schil en pulp op. Die wordt nu een marmeladecompote bij de yoghurt op hetzelfde ontbijtbuffet."}',
   '{"en":"About 390 kg less organic waste a year, with no extra purchasing.","nl":"Circa 390 kilo minder organisch afval per jaar, zonder extra inkoop."}',
   null, 'Rus Tourism News', 'https://www.rustourismnews.com/2026/07/16/langham-hospitality-group-tackles-food-waste-with-creative-upcycling-across-hotels/',
   '{inedible,preparation}'::text[], 5),
  ('langham-boston', 'The Langham Boston', 'Boston, USA', '2026', 'menu',
   '{"en":"Fish trimmings become a burger on the menu","nl":"Visafsnijdsels worden een burger op de kaart"}',
   '{"en":"Portioning cod and salmon leaves trimmings that are too good for the bin and too small for a plate. They became the Coastal Catch Burger, a permanent menu item.","nl":"Bij het portioneren van kabeljauw en zalm blijven afsnijdsels over die te goed zijn voor de bak en te klein voor een bord. Ze werden de Coastal Catch Burger, een vast item op de kaart."}',
   '{"en":"About 220 kg of fish a year is sold instead of thrown away.","nl":"Circa 220 kilo vis per jaar wordt verkocht in plaats van weggegooid."}',
   null, 'Rus Tourism News', 'https://www.rustourismnews.com/2026/07/16/langham-hospitality-group-tackles-food-waste-with-creative-upcycling-across-hotels/',
   '{preparation}'::text[], 6),
  ('langham-bar', 'Eaton Hong Kong and The Langham Gold Coast', 'Hong Kong and Australia', '2026', 'reuse',
   '{"en":"The bar as by-product kitchen","nl":"De bar als reststroomverwerker"}',
   '{"en":"The bar infuses leftover citrus peel into Lillet and uses spent espresso grounds to flavour rum. Gold Coast turns wagyu trim into kushiyaki skewers and renders the fat into its own tallow.","nl":"De bar trekt overgebleven citrusschil in Lillet en gebruikt koffiedik uit de espressomachine om rum op smaak te brengen. Gold Coast maakt van wagyu-afsnijdsels kushiyaki-spiesjes en smelt het vet tot eigen tallow."}',
   '{"en":"Two cocktails made entirely from by-products (Eaton Hong Kong).","nl":"Twee cocktails volledig uit reststromen (Eaton Hong Kong)."}',
   null, 'Rus Tourism News', 'https://www.rustourismnews.com/2026/07/16/langham-hospitality-group-tackles-food-waste-with-creative-upcycling-across-hotels/',
   '{inedible,preparation}'::text[], 7),
  ('tgtg', 'Too Good To Go', 'Worldwide', '2025', 'reuse',
   '{"en":"Sell the end-of-day surplus","nl":"Verkoop het overschot aan het eind van de dag"}',
   '{"en":"Food that is left at closing time is sold as a surprise bag through the app: an extra sales channel at an hour that otherwise brings in nothing.","nl":"Eten dat bij sluitingstijd over is, gaat als verrassingspakket via de app weg: een extra verkoopkanaal op een uur dat anders niets oplevert."}',
   '{"en":"Almost 157 million meals saved in 2025; 423,859 t CO2e avoided.","nl":"Bijna 157 miljoen maaltijden gered in 2025; 423.859 ton CO2e vermeden."}',
   null, 'RetailDetail', 'https://www.retaildetail.eu/news/food/too-good-to-go-will-save-157-million-meals-by-2025/',
   '{overproduction}'::text[], 8),
  ('careit', 'Careit', 'USA', '2025', 'reuse',
   '{"en":"Donating without the paperwork","nl":"Doneren zonder rompslomp"}',
   '{"en":"Donation software that removes the biggest objection: the kitchen reports in the app what is left, a nearby charity claims it, and logistics and records run automatically.","nl":"Donatiesoftware die het grootste bezwaar wegneemt: de keuken meldt in de app wat er over is, een goed doel in de buurt claimt het, en logistiek en registratie lopen automatisch."}',
   '{"en":"Clean Memphis saved more than 113 t of food with it in 2025.","nl":"Clean Memphis redde er in 2025 ruim 113 ton voedsel mee."}',
   null, 'NRDC', 'https://www.nrdc.org/bio/yvette-cabrera/2025-wins-food-waste-and-whats-next-2026',
   '{overproduction}'::text[], 9),
  ('spain', 'Spain, Law 1/2025', 'Spain', '2026', 'guest',
   '{"en":"A free doggy bag, on the menu","nl":"Een gratis doggy bag, op de kaart"}',
   '{"en":"Restaurants must offer guests a free container to take leftovers home and say so on the menu (buffets excepted). Larger businesses also need a prevention plan and a donation agreement with a charity.","nl":"Restaurants moeten gasten kosteloos een bakje aanbieden om restjes mee te nemen en dat op de kaart vermelden (buffetten uitgezonderd). Grotere zaken hebben daarnaast een preventieplan en een donatieafspraak met een goed doel nodig."}',
   '{"en":"In force since 5 April 2026, with fines up to EUR 500,000 for repeated offences. Spanish law, not EU law.","nl":"Van kracht sinds 5 april 2026, met boetes tot 500.000 euro bij herhaling. Spaanse wet, geen Europees recht."}',
   null, 'The Spanish Eye', 'https://www.thespanisheye.com/2026/04/05/new-food-waste-law-kicks-in-for-restaurants-and-supermarkets-across-spain-with-fines-of-up-to-e500000/',
   '{plate}'::text[], 10),
  ('guardians', 'Guardians of Grub (WRAP)', 'United Kingdom', 'ongoing', 'training',
   '{"en":"Free tools, chef ambassadors, one action month a year","nl":"Gratis tools, chef-ambassadeurs, één actiemaand per jaar"}',
   '{"en":"A permanent, free campaign for all of hospitality, from fine dining to the village pub: tools without sign-up, chef ambassadors with a name and a face, and the yearly Stand Up For Food month that makes it news again.","nl":"Een permanente, gratis campagne voor de hele horeca, van sterrenrestaurant tot dorpspub: tools zonder aanmelding, chef-ambassadeurs met naam en gezicht, en de jaarlijkse Stand Up For Food-maand die het steeds weer nieuws maakt."}',
   '{"en":"Built on the finding that 75% of the GBP 3 billion wasted yearly in UK hospitality was edible.","nl":"Gebouwd op het gegeven dat 75% van de 3 miljard pond die de Britse horeca jaarlijks verspilt eetbaar was."}',
   null, 'WRAP', 'https://www.wrap.ngo/taking-action/food-drink/initiatives/guardians-grub',
   '{}'::text[], 11),
  ('uaw', 'United Against Waste', 'Germany and Austria', 'ongoing', 'production',
   '{"en":"Measure waste as a share of the meals served","nl":"Meet verspilling als deel van de uitgegeven maaltijden"}',
   '{"en":"Express waste as a percentage of the meals served, not only in kilos. Then a restaurant with forty covers can compare itself with a hotel with four hundred rooms.","nl":"Druk verspilling uit als percentage van de uitgegeven maaltijden, niet alleen in kilo''s. Dan kan een zaak met veertig couverts zich vergelijken met een hotel met vierhonderd kamers."}',
   '{"en":"In the measured kitchens waste ranged from 3% to 46% of the meals served; hotels and restaurants 15 to 19%, large catering kitchens 29%. Over 215 sites now monitor continuously.","nl":"In de gemeten keukens liep de verspilling van 3% tot 46% van de uitgegeven maaltijden; hotels en restaurants 15 tot 19%, grootkeukens 29%. Ruim 215 locaties monitoren inmiddels doorlopend."}',
   null, 'United Against Waste', 'https://united-against-waste.at/erheben/ergebnisse-der-testerhebung/',
   '{overproduction,plate}'::text[], 12),
  ('hotelkitchen', 'Hotel Kitchen (WWF and AHLA)', 'USA', 'ongoing', 'training',
   '{"en":"Prevent, donate, divert: a free hotel toolkit","nl":"Voorkomen, doneren, verwerken: een gratis toolkit voor hotels"}',
   '{"en":"A free toolkit for hotels built on three steps, prevent, donate and divert, with training videos and guides for a waste audit.","nl":"Een gratis toolkit voor hotels rond drie stappen, voorkomen, doneren en verwerken, met trainingsvideo''s en handleidingen voor een afvalmeting."}',
   '{"en":"Pilot hotels cut waste by 10 to 38% in twelve weeks; many saved at least 3% on food cost. More than 36,000 staff have been trained.","nl":"Pilothotels verminderden hun verspilling met 10 tot 38% in twaalf weken; veel bespaarden minstens 3% op foodcost. Ruim 36.000 medewerkers zijn getraind."}',
   null, 'Hotel Kitchen', 'https://hotelkitchen.org/about-toolkit/',
   '{overproduction,spoilage}'::text[], 13),
  ('upcycled', 'Misfits Market and Upcycled Certified', 'USA and international', '2025', 'purchasing',
   '{"en":"Buy upcycled ingredients","nl":"Koop geüpcyclede ingrediënten"}',
   '{"en":"Bread baked with brewers'' spent grain, the residue breweries usually send off as cattle feed, sold on taste with the story small on the pack. The Upcycled Certified label makes such products easy to find.","nl":"Brood gebakken met bierbostel, het restproduct dat brouwerijen meestal als veevoer afvoeren, verkocht op smaak met het verhaal klein op de verpakking. Het keurmerk Upcycled Certified maakt zulke producten makkelijk te vinden."}',
   '{"en":"622 certified upcycled products from 106 brands at the end of 2025.","nl":"622 gecertificeerde geüpcyclede producten van 106 merken eind 2025."}',
   null, 'Prepared Foods', 'https://www.preparedfoods.com/articles/131208-upcycled-food-movement-gains-scale-credibility-and-global-momentum-in-2025',
   '{}'::text[], 14),
  ('dubai', 'Dubai food waste to fertiliser', 'Dubai, UAE', '2025', 'reuse',
   '{"en":"Separate it, and the city turns it into fertiliser","nl":"Scheiden, en de stad maakt er meststof van"}',
   '{"en":"Farms, restaurants and hotels deliver their food waste to one city-wide programme that turns it into fertiliser for farming. Kitchens only have to separate it.","nl":"Boerderijen, restaurants en hotels leveren hun voedselafval aan één stadsbreed programma dat er meststof voor de landbouw van maakt. Keukens hoeven alleen te scheiden."}',
   '{"en":"More than 1 million kg processed since 2021.","nl":"Meer dan 1 miljoen kilo verwerkt sinds 2021."}',
   null, 'World Economic Forum', 'https://www.weforum.org/stories/2025/04/innovations-to-reduce-food-waste/',
   '{inedible}'::text[], 15)
) as v(code, who, place, year, cat, title, solution, result, pct, src, url, reasons, ord)
on conflict (code) do nothing;
