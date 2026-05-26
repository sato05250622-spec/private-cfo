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
// ③: fiscalYear 省略時は最新年度、指定時はその年度を取得 (年度ダイヤル用)。
export function useAnnualBudgets(clientId, fiscalYear) {
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
      const row = await api.getCommittedByClient(clientId, fiscalYear);
      // Phase 1: committed_settled_months / Phase 1c: committed_annual_total_target を
      // camelCase でも露出 (UI 側 isSettled 判定 / 全体バー budget 用)。
      // 既存の snake_case フィールドはそのまま温存し、camelCase を追加するのみ。
      setData(
        row
          ? {
              ...row,
              committedSettledMonths: row.committed_settled_months ?? [],
              committedAnnualTotalTarget: row.committed_annual_total_target ?? null,
            }
          : null,
      );
      setError(null);
    } catch (e) {
      console.error('[useAnnualBudgets]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [clientId, fiscalYear]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { data, loading, error, refetch };
}
