import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/annualBudgets';

// =============================================================
// 指定 client の最新年度の繰越票 (committed_*) を取得する read-only hook
// (Phase E 最終ゴール — 顧客アプリ)。
//
// 戻り値 shape: { data, loading, error, refetch }
//   - data: getCommittedByClient の返却 (オブジェクト or null)。
//           last_committed_at が null なら「準備中」、UI 側で判定する。
//
// admin 側 useAnnualBudgets.js は optimistic + ref-mirror の重量実装だが、
// 顧客アプリは閲覧のみのため useState + useEffect + refetch の軽量パターン。
// clientId 変化時に自動再取得 (StrictMode 下の二重実行も冪等)。
// =============================================================
export function useAnnualBudgets(clientId) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!clientId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const row = await api.getCommittedByClient(clientId);
      setData(row);
      setError(null);
    } catch (e) {
      console.error('[useAnnualBudgets]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
