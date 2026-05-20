-- =============================================================
-- Phase 1 — 月確定 (settled months) カラム追加
-- -------------------------------------------------------------
-- 背景:
--   年間予算の「この月を確定」操作で、確定済み月を保持する。確定月は
--   monthly_actuals に実測を凍結し、残予算を未確定月へ再分配する
--   (再分配ロジックは src/utils/annualBudgetSheet.js)。
--
--   - settled_months           : 作業用の確定済み月配列 [1..12]
--   - committed_settled_months : 公開 snapshot 用の確定済み月配列
--                                (commitSnapshot で settled_months を凍結)
--
-- 適用方針:
--   - ADD COLUMN は IF NOT EXISTS で冪等。既存行は DEFAULT '[]' で埋まる。
--   - 実 DB 適用は deploy 時に Supabase ダッシュボード / CLI で実行。
--
-- Rollback:
--   alter table public.annual_budgets drop column if exists committed_settled_months;
--   alter table public.annual_budgets drop column if exists settled_months;
-- =============================================================

alter table public.annual_budgets
  add column if not exists settled_months           jsonb not null default '[]'::jsonb,
  add column if not exists committed_settled_months jsonb not null default '[]'::jsonb;

comment on column public.annual_budgets.settled_months           is '作業用:確定済み月配列 [1..12]';
comment on column public.annual_budgets.committed_settled_months is '公開用snapshot:確定済み月配列';
