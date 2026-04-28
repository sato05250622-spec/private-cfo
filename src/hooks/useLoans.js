import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/loans';

// =============================================================
// loans を配列形式で管理する hook。App.jsx の
// useLocalStorage("cfo_loans", []) と drop-in 互換 shape を維持。
//
// DB 行 (snake_case) → アプリ shape (camelCase) の変換は rowToItem で。
// 並び順は created_at 昇順 (reorder 機能なし)。
// pm_id は将来 payment_methods 連動の論理参照 (現実装は未使用、text 保持)。
// =============================================================

function rowToItem(row) {
  return {
    id: row.id,
    label: row.label,
    amount: Number(row.amount),
    bank: row.bank,
    withdrawalDay: row.withdrawal_day,
    pmId: row.pm_id,
  };
}

export function useLoans() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [loans, setState] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // StrictMode 対策の ref ミラー (usePaymentMethods.js と同方針)。
  const ref = useRef([]);
  useEffect(() => { ref.current = loans; }, [loans]);

  const refetch = useCallback(async () => {
    if (!userId) {
      setState([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listLoans(userId);
      setState(rows.map(rowToItem));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  const createLoan = useCallback(async (item) => {
    if (!userId) return;
    const prev = ref.current;
    setState((c) => [...c, item]);
    try {
      await api.upsertLoan(userId, item);
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  const updateLoan = useCallback(async (id, patch) => {
    if (!userId) return;
    const prev = ref.current;
    const target = prev.find((x) => x.id === id);
    if (!target) return;
    const updated = { ...target, ...patch };
    setState((c) => c.map((x) => (x.id === id ? updated : x)));
    try {
      await api.upsertLoan(userId, updated);
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  const deleteLoan = useCallback(async (id) => {
    if (!userId) return;
    const prev = ref.current;
    setState((c) => c.filter((x) => x.id !== id));
    try {
      await api.deleteLoan(userId, id);
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  return {
    loans,
    loading,
    error,
    createLoan,
    updateLoan,
    deleteLoan,
    refetch,
  };
}
