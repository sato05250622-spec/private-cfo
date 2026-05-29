import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/investmentTargets';

// =============================================================
// 投資対象者 (人別経費投資回収シート) を read-only で取得する hook (顧客アプリ)。
// 構造は useExpenses.js に準拠 (clientId→userId 切替・refetch・StrictMode 冪等)。
// 戻り値: { targets, loading, error, refetch }
// =============================================================
export function useInvestmentTargets(userId) {
  const [targets, setTargets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setTargets([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listTargets(userId);
      setTargets(rows);
      setError(null);
    } catch (e) {
      console.error('[useInvestmentTargets]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { targets, loading, error, refetch };
}
