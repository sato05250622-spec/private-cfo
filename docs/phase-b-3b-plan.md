# フェーズ B-3b 作業計画ドラフト — payment_methods / loans の Supabase 移行 + expenses.payment_method への FK 制約

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-04-28 |
| 改訂日 | 2026-04-28 (即時リリース方針へ) |
| ステータス | **改訂版** — 24h 観察ゲートを撤廃、即時リリース方針 |
| 対象テーブル | `payment_methods` (新規) / `loans` (新規) / `expenses` (ALTER で FK 追加) |
| 対象 localStorage | `cfo_paymentMethods` / `cfo_loans` |
| 関連 | `docs/phase-b-3a-plan.md` (B-3a 計画 + 完了記録)<br>`docs/phase-b-schema.md` (DDL ソース)<br>`docs/todo-followups.md` (別件 ToDo 3 項目) |
| 想定所要時間 | **2 〜 3 時間** (即時リリースで 24h 観察待ちなし) |
| 着手前提 | B-3a が main にマージ済 (commit `bda5165`) |

---

## 改訂履歴

### 2026-04-28 (作成日と同日)

**改訂内容**: 24h 観察ゲートを撤廃、Step 8 (観察期間) を削除、段階 2 ALTER を Step 7 動作確認の直後に実施 (即時リリース)。

**事業判断としての改訂理由**:

- 本プロジェクトは「プライベート CFO 事業として、1 人のクライアントに対して本部連携した運営を体験する」が目的
- スケール時バグの観察は実質ユーザー数 1 名では発見困難、現時点では observation gate の効用が薄い
- 大人数化フェーズで改めて 24h / 1 週間等の観察 SLA を再導入予定
- 現フェーズの優先事項は「事業フロー完成 (顧客アプリ + 本部 + Supabase 連携)」であり、開発速度を優先
- B-3a は Step 5 動作確認で全 CRUD パターン pass 済、ロールバック breadcrumb (`L221-225 useLocalStorage` コメント) も残存しており、緊急時のロールバック経路は確保済

**保持される安全策** (撤廃しない要素):

- Step 7 <client_A> さん立ち会い動作確認 (PM/loans CRUD + reorder + 既存 expenses 表示)
- 段階 2 ALTER 直前の **orphan_count = 0 確認 SQL**
- ロールバック手順 A / A2 / B / C
- `legacy_key` 列による debug/rollback 識別性

---

## 前提・原則

- **本番 URL (`private-cfo-app.vercel.app`) は変更しない**
- **既存テーブル `expenses` を変更する**(B-3b で初めて ALTER を実施)
  - 変更内容は `add constraint ... foreign key` のみ。列の追加・削除・型変更は無し
  - ALTER は **段階 2** (アプリ実装 + デプロイ + 動作確認 完了後、24h 待たずに即時) で適用
- **既存データに触らない**(クレンジング系の UPDATE は本フェーズ範囲外)
- **段階的フィーチャーフラグ運用**: アプリ側で `cfo_paymentsLoansMigrated` (仮称) が立つまで localStorage 版を併用
- **B-3a で確立したパターンを踏襲**:
  - state Record / action 文字列キー / エラー revert+throw (※ B-3b は **配列ベース**のため Record パターンの適用範囲は限定的、後述)
  - useXxx hook (optimistic / loading / refetch / `deps=[userId]` / StrictMode 対策 ref ミラー)
  - `legacy_key` 列を全テーブルに持たせ rollback / debug 容易性を確保

---

## 対象一覧と現状 (調査結果サマリ)

### 1. `payment_methods` (決済手段)
- **state**: `App.jsx` L262 `useLocalStorage("cfo_paymentMethods", [{id:"cash", label:"現金", color:"#4CAF50"}])`
- **shape**: `{ id, label, color, closingDay, withdrawalDay, bank }`
- **id 形式**: 既定 `'cash'` / カスタム `'pm_<Date.now()>'`
- **callsite 4 件**: create / update / delete / **reorder (drag-drop)**
- **UI**: メニュー画面 → 決済手段設定画面、モーダルフォーム + drag-drop 並び替え

