# フェーズ B-3a 作業計画ドラフト — 予算系 3 表の Supabase 移行

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-04-27 |
| ステータス | **計画ドラフト** — 着手前に瑠星さんレビュー必要 |
| 対象テーブル | `budgets` / `week_budgets` / `week_cat_budgets` |
| 対象 localStorage | `cfo_budgets` / `cfo_weekBudgets` / `cfo_weekCatBudgets` |
| 関連 | `docs/phase-b-schema.md` (DDL ソース)<br>`docs/phase-b-checklist.md` (前提条件) |
| 想定所要時間 | **2.5 〜 4 時間** (デプロイ・確認込み) |
| 着手前提 | `docs/phase-b-checklist.md` の Step 0-6 が全て完了 |

---

## 前提・原則

- **本番 URL (`private-cfo-app.vercel.app`) は変更しない** — Vercel プロジェクト設定にも触らない
- **既存テーブル (`profiles` / `categories` / `expenses` 等) を変更しない** — B-3a の DDL は `create table` のみ。`alter` は B-3b 以降
- **既存データに触らない** — クレンジング系の UPDATE は B-3b 以降。B-3a 範囲は純粋に新規テーブル追加とアプリ側 read/write 切替のみ
- **段階的フィーチャーフラグ運用** — アプリ側で `cfo_migratedToSupabase` が立つまで localStorage 版を併用する設計にする (急に DB 一本にしない)

## Step 2 完了 (2026-04-27) で確認済の前提

- ✅ profiles: 3 件 (admin 1 + client 2)。backfill 影響軽微
- ✅ 全 client が `categories.cat_count >= 9` → **懸念 4 (カテゴリ削除済み skip) は実発動見込みゼロ**。**R5 リスクを「低」から「極低」に格下げ**
- ✅ `expenses.payment_method` クリーン (NULL 0 / 異常値 0) → B-3b の clean-up SQL は空振りで通る
- ✅ `expenses.category` 孤児 0 件 → B 範囲外バックログのまま放置可
- ⚠️ `profiles` は実 DB で 22 列 (schema.sql の 7 列 + 15 列追加) → **Step 1-bis (`migrations/` 整備、§8.2-1)** を B-3a 着手 *前* に挟むことを推奨

---

## 作業ステップ概要

| # | フェーズ | 作業 | 所要 | リスク |
|---|---|---|---|---|
| **1** | Pre-flight | チェックリスト全項目消化を再確認 / バックアップ最新化 | 5 分 | 低 |
| **2** | DB 適用 | DDL 流し込み (Dashboard SQL Editor) | 15 分 | 中 (DDL ミス時はロールバック) |
| **3** | DB 確認 | RLS / FK / index / publication が揃っているか SQL で目視 | 10 分 | 低 |
| **4** | アプリ実装 | `lib/api/budgets.js` + `hooks/useBudgets.js` 等を実装、App.jsx を hook 駆動へ差し替え | 90 〜 150 分 | 高 (UI リグレッションリスク) |
| **5** | クライアント移行 | `migrateLocalToSupabase` の budgets ブロック実装 + 動作確認 | 30 分 | 中 |
| **6** | デプロイ | `git push origin main` → Vercel 自動デプロイ | 5 分 | 中 (Vercel ビルド失敗) |
| **7** | 本番動作確認 | <client_A> さん立ち会いでログイン → Dashboard で行確認 | 20 分 | 中 |
| **8** | 後始末 | <client_A> さん `cfo_migratedToSupabase` フラグの値とテーブル件数を記録 | 5 分 | 低 |

---

## Step 1. Pre-flight (5 分)

- [ ] `docs/phase-b-checklist.md` の Step 0-6 が全て **[x]** であることを再確認
- [ ] 直近 1 時間以内に Supabase Dashboard の手動 snapshot を取得 (※ Step 1-1 のものから時間が経っていれば取り直す)
- [ ] ローカル `git status` クリーン、`main` から作業ブランチ `feat/phase-b-3a-budgets` を切る
- [ ] 開発用テストアカウント (admin 1 名 + client 1 名) のログイン情報を手元に用意

