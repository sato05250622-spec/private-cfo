// =============================================================
// 報酬日サイクル(reward-day cycle)ユーティリティ
// -------------------------------------------------------------
// 報酬日が設定されていればその日を毎月の起点として「カレンダー月」ではなく
// 「サイクル」で日付範囲を扱う。未設定なら 1 日起点 = 従来カレンダー月と等価。
//
// 永続化:今は localStorage('cfo_rewardDay') に保存。
// 明日 Supabase profiles.reward_day 列に β 移行予定のため、
// 呼び出し側は必ず getRewardDay() / setRewardDay() 経由にする。
// 実装の差し替えはこのファイル内だけで完結するよう設計した。
//
// 値の扱い:
//  - 数値 1〜31     → その日(短月で日数が足りなければ末日へ clamp)
//  - 文字列 "末"    → その月の末日
//  - null / 空      → 1 日起点(未設定扱い)
// =============================================================

import { toDateStr } from '@shared/format';

const REWARD_DAY_KEY = 'cfo_rewardDay';

// 生値を { null | number(1-31) | '末' } に正規化。不正値は null を返す。
function normalizeRewardDay(raw) {
  if (raw == null) return null;
  if (raw === '末') return '末';
  const s = String(raw).trim();
  if (s === '') return null;
  if (s === '末') return '末';
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  return null;
}

export function getRewardDay() {
  if (typeof window === 'undefined') return null;
  try { return normalizeRewardDay(window.localStorage.getItem(REWARD_DAY_KEY)); }
  catch { return null; }
}

export function setRewardDay(value) {
  if (typeof window === 'undefined') return;
  try {
    const v = normalizeRewardDay(value);
    if (v == null) window.localStorage.removeItem(REWARD_DAY_KEY);
    else window.localStorage.setItem(REWARD_DAY_KEY, String(v));
  } catch {}
}

// 指定カレンダー月(year, month 0-indexed)のサイクル開始日。
export function cycleStart(year, month, rewardDay) {
  const rd = normalizeRewardDay(rewardDay);
  if (rd == null) return new Date(year, month, 1);
  if (rd === '末') return new Date(year, month + 1, 0);
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(rd, lastDay));
}

// サイクル終了日(= 翌月サイクル開始日 - 1 日)。
export function cycleEnd(year, month, rewardDay) {
  const next = cycleStart(year, month + 1, rewardDay);
  next.setDate(next.getDate() - 1);
  return next;
}

// 指定日が属するサイクルの { year, month, startDate, endDate }。
// month は「起点日の属するカレンダー月(0-indexed)」。
// 既存 weekCatBudgets / budgets キーの年月部分にこの year/month を使う。
export function findCycleOfDate(date, rewardDay) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const start = cycleStart(y, m, rewardDay);
  if (date >= start) {
    return { year: y, month: m, startDate: start, endDate: cycleEnd(y, m, rewardDay) };
  }
  const prev = cycleStart(y, m - 1, rewardDay);
  return {
    year: prev.getFullYear(),
    month: prev.getMonth(),
    startDate: prev,
    endDate: cycleEnd(prev.getFullYear(), prev.getMonth(), rewardDay),
  };
}

// サイクル内の週リスト。常に 4 週固定で、第 4 週がサイクル末日まで吸収する。
// - 報酬日未設定(rd==null):カレンダー月の 1 日 起点、第 4 週が月末まで吸収。
//                              28〜31 日月で常に 4 週、短い 2 月でも 4 週(第4週は1日でも残れば成立)。
// - 報酬日設定済み:サイクル起点から 7 日刻みで 3 週、第 4 週は cycleEnd まで(7〜10 日)。
//   例 5/25 起点 → 第1週 5/25-5/31、第2週 6/1-6/7、第3週 6/8-6/14、第4週 6/15-6/24(10 日)。
// 返り値: [{ weekNum, weekKey, startDate, endDate, startStr(表示用 M/D), endStr }]
export function weeksInCycle(year, month, rewardDay) {
  const start = cycleStart(year, month, rewardDay);
  const end = cycleEnd(year, month, rewardDay);
  const result = [];
  for (let wn = 1; wn <= 4; wn++) {
    const wStart = new Date(start);
    wStart.setDate(wStart.getDate() + (wn - 1) * 7);
    // 第 1〜3 週は 7 日固定、第 4 週は cycleEnd まで(可変長)。
    let wEnd;
    if (wn === 4) {
      wEnd = new Date(end);
    } else {
      wEnd = new Date(wStart);
      wEnd.setDate(wEnd.getDate() + 6);
    }
    // セーフガード:cycle が極端に短い(<22 日想定外)場合に week start が end を超えたら打ち切り。
    if (wStart > end) break;
    if (wEnd > end) wEnd.setTime(end.getTime());
    result.push({
      weekNum: wn,
      weekKey: `${year}-${month + 1}-w${wn}`,
      startDate: wStart,
      endDate: wEnd,
      startStr: `${wStart.getMonth() + 1}/${wStart.getDate()}`,
      endStr: `${wEnd.getMonth() + 1}/${wEnd.getDate()}`,
    });
  }
  return result;
}

// 指定日がサイクル内の第何週か(1..N)。見つからない場合は 1。
export function weekInCycle(date, rewardDay) {
  const { year, month } = findCycleOfDate(date, rewardDay);
  const weeks = weeksInCycle(year, month, rewardDay);
  const dStr = toDateStr(date);
  for (const w of weeks) {
    if (dStr >= toDateStr(w.startDate) && dStr <= toDateStr(w.endDate)) return w.weekNum;
  }
  return 1;
}

// サイクルラベル(画面ヘッダ用)
// - 報酬日未設定:"2026年5月"(従来の fmtMonth と同等)
// - 報酬日設定済み:"2026年5月(5月25日-6月24日)"
export function cycleLabel(year, month, rewardDay) {
  const rd = normalizeRewardDay(rewardDay);
  const base = `${year}年${month + 1}月`;
  if (rd == null) return base;
  const s = cycleStart(year, month, rewardDay);
  const e = cycleEnd(year, month, rewardDay);
  return `${base}(${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日)`;
}

// 指定日(または日付文字列)が、指定年月のサイクル範囲内かを判定。
export function isInCycle(dateOrStr, year, month, rewardDay) {
  const dStr = typeof dateOrStr === 'string' ? dateOrStr : toDateStr(dateOrStr);
  const s = toDateStr(cycleStart(year, month, rewardDay));
  const e = toDateStr(cycleEnd(year, month, rewardDay));
  return dStr >= s && dStr <= e;
}