### 2. `loans` (借入)
- **state**: `App.jsx` L301 `useLocalStorage("cfo_loans", [])`
- **shape**: `{ id, label, amount, bank, withdrawalDay, pmId }`
- **id 形式**: `'loan_<Date.now()>'`
- **callsite 3 件**: create / update / delete (reorder なし)
- **UI**: メニュー → 定期支出フォーム、calculator 付モーダル
- **特記**: `pmId` フィールド定義あるが App.jsx 内で**未使用** (将来 PM 連動を想定した遺産)

### 3. `expenses.payment_method` (FK 化対象)
- **既存スキーマ** (001_init.sql L126): `payment_method text` (FK 制約なし)
- **アプリ参照**: `useExpenses` で `payment_method ?? 'cash'` フォールバック実装
- **既存データ**: B-3a Step 2 確認 (2026-04-27) で `NULL 0 / 異常値 0` クリーン
- **孤児化リスク**: 現状 PM 削除しても expenses 行は残る (バッジ表示が消えるのみ)

---

## 作業ステップ概要

| # | フェーズ | 作業 | 所要 | リスク |
|---|---|---|---|---|
| **1** | Pre-flight | バックアップ取得 / ベースライン build 確認 | 5 分 | 低 |
| **2-1** | DB 適用 段階1 | `payment_methods` + `loans` の DDL 流し込み (FK 制約は段階2) | 15 分 | 中 |
| **3** | DB 確認 | 段階1 で作った 2 表の RLS / FK / index / publication を SQL で確認 | 10 分 | 低 |
| **4** | アプリ実装 | `lib/api/{paymentMethods,loans}.js` + `hooks/use{PaymentMethods,Loans}.js` 実装、App.jsx を hook 駆動へ差替 | 60 〜 90 分 | 高 |
| **5** | クライアント移行 | `migrateLocalToSupabase` の payments/loans ブロック実装 + 動作確認 | 30 分 | 中 |
| **6** | デプロイ | `git push origin main` → Vercel 自動デプロイ | 5 分 | 中 |
| **7** | 本番動作確認 | <client_A> さん立ち会い、PM/loans CRUD + 並び替え動作確認 | 30 分 | 中 |
| **2-2** | DB 適用 段階2 | 事前確認 SQL (orphan_count=0) → `expenses.payment_method` に FK 制約追加 (ALTER) | 10 分 | **高** |
| **8** | 段階2 動作確認 | PM 削除時の expenses への影響を確認 | 15 分 | 中 |
| **9** | 後始末 | フラグ確認、ログ記入、`docs/todo-followups.md` 該当項目消し込み | 10 分 | 低 |

合計: 約 2 〜 3 時間 (24h 観察ゲート撤廃により短縮)

---

## 設計論点

### 論点 A: PM 削除時の expenses の扱い (FK カスケード戦略)

PM が削除されると、それを参照する `expenses.payment_method` が孤児になる。FK 制約のカスケード方針を決める必要がある。検討した選択肢:

| 案 | 内容 | 採否 | 理由 |
|---|---|---|---|
| **A. 複合 FK + ON DELETE CASCADE** | PM 削除時に該当 expenses を物理削除 | ❌ | expenses は soft delete 設計 (`deleted_at`)。物理削除は履歴消失で原則違反 |
| **B. 複合 FK + ON DELETE NO ACTION (RESTRICT)** | PM を参照する expenses があると削除拒否 | ⚠️ 候補 | UX は微妙だが安全。アプリ側で削除前 confirm + 'cash' へ振替する事前処理が必要 |
| **C. 複合 FK + ON DELETE SET NULL** | PM 削除時に expenses.payment_method を NULL に | ❌ | 複合 FK では client_id も NULL 化されるが client_id は NOT NULL → SET NULL は失敗 |
| **D. 単純 FK (payment_method 列のみ) + SET NULL** | client_id を含まない単純 FK | ❌ | payment_methods.id は client 別に重複可能 (e.g. 各 client の 'cash')。global unique でないため単純 FK 不可 |
| **E. FK を貼らない** | アプリ側で整合性管理 | ⚠️ 候補 | 安全だが整合性保証が弱い。中長期で B-3c 等で対応する選択 |

