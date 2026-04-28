# フェーズ B-3 着手前 チェックリスト

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-04-27 |
| 想定実施者 | 瑠星さん (Dashboard 操作) + <client_A> (端末スナップショット 1 回のみ) |
| 推定所要時間 | 合計 60-90 分 (待ち時間含む) |
| 関連 | `docs/phase-b-schema.md`, `docs/phase-b-3a-plan.md` |

順番に実施し、各項目の **空欄欄に結果を書き込む** スタイル。**全項目チェックが付くまで B-3a の DDL 適用を開始しない**。

---

## Step 0. 前提条件の確認 (5 分)

- [ ] **0-1**: Supabase Dashboard にログインできる (瑠星さん権限)
- [ ] **0-2**: 本番プロジェクトの URL と Project Ref を把握 ⇒ 記入: `____________`
- [ ] **0-3**: ローカル開発環境で `npm run dev` が起動する
- [ ] **0-4**: `git status` がクリーン (作業前に commit/stash 済み)
- [ ] **0-5**: `main` ブランチが本番と同期済み (`git pull origin main` 後 ahead 0 / behind 0)

---

## Step 1. 本番 DB 論理バックアップ取得 (Supabase CLI、15 分)

> ⚠️ **本プロジェクトは Supabase Free プラン**。Dashboard からの手動 snapshot 機能は無く、**自動バックアップも非提供**。本 Step で取得する `pg_dump` 出力が **B-3 着手前の唯一の復旧手段** となる。
>
> **B-3a / B-3b / B-3c の各段階の直前に再取得を推奨 (合計 3 回)**。そのつどファイル名の日付を更新する。

### 前提

- ローカルに `supabase` CLI がインストール済 (未インストールなら `brew install supabase/tap/supabase`)
- バージョン確認: `supabase --version`
- 直接接続 (port 5432) は IPv6 のみ。失敗する場合は **Session pooler** (port 5432 / IPv4 OK) の URI を使う

### 1-1. backups/ ディレクトリ作成 + Git 除外確認 (1 分)

```bash
mkdir -p ~/Desktop/private-cfo-app/backups
cd ~/Desktop/private-cfo-app
grep -q '^backups/' .gitignore && echo "OK: backups/ is gitignored" || echo "NG: add backups/ to .gitignore"
```

- [ ] **1-1-a**: `backups/` ディレクトリが作成された
- [ ] **1-1-b**: 上記 grep が `OK: backups/ is gitignored` を出力した (本リポは設定済み)

### 1-2. 接続文字列を Dashboard から取得 (2 分)

1. Supabase Dashboard を開く
2. 左サイドバー → **Project Settings (歯車アイコン)**
3. **Database** タブ
4. **Connection string** セクション
5. **URI** タブを選択
6. 以下のいずれかをコピー (Free プランは前者が IPv6 限定。失敗したら後者にフォールバック):
   - **Direct connection** (port 5432) — `postgresql://postgres:[YOUR-PASSWORD]@db.<ref>.supabase.co:5432/postgres`
   - **Session pooler** (port 5432, IPv4 対応) — `postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`
7. `[YOUR-PASSWORD]` 部分は **Database password** (Project Settings → Database → Database password) を **Reset** で再発行するか、初回作成時に控えた値を使う

- [ ] **1-2-a**: 接続文字列をクリップボードに保持済 (まだファイルに保存しない)

### 1-3. 接続文字列を環境変数にセット (履歴に残さない) (1 分)

**履歴に残さないため、必ず `read -rs` 経由で渡す。コマンドラインに直接書かない:**

```bash
read -rsp "Supabase DB URL を貼り付けて Enter: " SUPABASE_DB_URL
export SUPABASE_DB_URL
echo
```

- ペースト時、Terminal には何も表示されない (`-s` フラグの効果) → 入力後 Enter で確定
- `echo` は単に改行を出すため
- このシェルセッションを閉じれば変数は消える (`.zshrc` 等には書かない)

