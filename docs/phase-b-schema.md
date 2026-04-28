# フェーズ B-2 設計書 — localStorage → Supabase 移行スキーマ (最終版)

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-04-27 |
| 最終更新 | 2026-04-27 (懸念 1 / 3 / 4 決定反映) |
| ステータス | **承認済 — B-3 適用待ち**。SQL は未実行 |
| 関連 | `docs/phase-b-checklist.md` (B-3 着手前の準備項目)<br>`docs/phase-b-3a-plan.md` (B-3a 作業計画ドラフト) |

---

## 0. このドキュメントの位置づけ

B-1 で localStorage に残っていた 7 キーを特定した。本書はそれを Supabase
側に格納するための **テーブル設計・RLS・移行手順・ロールバック手順** を
まとめた **最終化された設計書** である。

**今は SQL を流さない。** B-2 レビューで確定した 3 件の意思決定 (§8.1) を
反映済み。残課題 (§8.2) は B-3 着手前に解消する想定。

**既存本番 URL (`private-cfo-app.vercel.app`) は変更しない**。Vercel
プロジェクト設定にも一切触らない。本変更は Supabase 側 DDL とアプリ
コードのみで完結する。

---

## 1. Supabase 現状確認 (Step 1)

### 1.1 `supabase/schema.sql` の baseline

リポジトリにチェックインされているのは初回投入用の DDL 1 ファイル。
以下 7 テーブル + 1 ビューを定義済み:

| 名前 | 種別 | 主な列 |
|---|---|---|
| `profiles` | table | `id (uuid PK = auth.users.id)`, `email`, `display_name`, `role ('client'\|'admin')`, `phone`, `created_at`, `updated_at` |
| `categories` | table | **PK = `(client_id, id)`**, `id text`, `client_id uuid → profiles`, `label`, `icon_key`, `color`, `sort_order`, `created_at` |
| `expenses` | table | `id uuid PK`, `client_id`, `entered_by`, `date`, `amount bigint`, `category text` (= `categories.id`), `memo`, `payment_method text`, `is_recurring`, `recur_id`, `deleted_at`, `created_at`, `updated_at` |
| `notifications` | table | `id`, `client_id`, `sender_id`, `kind ('telop'\|'notice')`, `body`, `published_at`, `read_at`, `expires_at` |
| `inquiries` | table | `id`, `client_id`, `body`, `status`, `replied_*`, `created_at` |
| `points_ledger` | table | `id`, `client_id`, `delta`, `reason`, `created_by`, `created_at` |
| `appointments` | table | `id`, `client_id`, `scheduled_at`, `duration_min`, `status`, `requested_at`, `request_reason`, `admin_notes`, `created_by`, `created_at`, `updated_at` |
| `points_balances` | view | `client_id`, `balance` (合計、`security_invoker`) |

トリガ・関数:
- `set_updated_at()` — 汎用 `updated_at` 自動更新トリガ関数
- `is_admin()` — `security definer`、`profiles.role='admin'` 判定
- `handle_new_user()` — `auth.users` INSERT 時に `profiles` + 既定 9 カテゴリを自動投入

### 1.2 schema.sql に反映されていない実 DB の差分 (重要、B-2 Step 2 で実測)

> **2026-04-27 の Step 2 計測結果**: `profiles` は実 DB で **22 列**まで膨張済 (schema.sql baseline は 7 列)。Migration 1 と読んでいたものは実際には **15 列追加** + admin アプリ用 CRM カラムの大規模追加であった。

#### 全 22 列リスト (実測ベース、`information_schema.columns` 由来)

| # | 列名 | 型 | NOT NULL | default | 由来・用途 |
|---|---|---|---|---|---|
| 1 | `id` | uuid | ✓ | (auth.users.id) | schema.sql baseline |
| 2 | `email` | text | ✓ | — | schema.sql baseline |
| 3 | `display_name` | text |  | — | schema.sql baseline |
| 4 | `role` | text | ✓ | `'client'` | schema.sql baseline |
| 5 | `phone` | text |  | — | schema.sql baseline |
| 6 | `created_at` | timestamptz | ✓ | `now()` | schema.sql baseline |
| 7 | `updated_at` | timestamptz | ✓ | `now()` | schema.sql baseline |
| 8 | `age` | integer |  | — | **admin CRM** (顧客年齢) |
| 9 | `company` | text |  | — | **admin CRM** (所属会社) |
| 10 | `plan_type` | text |  | — | **admin CRM** (契約プラン) |
| 11 | `plan_options` | jsonb |  | `'[]'::jsonb` | **admin CRM** (プランオプション群) |
| 12 | `plan_detail` | text |  | — | **admin CRM** (プラン補足) |
| 13 | `customer_status` | text |  | `'trial'` | **admin CRM** (顧客ステータス) |
| 14 | `start_date` | date |  | — | **admin CRM** (契約開始日) |
| 15 | `next_topic` | text |  | — | **admin CRM** (次回面談トピック) |
| 16 | `staff` | text |  | — | **admin CRM** (担当者) |
| 17 | `source` | text |  | — | **admin CRM** (流入経路) |
| 18 | `referrer` | text |  | — | **admin CRM** (紹介者) |
| 19 | `refer_count` | integer |  | `0` | **admin CRM** (紹介人数) |
| 20 | `app_enabled` | boolean |  | `true` | アプリ全体停止フラグ (`AuthGate` の `AppDisabled`) |
| 21 | `approved` | boolean | ✓ | `false` | 承認ゲート (`AuthGate` の `PendingApprovalMessage`) |
| 22 | `management_start_date` | **date** |  | — | ⚠️ **解釈確認必要** — §1.2.1 参照 |

