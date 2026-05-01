# supabase/

プライベートCFO 顧客アプリの Supabase スキーマ定義。

## ファイル

- `migrations/` — **真のソースオブトゥルース** (2026-04-27 追加、フェーズ B-2 Step 1-bis)
- `schema.sql` — 初期構築の baseline 記録 (= migrations/001_init.sql と同一)。historical reference として残置

## migrations/ について (2026-04-27 追加)

実 DB の `profiles` は schema.sql の baseline 7 列から **22 列まで** 拡張済 (フェーズ B-2 Step 2 で実測)。`migrations/` ディレクトリは、過去に Dashboard SQL Editor で都度流された ALTER TABLE 群を、後追いで履歴ファイル化したもの。

### 適用順とファイル責務

| # | ファイル | 内容 |
|---|---|---|
| 001 | `001_init.sql` | 初期スキーマ全文 (= `schema.sql` の完全コピー)。profiles baseline 7 列 + 7 テーブル + RLS + functions |
| 002 | `002_profiles_admin_crm_initial.sql` | admin CRM 12 列追加 (`age` / `company` / `plan_type` / `plan_options` / `plan_detail` / `customer_status` / `start_date` / `next_topic` / `staff` / `source` / `referrer` / `refer_count`) + CHECK 制約 2 件 (`plan_type`, `customer_status`) |
| 003 | `003_profiles_app_gate_columns.sql` | アプリゲート 2 列追加 (`app_enabled`, `approved`) + 承認待ち顧客検索用 partial index `profiles_pending_idx` |
| 004 | `004_profiles_management_start_date.sql` | `management_start_date` (date) 1 列追加 |
| 005 | `005_profiles_updated_trigger.sql` | `handle_updated_at()` 関数 + `on_profiles_updated` トリガー (※ 既存の `trg_profiles_updated_at` と機能重複。詳細は下の「既知の課題」) |
| 009 | `009_profiles_management_start_day.sql` | `management_start_day` (smallint, 1-31) 1 列追加。NULL 許可。customer 側 localStorage の `cfo_managementStartDay` を Supabase に昇格させ admin から各顧客のサイクル起点日を読めるようにする (B-2 sync で順次充填、未充填は NULL = カレンダー月 fallback) |

### 新規環境への適用方法

ローカル / テスト DB を再構築する場合は順番に流す:

```bash
# 例: 環境変数で DB URL を設定済の前提
psql "$DATABASE_URL" -f supabase/migrations/001_init.sql
psql "$DATABASE_URL" -f supabase/migrations/002_profiles_admin_crm_initial.sql
psql "$DATABASE_URL" -f supabase/migrations/003_profiles_app_gate_columns.sql
psql "$DATABASE_URL" -f supabase/migrations/004_profiles_management_start_date.sql
psql "$DATABASE_URL" -f supabase/migrations/005_profiles_updated_trigger.sql
psql "$DATABASE_URL" -f supabase/migrations/009_profiles_management_start_day.sql
```

または Supabase CLI 経由:

```bash
supabase db push --db-url "$DATABASE_URL"
```

### 本番 DB への適用は不要

本番には既に同等の SQL が Dashboard 経由で流されている。`migrations/` は **記録目的** であり、本番への再適用は不要。`if not exists` / DO ブロック guard により再実行しても no-op で安全。

### 既知の課題

- **profiles 重複トリガー** (Migration 005): `trg_profiles_updated_at` (`set_updated_at()` 使用、Migration 001 由来) と `on_profiles_updated` (`handle_updated_at()` 使用、Migration 005 由来) の 2 つが BEFORE UPDATE で発火する。挙動 (= `updated_at = now()`) は同一のため実害なしだが冗長。整理は B 範囲外、`docs/todo.md` バックログ参照
- **`profiles_pending_idx` の列名未確定** (Migration 003): Dashboard 出力から `USING btree (xxx)` の xxx を完全特定できず。99% `created_at` と推定。`docs/todo.md` バックログ参照
- **`handle_updated_at()` 関数本体は推定実装** (Migration 005): 実 DB の関数定義ソースが未入手のため `set_updated_at()` と同じ挙動になる前提で再構成。後日 `pg_get_functiondef('public.handle_updated_at()'::regprocedure)` の出力で確認・差し替え推奨
- **CHECK 制約は `NOT VALID` 付き** (Migration 002): 既存行の検証をスキップ (= 既存データに違反値があってもエラーにならない)。新規 INSERT/UPDATE のみ強制。実際のところ既存 3 件は違反していないはずだが、安全側に倒した

