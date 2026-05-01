// =============================================================
// localStorage の budgets / weekBudgets / weekCatBudgets を
// Supabase の budgets / week_budgets / week_cat_budgets テーブルへ
// 1 回限り移行する。
//
// AuthGate ログイン後、App.jsx の useEffect から呼ぶ。
// 冪等: cfo_budgetsMigrated === "1" で二重実行防止 + idempotent upsert。
//
// データ保全方針 (B-3a 着手前の既存ユーザーが対象、4-30 incident との関係上重要):
//   - DB read 失敗時は abort し、フラグも立てない (次回ログイン時に再試行)
//   - DB に既に行があるキーは skip (incident 後の手動再入力を守る)
//   - ループ中の upsert 失敗は console.warn で続行 (migratePaymentsLoans と同方針)
//   - localStorage は削除しない (rollback 用)
//   - 0 円エントリも保存 (useBudgets.js L102 の zero-budget category 対応と整合)
//
// キー形式 (useBudgets.js L20-22, L43-45 と同一):
//   budgets:          '${year}-${month1}-${categoryId}'                 例 '2026-4-entertainment'
//   week_budgets:     '${year}-${month1}-w${weekNum}'                   例 '2026-4-w1'
//   week_cat_budgets: '${year}-${month1}-w${weekNum}_${categoryId}'     例 '2026-4-w1_custom_abc-def'
// =============================================================
import * as budgetsApi from './api/budgets';

const FLAG_KEY     = 'cfo_budgetsMigrated';
const BUDGETS_KEY  = 'cfo_budgets';
const WEEK_KEY     = 'cfo_weekBudgets';
const WEEK_CAT_KEY = 'cfo_weekCatBudgets';

const BUDGET_KEY_RE   = /^(\d{4})-(\d{1,2})-(.+)$/;
const WEEK_KEY_RE     = /^(\d{4})-(\d{1,2})-w([1-4])$/;
const WEEK_CAT_KEY_RE = /^(\d{4})-(\d{1,2})-w([1-4])_(.+)$/;

// DB row → アプリ側キー文字列 (useBudgets.js と同一形式、skip 判定用 Set のキー)
const dbBudgetKey  = (r) => `${r.year}-${r.cycle_month}-${r.category_id}`;
const dbWeekKey    = (r) => `${r.year}-${r.cycle_month}-w${r.week_num}`;
const dbWeekCatKey = (r) => `${r.year}-${r.cycle_month}-w${r.week_num}_${r.category_id}`;

function readLocalRecord(key) {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    console.warn(`[migrate-budgets] localStorage parse failed for ${key}, treating as empty`, e);
    return {};
  }
}

function normalizeAmount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

