-- =============================================================
-- Migration 009: profiles に management_start_day (smallint, 1-31) を追加
-- 適用予定日: 2026-05-01
-- 由来:
--   customer 側 cycle.js / App.jsx は managementStartDay を localStorage
--   ('cfo_managementStartDay') で保持していた。本 migration で同値を
--   Supabase profiles に昇格させ、admin 側からも各顧客のサイクル起点日を
--   読めるようにする (admin BudgetProgressTab / useCurrentWeekUsageByClient
--   の cycle-aware 化が目的、本日 02:00 の作業窓内で実施)。
--
-- 既存列との関係 (混同注意):
--   - profiles.start_date            (002, date)    — 契約開始日 (CFO サービス開始日)
--   - profiles.management_start_date (004, date)    — 用途未確定 orphan、touch しない方針
--   - profiles.management_start_day  (009, smallint) — 本 migration、1-31 day-of-month
-- 命名差異: -date は単一の暦日付、-day は繰り返し用の月内 day-of-month。
--
-- NULL 許可方針 (DEFAULT なし、NOT NULL なし):
--   - 既存ユーザー全員 NULL でスタート
--   - customer 側のログイン sync (B-2) で localStorage の値を順次 upsert
--   - NULL の解釈は「未設定 = カレンダー月起点 (msd=1 同等)」
--   - DEFAULT 1 を採らない理由: 実は localStorage に msd=25 を持つユーザー
--     が新端末でログインしたとき profile.msd=1 (誤値) が降りて事故るため。
--     NULL なら sync 側が「未設定」を検知して localStorage の値を優先できる。
--
-- 制約: smallint は -32768〜32767 だが CHECK で 1-31 に制限。
--       NULL も許容するため `is null or between 1 and 31` の OR 形式。
-- =============================================================

alter table public.profiles
  add column if not exists management_start_day smallint
    check (management_start_day is null
        or (management_start_day between 1 and 31));

comment on column public.profiles.management_start_day is
  'サイクル起点日 (1-31)。NULL = 未設定 = カレンダー月起点。'
  ' customer 側 cycle.js の getManagementStartDay() に対応。'
  ' management_start_date (004, date 型 orphan) とは別概念。';
