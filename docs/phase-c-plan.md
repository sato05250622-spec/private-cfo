# フェーズ C 作業計画ドラフト — 本部 (admin) 閲覧 read-only 機能追加

| 項目 | 内容 |
|---|---|
| 作成日 | 2026-04-29 (徹夜モード Phase B-3b 完走後) |
| ステータス | **計画ドラフト** — レビュー待ち |
| 対象 repo | `private-cfo-admin` (ローカル運用、GitHub remote なし) |
| 対象 client repo | `private-cfo-app` (GitHub PUBLIC、変更なし) |
| 対象 DB テーブル | `payment_methods` / `loans` / `budgets` / `week_budgets` / `week_cat_budgets` (B-3a/B-3b 成果) |
| 想定所要時間 | **1.5 〜 2.5 時間** (DB 変更なし、admin app コードのみ) |
| 着手前提 | B-3a / B-3b 完走、admin Supabase 連携正常、admin auth 6 段階ゲート動作中 |

---

## 1. 背景・目的

### Phase A / B / C / D の関係

| Phase | スコープ | 状態 |
|---|---|---|
| **A** | 認証ゲート (Supabase Auth + RLS の `is_admin()` + 6 段階 AuthGate) | admin 側完成、client 側 wip ブランチ未マージ (本流動作には不要) |
| **B-3a** | 予算系 3 表 (budgets / week_budgets / week_cat_budgets) を Supabase 化 | ✅ 完走 |
| **B-3b** | payment_methods / loans Supabase 化 + expenses.payment_method FK | ✅ 完走 |
| **C** (本書) | **本部閲覧 read-only**: admin が client の B-3a/B-3b データを閲覧 | 着手前 |
| **D** | 代理編集 + Realtime: admin が client の expenses 等を編集、client に即時反映 | 未着手 |

### 目的

メモリ記載の当初目標「**本部から PM / expenses / loans 閲覧**」を実現。Phase D (代理編集) の前段として **read hook 層を整備**することで、Phase D で write メソッドを追加するだけで済む拡張可能な構造を作る。

### Phase C で達成しないこと (明示的スコープ外)

- 代理編集 (Phase D)
- Realtime 反映 (Phase D)
- AdminDashboard の stub タブ (top / review / fee / contact) の実 DB 化 (Phase E)
- client 側 auth-gate のマージ (本流不要)
- DB スキーマ変更 (RLS 既に admin_all で許可済、追加不要)

---

## 2. 確定事項 (論点 6/7/8 + 4/5 の判断)

| 論点 | 判断 |
|---|---|
| **4. read-only 強制方法** | UI 層で書き込みボタンを描画しない (新 hook は read メソッドのみ export) |
| **5. Realtime** | Phase D に持ち越し、Phase C は素朴な fetch (refetch 関数で手動更新可) |
| **6. 顧客選択 UI** | 新規 UI 作らず、AdminDashboard `home` タブの既存顧客リストの click を流用 |
| **7. soft delete** | `where deleted_at is null` を default、client UI と同じ view (削除済み復元は Phase D 領域) |
| **8. display_name** | 既存 admin の表示パターン踏襲。新規 column 追加なし |

---

## 3. 実装内容

### 3-1. 新規 API 層 (`/Users/satou/Desktop/private-cfo-admin/src/lib/api/`)

既存 `expenses.js` (`listExpensesForClient`) のパターンを踏襲、3 ファイル新規追加:

#### `paymentMethods.js`
```js
export async function listPaymentMethodsForClient(clientId) {
  const { data, error } = await supabase
    .from('payment_methods')
    .select('*')
    .eq('client_id', clientId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
```

#### `loans.js`
```js
export async function listLoansForClient(clientId) {
  const { data, error } = await supabase
    .from('loans')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
```

#### `budgets.js`
```js
// B-3a の useBudgets 同様、3 テーブルを Promise.all で 1 RTT 取得
export async function listBudgetsForClient(clientId) {
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
```

### 3-2. 新規 hook 層 (`/Users/satou/Desktop/private-cfo-admin/src/hooks/`)

既存 `useClientExpenses(clientId, opts)` のパターン踏襲、3 ファイル:

