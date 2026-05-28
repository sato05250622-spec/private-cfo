import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/investmentIncomes';

// =============================================================
// 指定対象者 (target_id) への入金明細を read-only で取得する hook (顧客アプリ)。
// 構造は useExpenses.js / useInvestmentTargets.js に準拠。
// 戻り値: { incomes, loading, error, refetch }
// =============================================================
export function useInvestmentIncomes(userId, targetId) {
  const [incomes, setIncomes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId || !targetId) {
      setIncomes([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listIncomes(userId, targetId);
      setIncomes(rows);
      setError(null);
    } catch (e) {
      console.error('[useInvestmentIncomes]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId, targetId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { incomes, loading, error, refetch };
}
