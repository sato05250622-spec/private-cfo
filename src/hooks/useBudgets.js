import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/budgets';

// =============================================================
// budgets / week_budgets / week_cat_budgets を localStorage 互換の
// Record<key, number> 形式で管理する hook。App.jsx の useLocalStorage 版
// と同じキー文字列形式を維持し、drop-in 置換できる設計。
//
// キー文字列の構造 (App.jsx + cycle.js から):
//   budgets:          '${year}-${month1}-${categoryId}'                  例 '2026-4-entertainment'
//   week_budgets:     '${year}-${month1}-w${weekNum}'                    例 '2026-4-w1'
//   week_cat_budgets: '${year}-${month1}-w${weekNum}_${categoryId}'      例 '2026-4-w1_custom_abc-def'
//
// categoryId は '_' '-' を含み得る (custom_<uuid> 形式) ため、末尾は
// greedy capture (.+) で取る。誤マッチ (例: setBudget に week キー誤渡し)
// は最終的に DB の FK 違反でエラーとなる前提 (信頼ベース防御)。
// =============================================================

const BUDGET_KEY_RE   = /^(\d{4})-(\d{1,2})-(.+)$/;
const WEEK_KEY_RE     = /^(\d{4})-(\d{1,2})-w([1-4])$/;
const WEEK_CAT_KEY_RE = /^(\d{4})-(\d{1,2})-w([1-4])_(.+)$/;

function parseBudgetKey(key) {
  const m = BUDGET_KEY_RE.exec(key);
  if (!m) throw new Error(`invalid budget key format: ${key}`);
  return { year: +m[1], cycleMonth: +m[2], categoryId: m[3] };
}

function parseWeekKey(key) {
  const m = WEEK_KEY_RE.exec(key);
  if (!m) throw new Error(`invalid week_budget key format: ${key}`);
  return { year: +m[1], cycleMonth: +m[2], weekNum: +m[3] };
}

function parseWeekCatKey(key) {
  const m = WEEK_CAT_KEY_RE.exec(key);
  if (!m) throw new Error(`invalid week_cat_budget key format: ${key}`);
  return { year: +m[1], cycleMonth: +m[2], weekNum: +m[3], categoryId: m[4] };
}

// DB 行 → アプリ側キー文字列の生成 (3 種)
const budgetKeyOf  = (row) => `${row.year}-${row.cycle_month}-${row.category_id}`;
const weekKeyOf    = (row) => `${row.year}-${row.cycle_month}-w${row.week_num}`;
const weekCatKeyOf = (row) => `${row.year}-${row.cycle_month}-w${row.week_num}_${row.category_id}`;

function rowsToRecord(rows, keyOf) {
  const result = {};
  for (const row of rows) {
    result[keyOf(row)] = Number(row.amount);
  }
  return result;
}

