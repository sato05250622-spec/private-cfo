import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/investmentIncomes';
import { supabase } from '../lib/supabaseClient';

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

  // #3-A 同期修正: Supabase Realtime + focus/visibility refetch。
  //   target ごとにチャネルを分けるためチャネル名に targetId を含める。
  //   フィルタは client_id=eq.${userId} のみ (target_id は refetch 側の guard で吸収)。
  useEffect(() => {
    const onFocus = () => { refetch(); };
    const onVis = () => { if (!document.hidden) refetch(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    if (!userId || !targetId) {
      return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVis);
      };
    }
    const channel = supabase
      .channel(`invincomes-${userId}-${targetId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'investment_incomes',
        filter: `client_id=eq.${userId}`,
      }, () => { refetch(); })
      .subscribe();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      supabase.removeChannel(channel);
    };
  }, [userId, targetId, refetch]);

  return { incomes, loading, error, refetch };
}
