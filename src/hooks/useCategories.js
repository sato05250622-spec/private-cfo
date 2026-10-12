import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/categories';

// -----------------------------------------------------------------
// categories の localStorage キャッシュ (stale-while-revalidate)。
//   profiles キャッシュ (AuthContext) と同型。入力画面のカテゴリチップを
//   認証解決後の RTT を待たずキャッシュから即描画するための最適化。
//   保存 shape: { userId, rows(toApp 変換後の配列・sort_order 順), savedAt }。
//   全操作 try/catch で握りつぶし、localStorage 不可環境でも動作を壊さない。
// -----------------------------------------------------------------
// v2 (2026-10-12): 事業費/プライベート費区分 (expenseType) を行に含めるため bump。旧 v1 はサインアウト時の pcfo_ 一括削除で消える。
const CATEGORIES_CACHE_KEY = 'pcfo_categories_cache_v2';

function readCategoriesCache() {
  try {
    const raw = localStorage.getItem(CATEGORIES_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCategoriesCache(userId, rows) {
  try {
    localStorage.setItem(
      CATEGORIES_CACHE_KEY,
      JSON.stringify({ userId, rows, savedAt: Date.now() }),
    );
  } catch {
    // quota / localStorage 不可は無視 (キャッシュは最適化)。
  }
}

// DB 行 → App.jsx が期待する形。
// 既定 9 個も DB に格納される設計のため、_custom フラグは廃止。
function toApp(row) {
  return {
    id: row.id,
    label: row.label,
    iconKey: row.icon_key,
    color: row.color,
    sortOrder: row.sort_order ?? 0,
    // 2026-10-12 P5: 事業費/プライベート費区分。DB 既定は 'business' (列が無い・null も business 扱い = 本部の MonthSummary と同じ判定)。
    expenseType: row.expense_type === 'private' ? 'private' : 'business',
  };
}

function toDb(cat, clientId) {
  const row = {
    client_id: clientId,
    label: cat.label,
    icon_key: cat.iconKey,
    color: cat.color,
    sort_order: cat.sortOrder ?? 0,
  };
  // P5: 区分は指定されたときだけ送る (未指定で既存の値・本部が設定した値を上書きしない)。
  if (cat.expenseType === 'business' || cat.expenseType === 'private') row.expense_type = cat.expenseType;
  return row;
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
  // SWR 番兵: 初回に権威データ (キャッシュ採用 or fetch 成功) を適用済みか。
  //   false の間は write-through effect でキャッシュを書かない (初期 [] で良好な
  //   キャッシュを潰さないため)。
  const hydratedRef = useRef(false);

  // opts.background=true: stale-while-revalidate の裏更新。loading を触らず、
  //   fetch 結果がキャッシュと差分がある時のみ setState する (無駄な再描画回避)。
  const refetch = useCallback(async (opts) => {
    if (!userId) {
      setCategories([]);
      setLoading(false);
      hydratedRef.current = false;
      return;
    }
    const background = opts?.background === true;
    if (!background) setLoading(true);
    try {
      const rows = await api.listCategories(userId);
      const mapped = rows.map(toApp);
      if (background) {
        const prev = readCategoriesCache();
        const changed = !prev || prev.userId !== userId
          || JSON.stringify(prev.rows) !== JSON.stringify(mapped);
        if (changed) setCategories(mapped);
      } else {
        setCategories(mapped);
      }
      hydratedRef.current = true;
      setError(null);
    } catch (e) {
      // 取得失敗/タイムアウト時はキャッシュを消さない (オフライン耐性)。
      setError(e);
    } finally {
      if (!background) setLoading(false);
    }
  }, [userId]);

  // mount / userId 変更時: キャッシュヒットなら即描画 → 裏で revalidate。
  useEffect(() => {
    if (!userId) {
      setCategories([]);
      setLoading(false);
      hydratedRef.current = false;
      return;
    }
    const cached = readCategoriesCache();
    if (cached && cached.userId === userId && cached.rows.length > 0) {
      setCategories(cached.rows);
      setLoading(false);
      hydratedRef.current = true;
      refetch({ background: true });
    } else {
      refetch();
    }
  }, [userId, refetch]);

  // write-through: categories が変わるたびにキャッシュを書き直す。
  //   add/update/remove/reorder の楽観更新・rollback にも自動追従。
  //   hydrated 前 / userId 無 / 空配列 (未ロード) では書かない。
  useEffect(() => {
    if (userId && hydratedRef.current && categories.length > 0) {
      writeCategoriesCache(userId, categories);
    }
  }, [categories, userId]);

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
      // P5 (副バグ修正): 並び順を渡していない編集で sort_order を 0 に戻さない。
      if (patchApp.sortOrder === undefined) delete patch.sort_order;
      const updated = await api.updateCategory(id, patch, userId);
      const mapped = toApp(updated);
      setCategories((prev) => prev.map((c) => (c.id === id ? mapped : c)));
      return mapped;
    },
    [userId],
  );

  const removeCategory = useCallback(
    async (id) => {
      if (!userId) return;
      await api.deleteCategory(id, userId);
      setCategories((prev) => prev.filter((c) => c.id !== id));
    },
    [userId],
  );

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
          diffs.map((d) => api.updateCategory(d.id, { sort_order: d.newOrder }, userId)),
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
