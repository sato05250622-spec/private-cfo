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

import { findCycleOfDate, cycleStart, cycleEnd } from './cycle';
import { toDateStr } from '@shared/format';

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

// =============================================================
// Phase D-A (2026-06-11): admin リポ src/utils/annualBudgetSheet.js から
//   下記 9 関数 + 2 module-private 補助を「1 バイトも変えず」コピー移植。
//   既存 6 export (L17-178) は無改変。本ブロックの呼び出し元は本 PR 時点で
//   皆無 (inert)。AssetSheetViewer 結線は Phase D-E で行う。
//
// 移植元行範囲 (admin/src/utils/annualBudgetSheet.js):
//   L79-104   : makeEmptyFixedCostLine (module-private)
//   L106-111  : buildFixedCostLines
//   L215-228  : fiscalMonthCalendarYear
//   L230-242  : parseDateLocal (module-private)
//   L244-329  : aggregateCellsFromExpenses
//   L331-412  : computeTotalsRow
//   L555-569  : classifyMonth
//   L752-788  : deriveFutureWeekBudgetForCategory
//   L1047-1077: _pickMonth (module-private)
//   L1079-1216: resolveExpenseCellPure
//   L1218-1226: computeMonthlyExpenseBudgetTotals
//
// 外部依存:
//   - findCycleOfDate / cycleStart / cycleEnd : ./cycle (顧客既存)
//   - toDateStr                              : @shared/format (顧客 alias 既存)
// =============================================================

// Phase 3 (固定費): loans (借入) の 1 レコード → 繰越票の固定費行 (line) を生成。
//   データ源は loans テーブル (label=項目名 / amount=月額)。
//   - row_type 'fixed_cost' (通常カテゴリでも特殊行でもない第3種別)
//   - category_id に loans.id を入れて行識別子とする
//   - monthly_amount に loans.amount (基準月額)、monthly_amounts に loans.monthly_amounts
//     (月別上書き jsonb)。resolveCell は各月 monthly_amounts[m] ?? monthly_amount を返す
//     (月別に違う額を出せる。予算/実測の区別なし)
//   - locked=false / archived=false。繰越票上は本部が月別に編集可 (確定ロック対象外)
//   ※ 固定費行は永続 lines / committed_lines には焼かず、描画時にライブ生成する
//     (settle/recompute/commit を汚さない・loans 変更を即反映するため)。
function makeEmptyFixedCostLine(loan, displayOrder) {
  return {
    category_id: loan.id,
    category_name: loan.label,
    row_type: 'fixed_cost',
    locked: false,
    archived: false,
    monthly_amount: Number(loan.amount) || 0,            // 基準月額 (フォールバック)
    monthly_amounts: loan.monthly_amounts || null,        // 月別上書き { "1".."12": 額 }
    monthly_values: {},
    monthly_overrides: {},
    monthly_budget: {},
    target_value: loan.annual_target ?? null,             // 年間目標 (手入力、loans.annual_target)
    display_order: displayOrder,
  };
}

// loans 配列 → 固定費行配列 (created_at 昇順は呼び出し側 API が保証済み)。
// display_order は 0 起点 (描画は配列順だが、他コードとの整合のため採番)。
export function buildFixedCostLines(loans) {
  const arr = Array.isArray(loans) ? loans : [];
  return arr.map((loan, i) => makeEmptyFixedCostLine(loan, i));
}

// ---- Step 2: 年度境界 (暦年マッピング) -----------------------
// 月-of-year m (1-12) が、開始月 startMonth の会計年度 fiscalYear で属する「暦年」を返す。
// ルール: m >= startMonth → fiscalYear / m < startMonth → fiscalYear+1。
//   例) FY=2026, startMonth=4 → m=4..12 は 2026、m=1..3 は 2027。
//   ※ startMonth=1 のとき m は常に >=1 なので全月 fiscalYear を返す
//      (= 暦年=会計年度、Step 2 以前の挙動とビット一致。回帰防止の要)。
export function fiscalMonthCalendarYear(fiscalYear, startMonth, m) {
  const s = Math.max(1, Math.min(12, Number(startMonth) || 1));
  return Number(m) >= s ? fiscalYear : fiscalYear + 1;
}

