-- Hinata's cloud home: one signed-in owner per row, enforced by row level security.
-- Phone and PC read the same rows, so Hinata remembers the user on every device.

-- Settings that follow the user to every device (name, provider key, voice, chosen model).
create table if not exists public.hinata_profile (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  user_name text,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Long-term memory: durable facts about the user ("Their best friend is Haroon").
create table if not exists public.hinata_memories (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  fact text not null check (char_length(fact) between 1 and 300),
  created_at timestamptz not null default now()
);
-- A plain unique key, so the REST API can skip duplicates (`on_conflict=user_id,fact`). The app also dedupes case-insensitively.
alter table public.hinata_memories drop constraint if exists hinata_memories_user_fact;
drop index if exists public.hinata_memories_user_fact;
alter table public.hinata_memories add constraint hinata_memories_user_fact unique (user_id, fact);

-- Recent conversation, shared between devices, so a chat started on the PC continues on the phone.
create table if not exists public.hinata_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) <= 8000),
  created_at timestamptz not null default now()
);
create index if not exists hinata_messages_user_time on public.hinata_messages (user_id, created_at desc);

alter table public.hinata_profile enable row level security;
alter table public.hinata_memories enable row level security;
alter table public.hinata_messages enable row level security;

drop policy if exists "owner" on public.hinata_profile;
create policy "owner" on public.hinata_profile for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "owner" on public.hinata_memories;
create policy "owner" on public.hinata_memories for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "owner" on public.hinata_messages;
create policy "owner" on public.hinata_messages for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Private files (the Hinata avatar): each user reads and writes only their own folder, <user id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('hinata-private', 'hinata-private', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "hinata owner read" on storage.objects;
create policy "hinata owner read" on storage.objects for select to authenticated
  using (bucket_id = 'hinata-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "hinata owner write" on storage.objects;
create policy "hinata owner write" on storage.objects for insert to authenticated
  with check (bucket_id = 'hinata-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "hinata owner update" on storage.objects;
create policy "hinata owner update" on storage.objects for update to authenticated
  using (bucket_id = 'hinata-private' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "hinata owner delete" on storage.objects;
create policy "hinata owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'hinata-private' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- The Hinata server function reads and writes with the service role.
grant select, insert, update, delete on public.hinata_profile, public.hinata_memories, public.hinata_messages to service_role;
grant usage, select on all sequences in schema public to service_role;
