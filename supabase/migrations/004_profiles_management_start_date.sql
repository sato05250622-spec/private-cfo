-- =============================================================
-- Migration 004: profiles に management_start_date を追加
-- 適用済日: 不明 (CRM 第 1 弾 + app_gate より後、最も新しい列追加)
-- 由来: ⚠️ 解釈未確定 — docs/phase-b-schema.md §1.2.1 参照
--   仮説 A (推奨): 「顧客の CFO 管理開始日」(契約・関係性開始日)
--   仮説 B (要警戒): 「毎月のサイクル起点日」(date 型で日付ピッカー運用)
-- 備考:
--   - customer 側 cycle.js は本列を読まず localStorage を直読みしている
--   - フェーズ B では本列に touch しない方針 (admin 側の用途確認待ち)
--   - 本ファイルは「本番への再適用は不要」(履歴記録目的)
-- =============================================================

alter table public.profiles
  add column if not exists management_start_date date;

comment on column public.profiles.management_start_date is
  'CFO 管理開始日 (admin CRM)。詳細は docs/phase-b-schema.md §1.2.1';
