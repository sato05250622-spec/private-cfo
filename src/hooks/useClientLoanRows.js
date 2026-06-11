import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/loans';

// =============================================================
// 顧客自身の loans を「snake_case raw rows そのまま」露出する read-only hook。
//
// 用途:
//   AssetSheetViewer (Phase D-E) が buildFixedCostLines(loans) に DB raw rows を
//   直接投入するため。既存 useLoans は camelCase 変換 (monthlyAmounts /
//   annualTarget) を行うので shape が合わない。本 hook は別経路として新設し、
//   useLoans は 1 文字も触らない。
//
// 戻り値 shape:
//   { loanRows: Row[],   // [{id, label, amount, bank, withdrawal_day, pm_id,
//                            monthly_amounts, annual_target, created_at, ...}, ...]
//                        // (api.listLoans が select('*') の raw rows を created_at ASC で返す)
//     loading: boolean, error: Error|null, refetch: () => Promise<void> }
//
// 動作:
//   - userId 変化で再取得 (useAuth().user.id)。
//   - focus / visibility=visible 復帰時に自動 refetch (useClientBudgetRows / useAnnualBudgets と同方針)。
//     admin が固定費を編集 → 顧客がタブに戻った瞬間に最新化される。
//   - mutator なし。書込みは既存 useLoans / admin 経路に委譲。
//   - realtime/postgres_changes は使用しない (鉄の掟)。
// =============================================================
export function useClientLoanRows() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [loanRows, setLoanRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setLoanRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listLoans(userId);
      // listLoans は select('*') の raw rows を created_at ASC で返す。
      // 変換せず snake_case のまま state に保持。
      setLoanRows(Array.isArray(rows) ? rows : []);
      setError(null);
    } catch (e) {
      console.error('[useClientLoanRows]', e);
      setError(e);
      // 失敗時は空配列に戻して描画側のクラッシュを防ぐ (viewer はガード前提)。
      setLoanRows([]);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  // タブ復帰時の最新化 (useClientBudgetRows と同パターン)。
  // admin が固定費を編集後、顧客がタブに戻ったときに反映される。
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
    loanRows,
    loading,
    error,
    refetch,
  };
}
