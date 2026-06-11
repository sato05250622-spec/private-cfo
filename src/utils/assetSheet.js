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

// =============================================================
// Phase 2-1 (2026-06-11): admin リポ src/utils/annualBudgetSheet.js
//   L938-1045 の computeAssetSheet (Phase 1-D-3b 最終仕様) を顧客アプリへ
//   ロジック完全一致で移植。資産残高繰越票の顧客直接編集 (Phase 2) に
//   向けた純関数化。既存3関数 (sumIncomeForMonth / sumExpenseForMonth /
//   computeAssetBalance) は無改変。
//
// ★月キー2方式の罠 (admin と完全同一):
//   - 支出 line.monthly_* は jsonb {1..12} (暦月キー、commit 時に焼かれる)
//   - 本収入 line.monthly_actuals/monthly_targets は配列 0..11 (fiscal idx)
//   sumExpenseBudgetForMonth / sumExpenseActualForMonth は fiscal idx →
//   暦月 cm = months[idx] へ変換して引く (数値/文字列キー両対応)。
// =============================================================

// 1 ヶ月の支出予算 (monthly_budget)。expense 側の monthly_* は commit 時に
//   「暦月 1-12 キー」の jsonb で焼かれる。fiscal idx → 暦月 cm = months[idx]
//   に変換して引く (数値/文字列キー両対応)。
export function sumExpenseBudgetForMonth(expenseLines, months, idx) {
  const cm = Number((months || [])[idx]);
  return (expenseLines || []).reduce((s, l) => {
    const obj = l?.monthly_budget;
    const raw = obj?.[cm] ?? obj?.[String(cm)];
    const v = Number(raw);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
}

// 1 ヶ月の支出実測 (monthly_actuals 優先、無ければ monthly_spent fallback)。
//   暦月キー前提で引く (上と同じ規約)。
export function sumExpenseActualForMonth(expenseLines, months, idx) {
  const cm = Number((months || [])[idx]);
  return (expenseLines || []).reduce((s, l) => {
    const obj = l?.monthly_actuals ?? l?.monthly_spent;
    const raw = obj?.[cm] ?? obj?.[String(cm)];
    const v = Number(raw);
    return s + (Number.isFinite(v) ? v : 0);
  }, 0);
}

// computeAssetSheet — admin Phase 1-D-3b 仕様 (auto-settle)
//   isSettled(i) = (incomeActual(i) > 0) || (expenseActual(i) > 0)
//   fRun: 全月通しの予想累計 (= initialAsset + Σ forecastNet)
//   aRun: 確定月のみ加算する実測累計 (= initialAsset + Σ {settled} actualNet)
//   未確定月の actualCum は null (aRun 据置、次の確定月で再開)
//
// 返却 shape:
//   { rows: [{ month, settled,
//              incomeTarget, incomeActual, expenseBudget, expenseActual,
//              forecastNet, actualNet, forecastCum, actualCum }, ...],
//     summary: { incomeTargetTotal, incomeActualTotal,
//                expenseBudgetTotal, expenseActualTotal,
//                forecastCumTotal, progressLanding } }
export function computeAssetSheet({
  incomeLines = [],
  expenseLines = [],
  months = [],
  initialAsset = 0,
} = {}) {
  // 1 ヶ月の収入目標 (monthly_targets, 未導入なら 0)。fiscal idx を直接引く。
  const sumIncomeTargetForMonth = (idx) =>
    (incomeLines || []).reduce((s, l) => {
      const arr = Array.isArray(l?.monthly_targets) ? l.monthly_targets : null;
      const v = arr ? Number(arr[idx]) : 0;
      return s + (Number.isFinite(v) ? v : 0);
    }, 0);

  const seedInitial = Number(initialAsset) || 0;
  const rows = [];
  let fRun = seedInitial;
  let aRun = seedInitial;

  for (let i = 0; i < (months || []).length; i++) {
    const m = Number(months[i]);
    const incomeTarget  = sumIncomeTargetForMonth(i);
    const incomeActual  = sumIncomeForMonth(incomeLines, i, true);
    const expenseBudget = sumExpenseBudgetForMonth(expenseLines, months, i);
    const expenseActual = sumExpenseActualForMonth(expenseLines, months, i);
    const settled = (incomeActual > 0) || (expenseActual > 0);
    const forecastNet = incomeTarget - expenseBudget;
    const actualNet   = incomeActual - expenseActual;
    fRun += forecastNet;
    const forecastCum = fRun;
    let actualCum = null;
    if (settled) {
      aRun += actualNet;
      actualCum = aRun;
    }
    rows.push({
      month: m,
      settled,
      incomeTarget,
      incomeActual,
      expenseBudget,
      expenseActual,
      forecastNet,
      actualNet,
      forecastCum,
      actualCum,
    });
  }

  const summary = rows.reduce(
    (acc, r) => {
      acc.incomeTargetTotal  += r.incomeTarget;
      acc.incomeActualTotal  += r.incomeActual;
      acc.expenseBudgetTotal += r.expenseBudget;
      acc.expenseActualTotal += r.expenseActual;
      acc.forecastCumTotal   += r.forecastNet;
      acc.progressLanding    += r.settled ? r.actualNet : r.forecastNet;
      return acc;
    },
    {
      incomeTargetTotal: 0,
      incomeActualTotal: 0,
      expenseBudgetTotal: 0,
      expenseActualTotal: 0,
      forecastCumTotal: seedInitial,
      progressLanding: seedInitial,
    },
  );

  return { rows, summary };
}
