# Day 3 サマリ — 2026-04-22

プライベートCFO 顧客アプリの Day 3 作業記録。
4/25 トライアル開始まで残 3 日の時点での到達点と、Day 4 開始時の前提を残す。

## コミット一覧

```
d8edbf1  Day 3 Phase 4: logout UI, localStorage migration, pre-trial TODOs
b2f126e  Day 3 Phase 3: categories + points on Supabase (Path B)
1128f6a  Day 3 Phase 1-2: expenses on Supabase
(shared-cfo) 27e7f8b  Drop DEFAULT_EXPENSE_CATS (moved to Supabase)
```

## 達成事項

### Phase 1+2(`1128f6a`)
- `src/lib/api/{expenses,categories,points}.js` と `src/hooks/{useExpenses,useCategories,usePoints}.js` を新規作成
- `expenses` を Supabase に移行。App.jsx の書き込み 4 箇所(`addTransaction` / `deleteTransaction` / `saveEditTx` / `applyRecurring`)を hook の action に差し替え
- soft delete(`deleted_at` UPDATE)で顧客の物理削除を封じ、本部が監査できる
- `TxItem` に「本部入力」バッジ(`entered_by !== client_id` 時にゴールド塗り)を追加

### Phase 3(`b2f126e` + shared `27e7f8b`)
- **カテゴリスキーマを Path B に移行**: `categories.id` を `uuid → text`、PK を `(client_id, id)` 複合に
  - 既定は `entertainment` / `daily` ... の意味のある text id で統一
  - カスタムは `'custom_' || gen_random_uuid()::text` で自動発行
- `handle_new_user` トリガを拡張:profiles INSERT 時に 9 既定カテゴリを自動投入
- `shared-cfo/categories.js` から `DEFAULT_EXPENSE_CATS` を削除(DB を唯一のソース化)
- `useCategories` hook から `_custom` フラグ廃止
- 顧客は**既定 9 カテゴリも編集・削除可能**に(DB 行を直接触るため)
- `usePoints` を接続(読み取り専用、残高 + 履歴)

### Phase 4(`d8edbf1`)
- `src/components/LogoutButton.jsx`:accountSetting 画面下部、赤字+確認ダイアログ
- `localStorage` 残 5 キーを `kakeibo_* → cfo_*` に改名
  - `cfo_budgets` / `cfo_weekBudgets` / `cfo_weekCatBudgets` / `cfo_paymentMethods` / `cfo_loans`
- **module top-level の一度だけ移行ロジック**(`cfo_migratedFromKakeibo` フラグ)を追加
  - 生文字列でコピー、既存 `cfo_*` を上書きしない、旧 `kakeibo_*` は rollback 用に残置
- `docs/todo.md`:4/25 トライアル前 UI 3 項目 + Phase 1 以降の課題をストック

### Phase 5(2-browser RLS スモークテスト)
実施日: 2026-04-22、Chrome 通常 + Chrome シークレット で検証。

**実施・パス:**
- **Part A**: Supabase Auth で `test-client@example.com` を新規作成 → profiles / categories 両方に行が自動生成されることを確認(= `handle_new_user` トリガの 2 段階動作 OK)
- **Part B**: シークレット窓で test-client ログイン → カテゴリは既定 9 個のみ、admin 側で作ったカスタム(ゴルフ接待)・改名(娯楽・趣味)・削除(ETC)が**一切漏洩なし**
- **Part C**: client 側で 300 円を追加 → 双方向に隔離されていることを F5 で確認(admin 側には 4/22 が 0 円と表示、client 側には admin の支出が一切出ない)

**未実施(Day 4 で合流して検証):**
- Part D: 本部代行入力 → 「本部入力」バッジ描画(実装済だが実地未確認)
- Part E: points_ledger INSERT → client 側残高反映(実装済だが実地未確認)
- Part F: ログアウト → 再ログインでのセッション永続性(LogoutButton は compile OK のみ、ブラウザで動作未検証)
- Part G: RLS 負テスト(他 client_id INSERT が 42501 で弾かれる)

## テスト用アカウントの扱い

- **ADMIN_UUID** / **TEST_CLIENT_UUID** の実値は **Supabase Dashboard → Authentication → Users** でのみ管理
- コード・docs・コミットメッセージには書かない方針(漏洩・混乱防止)
- 取得するときは SQL Editor で:
  ```sql
  select id, email, role from public.profiles order by created_at;
  ```

## 残タスク

### 4/25 トライアル前(優先:高)
- Day 4: 通知(`notifications`)・問い合わせ(`inquiries`)・面談(`appointments`)の Supabase 接続
- `App.jsx` の `TELOP_TEXT` ハードコードを `notifications` テーブル購読に差し替え
- Phase 5 Part D / E / F / G の実地検証(Day 4 作業のついでに)
- `docs/todo.md` の UI 3 項目(週サマリ背景 / 円グラフ全%表示 / カテゴリ D&D)

### Phase 1 リリース後(5/1 以降)
- `budgets` / `weekBudgets` / `weekCatBudgets` / `paymentMethods` / `loans` の Supabase 移行
  - 現在は `cfo_*` prefix で localStorage に継続保存
  - 本部から顧客の予算状況を見たい・端末跨ぎで同期したい要望が出たら着手
- `recurring_rules` テーブルの追加で「定期」バッジを復活
- 本部アプリ(`Desktop/admin175-project`)の Supabase 接続実装
- 招待フロー(現在は Dashboard 手動 → 本番は admin アプリ経由で invite 発行)
- `docs/todo.md` の「Phase 1 以降」「バックログ」セクション参照

## `test-client@example.com` の削除手順

ブラウザテストが終わって不要になった時点で:

1. Supabase Dashboard → **Authentication → Users**
2. `test-client@example.com` の行 → 右端の `…` メニュー → **Delete user**
3. `auth.users` から削除されると、ON DELETE CASCADE により以下の public テーブルから自動削除される:
   - `profiles` / `categories` / `expenses` / `notifications` / `inquiries` / `points_ledger` / `appointments`
4. Table Editor で各テーブルの行数が減っていることを目視確認

削除は Day 4 の検証にも使うなら**しばらく残しておく**のも可。本番データと混ざる懸念がなければ再利用したほうが早い。

## Day 4 開始時に確認すべきこと

- 本部アプリ(`Desktop/admin175-project`)の扱い — 顧客アプリに admin 専用画面を同居させるか、別アプリで組むか方針決定
- テロップを Supabase で購読する際のポーリング頻度 vs リアルタイム購読の判断(顧客体験と請求の兼ね合い)
- 既存バグ `recurDraft.category = "food"`(L269 / L1808)の扱い — Day 4 でまとめて修正するか後日送りか
