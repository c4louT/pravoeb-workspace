-- =================================================================
-- Phase 5a: документооборот — таблица сгенерированных документов
-- Запустить ОДИН раз в Supabase: Studio → SQL Editor → New query → вставить → Run
-- Все изменения additive, существующие данные не трогаются.
-- =================================================================

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  template_id text not null,            -- 'actor', 'director', 'license' и т.д. (см. contracts/templates_index.json)
  template_label text,                  -- человекочитаемое имя шаблона на момент генерации
  title text not null,                  -- имя файла без расширения (Договор_актер_Иванов_2026-04)
  body_md text not null,                -- финальный markdown с подставленными значениями
  placeholders jsonb not null default '{}'::jsonb, -- словарь {ключ → значение} для повторной генерации
  project_id uuid references public.projects(id) on delete set null,
  contract_id uuid references public.contracts(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_user_id_idx     on public.documents (user_id, created_at desc);
create index if not exists documents_project_id_idx  on public.documents (project_id);
create index if not exists documents_contract_id_idx on public.documents (contract_id);
create index if not exists documents_contact_id_idx  on public.documents (contact_id);

alter table public.documents enable row level security;

drop policy if exists "documents: select own" on public.documents;
create policy "documents: select own" on public.documents for select using (auth.uid() = user_id);

drop policy if exists "documents: insert own" on public.documents;
create policy "documents: insert own" on public.documents for insert with check (auth.uid() = user_id);

drop policy if exists "documents: update own" on public.documents;
create policy "documents: update own" on public.documents for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "documents: delete own" on public.documents;
create policy "documents: delete own" on public.documents for delete using (auth.uid() = user_id);
