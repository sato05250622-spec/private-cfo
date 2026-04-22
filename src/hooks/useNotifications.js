import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/notifications';

// テロップ 1 本を保持する read-only フック。
// - body: 最新 telop の body 文字列。取得できない場合は null
// - loading: 初回取得中
// - error: Supabase 側で何か起きた時に入る(呼び出し側は無視可)
// - refetch: 手動再取得(必要になったら画面切替時に呼ぶ)
export function useLatestTelop() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [body, setBody] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setBody(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listLatestTelop(userId);
      setBody(rows[0]?.body ?? null);
      setError(null);
    } catch (e) {
      setError(e);
      setBody(null); // 失敗時は null → 呼び出し側が FALLBACK_TELOP で埋める
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { body, loading, error, refetch };
}