確認 (パスワード部分は隠して表示):

```bash
echo "$SUPABASE_DB_URL" | sed -E 's|(://[^:]+:)[^@]+(@)|\1***\2|'
```

- [ ] **1-3-a**: `SUPABASE_DB_URL` が `postgresql://postgres:***@db...:5432/postgres` の形で表示される

### 1-4. スキーマ dump 取得 (3 分)

```bash
DATE=$(date +%F)
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  --schema public \
  -f ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-schema.sql
```

- [ ] **1-4-a**: コマンドが `Dumping schemas from remote database...` を出して正常終了 (エラーなし)
- [ ] **1-4-b**: ファイル生成確認: `ls -lh ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-schema.sql`
  - サイズ目安: **数十 KB 〜 数百 KB** (現状 7 テーブル + RLS + functions)
  - サイズ記入欄: `___ KB`

### 1-5. データ dump 取得 (3 分)

```bash
supabase db dump \
  --db-url "$SUPABASE_DB_URL" \
  --data-only \
  -f ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-data.sql
```

- [ ] **1-5-a**: コマンドが正常終了
- [ ] **1-5-b**: ファイル生成確認: `ls -lh ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-data.sql`
  - サイズ目安: <client_A>本データの量に依存 (数十 KB〜数 MB)
  - サイズ記入欄: `___ KB`

### 1-6. dump 中身の健全性チェック (2 分)

```bash
# 先頭 20 行を表示 (ヘッダ・SET 文・拡張機能宣言が並ぶ)
head -20 ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-schema.sql

# テーブル定義が含まれているか確認
grep -c "CREATE TABLE" ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-schema.sql

# データ dump に COPY 文が含まれているか
grep -c "^COPY public\." ~/Desktop/private-cfo-app/backups/backup-pre-b3-${DATE}-data.sql
```

- [ ] **1-6-a**: schema dump 先頭に `-- PostgreSQL database dump` が見える
- [ ] **1-6-b**: `CREATE TABLE` の出現回数: `___` (期待: **7 件以上** = profiles/categories/expenses/notifications/inquiries/points_ledger/appointments)
- [ ] **1-6-c**: data dump の `COPY public.*` 出現回数: `___` (期待: **テーブル数と同等**、空テーブルは出力されない場合あり)

### 1-7. 環境変数の後始末 (30 秒)

```bash
unset SUPABASE_DB_URL
echo $SUPABASE_DB_URL  # → 何も表示されないことを確認
```

- [ ] **1-7-a**: `echo $SUPABASE_DB_URL` で何も出ない (= 環境変数クリア完了)

### 1-8. ファイルが Git に乗らないことの最終確認

```bash
cd ~/Desktop/private-cfo-app
git status backups/   # → "Untracked: backups/" すら出ないこと(完全除外)
git check-ignore -v backups/backup-pre-b3-${DATE}-schema.sql
# → ".gitignore:34:backups/" のような出力 = 除外されている証拠
```

- [ ] **1-8-a**: `git status` で backups/ が表示されない
- [ ] **1-8-b**: `git check-ignore` が ignore ルールにマッチした旨を出力

---

### Step 1 注意事項 (重要)

| 項目 | 内容 |
|---|---|
| **唯一の復旧手段** | Free プランは自動バックアップ無し。この dump が壊れていたら **B-3 で事故ったとき戻せない**。1-6 の中身チェックは必ず実施 |
| **再取得の頻度** | B-3a / B-3b / B-3c の **各着手直前に 1 回ずつ再取得** (合計 3 ファイルセット)。日付付きで上書きしないファイル名にする |
| **Git に絶対乗せない** | dump はパスワード hash や本番データを含む。`.gitignore` 設定済 (1-1-b で確認)。誤って `git add backups/` しても `.gitignore` で弾かれる |
| **パスワード履歴対策** | 接続文字列を直接コマンドラインに書かない。`read -rs` で環境変数にセット → 用済み後 `unset`。`.zshrc` 等にも書かない |
| **dump ファイルの保管場所** | `~/Desktop/private-cfo-app/backups/` のみ。クラウド同期 (iCloud Desktop 等) を使っているなら、サードパーティへ転送される可能性を意識する。機密度が高ければ別途暗号化推奨 |
| **接続失敗時** | Direct connection (db.\*.supabase.co:5432) は IPv6 限定。`Could not translate host name` 等で失敗したら **Session pooler** (aws-0-\*.pooler.supabase.com:5432) の URI に切り替えて再実行 |

