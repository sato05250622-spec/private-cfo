-- =============================================================
-- Phase E 最終ゴール — Step 1: monthly_reviews の公開列 + RLS を repo に記録
-- -------------------------------------------------------------
-- 背景:
--   monthly_reviews は migration 011 (011_phase_1b3_history_reviews.sql) で
--   作成されたが、その時点では公開制御列がなく、顧客 RLS は
--   monthly_reviews_client_select_own (client_id = auth.uid()) のみだった。
--   その後 admin アプリ (Phase B Step 3a) で is_published / published_at /
--   published_by 列と「反映トグル」が Supabase Dashboard 直編集で追加され、
--   顧客 RLS も is_published=true 条件付きに更新されたが、repo の migration
--   ファイルに記録が残っていなかった。
--   Phase E 最終ゴール (顧客アプリへの月次レビュー表示) で顧客側 RLS に
--   依存するため、現状 DB 状態をここに記録して repo との乖離を解消する。
--
-- 適用方針:
--   - 本ファイルは「記録目的」。本番 DB は既に同等状態のため適用不要。
--   - 全ステートメント冪等 (ADD COLUMN IF NOT EXISTS / DROP→CREATE POLICY)。
--     既存 DB に再適用しても害なし。
--
-- ⚠️ 注意 (型・default の確度):
--   is_published の型 (boolean) と default (false) は admin API コード
--   (src/lib/api/monthlyReviews.js: 新規 INSERT 時 is_published 未指定なら
--   false) からの推定。Step 0 (b) の Dashboard 出力と突き合わせて差異が
--   あれば後続 migration で補正すること。
--
-- 変更内容:
--   - 公開制御 3 列を追加 (既存時は no-op):
--       is_published boolean not null default false
--       published_at timestamptz
--       published_by uuid references profiles(id)
--   - RLS ポリシー再定義:
--       monthly_reviews_admin_all                : admin は全権 (is_admin())
--       monthly_reviews_client_select_published  : 顧客は自分の行のうち
--                                                  is_published=true を SELECT のみ
--   - migration 011 で定義した旧 monthly_reviews_client_select_own は
--     公開制御がないため DROP する (is_published=false の下書きが顧客に
--     見えてしまうのを防ぐ)。
--
-- Rollback (記録目的のため通常不要):
--   drop policy if exists "monthly_reviews_client_select_published" on public.monthly_reviews;
--   drop policy if exists "monthly_reviews_admin_all" on public.monthly_reviews;
--   alter table public.monthly_reviews
--     drop column if exists is_published,
--     drop column if exists published_at,
--     drop column if exists published_by;
-- =============================================================

-- ---- 公開制御列 (既存時は no-op、記録目的) -------------------------
alter table public.monthly_reviews
  add column if not exists is_published boolean not null default false,
  add column if not exists published_at timestamptz,
  add column if not exists published_by uuid references public.profiles(id);

-- ---- RLS ------------------------------------------------------------
alter table public.monthly_reviews enable row level security;

-- 本部 admin は全権 (作成・編集・削除・公開トグル)
drop policy if exists "monthly_reviews_admin_all" on public.monthly_reviews;
create policy "monthly_reviews_admin_all" on public.monthly_reviews
  for all using (public.is_admin())
  with check (public.is_admin());

-- migration 011 の旧ポリシー (公開制御なし) を撤去
drop policy if exists "monthly_reviews_client_select_own" on public.monthly_reviews;

-- 顧客は自分のレビューのうち is_published=true のものを SELECT のみ
drop policy if exists "monthly_reviews_client_select_published" on public.monthly_reviews;
create policy "monthly_reviews_client_select_published" on public.monthly_reviews
  for select using (client_id = auth.uid() and is_published = true);