// ---- Phase E-b: expenses 集計 -------------------------------

// 'YYYY-MM-DD' を local time 0:00 の Date に変換 (UTC 解釈による日付ズレを回避)。
// Step 3f は string 直接比較で済んでいたが、findCycleOfDate は Date 必須のため変換する。
function parseDateLocal(input) {
  if (input instanceof Date) return input;
  if (typeof input !== 'string') return null;
  const parts = input.split('-');
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => Number(p));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

// expenses を月 × カテゴリで集計し Map<categoryId, {1..12} → number> を返す純関数。
//
// 入力:
//   - msd: number | string | null  management_start_day (1-31)。
//                                   null/undefined は素通しで findCycleOfDate に渡し、
//                                   内部 fallback (day 1 = カレンダー月起点) に委譲。
//                                   非 null で 0/NaN/範囲外なら warn + 空 Map。
//   - fiscalYear: number           集計対象の年度。null/NaN は warn + 空 Map。
//   - expenses: array              顧客の expenses 配列 (DB 列名: date, amount, category)。
//                                   非配列は空 Map (静か)。
//
// 防御的ガード (E-b 修正):
//   1. expenses 非配列 → 空 Map 即 return (warn せず)
//   2. msd 非 null で範囲外 → warn + 空 Map。null/undefined は素通し。
//      (Step 3f handleAutoFillLines / BudgetProgressTab と同じセマンティクス:
//       「null = 未設定 = カレンダー月起点 fallback」、cycle.js が normalize)
//   3. fiscalYear 無効 (null/undefined/非数値) → warn + 空 Map
//   4. 各 expense は try/catch でラップ、失敗時は warn + skip (全体クラッシュ防止)
//
// expenses 側の category 列名は DB スキーマ上 `category` (UUID 文字列)、
// 後方互換のため `category_id` も許容。
// Step 2: startMonth を追加。年度境界 (非1月始まり) のとき、expense の暦年と
//   グリッド列 (月-of-year) の暦年が一致するものだけ採用する。
//   startMonth=1 (default) では従来の `cycle.year === fiscalYear` と論理同値。
export function aggregateCellsFromExpenses(msd, fiscalYear, expenses, startMonth = 1) {
  const result = new Map();

  // Guard 1: expenses は配列必須 (loading 中の undefined / null 含む)
  if (!Array.isArray(expenses)) return result;

  // Guard 2: msd null/undefined は素通し (findCycleOfDate 内部で day-1 fallback)。
  // 非 null の場合のみ範囲チェック (0 / NaN / <1 / >31 を弾く)。
  if (msd != null) {
    const msdNum = Number(msd);
    if (!Number.isFinite(msdNum) || msdNum < 1 || msdNum > 31) {
      // eslint-disable-next-line no-console
      console.warn('[aggregateCellsFromExpenses] msd out of range:', msd);
      return result;
    }
  }

  // Guard 3: fiscalYear は有限数のみ受付
  const yearNum = Number(fiscalYear);
  if (fiscalYear == null || !Number.isFinite(yearNum)) {
    // eslint-disable-next-line no-console
    console.warn('[aggregateCellsFromExpenses] invalid fiscalYear, skipping aggregation:', fiscalYear);
    return result;
  }

  for (const e of expenses) {
    // Guard 4: 各 expense を try/catch でラップ、失敗しても全体クラッシュさせない
    try {
      if (!e) continue;
      const categoryId = e.category ?? e.category_id ?? null;
      if (!categoryId) continue;
      const dateObj = parseDateLocal(e.date);
      if (!dateObj) continue;

      // msd は raw 値のまま findCycleOfDate に渡す (内部 normalizeManagementStartDay
      // が string / number / null を吸収、null → day 1 fallback)。
      const cycle = findCycleOfDate(dateObj, msd);
      if (!cycle) continue;

      const monthKey = cycle.month + 1; // 0-indexed → 1-indexed
      // Step 2: この expense の暦年 (cycle.year) が、fiscalYear+startMonth における
      // 列 monthKey の暦年と一致する月のみ採用 (年度境界をまたぐ翌暦年の月も正しく取り込む)。
      // startMonth=1 のとき fiscalMonthCalendarYear は常に yearNum を返すため
      // 旧条件 `cycle.year !== yearNum` と論理同値 (回帰なし)。
      if (fiscalMonthCalendarYear(yearNum, startMonth, monthKey) !== cycle.year) continue;

      const amount = Number(e.amount) || 0;

      let cellsForCat = result.get(categoryId);
      if (!cellsForCat) {
        cellsForCat = {};
        result.set(categoryId, cellsForCat);
      }
      cellsForCat[monthKey] = (cellsForCat[monthKey] || 0) + amount;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[aggregateCellsFromExpenses] skip expense', { expense: e, error: err });
    }
  }

  return result;
}

