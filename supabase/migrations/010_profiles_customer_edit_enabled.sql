-- Phase E ⑦-2: 顧客自身による編集許可フラグ
-- default false = 全既存顧客はロック状態でスタート(⑦-1 のハードコード false と等価)
-- 本部側から true に UPDATE することで該当顧客のみ編集解放
-- 既存パターン (003_app_enabled, approved 等) に揃える
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS customer_edit_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.customer_edit_enabled IS
  '顧客自身がアプリ内で予算/カテゴリ/支払い方法を編集できるか。本部側で切替。';