**推奨**: **案 B (RESTRICT)** をデフォルトとし、アプリ側 PM 削除モーダルで以下の事前処理を実装:

1. 削除対象 PM を参照する expenses 件数を表示 (`select count(*) from expenses where payment_method = $pm_id and client_id = $uid`)
2. ユーザーに選択肢を提示:
   - **a.** 該当 expenses を 'cash' (default PM) へ一括振替 → PM 削除
   - **b.** 該当 expenses も soft-delete (deleted_at セット) → PM 削除
   - **c.** キャンセル
3. 選択後、トランザクション内で UPDATE → DELETE を実行

**フォールバック**: `useExpenses` 既存の `payment_method ?? 'cash'` 処理は維持 → DB 上 NULL 行は発生し得ないが、レイヤー保険として残置。

### 論点 B: ID 戦略 (text PK 維持 vs uuid 化)

- **現状**: `'cash'` / `'pm_<timestamp>'` / `'loan_<timestamp>'` の text id
- **既存 expenses.payment_method は text** で `'cash'` 等の文字列を持つ → uuid 化は破壊的
- **推奨**: text PK 維持 (B-3a の `categories` テーブルと整合)。複合 PK `(client_id, id)` で client 跨ぎ衝突を回避
- **timestamp 衝突リスク**: 低 (1ms 内の連続作成のみ)。UX 上も連打しない場面のみ。許容

### 論点 C: payment_methods の並び替え (sort_order)

- **現状**: `arrayMove` で配列順序を保持し localStorage に書込
- **DB 化後**: 配列順序を保証するため `sort_order int` 列を追加
- **更新ロジック**: drag-drop 完了時に該当 2 行 (or 全行) の sort_order を UPDATE
- **初期値**: backfill 時に既存配列の index を sort_order として埋める

### 論点 D: loans.pmId の扱い

- **現状**: shape に定義あるが App.jsx 内で参照箇所ゼロ
- **選択肢**:
  - **i.** DB 化時も text 列で保持 (FK 化しない)、将来連動拡張時に FK 追加
  - **ii.** DB 化時に列ごと省略 (シンプル化)
  - **iii.** DB 化時に payment_methods への FK にする (`on delete set null`)
- **推奨**: **i** (text 保持、FK なし)。現実装と挙動同一かつ将来拡張余地を残す。
  - 補足: 段階2 で FK 化を検討する別タスクとして記録

### 論点 E: 段階リリース戦略 (即時リリース方針へ改訂)

FK を即時追加すると、移行未完了 client の expenses が `payment_methods` 行に存在しない id を参照する状態が生じ、FK 違反で **テーブルそのものが INSERT 不能**になる。これを回避するため、段階 1 と段階 2 に分ける:

- **段階 1**: payment_methods / loans テーブルを作成、アプリを hook 駆動に切替、`migrateLocalToSupabase` で全 client (実質 1 名) の payment_methods 行を seed
- **段階 2**: Step 7 動作確認直後に **orphan_count = 0 を SQL で確認** → `ALTER TABLE expenses ADD CONSTRAINT ...` で FK 追加 (即時、24h 待たない)
- **検証 SQL**: 段階 2 ALTER 実行直前に `select count(*) from expenses e where not exists (select 1 from payment_methods pm where pm.client_id = e.client_id and pm.id = e.payment_method) and e.payment_method is not null` で孤児ゼロを確認

**改訂前との差分** (2026-04-28 改訂):

- 段階 1 と段階 2 の **間に 24h 観察を置かない**。動作確認 (Step 7) の直後に段階 2 を実行
- 観察ゲートを置かない理由は「改訂履歴」セクション参照 (1 名運用フェーズでの効用が薄い)
- 段階分割は維持される (FK 即時付けは構造上不可なので、最小限の段階構造は残す)

---

## 移行順序と根拠

**順序: payment_methods → loans → expenses FK 追加**

