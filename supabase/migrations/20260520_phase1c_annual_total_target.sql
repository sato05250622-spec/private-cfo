-- ============================================================
-- Phase 1c - 年間総予算 (annual total target) カラム追加
-- ------------------------------------------------------------
-- 背景:
--   従来「全体の年間予算」はカテゴリ別 target_value の単純合計だったが、
--   全体を独立して入力できるよう専用カラムを追加する。
--   - annual_total_target           : 作業用の年間総予算 (全体)
--   - committed_annual_total_target : 公開 snapshot 用 (commitSnapshot で凍結)
--
-- 適用方針:
--   - ADD COLUMN IF NOT EXISTS で冪等。既存行は DEFAULT NULL。
--   - NULL = 未設定 = 顧客側はカテゴリ別合計へフォールバック。
--   - 実 DB 適用は deploy 時に Supabase ダッシュボード / CLI で実行。
--
-- Rollback:
--   alter table public.annual_budgets drop column if exists committed_annual_total_target;
--   alter table public.annual_budgets drop column if exists annual_total_target;
-- ============================================================

ALTER TABLE public.annual_budgets
  ADD COLUMN IF NOT EXISTS annual_total_target numeric DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS committed_annual_total_target numeric DEFAULT NULL;

COMMENT ON COLUMN public.annual_budgets.annual_total_target
  IS '作業用:年間総予算(全体)';
COMMENT ON COLUMN public.annual_budgets.committed_annual_total_target
  IS '公開用snapshot:年間総予算(全体)';
