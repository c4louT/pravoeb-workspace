-- =================================================================
-- Phase 4.2: чат-виджет + мост к Telegram
-- Запустить ОДИН раз в Supabase: Studio -> SQL Editor -> New query -> вставить -> Run
-- Все изменения additive.
-- =================================================================

-- 1) Профиль пользователя (Telegram ID и прочее)
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  telegram_chat_id bigint,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists profiles_telegram_chat_id_uniq
  on public.profiles (telegram_chat_id)
  where telegram_chat_id is not null;

alter table public.profiles enable row level security;

drop policy if exists "profiles: select own" on public.profiles;
create policy "profiles: select own" on public.profiles for select using (auth.uid() = user_id);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles for insert with check (auth.uid() = user_id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2) История чата: и исходящие (из дашборда в TG) и входящие (из TG в дашборд) сообщения
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  direction text not null check (direction in ('out','in')),  -- out = дашборд -> tg, in = tg -> дашборд
  text text not null,
  tg_message_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_user_id_idx on public.chat_messages (user_id, created_at desc);

alter table public.chat_messages enable row level security;

drop policy if exists "chat: select own" on public.chat_messages;
create policy "chat: select own" on public.chat_messages for select using (auth.uid() = user_id);

drop policy if exists "chat: insert own" on public.chat_messages;
create policy "chat: insert own" on public.chat_messages for insert with check (auth.uid() = user_id);

-- service_role вставляет входящие сообщения (webhook) — для него RLS не применяется автоматически.
-- UPDATE/DELETE не даём никому — история иммутабельная.

-- 3) Включаем Realtime на chat_messages, чтобы виджет получал входящие в реальном времени
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      alter publication supabase_realtime add table public.chat_messages;
    exception when duplicate_object then
      null; -- уже в публикации
    end;
  end if;
end$$;