| 順 | 対象 | 根拠 |
|---|---|---|
| **1** | payment_methods | loans が `pmId` で参照、expenses が `payment_method` で参照 → 最も依存元 |
| **2** | loans | payment_methods に依存 (`pmId` text 保持)。expenses からの参照はない |
| **3** | expenses FK 追加 (段階 2) | 全 client の payment_methods が DB に揃った後に制約適用 |

別 commit に分けるかは Step 4 の callsite migration と同じ「pattern 別」「カテゴリ別」で判断。B-3a で確立した `phase 1 (hook 切替) → phase 2a (simple) → phase 2b (bulk) → phase 3 (shim 削除)` の段階分けを踏襲予定。

---

## スキーマ案 (DDL)

`supabase/migrations/007_phase_b3b_payments_loans.sql` (段階 1 用):

```sql
-- =============================================================
-- B-3b 段階 1: payment_methods + loans (FK 制約は段階 2)
-- =============================================================

-- ---- payment_methods ---------------------------------------------
create table public.payment_methods (
  client_id      uuid not null references public.profiles(id) on delete cascade,
  id             text not null,                        -- 'cash' or 'pm_<timestamp>'
  label          text not null,
  color          text,
  closing_day    smallint check (closing_day between 1 and 31),
  withdrawal_day smallint check (withdrawal_day between 1 and 31),
  bank           text,
  sort_order     int not null default 0,               -- drag-drop 順序
  legacy_key     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (client_id, id)
);
create index payment_methods_client_sort_idx
  on public.payment_methods (client_id, sort_order);
create trigger trg_payment_methods_updated_at
  before update on public.payment_methods
  for each row execute procedure public.set_updated_at();
comment on column public.payment_methods.sort_order is
  'drag-drop による表示順。新規は max(sort_order)+1';
comment on column public.payment_methods.legacy_key is
  'localStorage 移行時の元 id 控え (debug / rollback 用)';

-- ---- loans ----------------------------------------------------------
create table public.loans (
  client_id      uuid not null references public.profiles(id) on delete cascade,
  id             text not null,                        -- 'loan_<timestamp>'
  label          text not null,
  amount         bigint not null check (amount >= 0),
  bank           text,
  withdrawal_day smallint check (withdrawal_day between 1 and 31),
  pm_id          text,                                  -- payment_methods への論理参照 (現実装は未使用、FK 貼らない)
  legacy_key     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (client_id, id)
);
create index loans_client_idx on public.loans (client_id);
create trigger trg_loans_updated_at
  before update on public.loans
  for each row execute procedure public.set_updated_at();

-- ---- RLS ------------------------------------------------------------
alter table public.payment_methods enable row level security;
alter table public.loans           enable row level security;

create policy "payment_methods_client_rw_own" on public.payment_methods
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "payment_methods_admin_all" on public.payment_methods
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "loans_client_rw_own" on public.loans
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "loans_admin_all" on public.loans
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- Realtime publication -------------------------------------------
alter publication supabase_realtime add table public.payment_methods;
alter publication supabase_realtime add table public.loans;
```

`supabase/migrations/008_phase_b3b_expenses_payment_fk.sql` (段階 2 用、Step 7 直後に即時実行):

```sql
-- =============================================================
-- B-3b 段階 2: expenses.payment_method に FK 制約追加
-- 前提: 全 client が payment_methods 移行完了済 (cfo_paymentsLoansMigrated == "1")
-- =============================================================

-- 事前確認: 孤児ゼロを確認 (このクエリが 0 行返すことを確認してから ALTER)
-- select count(*) from public.expenses e
-- where e.payment_method is not null
--   and not exists (
--     select 1 from public.payment_methods pm
--     where pm.client_id = e.client_id and pm.id = e.payment_method
--   );

alter table public.expenses
  add constraint expenses_payment_method_fk
    foreign key (client_id, payment_method)
    references public.payment_methods(client_id, id)
    on delete no action                              -- アプリ側で削除前 confirm + 振替を強制
    on update cascade;                               -- 万一 PM id が rename された時に追従 (実運用ではほぼ無い)

create index expenses_payment_method_idx
  on public.expenses (client_id, payment_method)
  where deleted_at is null and payment_method is not null;

comment on constraint expenses_payment_method_fk on public.expenses is
  'B-3b 段階2 で追加。PM 削除時はアプリ側で先に振替/soft-delete を実施する想定 (NO ACTION で違反は即拒否)';
```