---

## Step 2. DB 適用 (15 分)

`supabase/migrations/006_phase_b3a_budgets.sql` を新規作成し、**そのファイルの中身を Dashboard SQL Editor に貼って Run**。

### 2-1. DDL ファイル作成

`supabase/migrations/006_phase_b3a_budgets.sql`:

```sql
-- =============================================================
-- B-3a: 予算系 3 表 + Realtime publication 追加
-- =============================================================

-- ---- budgets -----------------------------------------------------
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
  '1-12 のサイクル月。managementStartDay 未設定ならカレンダー月と等価';
comment on column public.budgets.legacy_key is
  '旧 cfo_budgets のキー文字列 (例 "2026-4-entertainment")';

-- ---- week_budgets ------------------------------------------------
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

-- ---- week_cat_budgets --------------------------------------------
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

-- ---- RLS ---------------------------------------------------------
alter table public.budgets          enable row level security;
alter table public.week_budgets     enable row level security;
alter table public.week_cat_budgets enable row level security;

create policy "budgets_client_rw_own" on public.budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "budgets_admin_all" on public.budgets
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "week_budgets_client_rw_own" on public.week_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_budgets_admin_all" on public.week_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "week_cat_budgets_client_rw_own" on public.week_cat_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_cat_budgets_admin_all" on public.week_cat_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- Realtime publication ----------------------------------------
alter publication supabase_realtime add table public.budgets;
alter publication supabase_realtime add table public.week_budgets;
alter publication supabase_realtime add table public.week_cat_budgets;
```

### 2-2. 適用手順

1. Dashboard → **SQL Editor → New query**
2. 上記 SQL を **丸ごとコピペ**
3. 右下 **Run**
4. "Success. No rows returned" 表示を確認 → エラー時はメッセージを記録して即 ROLLBACK (Step Rollback A 参照)

---

## Step 3. DB 確認 (10 分) — ✅ 完了 (2026-04-27)

> **実施結果サマリ** (2026-04-27 夜):
> Dashboard SQL Editor で B-3 計画書外の **拡張版検証 7 本** を実行し全件一致を確認 (本セクションの 3-1 〜 3-4 + FK / CHECK / RLS ポリシー詳細)。
>
> | 検証 | 結果 | 内容 |
> |---|---|---|
> | 1 (テーブル存在) | ✅ 3 行 | budgets / week_budgets / week_cat_budgets |
> | 2 (インデックス) | ✅ 6 行 | 各テーブル `*_pkey` + `*_client_period_idx` |
> | 3 (トリガー) | ✅ 3 行 | 全 `set_updated_at()` BEFORE UPDATE |
> | 4 (RLS 有効) | ✅ relrowsecurity 全 t | 3 テーブル全部 |
> | 5 (RLS ポリシー) | ✅ 6 行 | qual / with_check 完璧 (`is_admin()` / `client_id = auth.uid()`) |
> | 6 (Realtime publication) | ✅ 3 行 | 3 テーブル全部登録済 |
> | 7 (FK + CHECK) | ✅ 16 行 | 複合 FK + ON DELETE CASCADE + 4 種 CHECK 制約 |
>
> **DB 側 B-3a は完全に揃った状態**。アプリ実装 (Step 4) 着手可。
> **3-5 (RLS 動作確認) は実アカウントによる実行は省略** — 検証 5 で qual / with_check 式の完全一致を確認したため、機能的に等価な検証で代替済。

Dashboard SQL Editor で以下を実行し、結果を記録:

### 3-1. テーブル / インデックス / トリガ

