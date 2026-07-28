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

// -----------------------------------------------------------------
// payment_methods の localStorage キャッシュ (stale-while-revalidate)。
//   useCategories / profiles キャッシュと同型。入力画面の支払い方法を
//   認証解決後の RTT を待たずキャッシュから即描画するための最適化。
//   保存 shape: { userId, rows(rowToItem 変換後・sort_order 順), savedAt }。
//   DEFAULT_PM フォールバックは refetch / mount 側で維持 (空配列は書かない)。
//   全操作 try/catch で握りつぶす (localStorage 不可でも安全)。
// -----------------------------------------------------------------
const PAYMENT_METHODS_CACHE_KEY = 'pcfo_payment_methods_cache_v1';

function readPaymentMethodsCache() {
  try {
    const raw = localStorage.getItem(PAYMENT_METHODS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePaymentMethodsCache(userId, rows) {
  try {
    localStorage.setItem(
      PAYMENT_METHODS_CACHE_KEY,
      JSON.stringify({ userId, rows, savedAt: Date.now() }),
    );
  } catch {
    // quota / localStorage 不可は無視。
  }
}

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

  // SWR 番兵: 初回に権威データ (キャッシュ採用 or fetch 成功) を適用済みか。
  //   false の間は write-through effect でキャッシュを書かない。
  const hydratedRef = useRef(false);

  // opts.background=true: stale-while-revalidate の裏更新。loading を触らず、
  //   fetch 結果がキャッシュと差分がある時のみ setState する。
  const refetch = useCallback(async (opts) => {
    if (!userId) {
      setState(DEFAULT_PM);
      setLoading(false);
      hydratedRef.current = false;
      return;
    }
    const background = opts?.background === true;
    if (!background) setLoading(true);
    try {
      const rows = await api.listPaymentMethods(userId);
      // DEFAULT_PM フォールバック維持: DB 空なら現金デフォルトを出す (既存挙動)。
      const mapped = rows.length === 0 ? DEFAULT_PM : rows.map(rowToItem);
      if (background) {
        const prev = readPaymentMethodsCache();
        const changed = !prev || prev.userId !== userId
          || JSON.stringify(prev.rows) !== JSON.stringify(mapped);
        if (changed) setState(mapped);
      } else {
        setState(mapped);
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
      setState(DEFAULT_PM);
      setLoading(false);
      hydratedRef.current = false;
      return;
    }
    const cached = readPaymentMethodsCache();
    if (cached && cached.userId === userId && cached.rows.length > 0) {
      setState(cached.rows);
      setLoading(false);
      hydratedRef.current = true;
      refetch({ background: true });
    } else {
      refetch();
    }
  }, [userId, refetch]);

  // write-through: paymentMethods が変わるたびにキャッシュを書き直す。
  //   create/update/delete/reorder の楽観更新・rollback にも自動追従。
  //   hydrated 前 / userId 無 / 空配列では書かない (DEFAULT_PM は length>=1 なので保存対象)。
  useEffect(() => {
    if (userId && hydratedRef.current && paymentMethods.length > 0) {
      writePaymentMethodsCache(userId, paymentMethods);
    }
  }, [paymentMethods, userId]);

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