---

## B-3a との差分 (重要)

| 観点 | B-3a | B-3b | 影響 |
|---|---|---|---|
| データ構造 | Record (`{key: value}`) | **配列** (`[{id, ...}, ...]`) | hook の state 形が異なる。CRUD ロジックは map / filter / spread + reorder |
| キー設計 | 複合キー文字列 (`year-cycleMonth-categoryId`) | text PK (`id`) + 複合 PK で client 分離 | 移行ロジック単純化 (key parse 不要) |
| 既存テーブル変更 | なし (create のみ) | **expenses に ALTER で FK 追加** | B 原則 "alter は B-3b 以降" を初めて実施。段階リリース必須 |
| reorder | 不要 | **必須** (payment_methods drag-drop) | sort_order 列追加 + UPDATE 1〜n 行のロジック |
| 孤児化リスク | なし (categories は既に DB) | **あり** (PM 削除→ expenses 参照消失) | FK カスケード戦略の決定 (論点 A) |
| callsite 数 | 10 (Phase 2 で全置換) | **7** (PM 4 + loans 3) | 規模は小さい。ただし配列 mutation の変換が新規 |
| 段階リリース | 単発 | **2 段階** (FK 追加は別 migration、即時連続) | 観察期間なし、Step 7 直後に段階 2 実施 |
| migration の冪等性 | 容易 (upsert) | **配列順序の保持** が新論点 | sort_order 設定で対応 |

---

## 別件 ToDo の B-3b への影響評価

`docs/todo-followups.md` 記載の 3 項目を、B-3b 実施に対する影響度で評価:

### 1. L221-225 useLocalStorage rollback breadcrumb 整理
- **B-3b への影響**: **なし**
- **判断**: B-3a と同じ方式で B-3b でも commented-out backup 行を rollback 用に残す。次フェーズの "削除予定" コメントは付け直しか、breadcrumb 全体を一括整理するクリーンアップ commit を別で起こす。**B-3b では新規追加分の breadcrumb 方針だけ揃える**

### 2. catBudget OK で budgetDraft 更新されない sync 漏れ
- **B-3b への影響**: **なし**
- **判断**: 影響範囲は budgets 系のみ。B-3b 対象 (payment_methods / loans) には類似 UI フローがない。`showBudgetModal` 自体が unreachable のため B-3b 着手を妨げない

### 3. auth context timeout 5000ms console エラー多発
- **B-3b への影響**: **中** ⚠️
- **理由**: B-3b の Supabase 操作も同 auth context 経由。timeout 発生時は CRUD 失敗 → ユーザーに alert が出る (B-3a でも同じ症状を観測済)
- **判断 (2026-04-28 改訂)**:
  - **B-3b と並行 or 別途で対応**を許容 (本フェーズの blocker ではない)
  - B-3b Step 7 動作確認時に顕著な timeout 症状が出れば、その場で本問題の対応を割り込ませる判断もあり得る
  - 出なければ B-3b 完了後に別 PR で対応
  - 機能は動作する (alert は出るが CRUD 自体は再試行で成功する観測有り)

---

## Step 1. Pre-flight (5 分)

- [ ] B-3a が main にマージ済 (commit `bda5165`) を確認
- [ ] Supabase Dashboard で手動 snapshot を取得 (rollback 用)
- [ ] ローカル `git status` クリーン、ブランチ `feat/phase-b-3b-payments-loans` 上で作業
- [ ] `npm run build` が現状でエラーゼロで通ることを確認 (B-3b 着手前のベースライン)

> **改訂注**: 旧 Step 1 にあった「24 時間運用観察完了」「legacy_key 空行確認」のゲートは **改訂で撤廃** (改訂履歴参照)。snapshot 取得は rollback 用の純粋な保険として 1 件保持する。

---

## Step 2-1. DB 適用 段階 1 (15 分)

`supabase/migrations/007_phase_b3b_payments_loans.sql` を作成 → Dashboard SQL Editor で Run。