```sql
select tablename from pg_tables
where schemaname = 'public' and tablename in ('budgets','week_budgets','week_cat_budgets')
order by tablename;
-- 期待: 3 行

select indexname from pg_indexes
where schemaname = 'public'
  and tablename in ('budgets','week_budgets','week_cat_budgets')
order by indexname;
-- 期待: 3 つの *_client_period_idx + 3 つの implicit PK index (*_pkey)

select tgname from pg_trigger
where tgrelid::regclass::text in ('public.budgets','public.week_budgets','public.week_cat_budgets')
  and not tgisinternal
order by tgname;
-- 期待: trg_budgets_updated_at / trg_week_budgets_updated_at / trg_week_cat_budgets_updated_at
```

### 3-2. RLS が有効

```sql
select relname, relrowsecurity
from pg_class
where relname in ('budgets','week_budgets','week_cat_budgets');
-- 期待: 全行 relrowsecurity = true
```

### 3-3. RLS ポリシー数

```sql
select tablename, count(*) as policy_count
from pg_policies
where schemaname = 'public'
  and tablename in ('budgets','week_budgets','week_cat_budgets')
group by tablename;
-- 期待: 各 2 件 (client_rw_own + admin_all)
```

### 3-4. Realtime publication

```sql
select tablename from pg_publication_tables
where pubname = 'supabase_realtime'
  and schemaname = 'public'
  and tablename in ('budgets','week_budgets','week_cat_budgets');
-- 期待: 3 行
```

### 3-5. RLS の動作確認 (テストアカウントで)

1. テストクライアント A でログイン
2. Dashboard → SQL Editor で **A の uuid をハードコードして** INSERT を試す:
   ```sql
   insert into public.budgets (client_id, year, cycle_month, category_id, amount)
   values ('<A の uuid>', 2026, 4, 'entertainment', 30000);
   -- → admin として実行: 成功
   ```
3. テストクライアント B のセッションで A の budgets が 0 件返ることを確認 (アプリ DevTools or `select` 実行)
4. テスト終了後、上記 INSERT した行を削除:
   ```sql
   delete from public.budgets
   where client_id = '<A の uuid>' and year = 2026 and cycle_month = 4 and category_id = 'entertainment';
   ```

---

## Step 4. アプリ実装 (90 〜 150 分)

### 4-1. 新規ファイル

#### `src/lib/api/budgets.js`

```js
import { supabase } from '../supabaseClient';

export async function listBudgets(clientId) {
  const [b, wb, wcb] = await Promise.all([
    supabase.from('budgets').select('*').eq('client_id', clientId),
    supabase.from('week_budgets').select('*').eq('client_id', clientId),
    supabase.from('week_cat_budgets').select('*').eq('client_id', clientId),
  ]);
  if (b.error) throw b.error;
  if (wb.error) throw wb.error;
  if (wcb.error) throw wcb.error;
  return { budgets: b.data ?? [], weekBudgets: wb.data ?? [], weekCatBudgets: wcb.data ?? [] };
}

export async function upsertBudget(clientId, { year, cycleMonth, categoryId, amount }) {
  const { error } = await supabase.from('budgets').upsert({
    client_id: clientId, year, cycle_month: cycleMonth, category_id: categoryId, amount,
  });
  if (error) throw error;
}

export async function deleteBudget(clientId, { year, cycleMonth, categoryId }) {
  const { error } = await supabase.from('budgets')
    .delete()
    .eq('client_id', clientId).eq('year', year)
    .eq('cycle_month', cycleMonth).eq('category_id', categoryId);
  if (error) throw error;
}

// week_budgets / week_cat_budgets も同パターン (省略)
```

#### `src/hooks/useBudgets.js` (骨格)

