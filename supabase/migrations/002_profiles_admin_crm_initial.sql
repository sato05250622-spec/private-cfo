-- =============================================================
-- Migration 002: profiles に admin CRM 12 列 + CHECK 制約 2 件
-- 適用済日: 不明 (Dashboard SQL History 未確認)
-- 由来: 本部アプリの顧客管理 UI 追加に伴うもの
-- 備考:
--   - management_start_date は後発のため本ファイルに含めない (→ 004 へ)
--   - 本ファイルは「本番への再適用は不要」(履歴記録目的)。
--     既に流された SQL の再現で、新規環境構築用に残す。
-- =============================================================

-- ---- 12 列追加 (idempotent: IF NOT EXISTS) ---------------------
alter table public.profiles
  add column if not exists age              integer,
  add column if not exists company          text,
  add column if not exists plan_type        text,
  add column if not exists plan_options     jsonb        default '[]'::jsonb,
  add column if not exists plan_detail      text,
  add column if not exists customer_status  text         default 'trial',
  add column if not exists start_date       date,
  add column if not exists next_topic       text,
  add column if not exists staff            text,
  add column if not exists source           text,
  add column if not exists referrer         text,
  add column if not exists refer_count      integer      default 0;

-- ---- CHECK 制約 2 件 (NOT VALID で既存データ保護) ---------------
-- NOT VALID: 既存行は検証しない、以降の INSERT/UPDATE のみ強制
-- DO ブロックで idempotent (既に同名制約があれば skip)

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname  = 'profiles_customer_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_customer_status_check
      check (customer_status in ('trial', 'active', 'canceled'))
      not valid;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname  = 'profiles_plan_type_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_plan_type_check
      check (plan_type in ('personal', 'corporate'))
      not valid;
  end if;
end $$;

-- ---- 列コメント (推測値、Dashboard で設定済の可能性あり) --------
-- comment on column は idempotent (再実行で上書き)
comment on column public.profiles.age              is '顧客年齢 (admin CRM)';
comment on column public.profiles.company          is '所属会社 (admin CRM)';
comment on column public.profiles.plan_type        is '契約プラン種別: personal / corporate (admin CRM)';
comment on column public.profiles.plan_options     is 'プランオプション群 (jsonb)';
comment on column public.profiles.plan_detail      is 'プラン補足記述';
comment on column public.profiles.customer_status  is '顧客ステータス: trial / active / canceled (admin CRM)';
comment on column public.profiles.start_date       is '契約開始日 (admin CRM)';
comment on column public.profiles.next_topic       is '次回面談トピックメモ';
comment on column public.profiles.staff            is '担当スタッフ';
comment on column public.profiles.source           is '流入経路';
comment on column public.profiles.referrer         is '紹介者';
comment on column public.profiles.refer_count      is '紹介人数 (default 0)';