// ---- Phase E-c: totals 再計算 ---------------------------------

// 全 lines × 12ヶ月で resolveCell を呼んで、月別 / 累計 / 年間合計を返す純関数。
//
// 引数:
//   - lines: row 配列。空配列 / 非配列は空結果。
//   - resolveCell: (line, month) → { value, isOverride } もしくは プリミティブ。
//                  AnnualBudgetTab.jsx 側の closure 関数を引数で受け取る形 (純関数
//                  化のため resolveCell を依存注入)。null/undefined を返したセル
//                  は無視 (合計に影響しない)。
//   - startMonth: 年度開始月 (1-12)、累計の走査開始月 (default 1)。
//
// 戻り値:
//   {
//     monthly:    {1..12 → number | null},  // 月別合計、その月に1件も値が無ければ null
//     cumulative: {1..12 → number | null},  // 年度開始月から running sum
//                                            // (まだ値が無い prefix 月は null)
//     grandTotal: number | null,             // 12ヶ月総合計、全 null なら null
//   }
//
// 仕様 (Phase E-c B + C):
//   - archived 行も合計に含める (resolveCell が値を返す限り)
//   - locked 特殊行は resolveCell が null を返す前提で自然 skip
//   - 各セルの resolveCell エラーは try/catch で skip、全体クラッシュ防止
export function computeTotalsRow(lines, resolveCell, startMonth = 1) {
  const monthly = {};
  for (let m = 1; m <= 12; m++) monthly[m] = null;

  const arr = Array.isArray(lines) ? lines : [];

  // 月別合計を集計
  for (const line of arr) {
    if (!line) continue;
    for (let m = 1; m <= 12; m++) {
      try {
        const cell = typeof resolveCell === 'function' ? resolveCell(line, m) : null;
        // resolveCell の戻り値が { value } 形 or プリミティブの両方を受ける
        const raw = (cell != null && typeof cell === 'object' && 'value' in cell)
          ? cell.value
          : cell;
        if (raw == null) continue;
        const num = Number(raw);
        if (!Number.isFinite(num)) continue;
        monthly[m] = (monthly[m] ?? 0) + num;
      } catch {
        // 個別セル失敗時は skip (全体クラッシュ防止)
      }
    }
  }

  // cumulative: startMonth から running sum
  // - prefix (まだ値が来ていない区間) は null
  // - 一度数値が来たら以降は running を伝播 (null 月は前月までの累計を保持)
  const s = Math.max(1, Math.min(12, Number(startMonth) || 1));
  const order = [];
  for (let i = 0; i < 12; i++) order.push(((s - 1 + i) % 12) + 1);

  const cumulative = {};
  for (let m = 1; m <= 12; m++) cumulative[m] = null;

  let running = null;
  for (const m of order) {
    const v = monthly[m];
    if (v == null) {
      // 既に積み始めていれば直前の running を保持、未開始なら null
      cumulative[m] = running;
    } else {
      running = (running ?? 0) + v;
      cumulative[m] = running;
    }
  }

  // grandTotal: monthly の合計、全 null なら null
  let grandTotal = null;
  for (let m = 1; m <= 12; m++) {
    if (monthly[m] != null) {
      grandTotal = (grandTotal ?? 0) + monthly[m];
    }
  }

  return { monthly, cumulative, grandTotal };
}