期待: "Success. No rows returned"。エラー時は **Rollback A** (drop table)。

---

## Step 3. DB 確認 (10 分)

B-3a Step 3 と同形式で:

```sql
-- 3-1. テーブル / インデックス / トリガ
select tablename from pg_tables
where schemaname = 'public' and tablename in ('payment_methods','loans')
order by tablename;
-- 期待: 2 行

select indexname from pg_indexes
where schemaname = 'public' and tablename in ('payment_methods','loans')
order by indexname;
-- 期待: payment_methods_pkey + payment_methods_client_sort_idx + loans_pkey + loans_client_idx

-- 3-2 RLS, 3-3 ポリシー数 (各 2 件), 3-4 Realtime 登録 → B-3a と同パターン
```

---

## Step 4. アプリ実装 (60 〜 90 分)

B-3a と同じく `phase 1 → 2a → 2b → 3` の段階分けを踏襲予定。

### 4-1. 新規ファイル

#### `src/lib/api/paymentMethods.js`
- `listPaymentMethods(clientId)` → `select * from payment_methods where client_id = $1 order by sort_order`
- `upsertPaymentMethod(clientId, {id, label, color, closingDay, withdrawalDay, bank, sortOrder})`
- `deletePaymentMethod(clientId, id)`
- `reorderPaymentMethods(clientId, ids[])` → 一括 UPDATE で sort_order を 0..n-1 に設定

#### `src/lib/api/loans.js`
- `listLoans(clientId)`, `upsertLoan(clientId, {...})`, `deleteLoan(clientId, id)`

#### `src/hooks/usePaymentMethods.js`
- 配列 state、optimistic update、error revert+throw、`deps=[userId]`
- 配列 mutation: create / update / delete は `setState(prev => prev.map / filter / [...prev, ...])`
- reorder は `setState(arrayMove(prev, from, to))` + DB に sort_order 一括 UPDATE

#### `src/hooks/useLoans.js`
- 同パターン (reorder なし)

### 4-2. App.jsx 切替

- L262 / L301 の useLocalStorage を usePaymentMethods / useLoans に置換 (B-3a phase 1 相当)
- 7 callsite を hook 直呼びに置換 (B-3a phase 2 相当)
- shim 必要なら設置 → 全 callsite 置換後に削除 (phase 3 相当)

### 4-3. 動作確認

各 callsite ごとに動作確認 → commit (B-3a の流れ踏襲)。

---

## Step 5. クライアント移行 (30 分)

`migrateLocalToSupabase` 関数 (or 同等のフラグベース移行ロジック) に payments/loans ブロックを追加:

```js
// 擬似コード
if (!localStorage.getItem('cfo_paymentsLoansMigrated')) {
  const localPMs = JSON.parse(localStorage.getItem('cfo_paymentMethods') ?? '[]');
  const localLoans = JSON.parse(localStorage.getItem('cfo_loans') ?? '[]');

  // payment_methods upsert (sort_order = index)
  for (const [i, pm] of localPMs.entries()) {
    await api.upsertPaymentMethod(uid, {
      id: pm.id, label: pm.label, color: pm.color,
      closingDay: pm.closingDay, withdrawalDay: pm.withdrawalDay, bank: pm.bank,
      sortOrder: i, legacyKey: pm.id,
    });
  }

  // loans upsert
  for (const loan of localLoans) {
    await api.upsertLoan(uid, { ...loan, legacyKey: loan.id });
  }

  localStorage.setItem('cfo_paymentsLoansMigrated', '1');
}
```

注意:
- 既定 `'cash'` PM が DB に必ず存在する状態にする (空の客は `[{id:'cash', label:'現金', color:'#4CAF50'}]` を seed)
- migrate 中の race condition を避ける (`cfo_paymentsLoansMigrated` フラグの atomic セット)

---

## Step 6. デプロイ (5 分)

- [ ] feat ブランチで `npm run build` がエラーゼロ
- [ ] PR → main マージ
- [ ] Vercel 自動デプロイ → Build successful 確認
- [ ] 本番 URL で開発者ログインしてエラー無し確認