// 戻り値:
//   { skipped: true, reason }
//   { skipped: false, reason?: 'no-localstorage-data',
//     bWritten, bSkipped, bFailed,
//     wWritten, wSkipped, wFailed,
//     wcWritten, wcSkipped, wcFailed }
export async function migrateBudgets(userId) {
  if (!userId) return { skipped: true, reason: 'no-userId' };
  if (typeof window === 'undefined') return { skipped: true, reason: 'no-window' };
  if (window.localStorage.getItem(FLAG_KEY) === '1') {
    return { skipped: true, reason: 'already-migrated' };
  }

  const localBudgets = readLocalRecord(BUDGETS_KEY);
  const localWeek    = readLocalRecord(WEEK_KEY);
  const localWeekCat = readLocalRecord(WEEK_CAT_KEY);

  const totalLocal =
    Object.keys(localBudgets).length +
    Object.keys(localWeek).length +
    Object.keys(localWeekCat).length;

  // localStorage に何も無い既存ユーザー (or 新規) はフラグだけ立てて短絡。
  // DB read を呼ばないので「DB read 失敗で abort」リスクも無い。
  if (totalLocal === 0) {
    window.localStorage.setItem(FLAG_KEY, '1');
    return { skipped: false, reason: 'no-localstorage-data',
      bWritten: 0, bSkipped: 0, bFailed: 0,
      wWritten: 0, wSkipped: 0, wFailed: 0,
      wcWritten: 0, wcSkipped: 0, wcFailed: 0 };
  }

  // DB 既存行を 1 RTT で取得して Set 化。
  // ここで失敗したらフラグを立てずに abort (誤って「空 DB」判定して上書きしないため)。
  let dbBudgetSet, dbWeekSet, dbWeekCatSet;
  try {
    const db = await budgetsApi.listBudgets(userId);
    dbBudgetSet  = new Set(db.budgets.map(dbBudgetKey));
    dbWeekSet    = new Set(db.weekBudgets.map(dbWeekKey));
    dbWeekCatSet = new Set(db.weekCatBudgets.map(dbWeekCatKey));
  } catch (e) {
    console.warn('[migrate-budgets] listBudgets failed, aborting migration (flag NOT set, will retry next login)', e);
    return { skipped: true, reason: 'db-read-failed' };
  }

  // ---- budgets (月予算) ------------------------------------------
  let bWritten = 0, bSkipped = 0, bFailed = 0;
  for (const [k, v] of Object.entries(localBudgets)) {
    const m = BUDGET_KEY_RE.exec(k);
    if (!m) { console.warn('[migrate-budgets] invalid budget key', k); bFailed++; continue; }
    if (dbBudgetSet.has(k)) { bSkipped++; continue; }
    const amount = normalizeAmount(v);
    if (amount === null) { console.warn('[migrate-budgets] invalid budget amount', k, v); bFailed++; continue; }
    try {
      await budgetsApi.upsertBudget(userId, {
        year: +m[1], cycleMonth: +m[2], categoryId: m[3], amount,
      });
      bWritten++;
    } catch (e) {
      console.warn('[migrate-budgets] upsertBudget failed', k, e);
      bFailed++;
    }
  }

  // ---- week_budgets (週予算 / 全カテゴリ合計) --------------------
  let wWritten = 0, wSkipped = 0, wFailed = 0;
  for (const [k, v] of Object.entries(localWeek)) {
    const m = WEEK_KEY_RE.exec(k);
    if (!m) { console.warn('[migrate-budgets] invalid week_budget key', k); wFailed++; continue; }
    if (dbWeekSet.has(k)) { wSkipped++; continue; }
    const amount = normalizeAmount(v);
    if (amount === null) { console.warn('[migrate-budgets] invalid week_budget amount', k, v); wFailed++; continue; }
    try {
      await budgetsApi.upsertWeekBudget(userId, {
        year: +m[1], cycleMonth: +m[2], weekNum: +m[3], amount,
      });
      wWritten++;
    } catch (e) {
      console.warn('[migrate-budgets] upsertWeekBudget failed', k, e);
      wFailed++;
    }
  }

  // ---- week_cat_budgets (週 × カテゴリ) ---------------------------
  // WEEK_KEY_RE と WEEK_CAT_KEY_RE は前者が後者の prefix にマッチしうるため、
  // localWeekCat 側のループでは WEEK_CAT_KEY_RE で誤マッチを排除 (アンダースコア +
  // categoryId が必須)。一方 localWeek 側は WEEK_KEY_RE が末尾アンカー付きなので、
  // 誤って 'w1_xxx' を week キーとして受けることはない。
  let wcWritten = 0, wcSkipped = 0, wcFailed = 0;
  for (const [k, v] of Object.entries(localWeekCat)) {
    const m = WEEK_CAT_KEY_RE.exec(k);
    if (!m) { console.warn('[migrate-budgets] invalid week_cat_budget key', k); wcFailed++; continue; }
    if (dbWeekCatSet.has(k)) { wcSkipped++; continue; }
    const amount = normalizeAmount(v);
    if (amount === null) { console.warn('[migrate-budgets] invalid week_cat_budget amount', k, v); wcFailed++; continue; }
    try {
      await budgetsApi.upsertWeekCatBudget(userId, {
        year: +m[1], cycleMonth: +m[2], weekNum: +m[3], categoryId: m[4], amount,
      });
      wcWritten++;
    } catch (e) {
      console.warn('[migrate-budgets] upsertWeekCatBudget failed', k, e);
      wcFailed++;
    }
  }

  // 全ループ完了 (途中失敗があっても記録済) でフラグセット。
  // フラグを立てないと次回ログイン毎に listBudgets + 全件 skip ループが走るため、
  // ここで idempotent 化する。再 migration したい場合は cfo_budgetsMigrated を
  // 手動削除する運用 (rollback 用に localStorage 原本も残置済み)。
  window.localStorage.setItem(FLAG_KEY, '1');

  const summary = {
    localBudgets: Object.keys(localBudgets).length,
    localWeek:    Object.keys(localWeek).length,
    localWeekCat: Object.keys(localWeekCat).length,
    bWritten, bSkipped, bFailed,
    wWritten, wSkipped, wFailed,
    wcWritten, wcSkipped, wcFailed,
  };
  console.log('[migrate-budgets] done', summary);

  return { skipped: false, ...summary };
}
