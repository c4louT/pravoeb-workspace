-- =================================================================
-- Phase 2: контрагенты + чеклисты
-- Запустить ОДИН раз в Supabase: Studio -> SQL Editor -> New query -> вставить -> Run
-- Все изменения additive, существующие данные не трогаются.
-- =================================================================

-- 1) Справочник контрагентов
create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  kind text not null default 'person' check (kind in ('person','org')),
  inn text,
  passport text,
  phone text,
  email text,
  address text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists contacts_user_id_idx on public.contacts (user_id);
create index if not exists contacts_name_idx    on public.contacts (lower(name));

alter table public.contacts enable row level security;

drop policy if exists "contacts: select own" on public.contacts;
create policy "contacts: select own" on public.contacts for select using (auth.uid() = user_id);

drop policy if exists "contacts: insert own" on public.contacts;
create policy "contacts: insert own" on public.contacts for insert with check (auth.uid() = user_id);

drop policy if exists "contacts: update own" on public.contacts;
create policy "contacts: update own" on public.contacts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "contacts: delete own" on public.contacts;
create policy "contacts: delete own" on public.contacts for delete using (auth.uid() = user_id);

-- 2) Связь договора с контрагентом (необязательная)
alter table public.contracts add column if not exists contact_id uuid references public.contacts(id) on delete set null;
create index if not exists contracts_contact_id_idx on public.contracts (contact_id);

-- 3) Состояние чеклиста по этапам производства, JSONB на проекте
alter table public.projects add column if not exists checklist_state jsonb not null default '{}'::jsonb;
