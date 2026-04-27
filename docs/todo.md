# TODO

開発中に出てきた改善アイディアを溜めておく場所。
対応した項目は `[x]` にして残す(完了時期がわかるように)。

## 4/25 トライアル前にやりたい UI 改善(優先度:高)

記録日: 2026-04-22

- [ ] **週サマリー画面:各週ブロック全体の背景をグレーに**
  - 「今週」を示す金枠バッジとは別に、週ブロックそのものをグレー塗りにして
    視認性を上げる
  - 対象:週サマリー画面の `weekSummary` をループする各 `第N週` ブロック

- [ ] **円グラフ:全カテゴリに %表示を出す**
  - 現状は割合が小さいカテゴリのラベル・%が重なって見えないため、
    小さいスライスは外側引き出し線(leader line)で %表示
  - 対象:`renderReport` 内の `PieChart`(`recharts`)

- [ ] **カテゴリ編集画面:ドラッグ&ドロップで並び替え**
  - `categories.sort_order` を更新することで表示順を永続化
  - 実装メモ:`@dnd-kit/core` か `react-beautiful-dnd` を導入
  - 対象:`menuScreen === "catEdit"` の一覧、`expenseCats.map(...)`

## Phase 1 以降の課題(優先度:中)

- [ ] **予算の Supabase 化(admin 可視化のため)**
  - 現状 `cfo_budgets` / `cfo_weekBudgets` / `cfo_weekCatBudgets` /
    `cfo_paymentMethods` / `cfo_loans` は顧客端末の localStorage のみ
  - Day 5 Phase 1 で本部ダッシュボード側の「予算タブ」を実装しようとして、
    データソースが無く断念(判断 E-1)
  - admin から顧客の予算状況を見たい要望が出た段階でスキーマ追加 + 顧客側
    フック差し替えを検討
- [ ] `recurring_rules` テーブルを作り、`applyRecurring` の
  `recurId` / `isRecurring` を復活(「定期」バッジ再表示)
- [ ] 既定カテゴリの「リセット」機能(削除後に元に戻せる動線)
- [ ] 本部アプリ(`admin175-project`)の Supabase 接続実装
- [ ] 本部からの招待 UI(Supabase Admin API 経由、service_role は
  サーバ側関数化)
- [ ] `recurDraft` の初期値 `"food"` を `"entertainment"` へ修正
  (L269 / L1808 の既存バグ)
- [ ] Supabase Realtime で本部 INSERT の即時反映

## バックログ(優先度:低)

- [ ] PDF レポート(Phase 2 予定、5/10)
- [ ] 予算・支払方法・ローン類の Supabase 化(現状 localStorage)
- [ ] ログインフォームの UI 微調整(error 表示のアニメーション等)
- [ ] PWA 更新通知(service worker の new-version prompt)

## DB スキーマ — フェーズ B 範囲外(2026-04-27 追加)

フェーズ B-2 Step 1-bis で migrations/ 整備中に発見した、本フェーズでは触らない課題。

- [ ] **profiles 重複トリガーの整理**
  - `trg_profiles_updated_at` (`set_updated_at()`) と `on_profiles_updated`
    (`handle_updated_at()`) の 2 つが BEFORE UPDATE で発火
  - 挙動 (= `updated_at = NOW()`) は同等 (2026-04-27 検証済)
  - 関数本体の書式に差異あり (= 別タイミング / 別の人による定義の可能性):
    - `handle_updated_at`: 大文字 `BEGIN ... NEW.updated_at = NOW(); RETURN NEW; END;`
    - `set_updated_at`  : 小文字 `begin ... new.updated_at = now(); return new; end;`
  - 機能重複は冗長のみ (実害なし)
  - 解消案: どちらかを drop。`set_updated_at()` を残し `on_profiles_updated`
    + `handle_updated_at()` を drop するのが他テーブルとの統一性で自然
  - 関連: `supabase/migrations/005_profiles_updated_trigger.sql`