---

## Step 7. 本番動作確認 (30 分、<client_A> さん立ち会い)

- [ ] <client_A> さんに本番ログインしてもらう (DevTools 開く)
- [ ] Console に `[migrate] payments/loans` ログ
- [ ] `localStorage.cfo_paymentsLoansMigrated === "1"` 確認
- [ ] Dashboard で <client_A> さん uuid の payment_methods / loans 行件数を確認、localStorage と一致
- [ ] PM CRUD 全動作 (create / update / delete / **drag-drop reorder**) を 1 件ずつ実施 → DB 反映を確認
- [ ] loans CRUD 全動作 (create / update / delete) を 1 件ずつ
- [ ] 並び替え後ページリロード → 順序が保持される
- [ ] 既存 expenses が削除済みでない PM を参照していることを確認 (孤児ゼロ確認)

---

## Step 2-2. DB 適用 段階 2 (10 分、Step 7 直後に即時実施)

事前確認 SQL:

```sql
-- 孤児ゼロ確認 (この結果が 0 行であることを確認してから ALTER)
select count(*) as orphan_count from public.expenses e
where e.payment_method is not null
  and not exists (
    select 1 from public.payment_methods pm
    where pm.client_id = e.client_id and pm.id = e.payment_method
  );
-- 期待: orphan_count = 0
```

orphan_count = 0 を確認後、`008_phase_b3b_expenses_payment_fk.sql` を Run。

エラー時は Rollback A2 (FK 制約のみ drop):
```sql
alter table public.expenses drop constraint expenses_payment_method_fk;
drop index if exists public.expenses_payment_method_idx;
```

> **改訂注**: 旧 Step 8 「観察期間 (24 時間)」は撤廃。Step 7 動作確認の直後にこの段階 2 を即時実施する。

---

## Step 8. 段階 2 動作確認 (15 分)

- [ ] PM 削除を試行 → アプリ側で confirm dialog が出ることを確認 ('cash' へ振替 or soft-delete or キャンセル)
- [ ] 'cash' に振替を選ぶ → 該当 expenses の payment_method が 'cash' に更新される、PM が削除される
- [ ] 直接 SQL で参照中 PM を削除しようとする → FK 違反でエラー (= 制約が機能している)

---

## Step 9. 後始末 (10 分)

- [ ] <client_A> さんの localStorage に `cfo_paymentMethods` / `cfo_loans` が残っていることを確認 (削除しない方針)
- [ ] `docs/phase-b-3b-plan.md` 末尾の「実施結果ログ」を記入
- [ ] `docs/todo-followups.md` の 3 項目を再評価 (item 3 auth timeout は本フェーズで顕在化したか)
- [ ] `docs/day_-summary.md` (or 同等) に B-3b 完了を追記

---

## ロールバック手順

### Rollback A — 段階 1 DDL 適用直後にエラー (Step 2-1 段階)
```sql
drop table if exists public.loans            cascade;
drop table if exists public.payment_methods  cascade;
```
→ アプリは未デプロイなので影響ゼロ

### Rollback A2 — 段階 2 ALTER 適用直後にエラー (Step 2-2 段階)
```sql
alter table public.expenses drop constraint if exists expenses_payment_method_fk;
drop index if exists public.expenses_payment_method_idx;
```

### Rollback B — アプリデプロイ後、致命的な UI バグ (Step 6-7 段階)
1. Vercel Dashboard で 1 つ前のデプロイメントを Promote to Production
2. クライアント側 `cfo_paymentsLoansMigrated` フラグを hot-fix で 1 回だけ削除する版を出すか、<client_A> さんに DevTools から手動削除依頼
3. DB の payment_methods / loans 行は drop しなくて良い (legacy_key で identify 可)

### Rollback C — DB データ汚染、原因不明
B-3a Rollback C と同手順 (snapshot リストア + expenses 差分 CSV 救済)

---

## 想定リスクと対応

