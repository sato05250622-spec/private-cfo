// =============================================================
// 管理スタート日サイクル(management-start-day cycle)ユーティリティ
// -------------------------------------------------------------
// 管理スタート日が設定されていればその日を毎月の起点として「カレンダー月」ではなく
// 「サイクル」で日付範囲を扱う。未設定なら 1 日起点 = 従来カレンダー月と等価。
//
// 旧 rewardDay(報酬日) はサイクル切替スイッチを兼任していたが、Phase 1 で
// その機能を managementStartDay に丸ごと移植。報酬日は「ただの記録」へ降格。
//
// 永続化:localStorage('cfo_managementStartDay')
// 明日 Supabase profiles.management_start_day 列に β 移行予定のため、
// 呼び出し側は必ず getManagementStartDay() / setManagementStartDay() 経由にする。
//
// 値の扱い:
//  - 数値 1〜31  → その日(短月で日数が足りなければ末日へ clamp)
//  - null / 空   → 1 日起点(未設定扱い、従来カレンダー月と等価)
//  ※ 旧 "末" 対応は削除済み(管理スタート日は 1-31 の数値のみ受け付ける)
// =============================================================

import { toDateStr } from '@shared/format';

const MANAGEMENT_START_DAY_KEY = 'cfo_managementStartDay';

// 生値を { null | number(1-31) } に正規化。不正値や "末" 等は null を返す。
function normalizeManagementStartDay(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  return null;
}

export function getManagementStartDay() {
  if (typeof window === 'undefined') return null;
  try { return normalizeManagementStartDay(window.localStorage.getItem(MANAGEMENT_START_DAY_KEY)); }
  catch { return null; }
}

export function setManagementStartDay(value) {
  if (typeof window === 'undefined') return;
  try {
    const v = normalizeManagementStartDay(value);
    if (v == null) window.localStorage.removeItem(MANAGEMENT_START_DAY_KEY);
    else window.localStorage.setItem(MANAGEMENT_START_DAY_KEY, String(v));
  } catch {}
}

// 指定カレンダー月(year, month 0-indexed)のサイクル開始日。
export function cycleStart(year, month, managementStartDay) {
  const md = normalizeManagementStartDay(managementStartDay);
  if (md == null) return new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(md, lastDay));
}

// サイクル終了日(= 翌月サイクル開始日 - 1 日)。
export function cycleEnd(year, month, managementStartDay) {
  const next = cycleStart(year, month + 1, managementStartDay);
  next.setDate(next.getDate() - 1);
  return next;
}

// 指定日が属するサイクルの { year, month, startDate, endDate }。
// month は「起点日の属するカレンダー月(0-indexed)」。
// 既存 weekCatBudgets / budgets キーの年月部分にこの year/month を使う。
export function findCycleOfDate(date, managementStartDay) {
  const y = date.getFullYear();
  const m = date.getMonth();
  const start = cycleStart(y, m, managementStartDay);
  if (date >= start) {
    return { year: y, month: m, startDate: start, endDate: cycleEnd(y, m, managementStartDay) };
  }
  const prev = cycleStart(y, m - 1, managementStartDay);
  return {
    year: prev.getFullYear(),
    month: prev.getMonth(),
    startDate: prev,
    endDate: cycleEnd(prev.getFullYear(), prev.getMonth(), managementStartDay),
  };
}

