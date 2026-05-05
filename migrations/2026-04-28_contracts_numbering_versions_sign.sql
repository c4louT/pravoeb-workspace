-- =================================================================
-- Phase 5i + Phase 6: расширение public.contracts
--   • Нумерация + версионирование (version, parent_contract_id, number_int, number_year)
--   • E-sign / отправка на подпись (sign_token, sign_email, sign_status, sent_at,
--     signed_at, signed_file_url, signed_file_name, signer_name)
-- Запустить ОДИН раз в Supabase: Studio → SQL Editor → New query → вставить → Run
-- Все изменения additive, существующие данные не трогаются.
-- =================================================================

alter table public.contracts
  add column if not exists version int not null default 1,
  add column if not exists parent_contract_id uuid references public.contracts(id) on delete set null,
  add column if not exists number_int int,
  add column if not exists number_year int,
  add column if not exists sign_token text,
  add column if not exists sign_email text,
  add column if not exists sign_status text default 'draft',
  add column if not exists sent_at timestamptz,
  add column if not exists signed_at timestamptz,
  add column if not exists signed_file_url text,
  add column if not exists signed_file_name text,
  add column if not exists signer_name text;

-- Уникальный токен для публичной страницы подписания /sign.html?token=...
create unique index if not exists contracts_sign_token_uq on public.contracts (sign_token) where sign_token is not null;

create index if not exists contracts_parent_idx on public.contracts (parent_contract_id);

-- Автонумерация per-user per-year: next_num = max(number_int where number_year=YYYY and user_id=uid) + 1.
-- Держим в RPC-функции чтобы можно было вызывать с client-side atomically.
create or replace function public.next_contract_number(p_year int)
returns int
language sql
security definer
set search_path = public
as $$
  select coalesce(max(number_int), 0) + 1
  from public.contracts
  where user_id = auth.uid() and number_year = p_year;
$$;

grant execute on function public.next_contract_number(int) to authenticated;

-- ВАЖНО: public-политика чтения для страницы подписания (гость без JWT).
-- Читаем ТОЛЬКО по sign_token, без него ничего не возвращаем.
-- Создаём отдельный security definer view — проще чем расширять RLS на anon.
create or replace function public.contract_by_sign_token(p_token text)
returns table (
  id uuid,
  number text,
  number_int int,
  number_year int,
  version int,
  type text,
  role text,
  person text,
  date date,
  amount numeric,
  notes text,
  file_url text,
  file_name text,
  signed_file_url text,
  signed_file_name text,
  sign_status text,
  sent_at timestamptz,
  signed_at timestamptz,
  signer_name text,
  project_id uuid
)
language sql
security definer
set search_path = public
as $$
  select id, number, number_int, number_year, version, type, role, person, date,
         amount, notes, file_url, file_name, signed_file_url, signed_file_name,
         sign_status, sent_at, signed_at, signer_name, project_id
  from public.contracts
  where sign_token = p_token and sign_token is not null
  limit 1;
$$;

grant execute on function public.contract_by_sign_token(text) to anon, authenticated;

-- Функция подписания из гостевой страницы: принимает token + signer_name,
-- проставляет signed_at + signer_name + sign_status='signed'. Идемпотентна.
create or replace function public.sign_contract_by_token(p_token text, p_signer_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  rows_affected int;
begin
  -- FOR UPDATE берёт row-level lock, чтобы параллельные запросы с одним токеном
  -- не могли оба пройти проверку sign_status='signed' (TOCTOU-гонка → перезапись подписанта).
  select id, sign_status into r
  from public.contracts
  where sign_token = p_token and sign_token is not null
  limit 1
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  if r.sign_status = 'signed' then
    return jsonb_build_object('ok', false, 'error', 'already_signed');
  end if;

  -- Belt-and-suspenders: UPDATE фильтрует по sign_status != 'signed', чтобы даже
  -- при обходе lock (репликация / другая изоляция) не было double-sign.
  update public.contracts
  set signed_at = now(),
      signer_name = nullif(trim(p_signer_name), ''),
      sign_status = 'signed'
  where id = r.id
    and (sign_status is null or sign_status <> 'signed');

  get diagnostics rows_affected = row_count;
  if rows_affected = 0 then
    return jsonb_build_object('ok', false, 'error', 'already_signed');
  end if;

  return jsonb_build_object('ok', true, 'id', r.id);
end;
$$;

grant execute on function public.sign_contract_by_token(text, text) to anon, authenticated;

-- =================================================================
-- Phase 5i: Storage bucket для подписанных PDF (публично-readable только
-- через signed URL владельца, загружать может только авторизованный юзер).
-- Bucket 'contracts' уже существует — signed_file хранится в contracts/signed/<contract_id>.<ext>.
-- Отдельного bucket'а не делаем.
-- =================================================================
