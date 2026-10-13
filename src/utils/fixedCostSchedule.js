// =============================================================
// 固定費 (loans) の月ごとの金額 (2026-10-14 v5)。本部・顧客アプリで同一内容。
//   loans.start_month   開始月 (月初日 'YYYY-MM-DD')。これより前の月は 0
//   loans.end_month     終了月 (月初日)。空 = 継続中。これより後の月は 0
//   loans.amount_history [{ from: 'YYYY-MM', amount }] 金額の履歴。各月は「その月以前で最後の履歴」の金額
//   loans.monthly_amounts { "1".."12": 額 } 繰越票の月別上書き (年の区別なし・従来機能)。期間内の月だけ効かせる
//   start_month が空の行 (未移行・freeder0324 等) は従来どおり全月に表示する。
//   snake_case (DB 行) と camelCase (顧客アプリの rowToItem) の両方を受け付ける。
// =============================================================

const pad = (n) => String(n).padStart(2, "0");
export const ymKey = (year, month) => `${year}-${pad(month)}`;
const toYm = (v) => (v ? String(v).slice(0, 7) : "");

export function loanSchedule(loan) {
  const l = loan || {};
  const history = Array.isArray(l.amount_history ?? l.amountHistory) ? (l.amount_history ?? l.amountHistory) : [];
  return {
    start: toYm(l.start_month ?? l.startMonth),
    end: toYm(l.end_month ?? l.endMonth),
    history: history
      .filter((h) => h && /^\d{4}-\d{2}$/.test(String(h.from || "")) && Number.isFinite(Number(h.amount)))
      .map((h) => ({ from: String(h.from), amount: Number(h.amount) }))
      .sort((a, b) => a.from.localeCompare(b.from)),
    amount: Number(l.amount) || 0,
    overrides: l.monthly_amounts ?? l.monthlyAmounts ?? null,
  };
}

// その月 (暦年 year・月 month 1-12) に固定費が有効か
export function loanActiveIn(loan, year, month) {
  const s = loanSchedule(loan), ym = ymKey(year, month);
  if (s.start && ym < s.start) return false;
  if (s.end && ym > s.end) return false;
  return true;
}

// その月の基準額 (月別上書きを除く): 金額の履歴 → 現在の金額
export function loanBaseAmountFor(loan, year, month) {
  const s = loanSchedule(loan), ym = ymKey(year, month);
  let amt = s.amount;
  if (s.history.length) {
    const hit = s.history.filter((h) => h.from <= ym);
    amt = hit.length ? hit[hit.length - 1].amount : s.history[0].amount;
  }
  return amt;
}

// その月の固定費の金額 (期間外は 0)。月別上書き (monthly_amounts[month]) があれば優先
export function fixedCostAmount(loan, year, month) {
  if (!loanActiveIn(loan, year, month)) return 0;
  const s = loanSchedule(loan);
  const ov = s.overrides ? (s.overrides[month] ?? s.overrides[String(month)]) : null;
  if (ov != null && ov !== "") return Number(ov) || 0;
  return loanBaseAmountFor(loan, year, month);
}

// 年度 (fiscalYear・開始月 startMonth) の 12 か月分 { 1..12: 額 }。繰越票の固定費行に使う
export function fiscalYearAmounts(loan, fiscalYear, startMonth = 1) {
  const out = {};
  for (let m = 1; m <= 12; m++) {
    const y = m >= startMonth ? fiscalYear : fiscalYear + 1;
    out[m] = fixedCostAmount(loan, y, m);
  }
  return out;
}

// 金額変更: 適用開始月 fromYm から newAmount にする履歴を作る (同じ月の履歴は置き換え)
export function withAmountChange(loan, fromYm, newAmount) {
  const s = loanSchedule(loan);
  const base = s.history.length ? s.history : (s.start ? [{ from: s.start, amount: s.amount }] : []);
  const next = base.filter((h) => h.from !== fromYm).concat([{ from: fromYm, amount: Number(newAmount) || 0 }]);
  return next.sort((a, b) => a.from.localeCompare(b.from));
}

// 今月 (JST) の 'YYYY-MM'
export function currentYm(now = new Date()) {
  const j = new Date(now.getTime() + 9 * 3600 * 1000);
  return `${j.getUTCFullYear()}-${pad(j.getUTCMonth() + 1)}`;
}