// サイクル内の週リスト。常に 4 週固定で、第 4 週がサイクル末日まで吸収する。
// - 未設定:カレンダー月の 1 日 起点、第 4 週が月末まで吸収。
// - 設定済み:サイクル起点から 7 日刻みで 3 週、第 4 週は cycleEnd まで(7〜10 日)。
//   例 25 起点 → 第1週 25-31、第2週 1-7、第3週 8-14、第4週 15-24(10 日)。
// 返り値: [{ weekNum, weekKey, startDate, endDate, startStr(表示用 M/D), endStr }]
export function weeksInCycle(year, month, managementStartDay) {
  const start = cycleStart(year, month, managementStartDay);
  const end = cycleEnd(year, month, managementStartDay);
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

// 指定日がサイクル内の第何週か(1..4)。見つからない場合は 1。
export function weekInCycle(date, managementStartDay) {
  const { year, month } = findCycleOfDate(date, managementStartDay);
  const weeks = weeksInCycle(year, month, managementStartDay);
  const dStr = toDateStr(date);
  for (const w of weeks) {
    if (dStr >= toDateStr(w.startDate) && dStr <= toDateStr(w.endDate)) return w.weekNum;
  }
  return 1;
}

// サイクルラベル(画面ヘッダ用)
// - 未設定:"2026年5月"(従来の fmtMonth と同等)
// - 設定済み:"2026年5月(5月25日-6月24日)"
export function cycleLabel(year, month, managementStartDay) {
  const md = normalizeManagementStartDay(managementStartDay);
  const base = `${year}年${month + 1}月`;
  if (md == null) return base;
  const s = cycleStart(year, month, managementStartDay);
  const e = cycleEnd(year, month, managementStartDay);
  return `${base}(${s.getMonth() + 1}月${s.getDate()}日-${e.getMonth() + 1}月${e.getDate()}日)`;
}

// 指定日(または日付文字列)が、指定年月のサイクル範囲内かを判定。
export function isInCycle(dateOrStr, year, month, managementStartDay) {
  const dStr = typeof dateOrStr === 'string' ? dateOrStr : toDateStr(dateOrStr);
  const s = toDateStr(cycleStart(year, month, managementStartDay));
  const e = toDateStr(cycleEnd(year, month, managementStartDay));
  return dStr >= s && dStr <= e;
}

// =============================================================
// 報酬日リスト(Phase 2):複数登録可能な「ただの記録」
// -------------------------------------------------------------
// localStorage('cfo_rewardDays') に number[] を JSON で保存。
// 値は 1-31 の整数のみ受付。重複は自動で排除。順序は登録順を維持。
// サイクル切替には一切影響しない(Phase 1 で managementStartDay へ完全移植済み)。
// =============================================================

const REWARD_DAYS_KEY = 'cfo_rewardDays';

// 1-31 の整数 / null に正規化。文字列・数値どちらも受け付ける(チップ追加時 / 配列読み戻し時)。
function normalizeDayValue(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') {
    return Number.isInteger(raw) && raw >= 1 && raw <= 31 ? raw : null;
  }
  const s = String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 31 ? n : null;
}

export function getRewardDays() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(REWARD_DAYS_KEY);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 不正値除去 + 重複排除しつつ登録順を維持
    const seen = new Set();
    const result = [];
    for (const v of parsed) {
      const n = normalizeDayValue(v);
      if (n != null && !seen.has(n)) {
        seen.add(n);
        result.push(n);
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function setRewardDays(arr) {
  if (typeof window === 'undefined') return;
  try {
    if (!Array.isArray(arr) || arr.length === 0) {
      window.localStorage.removeItem(REWARD_DAYS_KEY);
      return;
    }
    const seen = new Set();
    const cleaned = [];
    for (const v of arr) {
      const n = normalizeDayValue(v);
      if (n != null && !seen.has(n)) {
        seen.add(n);
        cleaned.push(n);
      }
    }
    if (cleaned.length === 0) {
      window.localStorage.removeItem(REWARD_DAYS_KEY);
    } else {
      window.localStorage.setItem(REWARD_DAYS_KEY, JSON.stringify(cleaned));
    }
  } catch {}
}

// 単一値を追加。重複なら既存リストをそのまま返す。返り値は最新リスト。
export function addRewardDay(value) {
  const n = normalizeDayValue(value);
  const current = getRewardDays();
  if (n == null) return current;
  if (current.includes(n)) return current;
  const next = [...current, n];
  setRewardDays(next);
  return next;
}

// 単一値を削除。返り値は最新リスト。
export function removeRewardDay(value) {
  const n = normalizeDayValue(value);
  const current = getRewardDays();
  if (n == null) return current;
  const next = current.filter(d => d !== n);
  setRewardDays(next);
  return next;
}