// 月 m (1-indexed cycle 月) の経過区分を日付文字列比較で返す ('past' | 'current' | 'future')。
// 期末が今日より前=past、期首が今日より後=future、それ以外=current。
// 案2: AnnualBudgetTab が「将来月セル→予算 / 当月・経過月セル→実測補正」の入力振り分けと
// resolveCell の予算/実測判定に使うため export する。
// Step 2: startMonth を追加。月 m が属する暦年を fiscalMonthCalendarYear で解決してから
//   cycleStart/cycleEnd を計算する (非1月始まりで翌暦年に当たる月も正しく past/current/future
//   判定)。startMonth=1 (default) では cy=year となり従来式とビット一致 (回帰なし)。
export function classifyMonth(year, m, msd, todayStr, startMonth = 1) {
  const cy = fiscalMonthCalendarYear(year, startMonth, m);
  const startStr = toDateStr(cycleStart(cy, m - 1, msd));
  const endStr = toDateStr(cycleEnd(cy, m - 1, msd));
  if (endStr < todayStr) return 'past';
  if (startStr > todayStr) return 'future';
  return 'current';
}

// #2: week_cat_budgets 行配列 → 指定カテゴリの「当月＋将来月の月予算」を導出する純関数。
//   月予算 = その cycle_month の Σ(週) とし、classifyMonth が current または future の月を返す。
//   (過去月は実測表示なので除外。当月は呼び出し側で「実支出が無ければ予算表示」に使う)
//   返り値: { [m(1-12)]: Σ(週) }  (week_cat_budgets に行のある当月・将来月のみ)
//
//   月対応: 繰越票グリッド月 m (= month-of-year 1-12) ↔ week_cat_budgets は
//     row.cycle_month === m かつ row.year === fiscalMonthCalendarYear(fiscalYear, startMonth, m)
//     (年度境界=非1月始まりで翌暦年に当たる月も classifyMonth と同じ暦年解決で一致させる)。
//   固定費・特殊行は対象外 (呼び出し側で row_type==='category' の行にのみ適用すること)。
export function deriveFutureWeekBudgetForCategory(weekCatBudgets, categoryId, { fiscalYear, startMonth = 1, msd, todayStr }) {
  const out = {};
  if (!Array.isArray(weekCatBudgets) || categoryId == null) return out;
  // 1) カテゴリ一致行を cycle_month で Σ(週)。年度の暦年に一致する行だけ採用。
  const byMonth = {};
  for (const r of weekCatBudgets) {
    if (!r || String(r.category_id) !== String(categoryId)) continue;
    const m = Number(r.cycle_month);
    if (!(m >= 1 && m <= 12)) continue;
    const cy = fiscalMonthCalendarYear(fiscalYear, startMonth, m);
    if (Number(r.year) !== cy) continue;
    byMonth[m] = (byMonth[m] || 0) + (Number(r.amount) || 0);
  }
  // 2) 全未確定月 (past + current + future) を採用。
  // タスク⑩ (2026-06-01): 旧仕様の「past 除外」を撤廃。
  //   方針「week_cat_budgets が常にソース」に従い、過去未確定月の Σ週も Map に乗せる。
  //   確定月 (isSettled) は resolveCell の isSettled 分岐で実測 (actuals) 優先になるため、
  //   Map に乗っても無害 (resolveCell まで届かない)。
  //   これにより予算進捗で過去未確定月の週予算を編集 → 繰越票が Σ週 を即時反映するようになる。
  for (const mStr of Object.keys(byMonth)) {
    const m = Number(mStr);
    const cls = classifyMonth(fiscalYear, m, msd, todayStr, startMonth);
    if (cls === 'future' || cls === 'current' || cls === 'past') {
      out[m] = byMonth[m];
    }
  }
  return out;
}

