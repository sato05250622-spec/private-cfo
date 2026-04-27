-- =============================================================
-- Migration 005: profiles 専用 updated_at トリガー (handle_updated_at)
-- 適用済日: 不明 (Dashboard SQL History 未確認)
-- 由来: profiles に対して set_updated_at() の trg_profiles_updated_at とは
--   別に、handle_updated_at() を呼ぶ on_profiles_updated トリガーが追加済。
--   重複トリガー状態。経緯不明。
-- 備考:
--   - ⚠️ schema.sql の trg_profiles_updated_at と同じテーブル / 同じ
--     タイミング (BEFORE UPDATE) で発火する。整合動作は同じだが冗長
--   - 重複解消は B 範囲外 → docs/todo.md にバックログ追加済
--   - handle_updated_at() の本体は不明のため、set_updated_at() と同じ
--     挙動になるよう推定で再構成。実 DB のソースが取れたら差し替え
--   - 本ファイルは「本番への再適用は不要」(履歴記録目的)
-- =============================================================

-- ---- handle_updated_at 関数 (推定実装、要検証) ------------------
create or replace function public.handle_updated_at() returns trigger
  language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

comment on function public.handle_updated_at() is
  'updated_at 自動更新トリガー関数 (profiles 専用、set_updated_at と機能重複)';

-- ---- on_profiles_updated トリガー -----------------------------
drop trigger if exists on_profiles_updated on public.profiles;
create trigger on_profiles_updated
  before update on public.profiles
  for each row execute procedure public.handle_updated_at();