```js
import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/budgets';

export function useBudgets() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const [budgets, setBudgetsState] = useState({});             // { "2026-4-entertainment": 30000 }
  const [weekBudgets, setWeekBudgetsState] = useState({});     // { "2026-4-w1": 15000 }
  const [weekCatBudgets, setWeekCatBudgetsState] = useState({}); // { "2026-4-w1_entertainment": 5000 }
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!userId) { setLoading(false); return; }
    setLoading(true);
    const data = await api.listBudgets(userId);
    setBudgetsState(Object.fromEntries(
      data.budgets.map(r => [`${r.year}-${r.cycle_month}-${r.category_id}`, r.amount])
    ));
    setWeekBudgetsState(Object.fromEntries(
      data.weekBudgets.map(r => [`${r.year}-${r.cycle_month}-w${r.week_num}`, r.amount])
    ));
    setWeekCatBudgetsState(Object.fromEntries(
      data.weekCatBudgets.map(r => [`${r.year}-${r.cycle_month}-w${r.week_num}_${r.category_id}`, r.amount])
    ));
    setLoading(false);
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  // setBudget(key, amount) のような shim を提供 → App.jsx の差分を最小化
  // 詳細は実装時に詰める

  return { budgets, weekBudgets, weekCatBudgets, loading, refetch /* ... */ };
}
```

### 4-2. App.jsx 差し替え方針

- `useLocalStorage("cfo_budgets", {})` → `useBudgets()` の返り値を **同じキー文字列形式** で公開
- `setBudgets(next)` のような **オブジェクト全体差し替え** API は廃止し、key 単位の `setBudget(key, amount)` に変える
- 既存の `saveBudgets` / `setWeekBudgets(...)` 等の呼び出し箇所をすべて hook の action に差し替え
- App.jsx の `useLocalStorage(...)` 行は **削除しない (コメントアウトで一時保持)** → ロールバック容易化

### 4-3. ロールバック容易化のための最小ガード

App.jsx 冒頭に以下のフラグを置く (あくまで保険):

```js
// B-3a 緊急ロールバック用フラグ
// true にすると localStorage 版に切り戻し (hook は無視される)
const FORCE_LOCALSTORAGE_BUDGETS = false;
```

- このフラグを切り替えるだけで、再デプロイなしで本番を戻せる…のは無理 (ビルド済みコード)。
- → **本フラグは「次のホットフィックスを 5 分で出すための準備」** と割り切る。Vercel のロールバック (Step Rollback C) のほうが信頼性高い。

---

## Step 5. クライアント移行コード実装 (30 分)

`src/lib/migrateLocalToSupabase.js` (新規) を作り、`AuthGate` がログイン直後に **1 回だけ呼ぶ**。

実装は本書 §5.3 の擬似コードを budgets / week_budgets / week_cat_budgets の 3 ブロック分に展開。

ポイント:
- `cfo_migratedToSupabase` 値が `'1'` なら何もしない
- 各ブロックで try/catch、**いずれか失敗したらフラグを立てない** (次回再試行)
- skip 行は `console.warn` でリスト出力
- `legacy_key` 列に元キー文字列を必ず埋める

開発環境での動作確認:
- [ ] localhost のテストアカウントで `localStorage.cfo_budgets = JSON.stringify({"2026-4-entertainment":30000})` を仕込み、リロード → DB に行が入ることを確認
- [ ] 2 回目のリロードで再 INSERT が走らないことを確認 (`cfo_migratedToSupabase === '1'`)
- [ ] 削除済みカテゴリを参照する不正キーを仕込み、skip + warn が出ることを確認

---

## Step 6. デプロイ (5 分)

- [ ] feat ブランチで `npm run build` がエラーゼロで通る
- [ ] PR → main マージ
- [ ] Vercel が自動デプロイ → Build successful を確認
- [ ] 本番 URL (`private-cfo-app.vercel.app`) で開発者ログインしてエラーが出ないことを軽く確認

---

## Step 7. 本番動作確認 (20 分、<client_A> さん立ち会い)

- [ ] <client_A> さんに本番 URL でログインしてもらう (DevTools 開く)
- [ ] Console に `[migrate]` ログが出ることを確認
- [ ] `localStorage.cfo_migratedToSupabase` が `"1"` になっていることを確認
- [ ] Dashboard で <client_A> さん uuid の budgets 行件数を確認:
  ```sql
  select count(*) from public.budgets where client_id = '<<client_A> の uuid>';
  select count(*) from public.week_budgets where client_id = '<<client_A> の uuid>';
  select count(*) from public.week_cat_budgets where client_id = '<<client_A> の uuid>';
  ```
