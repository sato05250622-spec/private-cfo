import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/categories';

// DB 行 → App.jsx が期待する形。
// 既定 9 個も DB に格納される設計のため、_custom フラグは廃止。
function toApp(row) {
  return {
    id: row.id,
    label: row.label,
    iconKey: row.icon_key,
    color: row.color,
    sortOrder: row.sort_order ?? 0,
  };
}

function toDb(cat, clientId) {
  return {
    client_id: clientId,
    label: cat.label,
    icon_key: cat.iconKey,
    color: cat.color,
    sort_order: cat.sortOrder ?? 0,
  };
}

// 顧客が持つカテゴリ一式(既定 + カスタム)を管理する。
// 既定 9 個は profiles INSERT 時のトリガで自動投入されるため、
// このフックは単純に DB を唯一のソースとして参照する。
export function useCategories() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setCategories([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listCategories(userId);
      setCategories(rows.map(toApp));
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

  const addCategory = useCallback(
    async (cat) => {
      if (!userId) return null;
      const row = toDb(cat, userId);
      const inserted = await api.insertCategory(row);
      const mapped = toApp(inserted);
      setCategories((prev) => [...prev, mapped]);
      return mapped;
    },
    [userId],
  );

  const updateCategory = useCallback(
    async (id, patchApp) => {
      if (!userId) return null;
      const patch = toDb(patchApp, userId);
      delete patch.client_id;
      const updated = await api.updateCategory(id, patch);
      const mapped = toApp(updated);
      setCategories((prev) => prev.map((c) => (c.id === id ? mapped : c)));
      return mapped;
    },
    [userId],
  );

  const removeCategory = useCallback(async (id) => {
    await api.deleteCategory(id);
    setCategories((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // 並び替え:sortedIds は新しい順序の id 配列。
  // optimistic にローカル state を並び替え、差分 UPDATE を並列発行。
  // 失敗時は元の順序へロールバック + alert。
  const reorderCategories = useCallback(
    async (sortedIds) => {
      if (!userId) return;
      const prev = categories;
      const diffs = sortedIds
        .map((id, idx) => ({
          id,
          newOrder: idx,
          prevOrder: prev.findIndex((c) => c.id === id),
        }))
        .filter((d) => d.newOrder !== d.prevOrder);
      if (diffs.length === 0) return;

      const next = sortedIds
        .map((id, idx) => {
          const c = prev.find((x) => x.id === id);
          return c ? { ...c, sortOrder: idx } : null;
        })
        .filter(Boolean);
      setCategories(next);

      try {
        await Promise.all(
          diffs.map((d) => api.updateCategory(d.id, { sort_order: d.newOrder })),
        );
      } catch (e) {
        console.error(e);
        setCategories(prev);
        alert('並び替えの保存に失敗しました。');
      }
    },
    [userId, categories],
  );

  return {
    categories,
    loading,
    error,
    refetch,
    addCategory,
    updateCategory,
    removeCategory,
    reorderCategories,
  };
}