export function useBudgets() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [budgets, setBudgetsState] = useState({});
  const [weekBudgets, setWeekBudgetsState] = useState({});
  const [weekCatBudgets, setWeekCatBudgetsState] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // state を ref にミラー。<React.StrictMode> 下で functional updater が
  // dev 時に 2 回呼ばれるため、外部変数で prev をキャプチャすると 2 回目に
  // 上書きされて revert が壊れる。ref からの同期取得でこの hazard を回避。
  // (categories.js は deps=[state] パターンで関数毎レンダ再生成しているが、
  //  budgets は cell 単位の頻繁書き込みのため deps=[userId] のみに最適化。)
  const budgetsRef = useRef({});
  const weekBudgetsRef = useRef({});
  const weekCatBudgetsRef = useRef({});
  useEffect(() => { budgetsRef.current = budgets; }, [budgets]);
  useEffect(() => { weekBudgetsRef.current = weekBudgets; }, [weekBudgets]);
  useEffect(() => { weekCatBudgetsRef.current = weekCatBudgets; }, [weekCatBudgets]);

  const refetch = useCallback(async () => {
    if (!userId) {
      setBudgetsState({});
      setWeekBudgetsState({});
      setWeekCatBudgetsState({});
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await api.listBudgets(userId);
      setBudgetsState(rowsToRecord(data.budgets, budgetKeyOf));
      setWeekBudgetsState(rowsToRecord(data.weekBudgets, weekKeyOf));
      setWeekCatBudgetsState(rowsToRecord(data.weekCatBudgets, weekCatKeyOf));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { refetch(); }, [refetch]);

  // ---- budgets (月予算) -------------------------------------------
  // setBudget(key, amount): upsert (amount=0 も保存。zero-budget category 対応)
  // deleteBudget(key)     : Record から key を削除。App.jsx saveBudgets の
  //                          「draft 空なら delete」ロジックと整合。

  const setBudget = useCallback(async (key, amount) => {
    if (!userId) return;
    const parsed = parseBudgetKey(key);
    const prev = budgetsRef.current[key];
    setBudgetsState((c) => ({ ...c, [key]: amount }));
    try {
      await api.upsertBudget(userId, { ...parsed, amount });
    } catch (e) {
      setBudgetsState((c) => {
        const next = { ...c };
        if (prev === undefined) delete next[key];
        else next[key] = prev;
        return next;
      });
      throw e;
    }
  }, [userId]);

  const deleteBudget = useCallback(async (key) => {
    if (!userId) return;
    const parsed = parseBudgetKey(key);
    const prev = budgetsRef.current[key];
    setBudgetsState((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
    try {
      await api.deleteBudget(userId, parsed);
    } catch (e) {
      if (prev !== undefined) {
        setBudgetsState((c) => ({ ...c, [key]: prev }));
      }
      throw e;
    }
  }, [userId]);

  // ---- week_budgets (週予算 / 全カテゴリ合計) ---------------------

  const setWeekBudget = useCallback(async (key, amount) => {
    if (!userId) return;
    const parsed = parseWeekKey(key);
    const prev = weekBudgetsRef.current[key];
    setWeekBudgetsState((c) => ({ ...c, [key]: amount }));
    try {
      await api.upsertWeekBudget(userId, { ...parsed, amount });
    } catch (e) {
      setWeekBudgetsState((c) => {
        const next = { ...c };
        if (prev === undefined) delete next[key];
        else next[key] = prev;
        return next;
      });
      throw e;
    }
  }, [userId]);

  const deleteWeekBudget = useCallback(async (key) => {
    if (!userId) return;
    const parsed = parseWeekKey(key);
    const prev = weekBudgetsRef.current[key];
    setWeekBudgetsState((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
    try {
      await api.deleteWeekBudget(userId, parsed);
    } catch (e) {
      if (prev !== undefined) {
        setWeekBudgetsState((c) => ({ ...c, [key]: prev }));
      }
      throw e;
    }
  }, [userId]);

  // ---- week_cat_budgets (週 × カテゴリ予算) -----------------------

  const setWeekCatBudget = useCallback(async (key, amount) => {
    if (!userId) return;
    const parsed = parseWeekCatKey(key);
    const prev = weekCatBudgetsRef.current[key];
    setWeekCatBudgetsState((c) => ({ ...c, [key]: amount }));
    try {
      await api.upsertWeekCatBudget(userId, { ...parsed, amount });
    } catch (e) {
      setWeekCatBudgetsState((c) => {
        const next = { ...c };
        if (prev === undefined) delete next[key];
        else next[key] = prev;
        return next;
      });
      throw e;
    }
  }, [userId]);

  const deleteWeekCatBudget = useCallback(async (key) => {
    if (!userId) return;
    const parsed = parseWeekCatKey(key);
    const prev = weekCatBudgetsRef.current[key];
    setWeekCatBudgetsState((c) => {
      const next = { ...c };
      delete next[key];
      return next;
    });
    try {
      await api.deleteWeekCatBudget(userId, parsed);
    } catch (e) {
      if (prev !== undefined) {
        setWeekCatBudgetsState((c) => ({ ...c, [key]: prev }));
      }
      throw e;
    }
  }, [userId]);

  return {
    budgets,
    weekBudgets,
    weekCatBudgets,
    loading,
    error,
    setBudget,
    deleteBudget,
    setWeekBudget,
    deleteWeekBudget,
    setWeekCatBudget,
    deleteWeekCatBudget,
    refetch,
  };
}