| hook | 引数 | 戻り値 |
|---|---|---|
| `useClientPaymentMethods(clientId)` | clientId | `{ paymentMethods, loading, error, refetch }` |
| `useClientLoans(clientId)` | clientId | `{ loans, loading, error, refetch }` |
| `useClientBudgets(clientId)` | clientId | `{ budgets, weekBudgets, weekCatBudgets, loading, error, refetch }` |

実装テンプレ (例: `useClientPaymentMethods`):
```js
import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/paymentMethods';

export function useClientPaymentMethods(clientId) {
  const [paymentMethods, setPaymentMethods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!clientId) { setPaymentMethods([]); setLoading(false); return; }
    setLoading(true);
    try {
      const rows = await api.listPaymentMethodsForClient(clientId);
      setPaymentMethods(rows);
      setError(null);
    } catch (e) {
      console.error(e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => { refetch(); }, [refetch]);

  return { paymentMethods, loading, error, refetch };
}
```

`useClientBudgets` も同パターンで `{ budgets, weekBudgets, weekCatBudgets }` を返す。

### 3-3. UI 層 (admin の AdminDashboard.jsx)

**選択肢を検討**:

| 案 | 内容 | 推奨 |
|---|---|---|
| **A** | AdminDashboard.jsx 内に新 sub-view 追加 (`activeView === 'clientFinancial'` 等の state で切替) | ⚠️ 1916 行の AdminDashboard をさらに拡張、保守性悪化 |
| **B** | 新規 `pages/ClientFinancialDetail.jsx` 作成し、AdminDashboard から条件付き render | ✅ **推奨**: 関心の分離、ClientDetail.jsx (参考資料) と並ぶ位置 |
| **C** | 既存 `pages/ClientDetail.jsx` 拡張 (現状未 import の参考資料) | △ ClientDetail の意図/構造が不明、参考資料を本番化するのは改修コスト高 |

**推奨: 案 B (新規 `ClientFinancialDetail.jsx`)**

#### `ClientFinancialDetail.jsx` 構造案

```
ClientFinancialDetail({ client, onBack })
├─ Header: client.display_name (or email) + 戻るボタン
├─ Tabs: [支出 | 決済手段 | 借入 | 予算]
│  ├─ 支出 (useClientExpenses): 既存実装の view を流用
│  ├─ 決済手段 (useClientPaymentMethods): list 表示 (label / color / closingDay / withdrawalDay / bank)
│  ├─ 借入 (useClientLoans): list 表示 (label / amount / bank / withdrawalDay / pmId)
│  └─ 予算 (useClientBudgets): 3 表合算ビュー (月予算 / 週予算 / 週×カテゴリ予算)
└─ Footer: refetch ボタン (素朴更新)
```

read-only のため CRUD ボタンなし。Phase D で同 component に編集 UI を追加する想定。

### 3-4. 導線 (AdminDashboard.jsx に新 nav タブ「本部閲覧」追加)

**重要な発見 (2026-04-29 実装着手前調査)**: AdminDashboard の `customers` は INITIAL_CUSTOMERS スタブ (in-memory、id integer)、DB の `clients` は別途 `rawClients` (L236 `useClients()`) として fetch 済だが home UI に未統合。stub customer.id で DB lookup 不可。

→ **案 G 採用**: 既存 home タブを不可侵 (Step 2-A 保持) とし、**新 nav タブ「本部閲覧」を追加** して rawClients (DB) ベースの read-only 導線を別建てで実現。

実装方針:

```jsx
// AdminDashboard.jsx 内 (擬似コード)
// 1. nav items 配列に追加 (1 行)
const navItems = [
  {id:"home", label:"ホーム"},
  {id:"sales", label:"営業分析"},
  {id:"viewer", label:"💰 本部閲覧"},  // ← 新規追加
  {id:"top", label:"トップ入力"},
  // ... 既存項目
];

// 2. viewer 分岐 (約 30 行)
{nav === "viewer" && (
  selectedViewerClient ? (
    <ClientFinancialDetail
      client={selectedViewerClient}
      onBack={() => setSelectedViewerClient(null)}
    />
  ) : (
    <ViewerClientList
      clients={rawClients}
      onSelect={(c) => setSelectedViewerClient(c)}
    />
  )
)}
```