> **schema.sql baseline 7 列 + 追加 15 列 = 22 列**。13 列が admin アプリ向け CRM カラム、2 列がアプリゲート、**1 列 (`management_start_date`) が要解釈確認**。

⚠️ **B-3 で `profiles` に列を足すことはあっても、上記 22 列はいずれも破壊しない。** 本設計書の `user_settings` は `profiles` には touch しない方針 (§3.4)。

→ **schema.sql ドリフトの解消方針**は §8.2 (1) を参照 (この発見により復元する SQL の量が増えた)。

---

### 1.2.1 `profiles.management_start_date` (date 型) の解釈 — 要確認

**事実**:
- 実 DB に `profiles.management_start_date` が **`date` 型 / nullable / default なし** で存在
- 設計書の `user_settings.management_start_day` (`smallint` 1-31) と **名前が酷似** している
- localStorage の `cfo_managementStartDay` も整数 1-31 で別物

**最有力仮説 (= 推奨設計)**: **2 つは別概念**

| 列 | 型 | 意味 (推定) | 想定用途 |
|---|---|---|---|
| `profiles.management_start_date` | `date` | **「この顧客のプライベートCFO 管理開始日」** | admin が顧客のプロフィール詳細に表示する記録専用 |
| (新規) `user_settings.management_start_day` | `smallint 1-31` | **「毎月のサイクル起点日」** | 顧客アプリの cycle.js が読む、報酬日サイクル切替 |

根拠:
1. `profiles.management_start_date` の隣接列 (`start_date`, `customer_status`, `plan_type`, `next_topic`, `staff`, `source`, `referrer`) は **明確に admin CRM 系**。同じグループに属する記録項目と読むのが自然
2. 型が `date` (年月日まで含む) であり、「毎月の N 日」(1-31 の整数) を表すには冗長。`integer` か `smallint` で実装するのが普通
3. cycle.js は localStorage を直読みしており、**現状この `profiles.management_start_date` は customer 側で参照されていない**
4. 名前は似ているが **`_date` (date) と `_day` (1-31)** で語末が違うのが意図的な区別の可能性が高い

**検討した別仮説**:

- 仮説 B (同一概念、エンコード違い): `profiles.management_start_date = '2026-04-25'` の `25` だけを使ってサイクル起点日とする  
  → 実装上、年月情報を捨てる前提で date 型を使うのは不自然。仮説 A のほうが整合度が高い
- 仮説 C (admin アプリが両用途で使用): admin が日付ピッカーで設定し、customer 側はその day 部分を抽出して使う  
  → 可能性ゼロではないが、admin アプリのソースを確認しないと断定できない

**推奨設計**: **仮説 A を採用、`user_settings.management_start_day` を新設 (設計書のまま)**

- メリット: `profiles.management_start_date` には **一切 touch しない**。admin アプリの既存挙動に影響ゼロ
- リスク: もし瑠星さん側で「`management_start_date` を customer 側のサイクル設定として既に使い始めている」場合は **重複 / 同期問題** が起きる
- ロールバック容易性: ✅ もし後日「実は同じものだった」と判明したら、`user_settings.management_start_day` を drop して `profiles.management_start_date` 読みに統一する PR を 1 本切れば済む (legacy_key 列は無いが、management_start_day はそもそも入力後上書き型なので legacy 復元は問題にならない)

**残る判断** (瑠星さんに確認):
- ❓ admin アプリ (`admin175-project`) で `profiles.management_start_date` をどう使っているか
  - **(A) 「顧客の管理開始日」として 1 度入力する記録**? → 推奨設計でそのまま進めて OK
  - **(B) 「毎月のサイクル起点日」として日付ピッカーで運用中**? → 設計を見直し、`user_settings.management_start_day` を取り消して `profiles.management_start_date` 読みに統一する案へ切り替え

### 1.3 既存 RLS ポリシーの方針 (確認)

- 顧客 (`role='client'`): `client_id = auth.uid()` の行のみ
- 本部 (`role='admin'`): `is_admin()` で全行
- `expenses` は顧客 DELETE 不可 (soft delete のみ)

本設計書の 6 テーブルもこの 2 軸 (自分のみ / admin 全部) を踏襲する。

### 1.4 `categories.id` 型の確定

**`text`**。`'entertainment'` などの意味のある既定 ID と `'custom_<uuid>'` のカスタム ID が混在し、PK は `(client_id, id)` 複合。
→ 本設計書で `categories(id)` を FK 参照する箇所は **複合 FK `(client_id, category_id)` references `categories(client_id, id)`** とする。