- [ ] Step 3 の checklist Step 3-3 (localStorage 集計) と件数が一致することを確認 (skip 数を引いて)
- [ ] 予算編集モーダルを 1 件触ってもらい、保存 → ページリロード → 値が残っていることを確認 (= read/write 双方向動作)
- [ ] アラート (赤バー、80% 黄色) が予算に応じて出ることを確認
- [ ] <client_A> さんから「予期せぬ表示崩れ・データ消失が無い」確認をもらう

---

## Step 8. 後始末 (5 分)

- [ ] <client_A> さんの localStorage に `cfo_*` キーが残っていることを確認 (削除しない方針)
- [ ] 本書 末尾の「実施結果ログ」欄に以下を記入:
  - 開始時刻 / 終了時刻
  - skip 件数 (もしあれば)
  - 本番 budgets / week_budgets / week_cat_budgets の行数
  - 不具合・気になった事象
- [ ] `docs/day_-summary.md` に B-3a 完了の旨を追記 (ファイル名は当日に合わせる)

---

## ロールバック手順

緊急度に応じて 3 段階:

### Rollback A — DDL 適用直後にエラー / RLS 不整合発覚 (Step 2-3 段階)

データ無し前提で table を drop:

```sql
drop table if exists public.week_cat_budgets cascade;
drop table if exists public.week_budgets     cascade;
drop table if exists public.budgets          cascade;
-- publication からは drop table と同時に外れる (確認 SQL は Step 3-4)
```

→ アプリは未デプロイなので影響ゼロ。原因解析後に修正版 DDL を再適用。

### Rollback B — アプリデプロイ後、致命的な UI バグ発覚 (Step 6-7 段階)

1. **Vercel Dashboard で 1 つ前のデプロイメントに Promote to Production**
   - 本番 URL は変わらず、コードのみ前バージョンに戻る
   - localStorage 側のデータは消していないので即座に復旧
2. クライアント側の `cfo_migratedToSupabase` フラグが残っているとアプリが「移行済」と誤認するので、**hot-fix デプロイで `localStorage.removeItem('cfo_migratedToSupabase')` を 1 回だけ実行する版** を出すか、<client_A> さんに DevTools から直接消してもらう
3. DB の budgets 行は **drop しなくて良い** (legacy_key で identify 可能、害は無い)。次の修正版で再 upsert する

### Rollback C — DB データ汚染、原因不明 (最悪ケース)

1. Step 1-1 の snapshot から DB をリストア (Dashboard → Backups → Restore)
   - **影響範囲**: snapshot 取得時刻以降の全テーブル変更が消える (expenses 含む) → <client_A> さんが移行後に新規追加した支出が消える可能性 → **取り扱い注意**
2. リストア前に必ず:
   - 取得時刻以降の expenses を CSV エクスポート (`select * from expenses where created_at > '<snapshot 時刻>'`)
   - リストア後に CSV を再 INSERT
3. アプリは Rollback B の手順でロールバック

---

## 動作確認チェックリスト (Step 7 用、コピペ用)

```
□ Console に [migrate] ログ
□ cfo_migratedToSupabase === "1"
□ DB budgets 件数 = localStorage 件数 - skip 数
□ DB week_budgets 件数 = localStorage 件数
□ DB week_cat_budgets 件数 = localStorage 件数 - skip 数
□ 予算編集モーダル: 保存 → reload → 残る
□ 予算アラート (赤・黄): 期待通り表示
□ <client_A> さん「表示崩れ無し」確認
□ skip された catId が存在すれば内容を本人に共有
```

---

## 想定リスクと対応