---

## Step 2. 既存ユーザー数と profiles 構造の実測 — ✅ 完了 (2026-04-27)

Dashboard → SQL Editor で全 5 クエリ実行済。結果を本セクションに転記。

### 2-1. 全 profile 件数 ✅

```sql
select count(*) as total_profiles,
       count(*) filter (where role = 'admin')  as admin_count,
       count(*) filter (where role = 'client') as client_count
from public.profiles;
```

⇒ **total: 3 / admin: 1 / client: 2**

> client 2 名の内訳 (<client_A> vs 他テストアカウント) の判別は B-4 (アプリ側フック差し替え) 直前で十分。本 Step では特定不要。

### 2-2. `profiles` の実列構造 ✅ — **22 列**判明 (schema.sql 7 列 + 追加 15 列)

```sql
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;
```

⇒ 結果 (実測):

| # | 列 | 型 | NN | default |
|---|---|---|---|---|
| 1 | id | uuid | ✓ | NULL |
| 2 | email | text | ✓ | NULL |
| 3 | display_name | text |  | NULL |
| 4 | role | text | ✓ | `'client'` |
| 5 | phone | text |  | NULL |
| 6 | created_at | timestamptz | ✓ | `now()` |
| 7 | updated_at | timestamptz | ✓ | `now()` |
| 8 | age | integer |  | NULL |
| 9 | company | text |  | NULL |
| 10 | plan_type | text |  | NULL |
| 11 | plan_options | jsonb |  | `'[]'::jsonb` |
| 12 | plan_detail | text |  | NULL |
| 13 | customer_status | text |  | `'trial'` |
| 14 | start_date | date |  | NULL |
| 15 | next_topic | text |  | NULL |
| 16 | staff | text |  | NULL |
| 17 | source | text |  | NULL |
| 18 | referrer | text |  | NULL |
| 19 | refer_count | integer |  | `0` |
| 20 | app_enabled | boolean |  | `true` |
| 21 | approved | boolean | ✓ | `false` |
| 22 | **management_start_date** | **date** |  | NULL |

- [x] **2-2-a**: `approved` 列が存在 (型: `boolean` / NN ✓ / default: `false`)
- [x] **2-2-b**: `app_enabled` 列が存在 (型: `boolean` / nullable / default: `true`)
- [x] **2-2-c**: 13 列の admin CRM カラム + 1 列の `management_start_date` を新規発見
  - ⚠️ **重要発見**: `management_start_date` (date 型) が既存。設計書 §1.2.1 で解釈確認中
  - `phase-b-schema.md` §1.2 に全 22 列を反映済

### 2-3. 既存 categories 件数 ✅

```sql
select client_id, count(*) as cat_count
from public.categories
group by client_id
order by cat_count desc;
```

⇒ 結果:

| client_id (頭 8 文字) | cat_count | 備考 |
|---|---|---|
| `<client_A>...` | **15** | 既定 9 + カスタム 6 |
| `eadf0186...` | **9** | 既定のみ |
| `<client_self>...` | **9** | 既定のみ |

- [x] **2-3-a**: 全 client が `cat_count >= 9` → **懸念 4 の skip ロジックは実発動見込みゼロ**

### 2-4. 既存 expenses の `payment_method` 値分布 (懸念 1 確認) ✅