### 1.5 既存ユーザー数の実測 (2026-04-27 完了)

Step 2 で計測済み (詳細は `docs/phase-b-checklist.md` 参照):

| 計測項目 | 値 | 設計への影響 |
|---|---|---|
| profiles 総数 | 3 (admin 1 + client 2) | backfill SQL は 2 client 分のみ → 影響軽微 |
| categories 件数 (client A) | 15 (既定 9 + カスタム 6) | 既定削除なし、カスタム多 |
| categories 件数 (client B) | 9 (既定のみ) | 削除なし |
| categories 件数 (client C) | 9 (既定のみ) | 削除なし |
| **懸念 4 実発動有無** | **無し** (全 client が `cat_count >= 9`) | クライアント側 skip ロジックは保険として残すが実発動見込みゼロ |
| expenses.payment_method 分布 | `cash`: 9 / `pm_1777128862118`: 1 (合計 10) | クリーン。**懸念 1 の clean-up SQL は実害ゼロで通る** |
| expenses.payment_method NULL | 0 | アプリ層 defaulting が完全に効いている |
| expenses.category 孤児 | **0 行** | 参照整合性クリーン。`expenses.category` FK 化はバックログのまま放置可 |

---

## 2. B-1 で特定された 7 キー (再確認)

| # | localStorage キー | 形 (App.jsx 上) | 例 |
|---|---|---|---|
| 1 | `cfo_budgets` | `Record<string, number>` | `{"2026-4-entertainment": 30000, ...}` |
| 2 | `cfo_weekBudgets` | `Record<string, number>` | `{"2026-4-w1": 15000, ...}` |
| 3 | `cfo_weekCatBudgets` | `Record<string, number>` | `{"2026-4-w1_entertainment": 5000, ...}` |
| 4 | `cfo_paymentMethods` | `Array<{ id, label, color, closingDay?, withdrawalDay?, bank? }>` | seed: `[{id:"cash",label:"現金",color:"#4CAF50"}]` |
| 5 | `cfo_loans` | `Array<{ id, label, amount, bank, withdrawalDay, pmId }>` | `id` は `loan_<timestamp>`, `withdrawalDay` は `"1".."31"` または `"末"` |
| 6 | `cfo_managementStartDay` | `number 1-31` または null | `25` |
| 7 | `cfo_rewardDays` | `number[] (1-31)` JSON | `[25, 10]` |

キー文字列の構造:
- 月予算キー: `${year}-${cycleMonth1based}-${categoryId}`
- 週予算キー: `${year}-${cycleMonth1based}-w${weekNum}`
- 週カテゴリ予算キー: `${weekKey}_${categoryId}`
- 「年・月」はサイクル年・月 (`findCycleOfDate` の戻り値)。`managementStartDay` 未設定なら従来カレンダー月と等価。

---

## 3. 新規 6 テーブル DDL

### 3.1 共通方針

- **PK / 一意性**: 物理 PK は単純な `uuid` を入れず、業務キー (合成 PK) で設計。`(client_id, ...)` を必ず先頭に置く
- **FK 参照**: `categories` は複合 PK のため、`category_id` を持つ表は **複合 FK** `(client_id, category_id) references categories(client_id, id) on delete cascade`
- **`updated_at` 列必須** (Realtime + 監査)。`set_updated_at()` トリガを全表に付ける
- **`legacy_id` / `legacy_key` 列を保持** (旧 localStorage の文字列キーを温存し、リプレイ・原因調査・ロールバックに使う)
- **金額** は `bigint check (amount >= 0)` (円整数)。`expenses.amount > 0` と異なり予算は 0 円明示も許容
- **不変条件**: `cycle_month` は 1-12、`week_num` は 1-4、`day` 系は `'1'..'31'|'末'`。`check` 制約で守る
- **削除**: `client_id` への FK は `on delete cascade` (顧客削除で予算系も一緒に消える)
- **列コメント**: 各テーブルに `comment on column ...` を付け、`cycle_month` / `legacy_key` の意味を DB 側にも残す (§8.2-2)

---

### 3.2 B-3a: 予算系 3 表

#### `budgets` (= `cfo_budgets`)

```sql
create table public.budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  category_id  text not null,
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, category_id),
  foreign key (client_id, category_id)
    references public.categories(client_id, id) on delete cascade
);

create index budgets_client_period_idx
  on public.budgets (client_id, year, cycle_month);

create trigger trg_budgets_updated_at
  before update on public.budgets
  for each row execute procedure public.set_updated_at();

comment on column public.budgets.cycle_month is
  '1-12 のサイクル月。managementStartDay 未設定ならカレンダー月と等価。findCycleOfDate(date) の month + 1';
comment on column public.budgets.legacy_key is
  '旧 localStorage cfo_budgets のキー文字列 (例 "2026-4-entertainment")。移行時のみ埋める';
```

#### `week_budgets` (= `cfo_weekBudgets`)

