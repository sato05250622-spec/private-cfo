-- =============================================================
-- Migration 003: profiles に承認ゲート / アプリ有効化フラグ + partial index
-- 適用済日: 不明 (Dashboard SQL History 未確認)
-- 由来:
--   - app_enabled / approved: src/components/AuthGate.jsx の AppDisabled /
--     PendingApprovalMessage 実装と同期
--   - profiles_pending_idx: 承認待ち顧客の高速検索用 partial index
-- 備考: 本ファイルは「本番への再適用は不要」(履歴記録目的)
-- =============================================================

-- ---- 2 列追加 (idempotent) -------------------------------------
-- app_enabled: nullable / default true (= 未取得時は AuthGate が許容)
-- approved   : NOT NULL / default false (= 承認待ち)
alter table public.profiles
  add column if not exists app_enabled boolean          default true,
  add column if not exists approved    boolean not null default false;

comment on column public.profiles.app_enabled is
  'アプリ全体を停止するフラグ。false で AuthGate が AppDisabled を表示';
comment on column public.profiles.approved is
  '本部の承認ゲート。false で AuthGate が PendingApprovalMessage を表示';

-- ---- partial index (承認待ち顧客の高速検索) --------------------
-- ⚠️ 列名は created_at と推定 (Dashboard 出力から完全特定できず)
--   docs/todo.md に最終確認バックログを残置
-- 用途: admin が承認待ちユーザー一覧を表示する際の order by + filter 高速化
create index if not exists profiles_pending_idx
  on public.profiles (created_at)
  where (approved = false and role = 'client');

comment on index public.profiles_pending_idx is
  '承認待ち client の created_at 順検索用 partial index (admin 用)';
