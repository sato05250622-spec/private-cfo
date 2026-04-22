import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/points';

// DB 行 → App.jsx の pointHistory 形。
// 既存 App.jsx は `reason` と `delta` さえあれば表示できる。
function toApp(row) {
  return {
    id: row.id,
    delta: row.delta,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function usePoints() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [balance, setBalance] = useState(0);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setBalance(0);
      setHistory([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [bal, rows] = await Promise.all([
        api.getBalance(userId),
        api.listHistory(userId),
      ]);
      setBalance(bal);
      setHistory(rows.map(toApp));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { balance, history, loading, error, refetch };
}