```sql
create table public.week_budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  week_num     smallint not null check (week_num between 1 and 4),
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, week_num)
);

create index week_budgets_client_period_idx
  on public.week_budgets (client_id, year, cycle_month);

create trigger trg_week_budgets_updated_at
  before update on public.week_budgets
  for each row execute procedure public.set_updated_at();

comment on column public.week_budgets.cycle_month is 'サイクル月 1-12';
comment on column public.week_budgets.week_num    is 'サイクル内の第 N 週 (1-4)。weeksInCycle() の weekNum';
comment on column public.week_budgets.legacy_key  is '旧 cfo_weekBudgets のキー (例 "2026-4-w1")';
```

#### `week_cat_budgets` (= `cfo_weekCatBudgets`)

```sql
create table public.week_cat_budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  week_num     smallint not null check (week_num between 1 and 4),
  category_id  text not null,
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, week_num, category_id),
  foreign key (client_id, category_id)
    references public.categories(client_id, id) on delete cascade
);

create index week_cat_budgets_client_period_idx
  on public.week_cat_budgets (client_id, year, cycle_month, week_num);

create trigger trg_week_cat_budgets_updated_at
  before update on public.week_cat_budgets
  for each row execute procedure public.set_updated_at();

comment on column public.week_cat_budgets.legacy_key is
  '旧 cfo_weekCatBudgets のキー (例 "2026-4-w1_entertainment")';
```

---

### 3.3 B-3b: マスタ系 2 表

#### `payment_methods` (= `cfo_paymentMethods`)

```sql
create table public.payment_methods (
  id              text not null default ('pm_' || gen_random_uuid()::text),
  client_id       uuid not null references public.profiles(id) on delete cascade,
  label           text not null,
  color           text not null,
  bank            text,
  closing_day     text,
  withdrawal_day  text,
  sort_order      integer not null default 0,
  legacy_id       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (client_id, id),
  check (closing_day    is null or closing_day    ~ '^([1-9]|[12][0-9]|3[01]|末)$'),
  check (withdrawal_day is null or withdrawal_day ~ '^([1-9]|[12][0-9]|3[01]|末)$')
);

create index payment_methods_client_sort_idx
  on public.payment_methods (client_id, sort_order);

create trigger trg_payment_methods_updated_at
  before update on public.payment_methods
  for each row execute procedure public.set_updated_at();

comment on column public.payment_methods.closing_day    is '締日: ''1''-''31'' / ''末'' / null=未設定';
comment on column public.payment_methods.withdrawal_day is '引落日: ''1''-''31'' / ''末'' / null=未設定';
comment on column public.payment_methods.legacy_id      is '旧 cfo_paymentMethods の id (移行時のみ)';
```

#### `expenses.payment_method` への FK 追加 (決定: 懸念 1 = 案 A)

`payment_methods` 投入後、既存 `expenses` の `payment_method` 値が `payment_methods` 行に対応するか整合性チェック → 漏れた行を `null` にクレンジング → FK を貼る。

```sql
-- (1) クレンジング: payment_methods に存在しない値を null へ
update public.expenses e
   set payment_method = null
 where payment_method is not null
   and not exists (
     select 1 from public.payment_methods pm
      where pm.client_id = e.client_id and pm.id = e.payment_method
   );

-- (2) FK 追加 (ON DELETE SET NULL — App.jsx は paymentMethods.find() の null を許容済)
alter table public.expenses
  add constraint expenses_payment_method_fk
  foreign key (client_id, payment_method)
  references public.payment_methods(client_id, id)
  on update cascade
  on delete set null;
```

事前確認 SQL は `docs/phase-b-checklist.md` を参照。

#### `loans` (= `cfo_loans`)

```sql
create table public.loans (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.profiles(id) on delete cascade,
  label           text not null,
  amount          bigint not null check (amount >= 0),
  bank            text,
  withdrawal_day  text,
  pm_id           text,
  sort_order      integer not null default 0,
  legacy_id       text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (withdrawal_day is null or withdrawal_day ~ '^([1-9]|[12][0-9]|3[01]|末)$'),
  foreign key (client_id, pm_id)
    references public.payment_methods(client_id, id) on delete set null
);

create index loans_client_sort_idx
  on public.loans (client_id, sort_order);

create trigger trg_loans_updated_at
  before update on public.loans
  for each row execute procedure public.set_updated_at();

comment on column public.loans.withdrawal_day is '引落日: ''1''-''31'' / ''末'' / null=未設定';
comment on column public.loans.legacy_id      is '旧 cfo_loans の id (例 "loan_1714200000000")';
```

⚠️ **`loans` 投入は `payment_methods` 投入後**。FK が失敗するため B-3b 内でも順序固定。

#### `handle_new_user` 拡張 (B-3b)

新規ユーザー登録時に `cash` シードを自動投入する:

```sql
-- handle_new_user の categories INSERT の直後に追加するブロック:
insert into public.payment_methods (id, client_id, label, color, sort_order)
values ('cash', new.id, '現金', '#4CAF50', 0);
```

