import { useCallback, useEffect, useState } from 'react';
import * as api from '../lib/api/investmentTargets';
import { supabase } from '../lib/supabaseClient';

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

  // #3-A 同期修正: Supabase Realtime + focus/visibility refetch。
  //   本部 (admin) が investment_targets を CRUD したとき、開きっぱなしの顧客画面で
  //   自動再取得して反映する。realtime 不達のフォールバックに focus/visibilitychange を併用。
  useEffect(() => {
    const onFocus = () => { refetch(); };
    const onVis = () => { if (!document.hidden) refetch(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVis);
    if (!userId) {
      return () => {
        window.removeEventListener('focus', onFocus);
        document.removeEventListener('visibilitychange', onVis);
      };
    }
    const channel = supabase
      .channel(`invtargets-${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'investment_targets',
        filter: `client_id=eq.${userId}`,
      }, () => { refetch(); })
      .subscribe();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      supabase.removeChannel(channel);
    };
  }, [userId, refetch]);

  return { targets, loading, error, refetch };
}
