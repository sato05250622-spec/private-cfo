import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/budgets';

// =============================================================
// 顧客自身の budgets / week_budgets / week_cat_budgets を
// 「行配列のまま (snake_case)」露出する read-only hook。
//
// 用途:
//   AssetSheetViewer (Phase D-E) が deriveFutureWeekBudgetForCategory に
//   week_cat_budgets 行配列を直接投入するため、Record<key,number> 形の
//   既存 useBudgets では shape が合わない。本 hook は別経路として新設し、
//   useBudgets は 1 文字も触らない。
//
// 戻り値 shape:
//   { weekCatBudgetRows: Row[],  // [{client_id, year, cycle_month, week_num,
//                                     category_id, amount, ...}, ...]
//     budgetRows:        Row[],
//     weekBudgetRows:    Row[],
//     loading: boolean, error: Error|null, refetch: () => Promise<void> }
//
// 動作:
//   - userId 変化で再取得 (useAuth().user.id)。
//   - focus / visibility=visible 復帰時に自動 refetch (useAnnualBudgets と同方針)。
//     admin が予算を編集 → 顧客がタブに戻った瞬間に最新化される。
//   - mutator なし。書込みは既存 useBudgets / admin 経路に委譲。
//   - realtime/postgres_changes は使用しない (鉄の掟)。
// =============================================================
export function useClientBudgetRows() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [budgetRows, setBudgetRows] = useState([]);
  const [weekBudgetRows, setWeekBudgetRows] = useState([]);
  const [weekCatBudgetRows, setWeekCatBudgetRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setBudgetRows([]);
      setWeekBudgetRows([]);
      setWeekCatBudgetRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.listBudgets(userId);
      // listBudgets は select('*') の raw rows をそのまま返す。
      // 変換せず行配列のまま 3 state に分配。
      setBudgetRows(Array.isArray(data?.budgets) ? data.budgets : []);
      setWeekBudgetRows(Array.isArray(data?.weekBudgets) ? data.weekBudgets : []);
      setWeekCatBudgetRows(Array.isArray(data?.weekCatBudgets) ? data.weekCatBudgets : []);
      setError(null);
    } catch (e) {
      console.error('[useClientBudgetRows]', e);
      setError(e);
      // 失敗時は空配列に戻して描画側のクラッシュを防ぐ (viewer はガード前提)。
      setBudgetRows([]);
      setWeekBudgetRows([]);
      setWeekCatBudgetRows([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  // タブ復帰時の最新化 (useAnnualBudgets.js:73-83 と同パターン)。
  // admin が week_cat_budgets を編集後、顧客がタブに戻ったときに反映される。
  useEffect(() => {
    if (!userId) return undefined;
    const onFocus = () => { refetch(); };
    const onVisible = () => { if (document.visibilityState === 'visible') refetch(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, refetch]);

  return {
    weekCatBudgetRows,
    budgetRows,
    weekBudgetRows,
    loading,
    error,
    refetch,
  };
}
