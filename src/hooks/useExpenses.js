import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/expenses';
import { supabase } from '../lib/supabaseClient';

// DB 行 → App.jsx が期待する形 への変換。
// App.jsx 既存コードが触る識別子(`t.date` / `t.amount` / `t.memo` /
// `t.category` / `t.payment` / `t.recurId` / `t.isRecurring`)は温存する。
// `enteredBy` / `isProxyEntry` は Day 3 で新規追加(本部代行入力バッジ用)。
function toApp(row, userId) {
  return {
    id: row.id,
    date: row.date,
    amount: Number(row.amount),
    memo: row.memo ?? '',
    category: row.category,
    payment: row.payment_method ?? 'cash',
    isRecurring: row.is_recurring ?? false,
    recurId: row.recur_id ?? null,
    enteredBy: row.entered_by ?? null,
    isProxyEntry: !!(row.entered_by && row.entered_by !== userId),
    // 人別経費投資回収シート: 紐づけた投資対象者の id (NULL = 一般支出)。
    target_id: row.target_id ?? null,
    // #3-A 同期修正 (Fix 2): InvestmentRecoveryViewer の mergedRows で同日 2 次ソート
    //   に使うため created_at を持ち上げる。本部 InvestmentRecoveryView と並びを揃え、
    //   同日複数行の cum/diff/judge が一致するようにする。
    createdAt: row.created_at ?? null,
  };
}

// App.jsx が作るオブジェクト → DB 行 への変換。
// client_id / entered_by は認証ユーザーで埋める(顧客自身が入力する場合)。
// 本部代行入力は admin アプリ側から別パスで挿入されるので、このフックでは扱わない。
function toDb(app, userId) {
  return {
    client_id: userId,
    entered_by: userId,
    date: app.date,
    amount: app.amount,
    memo: app.memo || null,
    category: app.category,
    payment_method: app.payment || 'cash',
    is_recurring: app.isRecurring || false,
    recur_id: app.recurId || null,
  };
}

export function useExpenses() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setExpenses([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listExpenses(userId);
      setExpenses(rows.map((r) => toApp(r, userId)));
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

  // #3-A 同期修正: Supabase Realtime + focus/visibility refetch。
  //   本部 (admin) が代理書込 / target_id 付与した場合に、開きっぱなしの顧客画面で
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
      .channel(`expenses-${userId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'expenses',
        filter: `client_id=eq.${userId}`,
      }, () => { refetch(); })
      .subscribe();
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVis);
      supabase.removeChannel(channel);
    };
  }, [userId, refetch]);

  const addExpense = useCallback(
    async (app) => {
      if (!userId) return null;
      const row = toDb(app, userId);
      const inserted = await api.insertExpense(row);
      const mapped = toApp(inserted, userId);
      setExpenses((prev) => [mapped, ...prev]);
      return mapped;
    },
    [userId],
  );

  const updateExpense = useCallback(
    async (id, patchApp) => {
      if (!userId) return null;
      const patch = toDb(patchApp, userId);
      // client_id / entered_by は更新時に送り返さない(RLS 安定化)。
      delete patch.client_id;
      delete patch.entered_by;
      const updated = await api.updateExpense(id, patch);
      const mapped = toApp(updated, userId);
      setExpenses((prev) => prev.map((t) => (t.id === id ? mapped : t)));
      return mapped;
    },
    [userId],
  );

  const softDeleteExpense = useCallback(
    async (id) => {
      if (!userId) return;
      await api.softDeleteExpense(id);
      setExpenses((prev) => prev.filter((t) => t.id !== id));
    },
    [userId],
  );

  return {
    expenses,
    loading,
    error,
    refetch,
    addExpense,
    updateExpense,
    softDeleteExpense,
  };
}
