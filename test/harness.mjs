// Local Postgres (PGlite) with the parts of Supabase the migrations rely on stubbed:
// roles anon/authenticated, auth.users/identities/uid(), storage.buckets/objects/foldername().
// Lets us run the real migrations and test Row Level Security without a cloud project.
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema extensions;
create schema auth;
create table auth.users (
  instance_id uuid, id uuid primary key, aud text, role text, email text, encrypted_password text,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
  created_at timestamptz, updated_at timestamptz, confirmation_token text, email_change text,
  email_change_token_new text, recovery_token text, banned_until timestamptz);
create table auth.identities (id uuid primary key, user_id uuid references auth.users(id) on delete cascade, provider_id text,
  identity_data jsonb, provider text, last_sign_in_at timestamptz, created_at timestamptz, updated_at timestamptz);
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner_id text);
create function storage.foldername(name text) returns text[] language sql immutable as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert on storage.objects to authenticated;
`;

export async function createDb({ seed = true } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUB);
  const migDir = path.join(root, 'supabase', 'migrations');
  for (const f of fs.readdirSync(migDir).filter((x) => x.endsWith('.sql')).sort()) {
    let sql = fs.readFileSync(path.join(migDir, f), 'utf8');
    try { await db.exec(sql); } catch (e) { throw new Error(`${f}: ${e.message} ${e.where || ""}`); }
  }
  if (seed) {
    await db.exec(fs.readFileSync(path.join(root, 'supabase', 'seed', 'demo.sql'), 'utf8'));
    await db.exec('begin');
    let r; try { r = await db.query('select app.seed_demo(60) as msg'); } catch (e) { throw new Error('seed: ' + e.message + ' ' + (e.where || '')); }
    await db.exec('commit');
    db.seedMessage = r.rows[0].msg;
  }
  return db;
}

// Run a function as a signed-in user (or anonymous when uid is null), inside a transaction.
export async function as(db, uid, fn) {
  await db.exec('begin');
  try {
    await db.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid || '']);
    await db.exec(uid ? 'set local role authenticated' : 'set local role anon');
    const out = await fn({
      q: async (sql, params) => (await db.query(sql, params)).rows,
      one: async (sql, params) => (await db.query(sql, params)).rows[0],
    });
    await db.exec('commit');
    return out;
  } catch (e) {
    await db.exec('rollback');
    throw e;
  }
}

export async function userId(db, email) {
  return (await db.query('select id from public.users where email = $1', [email])).rows[0]?.id;
}