---

# 以下、レガシー — schema.sql 単独運用時代の記録

> 2026-04-22 〜 2026-04-27 まで運用していた手順。`migrations/` 移行後はこのセクションは記録目的で残置。新規環境構築は上記「migrations/ について」を参照。

## 適用手順(初回)

1. Supabase Dashboard にログイン
2. 左メニュー **SQL Editor** を開く
3. **New query** をクリック
4. `schema.sql` の中身を丸ごとコピー → 貼り付け
5. 右下の **Run**(⌘+Enter)で実行
6. "Success. No rows returned" 表示を確認
7. 左メニュー **Table Editor** で以下 7 テーブル + 1 ビューが出ているか目視:
   - `profiles` / `categories` / `expenses` / `notifications` /
     `inquiries` / `points_ledger` / `appointments`
   - (ビュー)`points_balances`

## 初回 admin 昇格

schema を流した直後は **admin ロールを持つユーザーが 1 人もいない**。
以下の順で 1 人だけ admin にする:

1. 顧客アプリ(`private-cfo-app`)で一度ログイン(Google or Email)
   → `profiles` に自分の行が `role='client'` で自動作成される
2. Dashboard → **Table Editor → profiles** → 自分の行を編集
3. `role` を `client` → `admin` に書き換え → Save
4. アプリを再読み込み(セッション更新)

以降、本部アプリ(将来の `admin175-project`)はこの admin ロールを
持つユーザーでログインして全顧客データを操作できるようになる。

## 変更・再適用

**初回用**の SQL なので `create table` のまま。既に流した環境で再適用すると
`relation already exists` エラーになる。変更時は以下のいずれか:

- **軽微な変更**: Dashboard SQL Editor で該当テーブルに `alter table ...` を直接流す
- **構造の大幅変更(まだ本番データが無い)**: 全テーブルを drop して
  `schema.sql` を再適用。以下の drop スクリプトを SQL Editor で実行:

  ```sql
  drop table if exists public.appointments   cascade;
  drop table if exists public.points_ledger  cascade;
  drop table if exists public.inquiries      cascade;
  drop table if exists public.notifications  cascade;
  drop table if exists public.expenses       cascade;
  drop table if exists public.categories     cascade;
  drop table if exists public.profiles       cascade;
  drop view  if exists public.points_balances;
  drop function if exists public.is_admin()          cascade;
  drop function if exists public.set_updated_at()    cascade;
  drop function if exists public.handle_new_user()   cascade;
  ```

  **注**: 本番データが入ってからは絶対にやらない。Phase 1 リリース以降は
  個別 `alter` + マイグレーションファイル管理(Supabase CLI など)に移行する。

## RLS テスト(流した後の推奨チェック)

1. Dashboard → **Authentication → Users** で 2 人の **テストユーザー**(別メール)を作成
2. 片方の `profiles.role` を `admin` に昇格
3. 顧客アプリから 2 人でそれぞれログインし、互いの支出が見えないこと・admin は両方見えることを確認(Phase 4 の認証実装後)

## 備考

- `handle_new_user` トリガは Supabase Auth の signup 時に必ず発火する。
  trigger が失敗すると signup 自体が失敗するため、変更時は要注意
- `is_admin()` は security definer 関数。profiles テーブルの RLS をバイパス
  して role を読むので、profiles 自身のポリシーから安全に呼べる
- `points_balances` ビューは `security_invoker = true` で呼び出し元の RLS
  を継承する(RLS バイパス事故の防止)