// =============================================================
// Phase A (2026-06-11): 資産シート支出合計 下段 を 支出管理繰越票 monthlyTotals と
//   1 円も違わせないための純関数化。
//
//   方針:
//     - AnnualBudgetTab.jsx の resolveCell (L423-538) を純関数に派生して新規 export。
//     - 既存 resolveCell / computeTotalsRow / その他の関数は無改変。AnnualBudgetTab は
//       1 行も触らない (WIP 7 件保護)。
//     - resolveExpenseCellPure(line, m, ctx, opts) の opts 無指定挙動は
//       resolveCell L423-538 と分岐・値ともビット一致(コピー)。
//     - opts.budgetOnly=true は「全月予算モード」: 確定月でも実測 (kind='actual') を
//       返さず、常に予算経路 (kind='budget') で予算値を返す。資産シートの下段(青)用。
//
//   呼出側必要 context:
//     ctx = { currentYear, msdVal, todayStr, startMonth, settledMonths,
//             weekBudgetByCatMonth (Map<categoryId, {1..12}>),
//             aggregatedCells     (Map<categoryId, {1..12}>) }
//
//   依存:
//     - classifyMonth (本ファイル L562 で既に export 済、内部再利用)
//     - 月キー pick (このファイル module-private、AnnualBudgetTab.jsx L82 と同実装)
// =============================================================

// jsonb の月キーは "1".."12" (文字列) で入る場合と 1..12 (数値) で入る場合の両方を許容。
// AnnualBudgetTab.jsx L77-82 の pick と完全同実装。module-private。
function _pickMonth(obj, key) {
  if (!obj) return undefined;
  if (obj[key] !== undefined) return obj[key];
  if (obj[String(key)] !== undefined) return obj[String(key)];
  return undefined;
}

