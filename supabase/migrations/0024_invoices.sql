-- 0024  Supplier invoices: upload (PDF, photo, Excel), AI reads the lines, a manager checks and saves.
-- Saved invoice lines with a product and kilos give "invoice prices": waste of that product in the 90 days
-- after the invoice date is valued at the invoice price (most specific price wins, see waste_before).

-- Private bucket, one folder per organization; managers and up only
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoices', 'invoices', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy invoices_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'invoices' and app.rank() >= 30 and (
    (storage.foldername(objects.name))[1] = 'org-' || (app.org())::text
    or (app.is_super() and exists (select 1 from public.organizations o
         where o.deleted_at is null and 'org-' || o.id::text = (storage.foldername(objects.name))[1]))));
create policy invoices_files_select on storage.objects for select to authenticated
  using (bucket_id = 'invoices' and app.rank() >= 30
         and ((storage.foldername(objects.name))[1] = 'org-' || (app.org())::text or app.is_super()));

-- Bulk revaluation should not flood the audit log with one line per touched registration
do $$
declare src text; n text;
begin
  src := pg_get_functiondef('app.audit_row()'::regprocedure);
  if position('app.revalue' in src) = 0 then
    n := replace(src, 'begin
  if tg_op = ''UPDATE'' and (to_jsonb(old)', 'begin
  if tg_table_name = ''waste_records'' and tg_op = ''UPDATE'' and current_setting(''app.revalue'', true) = ''on'' then return new; end if;
  if tg_op = ''UPDATE'' and (to_jsonb(old)');
    if n = src then raise exception 'audit_row: pattern not found'; end if;
    execute n;
  end if;
end $$;

-- Recalculate the value of registrations of these products in [from, to] (the trigger picks the price)
create or replace function app.revalue_waste(p_org bigint, p_products bigint[], p_from date, p_to date)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  if p_products is null or cardinality(p_products) = 0 then return 0; end if;
  perform set_config('app.revalue', 'on', true);
  update public.waste_records w set updated_at = now()
   where w.organization_id = p_org and w.deleted_at is null and w.product_id = any (p_products)
     and w.recorded_at >= (p_from::timestamp at time zone 'Europe/Amsterdam')
     and w.recorded_at < ((p_to + 1)::timestamp at time zone 'Europe/Amsterdam');
  get diagnostics n = row_count;
  perform set_config('app.revalue', 'off', true);
  return n;
end $$;
revoke execute on function app.revalue_waste(bigint, bigint[], date, date) from public, anon, authenticated;

-- Save (create or replace) an invoice with its lines. p: { id?, restaurant_id?, supplier_id?, supplier_name?,
-- invoice_number?, invoice_date, total_amount?, file_path?, original_filename?, extraction_raw?, update_prices?,
-- items: [{ description, product_id?, quantity?, unit?, quantity_kg?, unit_price?, line_total?, confidence? }] }
create or replace function public.save_invoice(p jsonb, p_org bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_org  bigint := app.effective_org(p_org);
  v_id   bigint := nullif(p ->> 'id', '')::bigint;
  v_rest bigint := nullif(p ->> 'restaurant_id', '')::bigint;
  v_sup  bigint := nullif(p ->> 'supplier_id', '')::bigint;
  v_date date := nullif(p ->> 'invoice_date', '')::date;
  v_old  record;
  v_old_date date;
  v_items jsonb := coalesce(p -> 'items', '[]'::jsonb);
  it jsonb;
  v_prod bigint; v_kg numeric; v_total numeric; v_ppk numeric;
  v_products bigint[] := '{}';
  v_lines int := 0; v_matched int := 0; v_prices int := 0; v_reval int := 0;
  v_from date; v_to date;
begin
  if app.rank() < 30 or not app.in_org(v_org) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_date is null then raise exception 'Invoice date is required' using errcode = '22023'; end if;
  if v_date > app.local_date(now()) + 1 or v_date < app.local_date(now()) - 800 then raise exception 'Invoice date is not plausible' using errcode = '22023'; end if;
  if jsonb_typeof(v_items) <> 'array' or jsonb_array_length(v_items) = 0 then raise exception 'Add at least one line' using errcode = '22023'; end if;
  if jsonb_array_length(v_items) > 400 then raise exception 'Too many lines' using errcode = '22023'; end if;
  if v_rest is not null and not (v_rest = any (app.restaurant_ids())) then raise exception 'Restaurant not found' using errcode = 'P0002'; end if;
  if v_rest is null and app.rank() < 50 and app.org_restaurant_count(v_org) > cardinality(app.restaurant_ids()) then
    raise exception 'Choose a restaurant' using errcode = '22023'; end if;

  -- Supplier: existing one, or create it by name
  if v_sup is not null and not exists (select 1 from public.suppliers s where s.id = v_sup and s.organization_id = v_org and s.deleted_at is null) then
    raise exception 'Unknown supplier' using errcode = '22023'; end if;
  if v_sup is null and nullif(btrim(p ->> 'supplier_name'), '') is not null then
    select s.id into v_sup from public.suppliers s
     where s.organization_id = v_org and s.deleted_at is null and lower(s.name) = lower(btrim(p ->> 'supplier_name')) limit 1;
    if v_sup is null then
      insert into public.suppliers (organization_id, name) values (v_org, left(btrim(p ->> 'supplier_name'), 120)) returning id into v_sup;
    end if;
  end if;

  if v_id is not null then
    select * into v_old from public.invoices i where i.id = v_id and i.organization_id = v_org and i.deleted_at is null;
    if not found then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    if v_old.restaurant_id is not null and not (v_old.restaurant_id = any (app.restaurant_ids())) then raise exception 'Invoice not found' using errcode = 'P0002'; end if;
    v_old_date := v_old.invoice_date;
    select coalesce(array_agg(distinct ii.product_id) filter (where ii.product_id is not null), '{}') into v_products
      from public.invoice_items ii where ii.invoice_id = v_id;
    -- Editing keeps history: the old version is set aside and a new one is saved with the same file
    update public.invoices set deleted_at = now() where id = v_id;
    p := p || jsonb_build_object('file_path', v_old.file_path, 'original_filename', v_old.original_filename,
                                 'extraction_raw', v_old.extraction_raw);
    v_id := null;
  end if;
  if v_id is null then
    if v_old_date is null and nullif(p ->> 'file_path', '') is not null and (p ->> 'file_path') not like ('org-' || v_org || '/%') then
      raise exception 'Invalid file' using errcode = '22023'; end if;
    insert into public.invoices (organization_id, restaurant_id, supplier_id, invoice_number, invoice_date, file_path, original_filename,
                                 status, extraction_raw, total_amount, uploaded_by)
    values (v_org, v_rest, v_sup, left(nullif(btrim(p ->> 'invoice_number'), ''), 60), v_date, nullif(p ->> 'file_path', ''),
            left(nullif(p ->> 'original_filename', ''), 200), 'confirmed', p -> 'extraction_raw',
            nullif(p ->> 'total_amount', '')::numeric, auth.uid())
    returning id into v_id;
  end if;

  for it in select * from jsonb_array_elements(v_items) loop
    continue when nullif(btrim(it ->> 'description'), '') is null and nullif(it ->> 'product_id', '') is null;
    v_prod := nullif(it ->> 'product_id', '')::bigint;
    if v_prod is not null and not exists (select 1 from public.products pr where pr.id = v_prod and pr.organization_id = v_org and pr.deleted_at is null) then
      raise exception 'Unknown product' using errcode = '22023'; end if;
    v_kg := nullif(it ->> 'quantity_kg', '')::numeric;
    v_total := nullif(it ->> 'line_total', '')::numeric;
    if v_kg is not null and (v_kg <= 0 or v_kg > 100000) then v_kg := null; end if;
    v_ppk := case when v_kg > 0 and v_total > 0 then round(v_total / v_kg, 4) end;
    insert into public.invoice_items (invoice_id, organization_id, product_id, description, quantity, unit, quantity_kg,
                                      unit_price, price_per_kg, line_total, confidence)
    values (v_id, v_org, v_prod, left(coalesce(nullif(btrim(it ->> 'description'), ''), '(no description)'), 300),
            nullif(it ->> 'quantity', '')::numeric, left(nullif(it ->> 'unit', ''), 20), v_kg,
            nullif(it ->> 'unit_price', '')::numeric, v_ppk, v_total,
            least(greatest(nullif(it ->> 'confidence', '')::numeric, 0), 1));
    v_lines := v_lines + 1;
    if v_prod is not null then
      v_products := array_append(v_products, v_prod);
      if v_ppk is not null then
        v_matched := v_matched + 1;
        -- Keep the product list current: the latest invoice price becomes the product's own price
        if coalesce((p ->> 'update_prices')::boolean, true) then
          update public.products pr set purchase_price_per_kg = v_ppk, price_estimated = false
           where pr.id = v_prod and pr.organization_id = v_org
             and not exists (select 1 from public.invoice_items i2 join public.invoices iv on iv.id = i2.invoice_id
                              where i2.product_id = v_prod and iv.organization_id = v_org and iv.deleted_at is null
                                and iv.id <> v_id and iv.invoice_date > v_date and i2.price_per_kg is not null);
          if found then v_prices := v_prices + 1; end if;
        end if;
      end if;
    end if;
  end loop;

  -- Registrations that can use this invoice: from the invoice date up to 90 days later (or the old date, if it moved)
  v_from := least(v_date, coalesce(v_old_date, v_date));
  v_to := least(greatest(v_date, coalesce(v_old_date, v_date)) + 90, app.local_date(now()));
  v_reval := app.revalue_waste(v_org, (select array_agg(distinct x) from unnest(v_products) x), v_from, v_to);

  return jsonb_build_object('id', v_id, 'supplier_id', v_sup, 'lines', v_lines, 'priced', v_matched,
                            'prices_updated', v_prices, 'revalued', v_reval);
end $$;
revoke execute on function public.save_invoice(jsonb, bigint) from public, anon;
grant execute on function public.save_invoice(jsonb, bigint) to authenticated;

create or replace function public.delete_invoice(p_id bigint, p_org bigint default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_org bigint := app.effective_org(p_org); v_inv record; v_products bigint[]; v_n int;
begin
  if app.rank() < 30 or not app.in_org(v_org) then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_inv from public.invoices i where i.id = p_id and i.organization_id = v_org and i.deleted_at is null;
  if not found or (v_inv.restaurant_id is not null and not (v_inv.restaurant_id = any (app.restaurant_ids()))) then
    raise exception 'Invoice not found' using errcode = 'P0002'; end if;
  update public.invoices set deleted_at = now() where id = p_id;
  select array_agg(distinct ii.product_id) into v_products from public.invoice_items ii where ii.invoice_id = p_id and ii.product_id is not null;
  v_n := app.revalue_waste(v_org, v_products, v_inv.invoice_date, least(v_inv.invoice_date + 90, app.local_date(now())));
  return jsonb_build_object('deleted', true, 'revalued', v_n);
end $$;
revoke execute on function public.delete_invoice(bigint, bigint) from public, anon;
grant execute on function public.delete_invoice(bigint, bigint) to authenticated;

-- List for Settings › Invoices (caller's rights: managers see their restaurants and organization-wide invoices)
create or replace function public.invoices_list(p_org bigint default null, p_limit int default 200)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(x order by (x ->> 'invoice_date') desc nulls last, (x ->> 'id')::bigint desc), '[]'::jsonb) from (
    select jsonb_build_object('id', i.id, 'invoice_date', i.invoice_date, 'invoice_number', i.invoice_number,
             'supplier_id', i.supplier_id, 'supplier', s.name, 'restaurant_id', i.restaurant_id, 'restaurant', r.name,
             'total_amount', i.total_amount, 'file_path', i.file_path, 'original_filename', i.original_filename, 'status', i.status,
             'lines', (select count(*) from public.invoice_items ii where ii.invoice_id = i.id),
             'priced', (select count(*) from public.invoice_items ii where ii.invoice_id = i.id and ii.product_id is not null and ii.price_per_kg is not null),
             'kg', (select round(sum(ii.quantity_kg), 1) from public.invoice_items ii where ii.invoice_id = i.id),
             'created_at', i.created_at) x
      from public.invoices i
      left join public.suppliers s on s.id = i.supplier_id
      left join public.restaurants r on r.id = i.restaurant_id
     where i.organization_id = app.effective_org(p_org) and i.deleted_at is null
       and (i.restaurant_id is null or i.restaurant_id = any (app.restaurant_ids()))
     order by i.invoice_date desc nulls last, i.id desc
     limit greatest(1, least(coalesce(p_limit, 200), 1000))) q
$$;
revoke execute on function public.invoices_list(bigint, int) from public, anon;
grant execute on function public.invoices_list(bigint, int) to authenticated;

create or replace function public.invoice_get(p_id bigint, p_org bigint default null)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('id', i.id, 'invoice_date', i.invoice_date, 'invoice_number', i.invoice_number,
           'supplier_id', i.supplier_id, 'restaurant_id', i.restaurant_id, 'total_amount', i.total_amount,
           'file_path', i.file_path, 'original_filename', i.original_filename,
           'items', coalesce((select jsonb_agg(jsonb_build_object('product_id', ii.product_id, 'description', ii.description,
                      'quantity', ii.quantity, 'unit', ii.unit, 'quantity_kg', ii.quantity_kg, 'unit_price', ii.unit_price,
                      'line_total', ii.line_total, 'price_per_kg', ii.price_per_kg, 'confidence', ii.confidence) order by ii.id)
                    from public.invoice_items ii where ii.invoice_id = i.id), '[]'::jsonb))
    from public.invoices i
   where i.id = p_id and i.organization_id = app.effective_org(p_org) and i.deleted_at is null
     and (i.restaurant_id is null or i.restaurant_id = any (app.restaurant_ids()))
$$;
revoke execute on function public.invoice_get(bigint, bigint) from public, anon;
grant execute on function public.invoice_get(bigint, bigint) to authenticated;