```sql
select coalesce(payment_method, '<NULL>') as pm,
       count(*) as n
from public.expenses
where deleted_at is null
group by payment_method
order by n desc;
```

⇒ 結果 (実測):

| pm | n |
|---|---|
| `cash` | 9 |
| `pm_1777128862118` | 1 |
| **合計** | **10** |

- [x] **2-4-a**: `'cash'` 以外は `pm_<13桁数字>` パターン 1 種のみ → **完全クリーン**
- [x] **2-4-b**: NULL / 空文字: **0 件** (アプリ層 defaulting が完全に効いている)
- [x] **2-4-c**: 懸念 1 の **B-3b clean-up SQL は実害ゼロで通る** 確定

### 2-5. 既存 expenses の `category` 値で「DB に対応するカテゴリ行が無い」もの (懸念 2 = バックログ確認のみ) ✅

```sql
select category, count(*)
from public.expenses e
where deleted_at is null
  and not exists (
    select 1 from public.categories c
    where c.client_id = e.client_id and c.id = e.category
  )
group by category;
```

⇒ 結果: **0 行** (期待通り)

- [x] **2-5-a**: 参照整合性は完全クリーン。`expenses.category` FK 化はバックログのまま放置可

---

### Step 2 総括

| 項目 | 状態 | 設計への影響 |
|---|---|---|
| profiles 件数 | 3 (admin 1 + client 2) | backfill SQL 影響軽微 |
| profiles ドリフト | **22 列** (baseline 7 + 追加 15) | §8.2-1 の migrations/ 復元 SQL を 13 列追加分まで含む形に拡張 |
| **`management_start_date` (date) 発見** | 要解釈確認 (§1.2.1) | 推奨設計: 別物として `user_settings.management_start_day` (smallint) を新設 |
| 懸念 1 (FK + clean-up) | **実害ゼロ判明** | B-3b で予定通り実行 |
| 懸念 4 (カテゴリ削除済み skip) | **実発動見込みゼロ判明** | skip ロジックは保険として残置 |
| 懸念 2 系 (`expenses.category` FK 不在) | 孤児 0 件、リスクなし | バックログのまま放置 |

---

## Step 3. <client_A>の localStorage スナップショット取得 (10 分、本人立ち会い)

> 懸念 1 / 4 の正確な見積もりに必須。**B-3 着手前に必ず取る**。

- [ ] **3-1**: <client_A>に以下の手順を依頼 (LINE / Slack 経由):

  1. アプリ (`private-cfo-app.vercel.app`) を **Safari** または **Chrome** で開く
  2. ログイン状態であることを確認
  3. 開発者ツール (Safari: 「開発」メニュー → Web インスペクタ / iPhone なら Mac から接続) を開く
  4. **Console タブ** で以下を貼り付けて Enter:

     ```js
     copy(JSON.stringify(
       Object.fromEntries(
         Object.entries(localStorage).filter(([k]) => k.startsWith('cfo_'))
       ),
       null, 2
     ));
     ```
  5. クリップボードに JSON がコピーされるので **そのまま LINE / Slack に貼って送る**

- [ ] **3-2**: 受領した JSON を `docs/_private/<client_A>-localStorage-2026-04-__.json` (gitignore 対象) として保存
- [ ] **3-3**: JSON から以下を集計:
  - `cfo_budgets` のキー数: `___`
  - `cfo_weekBudgets` のキー数: `___`
  - `cfo_weekCatBudgets` のキー数: `___`
  - `cfo_paymentMethods` の要素数: `___`
  - `cfo_loans` の要素数: `___`
  - `cfo_managementStartDay` の値: `___`
  - `cfo_rewardDays` の値 (配列): `___`
- [ ] **3-4**: 上記 `cfo_paymentMethods[].id` のリストと、Step 2-4 の DB 側 `payment_method` 値 (cash 以外) が **完全一致** することを確認 → 一致しなければ §8.2(1) の clean-up SQL で吸収可能か判断
- [ ] **3-5**: `cfo_budgets` のキー第 3 セグメント (catId) と、<client_A>の `categories` 行の id 集合を突合 → カテゴリ削除済み事象の有無を実測
  - 削除済みカテゴリ参照キー数: `___` 件 (= 移行時 skip 予定件数)

