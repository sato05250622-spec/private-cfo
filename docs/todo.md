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