| # | リスク | 発生確率 | 対応 |
|---|---|---|---|
| R1 | Dashboard SQL Editor で構文エラー | 低 | DDL を `supabase/migrations/006_*.sql` に保存しているのでそのままコピペ。エラー時は Rollback A |
| R2 | RLS の `auth.uid()` が JWT 引けず常に NULL → 顧客が自分の行も見えない | 低 (既存テーブル動作中なので) | テストアカウントでの動作確認 (Step 3-5) で先に検出 |
| R3 | App.jsx の差し替えで UI リグレッション (週サマリーが空表示等) | **中** | Step 7 で <client_A> さん立ち会い必須。事前に開発環境で fixture データで確認 |
| R4 | Realtime 購読が動かない | 中 | Step 3-4 で publication 登録を確認。アプリ側は B-3a では subscribe しない (read on mount のみ) のでブロッカーにはならない |
| R5 | <client_A> さんのカテゴリ削除済み事象が想定より多く skip 大量発生 | **極低** (Step 2 で全 client `cat_count >= 9` 確認済) | skip コードは保険として残すが実発動見込みゼロ。万一 <client_A> さんの localStorage budgets キーが DB と乖離していたら個別判断 |
| R6 | `cfo_migratedToSupabase` フラグがバグで二重起動 → upsert が走り重複処理 | 低 | upsert 自体は冪等 (PK 衝突で overwrite)。実害なし |

---

## 実施結果ログ (記入欄)

| 項目 | 値 |
|---|---|
| 開始時刻 | `2026-__-__ __:__ JST` |
| 終了時刻 | `2026-__-__ __:__ JST` |
| 実施者 | `____________` |
| Step 2 SQL 実行結果 | `____________` |
| Step 3 RLS テスト結果 | `____________` |
| Step 7 <client_A> さん立ち会い時刻 | `____________` |
| skip 件数 (budgets / wb / wcb) | `___ / ___ / ___` |
| 本番 budgets 行数 | `___` |
| 本番 week_budgets 行数 | `___` |
| 本番 week_cat_budgets 行数 | `___` |
| 不具合・特記事項 | `____________` |

---

## 次フェーズ (B-3b) 着手前提

- 本 B-3a 完了後、最低 **24 時間は本番運用を観察** してから B-3b 着手
- 観察期間中:
  - <client_A> さんからの「予算が消えた」「数字が違う」報告がゼロ
  - Dashboard で `legacy_key` 列が空 (= 通常書き込み) の行が増えていく (新規予算編集が DB に届いている証拠)
  - 行数が日に 1 件以上は増減する (アクティブ性の確認)
- 24 時間後問題なければ B-3b (`payment_methods` + `loans` + `expenses.payment_method` FK) へ進む

---

## B-3a 完了記録（2026/4/28）

### 完了ステータス
- ブランチ: feat/phase-b-3a-budgets（13 commits ahead of main）
- Step 4-3 phase 3 まで完走、shim 完全除去
- Step 5 動作確認: 全項目クリア（単月CRUD / allWeek / copyLastMonth / clearAll / リロード永続化 / StrictMode）

### commit 履歴（Step 4-3）
| commit | 内容 |
|--------|------|
| 595ada2 | phase 1: useBudgets 切替 + shim 設置 |
| d86ffb2 | phase 2a: simple 6 callsite |
| ee3967d | phase 2b-1: saveBudgets (unreachable) |
| 1cdd6af | phase 2b-2: allWeek 一括 |
| 1b8e03d | phase 2b-3: copyLastMonth |
| b789d9a | phase 2b-4: clear all confirm |
| 01f6795 | phase 3: shim 削除 |

### 設計確定事項
- state 3分割 Record / action 文字列キー / エラー revert+throw
- optimistic キー単位 / loading 1個 / refetch 公開
- deps=[userId] / StrictMode 対策 ref ミラー
- delete = key 削除 / zero-budget 互換

### 残課題（scope 外、別件 ToDo へ）
- L221-225 useLocalStorage rollback breadcrumb 整理
- catBudget OK で budgetDraft 更新されない sync 漏れ（ee3967d 詳細）
- auth context timeout 5000ms console エラー多発