| # | リスク | 発生確率 | 対応 |
|---|---|---|---|
| R1 | DDL 構文エラー (段階 1) | 低 | migrations/007 を保存、エラー時 Rollback A |
| R2 | 配列順序の崩れ (sort_order の reorder ロジックバグ) | 中 | Step 7 で drag-drop → reload 検証必須。pre-prod で fixture テスト |
| R3 | App.jsx の差替で UI リグレッション (PM 一覧が空、loans が消失等) | **中** | Step 7 で <client_A> さん立ち会い必須 |
| R4 | 段階 2 ALTER で FK 違反 (孤児発見) | 中 | 事前確認 SQL で orphan_count = 0 を必ずチェック。0 でなければ ALTER 中止 |
| R5 | PM 削除時の confirm ロジック未実装で FK 違反エラーが UI に露出 | **高** | Step 4 で削除モーダルを必ず先に実装。段階 2 ALTER 前にアプリ側機能完成必須 |
| R6 | `cfo_paymentsLoansMigrated` フラグ二重起動 | 低 | upsert は冪等。実害なし |
| R7 | reorder 中に他端末から同 PM が編集される race condition | 低 | Realtime 購読で他端末更新を検知できるが、B-3b では subscribe しない (B-3a と同方針)。実害は最後勝ち上書きで限定 |
| R8 | auth context timeout 5000ms (別件 ToDo #3) が CRUD 失敗を誘発 | **中** | B-3b 着手前 or 並行で対応推奨。本フェーズ blocker ではないが UX 影響あり |

---

## 動作確認チェックリスト (Step 7 用、コピペ用)

```
□ Console に [migrate] payments/loans ログ
□ cfo_paymentsLoansMigrated === "1"
□ DB payment_methods 件数 = localStorage 件数
□ DB loans 件数 = localStorage 件数
□ PM 新規作成 → 一覧追加 → reload で残る
□ PM 編集 (label / color 等) → 反映 → reload で残る
□ PM drag-drop で並び替え → reload で順序保持
□ PM 削除 → confirm dialog 出る → 'cash' 振替 OK or キャンセル OK
□ loans 新規作成 → 一覧追加 → reload で残る
□ loans 編集 → 反映 → reload で残る
□ loans 削除 → 一覧から消える
□ 既存 expenses の PM バッジが正しく表示される
□ <client_A> さん「表示崩れ無し」確認
```

---

## 実施結果ログ (記入欄)

### 段階 1
| 項目 | 値 |
|---|---|
| 開始時刻 | `2026-__-__ __:__ JST` |
| 終了時刻 | `2026-__-__ __:__ JST` |
| 実施者 | `____________` |
| Step 2-1 SQL 実行結果 | `____________` |
| Step 3 DB 確認結果 | `____________` |
| Step 7 <client_A> さん立ち会い時刻 | `____________` |
| 本番 payment_methods 行数 | `___` |
| 本番 loans 行数 | `___` |
| 不具合・特記事項 | `____________` |

### 段階 2 (Step 7 直後に即時実施)
| 項目 | 値 |
|---|---|
| 段階 2 開始時刻 | `2026-__-__ __:__ JST` |
| 段階 2 終了時刻 | `2026-__-__ __:__ JST` |
| 事前確認 orphan_count | `___` (0 でなければ ALTER 中止) |
| Step 2-2 ALTER 実行結果 | `____________` |
| Step 8 動作確認結果 | `____________` |
| 不具合・特記事項 | `____________` |

---

## 次フェーズ着手前提

- 本 B-3b 完了後、即時に次フェーズ候補へ着手可 (1 名運用フェーズのため観察ゲートは置かない)
- `expenses_payment_method_fk` が機能していることを確認 (PM 削除 confirm が出る、孤児ゼロ維持)
- **B-3c 候補** (順不同、優先度は事業判断で決める):
  - `expenses.category` を `categories` への FK 化 (B-3a で前提だけ確認済、未実施)
  - `transactions` テーブル名統一 (現状アプリ側 `transactions` / DB 側 `expenses` の不整合解消)
  - 別件 ToDo #1〜#3 の整理 (rollback breadcrumb / catBudget sync / auth timeout)
- 大人数化フェーズに入った際は本 plan の改訂方針を再評価し、observation gate を再導入予定
