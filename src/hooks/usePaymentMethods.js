import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/paymentMethods';

// =============================================================
// payment_methods を配列形式で管理する hook。App.jsx の
// useLocalStorage("cfo_paymentMethods", [{id:"cash", ...}]) と
// drop-in 互換になるよう、データ shape (camelCase) を維持する。
//
// DB 行 (snake_case) → アプリ shape (camelCase) の変換は rowToItem で。
// 並び順は DB の sort_order 列 + listPaymentMethods で order by 担保。
// アプリ側は配列順 = 表示順として扱い、reorder 時に sort_order を一括 UPDATE。
//
// 'cash' default の扱い:
//   - DB が空のときは DEFAULT_PM を返す (App.jsx 旧挙動と互換)
//   - 実 seed (DB に 'cash' 行を持たせる) は Step 5 migrate で行う
//   - hook のデフォルトは brief な UI 安全網
// =============================================================

const DEFAULT_PM = [{ id: 'cash', label: '現金', color: '#4CAF50' }];

function rowToItem(row) {
  return {
    id: row.id,
    label: row.label,
    color: row.color,
    closingDay: row.closing_day,
    withdrawalDay: row.withdrawal_day,
    bank: row.bank,
  };
}

export function usePaymentMethods() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [paymentMethods, setState] = useState(DEFAULT_PM);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // StrictMode 下で functional updater の二重実行による revert hazard を
  // 回避するため、最新 state を ref ミラーで参照する (useBudgets.js と同方針)。
  const ref = useRef(DEFAULT_PM);
  useEffect(() => { ref.current = paymentMethods; }, [paymentMethods]);

  const refetch = useCallback(async () => {
    if (!userId) {
      setState(DEFAULT_PM);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listPaymentMethods(userId);
      setState(rows.length === 0 ? DEFAULT_PM : rows.map(rowToItem));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  const createPaymentMethod = useCallback(async (item) => {
    if (!userId) return;
    const prev = ref.current;
    const sortOrder = prev.length;
    setState((c) => [...c, item]);
    try {
      await api.upsertPaymentMethod(userId, { ...item, sortOrder });
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  const updatePaymentMethod = useCallback(async (id, patch) => {
    if (!userId) return;
    const prev = ref.current;
    const idx = prev.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const updated = { ...prev[idx], ...patch };
    setState((c) => c.map((x) => (x.id === id ? updated : x)));
    try {
      await api.upsertPaymentMethod(userId, { ...updated, sortOrder: idx });
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  const deletePaymentMethod = useCallback(async (id) => {
    if (!userId) return;
    const prev = ref.current;
    setState((c) => c.filter((x) => x.id !== id));
    try {
      await api.deletePaymentMethod(userId, id);
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  // newOrder: アプリ shape の配列。DB には id だけ送る。
  const reorderPaymentMethods = useCallback(async (newOrder) => {
    if (!userId) return;
    const prev = ref.current;
    setState(newOrder);
    try {
      await api.reorderPaymentMethods(userId, newOrder.map((x) => x.id));
    } catch (e) {
      setState(prev);
      throw e;
    }
  }, [userId]);

  return {
    paymentMethods,
    loading,
    error,
    createPaymentMethod,
    updatePaymentMethod,
    deletePaymentMethod,
    reorderPaymentMethods,
    refetch,
  };
}
