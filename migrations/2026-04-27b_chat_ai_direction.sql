-- =================================================================
-- Phase 4.3: добавляем 'ai' в enum направлений чата
-- Запустить ОДИН раз в Supabase → SQL Editor → New query → Run
-- =================================================================

-- Снимаем старый check constraint и ставим новый с 'ai'
alter table public.chat_messages drop constraint if exists chat_messages_direction_check;
alter table public.chat_messages
  add constraint chat_messages_direction_check
  check (direction in ('out','in','ai'));

-- Добавляем опциональное поле model — какой LLM отвечал
alter table public.chat_messages
  add column if not exists model text;