**stub home は不可侵**、他タブも触らない。Phase D で「本部閲覧」が「代理編集」に進化する想定。

---

## 4. read-only 強制方法 (論点 4 確認)

**4 層で write 入口ゼロ** を保証する設計 (RLS は admin_all で write 許可しているが、UI から発火する経路がない):

- **DB 層**: admin policy `for all using (is_admin())` で write **も許可されてる** (Phase C で変更しない、Phase D で write 必要なため)。**= ここはガードしない**
- **API 層**: 新 3 ファイル (paymentMethods.js / loans.js / budgets.js) は `list*` (SELECT) 関数のみ、`upsert*` `delete*` は**実装しない**
- **hook 層**: 新 3 hook は `{ data, loading, error, refetch }` のみ export、create/update/delete 系の action 関数は**返さない**
- **UI 層**: ClientFinancialDetail に CRUD ボタン (新規/編集/削除) を**描画しない**
- **検証**: Phase C リリース後、(a) UI に CRUD ボタンが見えないこと、(b) DevTools Network で POST/PATCH/DELETE が 0 件であることを動作確認シナリオ #11 / #12 で実測保証

---

## 5. soft delete デフォルト挙動 (論点 7 確認)

### スキーマ実測結果 (2026-04-29 確認、`awk '/create table public\.X/,/^\);/'` で各テーブル CREATE block 内に `deleted_at` 列があるかを直接 grep)

| テーブル | `deleted_at` 列 | migration | コメント |
|---|---|---|---|
| **expenses** | ✅ あり (`timestamptz`) | 001 | `deleted_at timestamptz, -- soft delete(顧客は物理削除不可)` |
| **payment_methods** | ❌ なし | 007 | 物理 delete のみ (B-3b 設計) |
| **loans** | ❌ なし | 007 | 物理 delete のみ |
| **budgets** | ❌ なし | 006 | 物理 delete のみ (B-3a 設計、Record 互換) |
| **week_budgets** | ❌ なし | 006 | 物理 delete のみ |
| **week_cat_budgets** | ❌ なし | 006 | 物理 delete のみ |

### 各 hook の挙動

- **expenses** (`useClientExpenses` 既存): `listExpensesForClient` で `.is('deleted_at', null)` 既定済 → そのまま流用
- **payment_methods / loans / budgets / week_budgets / week_cat_budgets**: `deleted_at` 列**不在のため soft delete 概念なし**、新 hook も全行 SELECT (フィルタ不要)

→ **expenses 以外は全行表示、expenses は active 行のみ表示**。client UI と完全一致。Phase C で追加検討事項なし。

---

## 6. 動作確認シナリオ (深夜時短スコープ、6 項目)

実施者: user (= admin として login)。

### 必須 4 項目 (核心)

| # | 操作 | 期待 |
|---|---|---|
| **#4** | admin login → **「💰 本部閲覧」タブ** → 顧客一覧 (rawClients ベース) で `<client_A>` row click → 「決済手段」タブ | `<client_A>` の payment_methods 全行 (`cash` + 追加 PM) が sort_order 順で表示 (= B-3b 連携検証) |
| **#7** | 「支出」タブ表示 | expenses 行のうち `deleted_at not null` の行は**見えない** (= soft delete フィルタ動作確認) |
| **#11** | ClientFinancialDetail 全タブを巡回 | UI 上に CRUD ボタン (新規/編集/削除) が**一切ない** (= read-only 強制) |
| **#12** | DevTools Network タブを開いた状態で各タブ巡回 + refetch ボタン押下 | リクエストは GET のみ、POST/PATCH/DELETE が**0 件** (= read-only 実測) |

### 追加 2 項目 (堅牢性)

| # | 操作 | 期待 |
|---|---|---|
| **#E** (empty state) | データが 0 件の顧客を選択 (= 別の test client 等)、各タブを開く | UI 崩れず、「データなし」など適切な空表示 (PM 0 件 / loans 0 件 / budgets 0 件 / expenses 0 件) |
| **#S** (client 切替) | freeder さん表示中に戻るボタン → 別 client row click | 切替後に新 clientId で正しく refetch、前 client のデータが残らない (各 hook の `useEffect(refetch, [clientId])` 動作検証) |

