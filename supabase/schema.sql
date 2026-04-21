-- =============================================================
-- プライベートCFO スキーマ
--
-- 適用: Supabase Dashboard → SQL Editor に貼り付けて "Run"
-- 前提: Supabase 標準(auth.users が存在、postgres 権限で実行)
--
-- 定義順の注意:
--   is_admin() は language sql(定義時に参照解決)なので
--   profiles テーブル作成「後」に定義する必要がある。
--   一方 handle_new_user() は plpgsql(遅延パース)なので
--   profiles 後に置けば体系上ロジックがまとまる。
-- =============================================================

create extension if not exists pgcrypto;

-- -------------------------------------------------------------
-- ヘルパ(テーブル参照なし・先頭で定義可能)
-- -------------------------------------------------------------

-- updated_at を自動更新する汎用トリガ関数
create or replace function public.set_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- =============================================================
-- 1. profiles (auth.users 拡張)
-- =============================================================
create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  role          text not null default 'client'
                  check (role in ('client','admin')),
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

-- -------------------------------------------------------------
-- profiles を参照するヘルパ(profiles 作成後に定義)
-- -------------------------------------------------------------

-- profiles.role = 'admin' か判定。
-- profiles の RLS を参照するので security definer で RLS をバイパスする。
create or replace function public.is_admin() returns boolean
  language sql security definer stable
  set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- auth.users 作成時に profiles 行を自動生成。
-- 新規ユーザーは必ず role='client' で作成される。
-- admin 昇格は Dashboard → Table Editor で手動。
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'client');
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- =============================================================
-- 2. categories (カスタムカテゴリのみ。既定 9 個はコード側)
-- =============================================================
create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.profiles(id) on delete cascade,
  label       text not null,
  icon_key    text not null,   -- shared-cfo/icons.jsx の key を参照
  color       text not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index categories_client_sort_idx
  on public.categories (client_id, sort_order);

-- =============================================================
-- 3. expenses (支出。soft delete 対応)
-- =============================================================
create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.profiles(id) on delete cascade,
  entered_by      uuid references public.profiles(id) on delete set null,
  -- entered_by != client_id の時に「本部代行入力」
  date            date not null,
  amount          bigint not null check (amount > 0),  -- 円(整数)
  category        text not null,     -- 既定 id or custom uuid 文字列
  memo            text,
  payment_method  text,              -- 'cash' などの ID
  is_recurring    boolean not null default false,
  recur_id        uuid,
  deleted_at      timestamptz,       -- soft delete(顧客は物理削除不可)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index expenses_client_date_idx
  on public.expenses (client_id, date desc)
  where deleted_at is null;
create index expenses_client_category_idx
  on public.expenses (client_id, category)
  where deleted_at is null;
create index expenses_deleted_idx
  on public.expenses (deleted_at) where deleted_at is not null;

create trigger trg_expenses_updated_at
  before update on public.expenses
  for each row execute procedure public.set_updated_at();

-- =============================================================
-- 4. notifications (本部→顧客テロップ / お知らせ)
-- =============================================================
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.profiles(id) on delete cascade,
  sender_id     uuid references public.profiles(id),
  kind          text not null default 'telop'
                  check (kind in ('telop','notice')),
  body          text not null,
  published_at  timestamptz not null default now(),
  read_at       timestamptz,
  expires_at    timestamptz
);
create index notifications_client_pub_idx
  on public.notifications (client_id, published_at desc);

