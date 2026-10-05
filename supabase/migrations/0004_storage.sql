-- 0004  Photo storage: private bucket, one folder per organization (org-<id>/...)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('waste-photos', 'waste-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Upload only into your own organization's folder
create policy waste_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'waste-photos' and (storage.foldername(name))[1] = 'org-' || app.org()::text);

-- Read: managers and admins see their organization's photos; employees only their own uploads
create policy waste_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'waste-photos'
         and ((storage.foldername(name))[1] = 'org-' || app.org()::text or app.is_super())
         and (app.rank() >= 30 or owner_id = (select auth.uid())::text));
-- No update or delete policies: photos are evidence and cannot be replaced from the app.
