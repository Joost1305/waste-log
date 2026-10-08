-- 0012  Super admins (no organization of their own) may upload photos into any existing organization's folder.
-- (objects.name is spelled out: inside the subquery a bare "name" would mean organizations.name.)
-- Before, the upload was refused with "new row violates row-level security policy".
drop policy if exists waste_photos_insert on storage.objects;
create policy waste_photos_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'waste-photos'
    and (
      (storage.foldername(objects.name))[1] = 'org-' || (app.org())::text
      or (app.is_super() and exists (
            select 1 from public.organizations o
             where o.deleted_at is null and 'org-' || o.id::text = (storage.foldername(objects.name))[1]))
    )
  );