-- =============================================================
-- 5. inquiries (顧客→本部問い合わせ)
-- =============================================================
create table public.inquiries (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.profiles(id) on delete cascade,
  body          text not null,
  status        text not null default 'open'
                  check (status in ('open','replied','closed')),
  replied_body  text,
  replied_by    uuid references public.profiles(id),
  replied_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index inquiries_client_created_idx
  on public.inquiries (client_id, created_at desc);
create index inquiries_open_idx
  on public.inquiries (status) where status = 'open';

-- =============================================================
-- 6. points_ledger + points_balances view
-- =============================================================
create table public.points_ledger (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.profiles(id) on delete cascade,
  delta       integer not null,    -- 正=付与 / 負=控除
  reason      text not null,
  created_by  uuid references public.profiles(id),  -- どの admin が
  created_at  timestamptz not null default now()
);
create index points_client_created_idx
  on public.points_ledger (client_id, created_at desc);

-- 現在残高ビュー(呼び出し元の RLS を尊重するため security_invoker)
create or replace view public.points_balances
  with (security_invoker = true) as
  select client_id,
         coalesce(sum(delta), 0)::bigint as balance
  from public.points_ledger
  group by client_id;

-- =============================================================
-- 7. appointments (面談。予定 + 日程変更リクエスト)
-- =============================================================
create table public.appointments (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.profiles(id) on delete cascade,
  scheduled_at    timestamptz not null,
  duration_min    integer not null default 10 check (duration_min > 0),
  status          text not null default 'scheduled'
                    check (status in ('scheduled','reschedule_requested',
                                      'confirmed','cancelled','completed')),
  requested_at    timestamptz,     -- 顧客が希望する新しい日時
  request_reason  text,
  admin_notes     text,
  created_by      uuid references public.profiles(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index appointments_client_sched_idx
  on public.appointments (client_id, scheduled_at desc);

create trigger trg_appointments_updated_at
  before update on public.appointments
  for each row execute procedure public.set_updated_at();

-- =============================================================
-- RLS 有効化
-- =============================================================
alter table public.profiles       enable row level security;
alter table public.categories     enable row level security;
alter table public.expenses       enable row level security;
alter table public.notifications  enable row level security;
alter table public.inquiries      enable row level security;
alter table public.points_ledger  enable row level security;
alter table public.appointments   enable row level security;

-- =============================================================
-- RLS ポリシー
--   顧客(client): 自分のデータのみ
--   本部(admin):  全データ
-- UPDATE の列単位制限は RLS では効かないため、
-- アプリ層(UI / クライアント実装)で担保する前提。
-- =============================================================

-- ---- profiles ---------------------------------------------------
create policy "profiles_self_select" on public.profiles
  for select using (id = auth.uid());

create policy "profiles_self_update" on public.profiles
  for update using (id = auth.uid())
  with check (id = auth.uid());

create policy "profiles_admin_all" on public.profiles
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- categories -------------------------------------------------
create policy "categories_client_rw_own" on public.categories
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "categories_admin_all" on public.categories
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- expenses ---------------------------------------------------
-- 顧客: SELECT / INSERT / UPDATE のみ。DELETE ポリシーを作らないことで
-- 物理削除は不可(soft delete = deleted_at を UPDATE する運用)。
create policy "expenses_client_select" on public.expenses
  for select using (client_id = auth.uid());

create policy "expenses_client_insert" on public.expenses
  for insert with check (client_id = auth.uid());

create policy "expenses_client_update" on public.expenses
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());

-- 本部: 物理削除も可
create policy "expenses_admin_all" on public.expenses
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- notifications ----------------------------------------------
create policy "notifications_client_select" on public.notifications
  for select using (client_id = auth.uid());

-- UPDATE は read_at 更新用(アプリ層で read_at 以外を送らない運用)
create policy "notifications_client_update" on public.notifications
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "notifications_admin_all" on public.notifications
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- inquiries --------------------------------------------------
-- 顧客は SELECT / INSERT のみ。送信後の本文改変・削除は不可。
create policy "inquiries_client_select" on public.inquiries
  for select using (client_id = auth.uid());

create policy "inquiries_client_insert" on public.inquiries
  for insert with check (client_id = auth.uid());

create policy "inquiries_admin_all" on public.inquiries
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- points_ledger ----------------------------------------------
-- 顧客は SELECT のみ。付与は admin のみ。
create policy "points_client_select" on public.points_ledger
  for select using (client_id = auth.uid());

create policy "points_admin_all" on public.points_ledger
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- appointments -----------------------------------------------
-- 顧客は SELECT と UPDATE(変更希望送信)のみ。新規 INSERT / DELETE は admin。
create policy "appointments_client_select" on public.appointments
  for select using (client_id = auth.uid());

create policy "appointments_client_update" on public.appointments
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "appointments_admin_all" on public.appointments
  for all using (public.is_admin())
  with check (public.is_admin());