---

### 3.4 B-3c: 設定値 (1 対 1 表に統合) — 決定: 懸念 3 = 案 A

`profiles` には既に `approved` / `app_enabled` (システム的フラグ) と CRM 系 13 列が乗っており、
**書き手と権限が違う** ものは別表にする。`reward_days` が配列である点も
profiles に押し込むには違和感があり、`management_start_day` と同じ
「サイクル設定」概念グループとして 1 表に集約する。

> 旧 `cycle.js` のコメント「明日 Supabase profiles.management_start_day 列に β 移行予定」は Day 2 時点の TODO であり、確定設計ではない。Day 6 時点の再評価でこの方針に上書き。

⚠️ **重要 — 名前衝突に注意**: 実 DB の `profiles.management_start_date` (date 型) とは **別物**。詳細は §1.2.1 参照。`user_settings.management_start_day` (本書設計) は **`smallint` 1-31** であり、`profiles.management_start_date` (date) には一切 touch しない。

**仮説 B が確定した場合の代替プラン (低確率)**: もし瑠星さん側の確認で「`profiles.management_start_date` は customer 側のサイクル起点日として既に運用中」と判明した場合、本 §3.4 の `user_settings` テーブルからは `management_start_day` を drop し、`reward_days` のみを持つ縮小版に切り替える。その場合の DDL は以下。

```sql
-- 仮説 B 確定時の代替版 (現時点では採用しない、参考)
create table public.user_settings (
  client_id    uuid primary key references public.profiles(id) on delete cascade,
  reward_days  smallint[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (
    coalesce(array_length(reward_days, 1), 0) = 0
    or (select bool_and(d between 1 and 31) from unnest(reward_days) as d)
  )
);
```

#### `user_settings`

```sql
create table public.user_settings (
  client_id              uuid primary key
                           references public.profiles(id) on delete cascade,
  management_start_day   smallint
                           check (management_start_day is null
                                  or (management_start_day between 1 and 31)),
  reward_days            smallint[] not null default '{}',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (
    coalesce(array_length(reward_days, 1), 0) = 0
    or (select bool_and(d between 1 and 31) from unnest(reward_days) as d)
  )
);

create trigger trg_user_settings_updated_at
  before update on public.user_settings
  for each row execute procedure public.set_updated_at();

comment on column public.user_settings.management_start_day is
  '1-31 のサイクル起点日。null=1日起点フォールバック';
comment on column public.user_settings.reward_days is
  '報酬日リスト (1-31)。サイクル切替には影響しない記録専用';
```

#### `handle_new_user` 拡張 (B-3c)

```sql
-- handle_new_user の末尾に追記:
insert into public.user_settings (client_id) values (new.id);
```

これで `user_settings` の存在は profiles と 1:1 で保証され、UPSERT を考えなくてよくなる。

---

## 4. RLS ポリシー

全テーブルで以下を必ず付与する。`expenses` 等と同じ思想:

```sql
alter table public.budgets           enable row level security;
alter table public.week_budgets      enable row level security;
alter table public.week_cat_budgets  enable row level security;
alter table public.payment_methods   enable row level security;
alter table public.loans             enable row level security;
alter table public.user_settings     enable row level security;

-- budgets ----------------------------------------------------------
create policy "budgets_client_rw_own" on public.budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "budgets_admin_all" on public.budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- week_budgets -----------------------------------------------------
create policy "week_budgets_client_rw_own" on public.week_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_budgets_admin_all" on public.week_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- week_cat_budgets -------------------------------------------------
create policy "week_cat_budgets_client_rw_own" on public.week_cat_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_cat_budgets_admin_all" on public.week_cat_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- payment_methods --------------------------------------------------
create policy "payment_methods_client_rw_own" on public.payment_methods
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "payment_methods_admin_all" on public.payment_methods
  for all using (public.is_admin())
  with check (public.is_admin());

-- loans ------------------------------------------------------------
create policy "loans_client_rw_own" on public.loans
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "loans_admin_all" on public.loans
  for all using (public.is_admin())
  with check (public.is_admin());

-- user_settings ----------------------------------------------------
create policy "user_settings_self_select" on public.user_settings
  for select using (client_id = auth.uid());
create policy "user_settings_self_update" on public.user_settings
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "user_settings_self_insert" on public.user_settings
  for insert with check (client_id = auth.uid());
create policy "user_settings_admin_all" on public.user_settings
  for all using (public.is_admin())
  with check (public.is_admin());
```

---

## 5. マイグレーション戦略

**前提**: localStorage は各端末ローカル。サーバ側からは参照できないため、移行は **顧客の次回ログイン時、クライアント側で 1 回だけ実行** する形になる。

### 5.1 SQL 適用 (B-3a/b/c 共通)

各段階の DDL を Supabase Dashboard → SQL Editor から流す。**初回投入用** につき `create table ... if not exists` は付けない (二重実行で気付けるように)。