- [x] **`profiles_pending_idx` の列名最終確認** (✅ 2026-04-27 深夜 完了)
  - 列名: **`created_at`** で確定
  - WHERE 句: **`((approved = false) AND (role = 'client'::text))`** で確定
  - `migrations/003_profiles_app_gate_columns.sql` の推定と **完全一致**、修正不要
- [x] **`handle_updated_at()` 関数本体の実体確認** (✅ 2026-04-27 深夜 完了)
  - 本体: `NEW.updated_at = NOW(); RETURN NEW;` (大文字書式)
  - `migrations/005_profiles_updated_trigger.sql` の推定と **本質的に同一**、機能差なし
  - `set_updated_at()` も同等挙動と確認 (書式のみ小文字で異なる、上記重複トリガー項目参照)
  - 念のため migrations/005 の本体を **大文字書式** に揃えるかは後日判断 (再適用予定なしのため放置可)
- [ ] **`expenses.category` の FK 不在**
  - フェーズ B-2 §8.2(5) で「B 範囲外」と判断済
  - `expenses` の `category` 列は `categories` テーブルへの参照整合性が無い
  - Step 2 で孤児 0 件を確認済のため緊急性なし
  - 解消時はカテゴリ削除動線 (UI) と一緒に検討
- [ ] **`profiles.management_start_date` (date) の用途確認**
  - admin アプリ (`admin175-project`) でこの列がどう使われているか未確認
  - 仮説 A (CFO 管理開始日) / 仮説 B (サイクル起点日) の判別が必要
  - 詳細: `docs/phase-b-schema.md` §1.2.1
  - 確認方法: admin リポで `grep -rn "management_start_date" admin175-project/src/`
- [ ] **`week_budgets` / `week_cat_budgets` の列コメント追加**
  - 設計書 `phase-b-schema.md` §3.2 にコメント定義があるが、計画書
    `phase-b-3a-plan.md` §2-1 のテンプレでは省略されていた
  - B-3a Step 2 (`supabase/migrations/006_phase_b3a_budgets.sql`) では
    `budgets` テーブルのみコメント追加済 (`cycle_month` / `legacy_key`)
  - 後日 `supabase/migrations/007_add_week_budgets_comments.sql` として
    追加可能 (実害なし、可読性向上目的)
  - 関連: `supabase/migrations/006_phase_b3a_budgets.sql`

## 実施記録 (Phase B-3a)

### 2026-04-27 — B-3a Step 1〜3 完了 (DB 側)

- ✅ **Step 1-bis (migrations/ 整備)**: `001_init.sql` 〜 `005_profiles_updated_trigger.sql` を作成。schema.sql ドリフト解消、profiles 22 列の履歴復元
- ✅ **Step 1 (Pre-flight)**: 退避ブランチ `feat/phase-a-auth-gate` で Category B を隔離、main クリーン化、`feat/phase-b-3a-budgets` 切り出し
- ✅ **Step 2 (DDL 適用)**: `006_phase_b3a_budgets.sql` 作成 → Dashboard SQL Editor で Run、"Success. No rows returned" 確認
- ✅ **Step 3 (DB 検証)**: 拡張版検証 7 本 (テーブル / index / trigger / RLS / RLS policy / publication / FK+CHECK) 全件期待一致
  - 検証 1: 3 行 (テーブル存在)
  - 検証 2: 6 行 (PK + 通常 index)
  - 検証 3: 3 行 (全 `set_updated_at()`)
  - 検証 4: relrowsecurity 全 t (RLS 有効)
  - 検証 5: 6 行 (RLS ポリシー、qual / with_check 完璧)
  - 検証 6: 3 行 (Realtime publication 登録済)
  - 検証 7: 16 行 (複合 FK + ON DELETE CASCADE + 4 種 CHECK)
- 🟡 **Step 4 (アプリ実装) 未着手**: 次フェーズ。`src/lib/api/budgets.js` + `src/hooks/useBudgets.js` 作成 + App.jsx 差し替え

DB 側は完全に揃っているため、アプリ実装で何かあっても **DB 側のロールバック不要**。最悪 Vercel デプロイのロールバック (前バージョン Promote) で復旧可能。
