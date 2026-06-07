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
              // Phase B-3 (2026-06-07): 資産残高繰越票用。admin commitIncomeSnapshot で焼かれた snapshot を露出。
              //   AssetSheetViewer が「準備中」判定 (incomeCommittedAt null) と本体描画 (committedIncomeLines) に使う。
              //   支出側 committedLines も読み出しが増えるため snake_case のままだが camelCase でも露出。
              committedLines: row.committed_lines ?? [],
              committedIncomeLines: row.committed_income_lines ?? [],
              incomeCommittedAt: row.income_committed_at ?? null,
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

  // 修正2(a): アプリ/タブに復帰したとき (focus / visibility=visible) に最新化。
  //   本部が「反映」した後、顧客が画面を開いたまま (mount/clientId/fiscalYear 不変) でも
  //   復帰時に refetch して committed_* の更新を取り込む。clientId 無しは何もしない。
  useEffect(() => {
    if (!clientId) return undefined;
    const onFocus = () => { refetch(); };
    const onVisible = () => { if (document.visibilityState === "visible") refetch(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clientId, refetch]);

  return { data, loading, error, refetch };
}