順序:
1. **B-3a** — `budgets` → `week_budgets` → `week_cat_budgets` + Realtime publication 追加 (§8.2-3)
2. **B-3b** — `payment_methods` → `expenses.payment_method` clean-up & FK → `loans` → `handle_new_user` 拡張
3. **B-3c** — `user_settings` → `handle_new_user` 拡張 + 既存 profiles 全員に空行を埋める backfill

`handle_new_user` の更新は `create or replace function ...` で安全に置換可能 (テーブル本体には触れない)。

### 5.2 既存 profile の backfill (B-3b/c のみ必要)

```sql
-- B-3b: 既存全員に cash を 1 行ずつ
insert into public.payment_methods (id, client_id, label, color, sort_order)
select 'cash', id, '現金', '#4CAF50', 0
from public.profiles
where not exists (
  select 1 from public.payment_methods pm
  where pm.client_id = profiles.id and pm.id = 'cash'
);

-- B-3c: 既存全員に user_settings 空行を 1 行ずつ
insert into public.user_settings (client_id)
select id from public.profiles
on conflict (client_id) do nothing;
```

### 5.3 顧客ローカルデータの取り込み (クライアント側 1 回限り)

`App.jsx` 冒頭の **module top-level** に `cfo_migratedToSupabase` フラグ
ベースの 1 回限り移行ブロックを追加 (既存 `cfo_migratedFromKakeibo` パターン
を踏襲)。

#### 決定: 懸念 4 = 案 A (skip + ログ + legacy_key 保存)

カテゴリ削除済みで FK 違反になる行は **skip して `console.warn` でログ**、`legacy_key` 列に元キーを保存して事後追跡可能にする。

```js
async function migrateLocalToSupabase(userId) {
  if (localStorage.getItem('cfo_migratedToSupabase') === '1') return;
  if (!userId) return;

  const skipped = [];

  try {
    // ---- カテゴリ ID 検証用に現在の DB セットを取得 ----
    const { data: cats } = await supabase
      .from('categories').select('id').eq('client_id', userId);
    const validCatIds = new Set((cats ?? []).map(c => c.id));

    // ---- 1. budgets ----
    const budgets = JSON.parse(localStorage.getItem('cfo_budgets') ?? '{}');
    const budgetRows = [];
    for (const [key, amount] of Object.entries(budgets)) {
      const m = key.match(/^(\d{4})-(\d{1,2})-(.+)$/);
      if (!m || !Number.isFinite(amount) || amount < 0) {
        skipped.push({ table: 'budgets', key, reason: 'invalid_format' }); continue;
      }
      const catId = m[3];
      if (!validCatIds.has(catId)) {
        skipped.push({ table: 'budgets', key, reason: 'category_not_found', catId }); continue;
      }
      budgetRows.push({
        client_id: userId, year: +m[1], cycle_month: +m[2],
        category_id: catId, amount, legacy_key: key,
      });
    }
    if (budgetRows.length) {
      const { error } = await supabase.from('budgets').upsert(budgetRows);
      if (error) throw error;
    }

    // ---- 2. week_budgets — key: '2026-4-w1' ----
    // ---- 3. week_cat_budgets — key: '2026-4-w1_<catId>' ----
    // ---- 4. payment_methods (array) ----
    // ---- 5. loans (array) ----
    // ---- 6. user_settings (1 行 UPSERT) ----
    //   詳細実装は B-3a〜c の各 PR で記述。同じ skip + ログ パターンを踏襲。

    if (skipped.length) console.warn('[migrate] skipped rows:', skipped);

    localStorage.setItem('cfo_migratedToSupabase', '1');
  } catch (e) {
    console.error('[migrate] failed; will retry next session', e);
    // フラグは立てない → 次回再試行
  }
}
```

ポイント:
- **冪等**: `upsert` で同じ PK は overwrite。途中失敗しても再実行で揃う
- **失敗時はフラグを立てない**。次回起動で再試行
- **`legacy_key` / `legacy_id` を必ず埋める** ことで事後追跡可能
- **skip した行も `console.warn` で必ず出す** (admin 側で `cfo_migratedToSupabase` セット後にユーザーへ「N 件 skip しました」ヒアリングできる)

### 5.4 <client_A>データ最優先 (人手介入)

<client_A>の本データ移行はトライアル運用に直接影響するため、自動移行任せ
にせず **次の段取り** を強く推奨:

1. B-3a/b/c の SQL を本番に適用
2. **<client_A>端末 (本人立ち会い) で 1 度ログインしてもらい、自動移行を発火 → 直後に Supabase Dashboard で行を目視確認**
3. 確認後、`cfo_migratedToSupabase` の値とテーブル件数のスクリーンショットを保管
4. ローカル `cfo_*` キーは **削除しない**。万一トラブった際のロールバック原資

### 5.5 アプリ側の参照切替

各キーの読み書きを `useLocalStorage` から **新規フック** に差し替える。
順序は SQL と同じ B-3a → B-3b → B-3c。