---

## Step 4. `supabase/migrations/` ディレクトリの整備 (15 分)

> §8.2(1)(4) 対応。schema.sql ドリフト解消 + handle_new_user 履歴管理。

- [ ] **4-1**: `supabase/migrations/` ディレクトリを作成
- [ ] **4-2**: `001_init.sql` として **現 `supabase/schema.sql` の内容をそのままコピー** (=「Migration 0 時点」)
- [ ] **4-3**: Dashboard → **SQL Editor → History** から `profiles.approved` / `app_enabled` を追加した SQL を発掘
  - 発掘できた場合: `002_profiles_approved.sql` / `003_profiles_app_enabled.sql` として保存
  - 発掘できなかった場合: 実列構造 (Step 2-2) から `alter table public.profiles add column ...` を再構成して保存
- [ ] **4-4**: `supabase/README.md` に **「migrations/ が真のソース。schema.sql は initial bootstrap 用の履歴ファイル」** と明記
- [ ] **4-5**: `git status` で 作成ファイルが Git に乗ることを確認 (`docs/_private/` は gitignore で除外、`supabase/migrations/*.sql` は commit 対象)

---

## Step 5. `expenses.payment_method` クレンジング SQL のドライラン (10 分)

> 懸念 1 (=決定 A: FK 追加) を実行する直前に流す clean-up SQL を、**まず SELECT で件数確認**。

```sql
-- (DRY RUN) 'cash' 以外で payment_methods に対応行が無い expenses を抽出
-- ※ payment_methods はまだ無い段階なので、この SELECT は B-3b の DDL を流した後に実行
--   B-3a 着手前は「Step 2-4 の結果に NULL や 'cash'/pm_<ts> 以外が無い」確認のみで OK
```

- [ ] **5-1**: Step 2-4 の結果に `'cash'` / `pm_<timestamp>` パターン以外の値が **無い** ことを再確認
- [ ] **5-2**: 異常値があった場合は本書 §8.2(1) の clean-up を B-3b の DDL の **最初** に流す方針で確定 ⇒ 個別異常値リスト: `____________`

---

## Step 6. Realtime publication 状態の事前確認 (3 分)

> 懸念 5 (= §8.2-3) 対応。

```sql
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
```

- [ ] **6-1**: 現在 publication に登録されているテーブル一覧を記録 (B-3 後の差分確認に必要):
  ```
  (現在の出力をここに貼る)
  ```
- [ ] **6-2**: 既存の `expenses` / `notifications` / `appointments` 等が登録されているか確認 (アプリで使われていない場合もある)

---

## Step 7. アプリ側 hook 雛形の準備 (任意、別 PR 推奨)

> 設計書 §5.5 のフック骨格を **B-3a の SQL 適用前に PR 切っておく** ことで、SQL 適用直後にデプロイまで一気通貫できる。

- [ ] **7-1**: `src/lib/api/budgets.js` (CRUD 薄ラッパ、現状 categories.js と同じ形) のスケルトン作成
- [ ] **7-2**: `src/hooks/useBudgets.js` の骨格作成 (まだ App.jsx には繋がない)
- [ ] **7-3**: TypeScript 化はしない (既存コードベースが JSX のため)

(本ステップは B-3a 計画書 `docs/phase-b-3a-plan.md` の Step 3 と統合可能)

---

## ステップ完了の判定

**Step 0 〜 6 が全て [x] になった時点で B-3a 着手可**。

Step 7 は B-3a の作業中に着手してもよい (= マージしないがブランチ用意しておく)。

不明点があれば本書ではなく `docs/phase-b-schema.md` §8 を再読し、それでも判断付かなければ B-3a を開始せず議論する。
