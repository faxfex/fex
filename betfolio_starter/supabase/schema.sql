-- Betfolio schema — run this entire file in Supabase SQL Editor.
-- RLS is enabled on all user-facing tables. The Telegram Worker uses the service-role
-- key server-side only and is restricted by ALLOWED_TELEGRAM_USER_ID.

create table if not exists public.ledger_records (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  record_date date not null,
  type text not null check (type in ('lottery','betting','trade')),
  name text not null,
  status text not null check (status in ('won','lost','pending')),
  stake numeric(14,2) not null default 0 check (stake >= 0),
  payout numeric(14,2) not null default 0 check (payout >= 0),
  fee numeric(14,2) not null default 0 check (fee >= 0),
  note text not null default '',
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ledger_records_user_date_idx
  on public.ledger_records (user_id, record_date desc);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_budget numeric(14,2) not null default 0 check (daily_budget >= 0),
  monthly_budget numeric(14,2) not null default 0 check (monthly_budget >= 0),
  daily_tp numeric(14,2) not null default 0 check (daily_tp >= 0),
  daily_sl numeric(14,2) not null default 0 check (daily_sl >= 0),
  monthly_tp numeric(14,2) not null default 0 check (monthly_tp >= 0),
  monthly_sl numeric(14,2) not null default 0 check (monthly_sl >= 0),
  updated_at timestamptz not null default now()
);

-- Photo uploads received by Telegram. Access is server-only (service role); the
-- browser client intentionally cannot query this table directly.
create table if not exists public.telegram_inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  telegram_user_id text not null,
  telegram_chat_id text not null,
  telegram_file_id text not null,
  storage_path text not null,
  ocr_text text not null default '',
  status text not null default 'received' check (status in ('received','reviewed','archived')),
  created_at timestamptz not null default now()
);
create index if not exists telegram_inbox_user_created_idx
  on public.telegram_inbox (user_id, created_at desc);

-- Idempotency for incoming Telegram webhook deliveries and threshold notifications.
create table if not exists public.telegram_updates (
  update_id text primary key,
  created_at timestamptz not null default now()
);

create table if not exists public.telegram_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null,
  sent_at timestamptz not null default now(),
  unique (user_id, event_key)
);

alter table public.ledger_records enable row level security;
alter table public.user_settings enable row level security;
alter table public.telegram_inbox enable row level security;
alter table public.telegram_updates enable row level security;
alter table public.telegram_alerts enable row level security;

-- Own ledger data only.
drop policy if exists "ledger_records_select_own" on public.ledger_records;
create policy "ledger_records_select_own" on public.ledger_records
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "ledger_records_insert_own" on public.ledger_records;
create policy "ledger_records_insert_own" on public.ledger_records
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "ledger_records_update_own" on public.ledger_records;
create policy "ledger_records_update_own" on public.ledger_records
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "ledger_records_delete_own" on public.ledger_records;
create policy "ledger_records_delete_own" on public.ledger_records
  for delete to authenticated using (auth.uid() = user_id);

-- Own preferences only.
drop policy if exists "user_settings_select_own" on public.user_settings;
create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "user_settings_insert_own" on public.user_settings;
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "user_settings_update_own" on public.user_settings;
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- The signed-in owner may list their own Telegram photo inbox. The bot inserts via service role.
drop policy if exists "telegram_inbox_select_own" on public.telegram_inbox;
create policy "telegram_inbox_select_own" on public.telegram_inbox
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "telegram_inbox_update_own" on public.telegram_inbox;
create policy "telegram_inbox_update_own" on public.telegram_inbox
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- telegram_updates and telegram_alerts have no anon/authenticated policies by design.

-- Private storage buckets: web user can manage own image files; Worker uses service role.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('bill-images', 'bill-images', false, 12582912, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "bill_images_select_own" on storage.objects;
create policy "bill_images_select_own" on storage.objects
  for select to authenticated using (
    bucket_id = 'bill-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "bill_images_insert_own" on storage.objects;
create policy "bill_images_insert_own" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'bill-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "bill_images_update_own" on storage.objects;
create policy "bill_images_update_own" on storage.objects
  for update to authenticated using (
    bucket_id = 'bill-images' and (storage.foldername(name))[1] = auth.uid()::text
  ) with check (
    bucket_id = 'bill-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
drop policy if exists "bill_images_delete_own" on storage.objects;
create policy "bill_images_delete_own" on storage.objects
  for delete to authenticated using (
    bucket_id = 'bill-images' and (storage.foldername(name))[1] = auth.uid()::text
  );