| 旧 (App.jsx) | 新 (hook 案) | 想定 API |
|---|---|---|
| `useLocalStorage("cfo_budgets")` | `useBudgets()` | `{ budgets, setBudget(year, cycleMonth, catId, amount), bulkSet }` |
| `useLocalStorage("cfo_weekBudgets")` | `useWeekBudgets()` | 同様 |
| `useLocalStorage("cfo_weekCatBudgets")` | `useWeekCatBudgets()` | 同様 |
| `useLocalStorage("cfo_paymentMethods")` | `usePaymentMethods()` | `{ methods, addMethod, updateMethod, removeMethod, reorderMethods }` |
| `useLocalStorage("cfo_loans")` | `useLoans()` | `{ loans, addLoan, updateLoan, removeLoan }` |
| `getManagementStartDay()` / `setManagementStartDay()` | `useUserSettings()` (context 経由) | `{ managementStartDay, setManagementStartDay, rewardDays, addRewardDay, removeRewardDay }` |

⚠️ `cycle.js` は **同期 API** で localStorage を読む前提のため、Supabase 化時は React 側で `useUserSettings()` を context に置いて `cycle.js` の関数群へ値を渡す方式に変更する。

---

## 6. ロールバック手順

### 6.1 SQL レベル

各段階で table を `drop ... cascade` すれば schema 構造のロールバックは可能。
ただしデータは消える。**B-3a/b/c それぞれの DDL を流す前に必ず Dashboard の
バックアップ機能で snapshot を取る**。

```sql
-- B-3a ロールバック
drop table if exists public.week_cat_budgets cascade;
drop table if exists public.week_budgets     cascade;
drop table if exists public.budgets          cascade;

-- B-3b ロールバック
alter table public.expenses drop constraint if exists expenses_payment_method_fk;
drop table if exists public.loans            cascade;
drop table if exists public.payment_methods  cascade;
-- handle_new_user を旧版へ戻す (supabase/migrations/ から該当ファイルを再実行)

-- B-3c ロールバック
drop table if exists public.user_settings    cascade;
-- handle_new_user を旧版へ戻す
```

### 6.2 アプリレベル

クライアント側マイグレーションコードは feature flag で `if (false)` ガード可能にする。
かつ:
- `localStorage.cfo_*` を移行後も削除しない方針なら、フックを localStorage 版に差し戻すだけで動作復元できる
- `cfo_migratedToSupabase` フラグを `localStorage.removeItem` で消せば再移行も可能

### 6.3 データレベル

`legacy_key` / `legacy_id` 列を `where legacy_key is not null` でフィルタすれば「移行で Supabase に入った行」を全部抽出できる。
→ SQL でその行群を export → 復元 SQL を生成、という手順で原理的には DB から localStorage へも戻せる (クライアント側で書き戻しスクリプトが別途必要)。

---

## 7. 検証チェックリスト

各段階の検証チェックリストは `docs/phase-b-checklist.md` を参照。

---

## 8. 意思決定ログ (Decision Log)

### 8.1 決定済み

#### B-2 初回レビュー時 (2026-04-27)

| # | 論点 | 決定 | 根拠 |
|---|---|---|---|
| **1** | `expenses.payment_method` の参照整合性 | **FK 追加 + `ON DELETE SET NULL`** | アプリ層 `app.payment \|\| 'cash'` の defaulting で実データはほぼクリーン。表示側 `paymentMethods.find()` は null 許容済 |
| **3** | `management_start_day` の置き場所 | **`user_settings` に統合 (`reward_days` と同表)** | profiles はシステム属性 / settings はアプリ機能設定で層が違う。`reward_days` が配列なので profiles 押し込みは無理筋 |
| **4** | 既定カテゴリ削除済みユーザーの予算行 | **skip + `console.warn` + `legacy_key` 保存** | 顧客が能動的に消したカテゴリの予算は価値が低い。legacy_key で事後追跡 100% 可能 |

#### B-2 Step 2 完了時の追加確認 (2026-04-27)

| # | 論点 | 状態 | 根拠 |
|---|---|---|---|
| **1' (= 1 の検証)** | `expenses.payment_method` の実データ汚染 | **クリーン確認済** (`cash`: 9 / `pm_1777128862118`: 1 / NULL: 0) | clean-up SQL は実害 0、FK 追加で問題発生する行ゼロ |
| **4' (= 4 の検証)** | カテゴリ削除済みユーザー有無 | **無し** (全 client `cat_count >= 9`) | skip ロジックは保険として残すが実発動見込みゼロ |
| **9** | `profiles.management_start_date` (date 型、既存) と `user_settings.management_start_day` (新設、smallint) の関係 | **別物として扱う (推奨設計、要確認)** | §1.2.1 参照。`profiles.management_start_date` には一切 touch しない方針。瑠星さんから「admin での `management_start_date` の用途」確認を得たら確定 |

### 8.2 残課題 (B-3 着手前 or 並行解消)

#### (1) `supabase/schema.sql` ドリフトの解消 — 推奨: **migrations/ 移行 (ただしスコープ拡大)**

