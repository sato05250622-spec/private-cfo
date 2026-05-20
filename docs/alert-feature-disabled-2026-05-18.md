# 予算オーバーアラート機能 一時非表示メモ (2026-05-18)

## 無効化した日付・理由

- **日付:** 2026-05-18
- **理由:** 通知過多で精神的負荷が大きいため、予算オーバーアラート機能を全機能停止。
- **方針:** 削除ではなくコメントアウトで元ロジックを温存。復活はコメント解除2箇所で即元通り。
- **無効化コミット:** `9e3c5f9`

## 無効化された機能リスト

データソースである `budgetAlerts` を空配列に、入力時トースト判定を `/* */` で囲むことで、以下が一括で非表示になっている。

- 集約バナー(`BudgetAlertSummary` / renderDaily 上部 + 別バナー）
- カード border の赤化
- 「超」バッジ(カテゴリ別の超過パーセント表示)
- 底ナビ(menu タブ)の赤 dot
- 入力直後の予算オーバートースト

これらはすべて `budgetAlerts` / `budgetOverToast` に依存して動くため、データ側を止めれば自動的に何も表示されない。`BudgetAlertSummary` 関数定義・トースト JSX・関連 state は触っていない(そのまま残置)。

## 復活手順(2箇所のコメント解除)

> 行番号は無効化直後 (commit `9e3c5f9`) 時点。編集でズレることがあるため、まず文字列 `一時非表示中` で grep して該当箇所を特定すること:
> `grep -n "一時非表示中" src/App.jsx`

### 箇所1: `budgetAlerts` useMemo を元に戻す (src/App.jsx L493 付近)

現状:

```js
const budgetAlerts = useMemo(() => {
  // ★予算オーバーアラート機能 一時非表示中 (2026-05-18)
  // 通知過多で精神的負荷が大きいため全機能停止。
  // 復活時:下の return []; 行を削除 + 続く /* */ を解除
  return [];
  /*
  const result = [];
  expenseCats.forEach(cat => {
    ...
  });
  return result;
  */
}, [transactions, budgets, weekCatBudgets, expenseCats, tmCycleStart, tmCycleEnd, todayCycle]);
```

復活手順:
1. `// ★予算オーバーアラート機能 一時非表示中 ...` の3行コメントを削除。
2. `return [];` の行を削除。
3. その下の `/*` と、`return result;` の後ろの `*/` を削除(中身のロジックを有効化)。

### 箇所2: 入力時トースト判定を元に戻す (src/App.jsx L666 付近 / addExpense `.then()` 内)

現状:

```js
setInputMemo("");
// ★予算オーバートースト 一時非表示中 (2026-05-18) — 復活時は /* */ 解除
/*
// 予算オーバートースト判定: ...
if (txDateStr < tmCycleStart || txDateStr > tmCycleEnd) return;
const cat = expenseCats.find(c => c.id === txCatId);
...
if (spentOld < budget && spentNew >= budget) {
  ...
  setBudgetOverToast(`⚠️ ${cat.label} が予算超過\n(¥${overAmount.toLocaleString()} オーバー)`);
  ...
}
*/
})
```

復活手順:
1. `// ★予算オーバートースト 一時非表示中 ...` のコメント行を削除。
2. その下の `/*` と、判定ブロック末尾の `*/` を削除。

## ビルド・デプロイの流れ

両リポは CLI-deploy 運用。push / `vercel --prod` は最終 GO 後に実行する。

```sh
cd ~/Desktop/private-cfo-app
npm run build          # 成功確認(警告はチャンクサイズ系のみ可、エラーは不可)
git add src/App.jsx
git commit -m "..."
git push origin main
vercel --prod          # 完了 URL + READY 確認
curl -sI https://private-cfo-app.vercel.app/ | head -3   # HTTP 200 確認
```

## 関連コミット

| 役割 | hash |
|---|---|
| Step A(budgetAlerts ソース修正+集約パネル+ナビ赤点) | `d971799` |
| Step B(入力直後トースト) | `951d82f` |
| 全機能一時非表示化 | `9e3c5f9` |
