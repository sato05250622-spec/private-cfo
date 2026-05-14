-- =============================================================
-- Phase E 最終ゴール — Step 1: annual_budgets の現状 DDL を repo に記録
-- -------------------------------------------------------------
-- 背景:
--   annual_budgets は admin アプリ (private-cfo-admin) 側で Phase A/E に
--   Supabase Dashboard 直編集で構築され、CREATE TABLE / RLS が repo の
--   migration ファイルに残っていなかった。Phase E 最終ゴール (顧客アプリへの
--   繰越票表示) で顧客側 RLS に依存するため、現状 DB 状態をここに記録して
--   repo との乖離を解消する。
--
-- 適用方針:
--   - 本ファイルは「記録目的」。本番 DB は既に同等状態のため適用不要。
--   - 全ステートメント冪等 (CREATE TABLE IF NOT EXISTS / DROP→CREATE POLICY)。
--     既存テーブルに再適用しても害なし。
--   - CREATE TABLE IF NOT EXISTS は既存テーブルに対しては完全な no-op
--     (列・型・制約は一切変更されない)。列定義は documentary な記録。
--
-- ⚠️ 注意 (型・制約の確度):
--   列の data_type / default / CHECK 制約は admin API コード
--   (src/lib/api/annualBudgets.js) と既存 migration 011/006 の規約から
--   推定したもの。Step 0 (a)/(d) の Dashboard 出力と突き合わせて
--   差異があれば本ファイルを後続 migration で補正すること。
--
-- 列構成 (13列):
--   id / client_id / fiscal_year / fiscal_year_start_month /
--   lines / totals / visible_to_client /
--   committed_lines / committed_totals / last_committed_at /
--   last_committed_by / created_at / updated_at
--
-- RLS:
--   - annual_budgets_admin_all          : admin は全権 (is_admin())
--   - annual_budgets_client_select_own  : 顧客は自分の行を SELECT のみ。
--                                         visible_to_client = true 条件付き。
--
-- Rollback (記録目的のため通常不要):
--   drop policy if exists "annual_budgets_client_select_own" on public.annual_budgets;
--   drop policy if exists "annual_budgets_admin_all" on public.annual_budgets;
--   -- テーブル本体は admin アプリ管理のため本ファイルでは drop しない。
-- =============================================================

-- ---- テーブル本体 (既存時は no-op、記録目的) -----------------------
create table if not exists public.annual_budgets (
  id                      uuid primary key default gen_random_uuid(),
  client_id               uuid not null references public.profiles(id) on delete cascade,
  fiscal_year             integer not null,
  fiscal_year_start_month integer not null default 1
                            check (fiscal_year_start_month between 1 and 12),
  lines                   jsonb not null default '[]'::jsonb,
  totals                  jsonb not null default '{}'::jsonb,
  visible_to_client       boolean not null default false,
  committed_lines         jsonb,
  committed_totals        jsonb,
  last_committed_at       timestamptz,
  last_committed_by       uuid references public.profiles(id),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (client_id, fiscal_year)
);

create index if not exists annual_budgets_client_year_idx
  on public.annual_budgets (client_id, fiscal_year desc);

-- updated_at 自動更新トリガ (既存規約: public.set_updated_at)
drop trigger if exists trg_annual_budgets_updated_at on public.annual_budgets;
create trigger trg_annual_budgets_updated_at
  before update on public.annual_budgets
  for each row execute procedure public.set_updated_at();

-- ---- RLS ------------------------------------------------------------
alter table public.annual_budgets enable row level security;

-- 本部 admin は全権 (作成・編集・削除)
drop policy if exists "annual_budgets_admin_all" on public.annual_budgets;
create policy "annual_budgets_admin_all" on public.annual_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- 顧客は自分の年度予算を SELECT のみ。visible_to_client=true の行に限定。
drop policy if exists "annual_budgets_client_select_own" on public.annual_budgets;
create policy "annual_budgets_client_select_own" on public.annual_budgets
  for select using (client_id = auth.uid() and visible_to_client = true);