- **問題**: 実 DB の `profiles` に **15 列追加**済 (Step 2 で発覚: `approved` / `app_enabled` 以外に admin CRM 13 列 + `management_start_date`)。schema.sql 未反映
- **推奨案**: `supabase/migrations/` ディレクトリを新設し、以下の構成で履歴を Git 管理:
  ```
  supabase/
    migrations/
      001_init.sql                              # 現 schema.sql の内容
      002_profiles_admin_crm_columns.sql        # age / company / plan_* / customer_status / start_date / next_topic / staff / source / referrer / refer_count / management_start_date (13 列、要復元)
      003_profiles_app_gate_columns.sql         # approved / app_enabled (2 列、要復元)
      004_phase_b3a_budgets.sql                 # B-3a で本書から流す DDL
      005_phase_b3b_payment_methods.sql         # B-3b
      006_phase_b3b_loans_and_expenses_fk.sql
      007_phase_b3c_user_settings.sql
    schema.sql        # 既存。当面は touch しない (移行期間)
    README.md         # 「migrations/ が真のソース」と追記
  ```
- **要注意**: 002 / 003 の SQL は Dashboard の SQL History or Logs から復元する。**Free プランは Logs の保持期間が短い**ため、復元できない場合は **`information_schema.columns` の出力をそのまま `alter table ... add column ...` SQL に再構成** する (型・default が分かっていれば再現可能)
- **B-3a 着手 *前* に 001-003 を整備推奨** (B-3a 並行ではなく先行)。優先度高
- **管理開始日カラムの帰属**: `profiles.management_start_date` は Migration 002 (= admin CRM) に含める方針。詳細は §1.2.1 参照

#### (2) `cycle_month` 等のセマンティクスを列コメントとして DB に残す — 推奨: **採用**

- 設計書 §3 の各 DDL に既に `comment on column ...` を埋め込み済 (本最終版で反映)
- DDL を流すだけで DB 側に残るので、追加コストゼロ

#### (3) Realtime publication への手動追加 — 推奨: **B-3a の最後に必ず実行 + checklist 化**

- **問題**: `updated_at` 列を作るだけでは Realtime 購読は走らない。`supabase_realtime` publication への明示的な追加が必要
- **推奨案**: 各段階の DDL の最後に以下を流す:
  ```sql
  -- B-3a 末尾
  alter publication supabase_realtime add table public.budgets;
  alter publication supabase_realtime add table public.week_budgets;
  alter publication supabase_realtime add table public.week_cat_budgets;

  -- B-3b 末尾
  alter publication supabase_realtime add table public.payment_methods;
  alter publication supabase_realtime add table public.loans;

  -- B-3c 末尾
  alter publication supabase_realtime add table public.user_settings;
  ```
- 確認 SQL:
  ```sql
  select schemaname, tablename
  from pg_publication_tables
  where pubname = 'supabase_realtime';
  ```
- `docs/phase-b-checklist.md` に各段階の checkpoint として明記

#### (4) `handle_new_user` の version 管理 — 推奨: **migrations/ で世代管理**

- **問題**: `create or replace function` で上書きするので「直前のバージョン」しか残らない
- **推奨案**: `supabase/migrations/` 内に都度新ファイルを切る:
  ```
  002_handle_new_user_v1.sql  # 現状版 (categories 9 個)
  005_handle_new_user_v2.sql  # B-3b 後 (+ payment_methods cash 行)
  007_handle_new_user_v3.sql  # B-3c 後 (+ user_settings 空行)
  ```
- 旧版はファイルとして残すので、ロールバック時に再実行できる
- ファイル冒頭にコメントで「このマイグレーション後の handle_new_user 完全版」を埋める (前バージョンの推測を不要にする)

#### (5) `expenses.category` の FK 不在 — 推奨: **B 範囲外 / バックログ化**

- 同様の問題が `expenses.category` にもあるが、本フェーズの直接スコープではない
- 後続フェーズでカテゴリ削除時の expenses 振る舞い (UI 連動含む) と一緒に検討する
- `docs/todo.md` にエントリを追加するのみ

#### (6) 既存ユーザー数の実測 — **Step 2 完了済 (2026-04-27)**

- 計測値: §1.5 / `docs/phase-b-checklist.md` Step 2 結果欄を参照
- profiles=3 (admin 1 + client 2) で確定。backfill SQL の影響度は軽微

---

## 9. ステータス & 次アクション

- [x] B-1 完了 (7 キー特定)
- [x] B-2 完了 (本書 = 設計書、レビュー反映済)
- [ ] B-3 着手前準備 → `docs/phase-b-checklist.md` で進行管理
- [ ] **B-3a 実行** (予算 3 表) → 計画は `docs/phase-b-3a-plan.md`
- [ ] B-3b 実行 (マスタ 2 表 + `expenses` FK)
- [ ] B-3c 実行 (設定統合 1 表)
- [ ] B-4 アプリ側フック差し替え (3 段階対応)
- [ ] B-5 ロールバック手順実演テスト

⚠️ **既存本番 (private-cfo-app.vercel.app) の URL / Vercel プロジェクトには触らない**。すべて Supabase 側の DDL とアプリ側コード変更のみで完結する。