// resolveCell の純関数版。AnnualBudgetTab.jsx L423-538 のロジック完全コピー (opts 無指定時)。
//   opts.budgetOnly === true のとき: 確定月でも実測 (kind='actual') を返さず、常に予算経路で
//   予算値を返す。固定費は常に固定費分岐 (両モード共通)。
//
//   フォールバック (budgetOnly=true):
//     - 固定費 (row_type='fixed_cost')
//         = monthly_amounts[m] → target_value/12 (Math.round) → monthly_amount (基準額)
//     - カテゴリ (row_type='category' && category_id)
//         = weekBudgetByCatMonth[catId][m] → monthly_overrides[m] → monthly_values[m] → null
//     - 特殊行 (category_id=null)
//         = monthly_budget[m] → null  (直接参照のみ。仕様: 「特殊行 = monthly_budget[m] 直」)
export function resolveExpenseCellPure(line, m, ctx, opts = {}) {
  const {
    currentYear,
    msdVal,
    todayStr,
    startMonth = 1,
    settledMonths = [],
    weekBudgetByCatMonth,
    aggregatedCells,
  } = ctx || {};
  const budgetOnly = opts?.budgetOnly === true;

  if (!line) return { value: null, isOverride: false, isSettled: false, kind: 'none' };

  // 固定費分岐 (両モード共通) — resolveCell と同実装。
  // 2026-06-15: 年間目標 (target_value) / 12 の自動月割りフォールバックを撤去 (admin と同期)。
  //   月セルは「手入力 monthly_amounts[m]」→「基準月額 monthly_amount」の 2 段のみ。
  // 2026-06-15: opts.fixedSettledOnly=true (資産残高繰越票 専用) のとき、
  //   未確定月では固定費を null で返す (= 「支出を入れてないのに残高が減る」を解消)。
  //   既定 (= 横棒バー 等) では従来通り全月で値を返す。admin と同形。
  if (line.row_type === 'fixed_cost') {
    if (opts?.fixedSettledOnly === true) {
      const isSettled = (ctx?.settledMonths || []).includes(m)
        || (ctx?.settledMonths || []).includes(String(m));
      if (!isSettled) {
        return { value: null, isOverride: false, isSettled: false, kind: 'fixed' };
      }
    }
    const ma = line.monthly_amounts;
    const mv = ma ? (ma[m] ?? ma[String(m)]) : null;
    const amt = mv != null ? Number(mv) : (Number(line.monthly_amount) || 0);
    return { value: amt > 0 ? amt : null, isOverride: false, isSettled: false, kind: 'fixed' };
  }

  // ─────────────────────────────────────────────────────
  //  budgetOnly=true: 本来の確定月 (origIsSettled) のカテゴリ行のみ短絡。
  //
  //   非確定月 (future/current/past+!isSettled) は下の既定分岐へ流す。
  //   isSettled 自体は origIsSettled をそのまま使うが、cat 確定月は上の短絡で
  //   bgVal → monthly_values のみを参照するため、既定分岐の isSettled→actVal /
  //   aggregatedCells→liveVal などの実測経路に到達しない。
  //
  //   特殊行・固定費 (両モード共通) はここで捕捉しない:
  //     - 固定費は上で早期 return 済
  //     - 特殊行は既定分岐に流して value は resolveCell と同値、kind は下の tag で
  //       'actual' → 'budget' に置換 ("両モード共通で変わらず" の原則を value 側で守る)
  // ─────────────────────────────────────────────────────
  const origIsSettled = settledMonths.includes(m) || settledMonths.includes(String(m));
  if (budgetOnly && origIsSettled && line.row_type === 'category' && line.category_id) {
    const bgVal = _pickMonth(weekBudgetByCatMonth?.get?.(line.category_id), m);
    if (bgVal != null) return { value: bgVal, isOverride: false, isSettled: false, kind: 'budget' };
    const vVal = _pickMonth(line.monthly_values, m);
    if (vVal != null) return { value: vVal, isOverride: false, isSettled: false, kind: 'budget' };
    return { value: null, isOverride: false, isSettled: false, kind: 'none' };
  }

  // ─────────────────────────────────────────────────────
  //  既定 (opts 無指定) 分岐 — resolveCell L437-537 完全コピー。
  //
  //   budgetOnly 非確定月もこの分岐を通る (isSettled = origIsSettled = false で
  //   resolveCell と同一パスを通る → current の overrides スキップ含む)。
  //   budgetOnly 確定特殊行もここを通り、isSettled 分岐の actVal が返ってくる
  //   (値は default と同じ)。kind は最後の `tag` で 'actual' → 'budget' に置換。
  // ─────────────────────────────────────────────────────
  const isSettled = origIsSettled;
  const cls = classifyMonth(currentYear, m, msdVal, todayStr, startMonth);
  const ovVal = _pickMonth(line.monthly_overrides, m);

  // budgetOnly のとき kind:'actual' → 'budget' に置換する shim (value は無改変)。
  //   'fixed' は固定費の早期 return で既に確定しているためここを通らない。
  const tag = (r) => (budgetOnly && r.kind === 'actual') ? { ...r, kind: 'budget' } : r;

  // 将来月 = 予算 (resolveCell L440-456)
  if (cls === 'future' && !isSettled) {
    const isCat = line.row_type === 'category' && line.category_id;
    const bgVal = isCat
      ? _pickMonth(weekBudgetByCatMonth?.get?.(line.category_id), m)
      : _pickMonth(line.monthly_budget, m);
    if (bgVal != null) return { value: bgVal, isOverride: false, isSettled: false, kind: 'budget' };
    if (ovVal != null) return { value: ovVal, isOverride: true, isSettled: false, kind: 'budget' };
    const vVal = _pickMonth(line.monthly_values, m);
    if (vVal != null) return { value: vVal, isOverride: false, isSettled: false, kind: 'budget' };
    return { value: null, isOverride: false, isSettled: false, kind: 'budget' };
  }

  // カテゴリ × 当月 未確定 = 予算 (resolveCell L466-479)
  if (line.row_type === 'category' && line.category_id
      && cls === 'current' && !isSettled) {
    const bgVal = _pickMonth(weekBudgetByCatMonth?.get?.(line.category_id), m);
    if (bgVal != null) {
      return { value: bgVal, isOverride: false, isSettled: false, kind: 'budget' };
    }
    const vVal = _pickMonth(line.monthly_values, m);
    if (vVal != null) {
      return { value: vVal, isOverride: false, isSettled: false, kind: 'budget' };
    }
    return { value: null, isOverride: false, isSettled: false, kind: 'budget' };
  }

  // カテゴリ × 過去 未確定 = 予算 (週予算 Σ 最優先、resolveCell L488-495)
  //   bgVal=null は下のフォールバック (ovVal/aggregatedCells/monthly_values) へ落とす。
  if (line.row_type === 'category' && line.category_id
      && cls === 'past' && !isSettled) {
    const bgVal = _pickMonth(weekBudgetByCatMonth?.get?.(line.category_id), m);
    if (bgVal != null) {
      return { value: bgVal, isOverride: false, isSettled: false, kind: 'budget' };
    }
  }

  // 確定月 (settled) = actuals 最優先 (resolveCell L508-513)
  if (isSettled) {
    const actVal = _pickMonth(line.monthly_actuals, m);
    if (actVal != null) return tag({ value: actVal, isOverride: false, isSettled: true, kind: 'actual' });
    if (ovVal != null) return { value: ovVal, isOverride: false, isSettled: true, kind: 'budget' };
  }

  // override (実測補正 or 過去未確定の予算ピン留め) (resolveCell L518-528)
  if (ovVal != null) {
    if (cls === 'past' && !isSettled) {
      return { value: ovVal, isOverride: false, isSettled: false, kind: 'budget' };
    }
    return tag({ value: ovVal, isOverride: true, isSettled, kind: 'actual' });
  }
  if (line.row_type === 'category' && line.category_id) {
    const aggForCat = aggregatedCells?.get?.(line.category_id) ?? null;
    const liveVal = _pickMonth(aggForCat, m);
    if (liveVal != null) return tag({ value: liveVal, isOverride: false, isSettled, kind: 'actual' });
  }
  // past かつ未確定で実支出ログが無い月 = 按分予算 (monthly_values) を着地見込みとして表示
  if (!isSettled && cls === 'past') {
    const budgetVal = _pickMonth(line.monthly_values, m);
    if (budgetVal != null) {
      return { value: budgetVal, isOverride: false, isSettled: false, kind: 'budget' };
    }
  }
  return { value: null, isOverride: false, isSettled, kind: 'none' };
}

// 月別予算縦計を 12 ヶ月分まとめて返す薄ラッパ。
// 既存 computeTotalsRow (関数注入形・無改変) に resolveExpenseCellPure を注入する形で実装。
//   戻り値 shape:
//     { monthly: {1..12 → number|null}, cumulative: {1..12 → number|null}, grandTotal: number|null }
//   - cumulative は startMonth 起点 fiscal 順 running sum (computeTotalsRow と完全同形)。
export function computeMonthlyExpenseBudgetTotals(lines, ctx, startMonth = 1, opts = {}) {
  const resolver = (line, m) => resolveExpenseCellPure(line, m, ctx, opts);
  return computeTotalsRow(lines, resolver, startMonth);
}
