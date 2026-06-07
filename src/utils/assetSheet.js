// =============================================================
// 資産残高繰越票 純関数ヘルパ (Phase B-3 2026-06-07・顧客アプリ版)
//
// admin リポ src/utils/annualBudgetSheet.js の sumIncomeForMonth /
// sumExpenseForMonth / computeAssetBalance を【ロジック完全一致】で移植。
// 両アプリで残高計算が 1 円もズレないよう、引数名・分岐・丸めまで同一。
//
// 行 shape:
//   incomeLines: [{ id, row_type:'income', category_name, target_value, monthly_actuals:number[12] }]
//   expenseLines: 既存支出 lines ({ monthly_actuals or monthly_spent } を持つ)
//
// 月次資産残高 = 前月残高 + 収入実測 − 支出実測 (m===0 は initialAsset 起点)。
// monthIdx は呼出側 (UI) が「fiscal 月並び (startMonth 起点) の 0..11 index」で渡す前提。
// =============================================================

// 収入行 1 ヶ月の合計 (useActual=true で monthly_actuals、false で monthly_budget)。
export function sumIncomeForMonth(incomeLines, monthIdx, useActual = true) {
  const idx = Number(monthIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx > 11) return 0;
  return (incomeLines || []).reduce((s, l) => {
    const arr = useActual ? l?.monthly_actuals : l?.monthly_budget;
    const v = Number(arr?.[idx]);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
}

// 支出行 1 ヶ月の合計 (useActual=true で monthly_actuals ?? monthly_spent、false で monthly_budget)。
//   既存支出 line の実測系列は monthly_actuals 優先、無ければ monthly_spent (admin baked) で fallback。
export function sumExpenseForMonth(expenseLines, monthIdx, useActual = true) {
  const idx = Number(monthIdx);
  if (!Number.isInteger(idx) || idx < 0 || idx > 11) return 0;
  return (expenseLines || []).reduce((s, l) => {
    const arr = useActual ? (l?.monthly_actuals ?? l?.monthly_spent) : l?.monthly_budget;
    const v = Number(arr?.[idx]);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
}

// 月次資産残高を順次累積で計算。
//   balance[0] = initialAsset + 収入[0] − 支出[0]
//   balance[m] = balance[m-1] + 収入[m] − 支出[m]  (m>=1)
//   返却: { byMonth: number[12], yearEnd: number }
export function computeAssetBalance({ initialAsset = 0, incomeLines = [], expenseLines = [] } = {}) {
  const init = Number(initialAsset);
  const base = Number.isFinite(init) ? init : 0;
  const byMonth = new Array(12).fill(0);
  for (let m = 0; m < 12; m++) {
    const prev = m === 0 ? base : byMonth[m - 1];
    const income = sumIncomeForMonth(incomeLines, m, true);
    const expense = sumExpenseForMonth(expenseLines, m, true);
    byMonth[m] = prev + income - expense;
  }
  return { byMonth, yearEnd: byMonth[11] };
}