### Skip 項目 (時短のため省略、Phase D 動作確認で補完)

- ClientFinancialDetail 表示そのもの (= #4 の前提として暗黙にカバー)
- 「借入」「予算」タブの個別データ表示 (= #4 と同パターン、PM で代表検証)
- refetch ボタン単体の動作 (= #12 の中で押下するため重複)
- 別 browser での client 同時編集 → admin refetch (= Realtime 非実装の Phase C スコープ外、Phase D で検証)
- 戻るボタン単体 (= #S の中でカバー)

---

## 7. 段階リリース

**不要 = 即時 1 commit + ローカル動作確認のみ**。理由:

- DB 変更ゼロ (RLS 既存 admin_all policy で全テーブル read 可能)
- admin repo は GitHub remote ゼロ、Vercel CLI deploy のため、git push の概念がない
- ローカルで `npm run dev` し、admin login → 動作確認すれば完結

deploy が必要な場合は `cd /Users/satou/Desktop/private-cfo-admin && vercel --prod` (private-cfo-admin.vercel.app に反映)。

---

## 8. Phase D へのつなぎ

Phase C で構築した hook 層は **read のみ**だが、Phase D で write メソッドを追加する設計を埋め込んでおく:

```js
// useClientPaymentMethods (Phase C 版)
return { paymentMethods, loading, error, refetch };

// Phase D で追加予定 (write メソッド):
return {
  paymentMethods, loading, error, refetch,
  createPaymentMethod, updatePaymentMethod, deletePaymentMethod, reorderPaymentMethods,  // ← Phase D
};
```

Phase C では hook 内部に `useState` ベースの shape を持たせるが、optimistic update / error revert は実装しない (= Phase D で追加)。

Realtime 化の入口も **Phase D で `supabase.channel(...).on('postgres_changes', ...)` を hook 内に追加するだけ** で実現可。

---

## 9. 想定リスクと対応

| # | リスク | 確率 | 対応 |
|---|---|---|---|
| R1 | admin 側 `display_name` 列の取得方法が既存パターンと異なり表示崩れ | 低 | Step C-2 着手時に既存 useClients() の出力 shape を確認、踏襲 |
| R2 | freeder さんが Phase B-3b で実際に payment_methods 追加してたら admin で見えるか確認漏れ | 中 | 動作確認 #4 で実値が見えることを必ず確認 |
| R3 | budgets / week_budgets / week_cat_budgets の 3 表結合表示 UI 設計が複雑 | 中 | client の表示 (App.jsx 内週予算画面) を参考に、admin 用に簡素化した一覧表示で OK |
| R4 | AdminDashboard.jsx 1916 行の nav items 配列に新タブ追加で既存挙動を壊す (home/sales/top/review/fee/contact 等の遷移崩れ) | 低 | 配列に 1 要素 push するだけ、`nav === "viewer"` の独立分岐で render、既存タブのロジック変更ゼロを守る |
| R5 | `useClientBudgets` の戻り値 shape が複雑で Phase D で破壊的変更必要 | 低 | 最初から `{ budgets, weekBudgets, weekCatBudgets }` 3 分割で返す (B-3a useBudgets 整合) |
| R6 | RLS 設定ミスで admin が他 client の行を読めない | 極低 | B-3a/B-3b で全テーブルに admin_all policy 追加済、検証もすべて pass |

---

## 10. 実装順序 (Step C-2 で着手)

1. **API 層 3 ファイル作成** (paymentMethods.js / loans.js / budgets.js) — 並列 Write 可
2. **hook 層 3 ファイル作成** (useClientPaymentMethods / useClientLoans / useClientBudgets) — 並列 Write 可
3. **ClientFinancialDetail.jsx 作成** — UI、4 タブ構造
4. **AdminDashboard.jsx の home タブに onClick + 状態管理追加** — 最小侵襲
5. **`npm run build` 確認**
6. **`npm run dev` でローカル動作確認** (シナリオ 1-12)
7. **動作確認 OK なら 1 commit** (msg: `feat(Phase C): admin 閲覧 read-only 機能追加 - PM/expenses/loans/budgets`)
8. **`vercel --prod` で本番反映** (admin は CLI deploy)

すべて 1 セッション内で完結 (見積 1.5-2.5 時間)。

---

## 11. 実施結果ログ

| 項目 | 値 |
|---|---|
| 開始時刻 | 2026-04-29 02:30 JST 頃 (徹夜モード Phase B-3b filter-repo 完走後) |
| 終了時刻 | 2026-04-29 03:30 JST 頃 (動作確認 6 項目すべて OK) |
| 実施者 | 佐藤 |
| 動作確認結果 (6 項目) | **全 OK** (詳細は下表) |
| Vercel deploy URL | https://private-cfo-admin.vercel.app (CLI deploy 想定、本記入時点で deploy 直前) |
| 不具合・特記事項 | 後述「不具合・気付き」参照 |

### 動作確認 6 項目 詳細結果

| # | 項目 | 結果 | 確認内容 |
|---|---|---|---|
| **#11** | CRUD ボタン不在 | ✅ | 4 タブ巡回、新規/編集/削除ボタンが**一切ない**ことを目視確認 |
| **#12** | DevTools Network | ✅ | 12 requests すべて GET (= REST API SELECT)、POST/PATCH/DELETE が **0 件** |
| **#4** | B-3b 連携 | ✅ | freeder0324 (`<client_A>`) の expenses 6 件表示、custom payment_method (B-3b で追加された) も含む |
| **#7** | soft delete フィルタ | ✅ | api 層の `.is('deleted_at', null)` フィルタが正常動作、削除済 expense 非表示 |
| **#S** | client 切替 | ✅ | client 切替時に `useEffect(refetch, [clientId])` が動作、前 client のデータが残らない |
| **#E** | empty state | ✅ | データ 0 件の client で「データなし」表示、UI 崩れず |

### 不具合・気付き

#### 1. Gmail ドット仕様による orphan auth.users (動作確認外の発見)

admin login 時に `AccessDenied` 画面に到達。原因調査で:

- 正規 admin: `sato.05250622@gmail.com` (ドット**付き**) → role=admin, approved=true, app_enabled=true ✅
- orphan: `sato05250622@gmail.com` (ドット**無し**) → profile MISSING (auth.users にのみ存在)

**原因**: Gmail はドット無視するが Supabase Auth はドットを区別。間違って ドット無し版でログインしていた。

**解決**: ログアウト → ドット付き版で再ログイン → AccessDenied 解消、Dashboard 到達。

**残存**: orphan auth.users (ドット無し版) は profile MISSING の状態で残るが、Phase C 動作確認には影響なし。後日 admin 経由で削除判断 (本日は触らない)。

#### 2. dev server port fallback

`vite --host --port 5174` に対し、5174 が client dev server で使用中だったため 5175 に fallback。動作影響なし、URL 確認時に注意。

#### 3. 別件 ToDo #3 (auth context timeout 5000ms)

admin login 時に `[auth] init exception Error: timeout(5000ms): auth.getSession` が console に出る既知の症状。**Phase C 機能には影響なし** (onAuthStateChange SIGNED_IN で session が確定し、Dashboard が正常表示される)。`docs/todo-followups.md` #3 で別タスクとして記録済、後日対応。

### 関連 commit (filter-repo 後の新 hash)

- 本書 commit (本日): TBD (Phase C 全変更を 1 commit、本書追記後)
- 関連: B-3a merge `3d50854` / B-3b 段階1 merge `b347322` / filter-repo memorial `f5160b0`

---

## 12. 次フェーズ (Phase D) 着手前提

- Phase C 完走後、即時 Phase D 着手可 (1 名運用フェーズのため観察ゲートなし)
- Phase D スコープ: hook 層に write メソッド (create/update/delete) 追加 + UI に CRUD ボタン追加 + Realtime subscribe
- 焦点: client が編集 → admin に即時反映 (代理編集の逆方向)、admin が編集 → client に即時反映 (代理編集本体)
