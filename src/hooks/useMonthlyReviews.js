import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/monthlyReviews';

// =============================================================
// 指定 client の公開済み月次レビュー一覧を取得する read-only hook
// (Phase E 最終ゴール — 顧客アプリ)。
//
// 戻り値 shape: { list, loading, error, refetch }
//   - list: listPublishedByClient の返却 (配列、新しい月順)。該当無しは []。
//
// 顧客アプリは閲覧のみのため useState + useEffect + refetch の軽量パターン。
// clientId 変化時に自動再取得 (StrictMode 下の二重実行も冪等)。
// 特定月の 1 件取得が要る画面では api.getPublishedByMonth を直接使う。
// =============================================================
export function useMonthlyReviews(clientId) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!clientId) {
      setList([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listPublishedByClient(clientId);
      setList(rows);
      setError(null);
    } catch (e) {
      console.error('[useMonthlyReviews]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { list, loading, error, refetch };
}
