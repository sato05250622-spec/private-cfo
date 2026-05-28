-- =============================================================
-- 人別経費投資回収シート — DBスキーマ追加
-- -------------------------------------------------------------
-- 目的:
--   顧客ごとに「投資対象者(人物)」を登録 (investment_targets)、
--   各対象者への入金明細 (investment_incomes) を記録し、
--   既存 expenses に target_id 列を追加して「人物別経費」を紐づける。
--   → 「人別経費投資回収シート」で 入金 - 支出 の回収状況を集計する土台。
--
-- 既存 expenses (001_init.sql L117〜) と同方針:
--   - soft delete (deleted_at)。顧客は物理削除不可 (UPDATE で deleted_at を立てる)
--   - 顧客 (client) は自分の client_id かつ deleted_at IS NULL の行のみ SELECT
--   - 顧客は client_id = auth.uid() で INSERT / UPDATE 可
--   - 本部 (admin) は public.is_admin() で全権 (SELECT/INSERT/UPDATE/DELETE)
--   - updated_at は trg_<table>_updated_at + public.set_updated_at() で自動更新
--
-- 依存ヘルパ (001_init.sql で定義済):
--   - public.set_updated_at()  (L21)  — BEFORE UPDATE トリガ用
--   - public.is_admin()        (L53)  — security definer / stable
--
-- 適用方針:
--   - CREATE TABLE / INDEX / ALTER ADD COLUMN は if not exists で冪等。
--   - policy は IF NOT EXISTS が無いため、再適用時は事前 DROP が必要。
--   - 本番適用は Supabase ダッシュボード / CLI から (このファイルは記録)。
--
-- Rollback:
--   drop policy if exists "investment_incomes_admin_all"      on public.investment_incomes;
--   drop policy if exists "investment_incomes_client_update"  on public.investment_incomes;
--   drop policy if exists "investment_incomes_client_insert"  on public.investment_incomes;
--   drop policy if exists "investment_incomes_client_select"  on public.investment_incomes;
--   drop policy if exists "investment_targets_admin_all"      on public.investment_targets;
--   drop policy if exists "investment_targets_client_update"  on public.investment_targets;
--   drop policy if exists "investment_targets_client_insert"  on public.investment_targets;
--   drop policy if exists "investment_targets_client_select"  on public.investment_targets;
--   drop index  if exists public.expenses_client_target_idx;
--   alter table public.expenses drop column if exists target_id;
--   drop table  if exists public.investment_incomes;
--   drop table  if exists public.investment_targets;
-- =============================================================


-- =============================================================
-- 1. investment_targets (投資対象者・人物)
-- =============================================================
create table if not exists public.investment_targets (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  target_year   int  not null,
  total_income  bigint not null default 0 check (total_income >= 0),
  sort_order    int  not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create index if not exists investment_targets_client_deleted_idx
  on public.investment_targets (client_id, deleted_at);

create trigger trg_investment_targets_updated_at
  before update on public.investment_targets
  for each row execute procedure public.set_updated_at();


-- =============================================================
-- 2. investment_incomes (各対象者への入金明細)
-- =============================================================
create table if not exists public.investment_incomes (
  id          uuid primary key default gen_random_uuid(),
  target_id   uuid not null references public.investment_targets(id) on delete cascade,
  client_id   uuid not null references public.profiles(id) on delete cascade,
  date        date not null,
  memo        text,
  amount      bigint not null check (amount > 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists investment_incomes_target_deleted_idx
  on public.investment_incomes (target_id, deleted_at);
create index if not exists investment_incomes_client_deleted_idx
  on public.investment_incomes (client_id, deleted_at);

create trigger trg_investment_incomes_updated_at
  before update on public.investment_incomes
  for each row execute procedure public.set_updated_at();


-- =============================================================
-- 3. expenses に target_id 列を追加 (人物別経費の紐付け)
--    既存 expenses (001_init.sql) の RLS / トリガはそのまま流用。
--    target_id は nullable (人物に紐づかない一般支出を許容)。
--    投資対象者の削除時は target_id を NULL に落とす (set null) — 過去の経費は残す。
-- =============================================================
alter table public.expenses
  add column if not exists target_id uuid
    references public.investment_targets(id) on delete set null;

create index if not exists expenses_client_target_idx
  on public.expenses (client_id, target_id);


-- =============================================================
-- RLS 有効化 (新規 2 テーブル)
-- =============================================================
alter table public.investment_targets enable row level security;
alter table public.investment_incomes enable row level security;


-- =============================================================
-- RLS ポリシー (expenses と同方針、001_init.sql L273-286 準拠)
--   顧客 (client):
--     SELECT — client_id = auth.uid() AND deleted_at IS NULL
--     INSERT — with check (client_id = auth.uid())
--     UPDATE — using/with check (client_id = auth.uid())  ※soft delete もこの経路
--     DELETE — ポリシー無し (物理削除は admin のみ)
--   本部 (admin):
--     ALL    — public.is_admin() で全権
-- =============================================================

-- ---- investment_targets ---------------------------------------
create policy "investment_targets_client_select" on public.investment_targets
  for select using (client_id = auth.uid() and deleted_at is null);

create policy "investment_targets_client_insert" on public.investment_targets
  for insert with check (client_id = auth.uid());

create policy "investment_targets_client_update" on public.investment_targets
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "investment_targets_admin_all" on public.investment_targets
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- investment_incomes ---------------------------------------
create policy "investment_incomes_client_select" on public.investment_incomes
  for select using (client_id = auth.uid() and deleted_at is null);

create policy "investment_incomes_client_insert" on public.investment_incomes
  for insert with check (client_id = auth.uid());

create policy "investment_incomes_client_update" on public.investment_incomes
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());

create policy "investment_incomes_admin_all" on public.investment_incomes
  for all using (public.is_admin())
  with check (public.is_admin());
