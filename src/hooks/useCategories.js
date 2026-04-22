import { useCallback, useEffect, useMemo, useState } from 'react';
import { DEFAULT_EXPENSE_CATS } from '@shared/categories';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/categories';

// DB 行 → App.jsx が期待する形。_custom フラグで既定 9 個と区別する。
function toApp(row) {
  return {
    id: row.id,
    label: row.label,
    iconKey: row.icon_key,
    color: row.color,
    sortOrder: row.sort_order ?? 0,
    _custom: true,
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

// 既定 9 個(コード側)+ カスタム(DB)の結合リストを返す。
// NOTE(Day 3 トレードオフ):
//   App.jsx の UI には既定カテゴリの編集導線もあるが、Day 3 では
//   既定の編集は永続化されない(ブラウザ限定)。既定の上書き対応は
//   Phase 1 リリース後に overrides テーブルなどで検討する。
export function useCategories() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [customs, setCustoms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setCustoms([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await api.listCategories(userId);
      setCustoms(rows.map(toApp));
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
      setCustoms((prev) => [...prev, mapped]);
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
      setCustoms((prev) => prev.map((c) => (c.id === id ? mapped : c)));
      return mapped;
    },
    [userId],
  );

  const removeCategory = useCallback(async (id) => {
    await api.deleteCategory(id);
    setCustoms((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // 読み取り用の結合リスト。既定 → カスタム の順。
  const categories = useMemo(
    () => [...DEFAULT_EXPENSE_CATS, ...customs],
    [customs],
  );

  return {
    categories,
    customs,
    loading,
    error,
    refetch,
    addCategory,
    updateCategory,
    removeCategory,
  };
}
