# supabase/

プライベートCFO 顧客アプリの Supabase スキーマ定義。

## ファイル

- `schema.sql` — 全テーブル + RLS + helper + trigger + view を 1 ファイルで定義

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
