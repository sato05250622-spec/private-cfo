// budgets / week_budgets / week_cat_budgets の CRUD 薄ラッパ。
// アプリの形状 → DB の形状 への変換は呼び出し側 (useBudgets) で行う。
import { supabase } from '../supabaseClient';

const TABLES = {
  budgets: 'budgets',
  week: 'week_budgets',
  weekCat: 'week_cat_budgets',
};

// 3 テーブル分の生 row を 1 RTT で取得。
// admin ロールは RLS `is_admin()` で全行を触れるため、いずれの操作も
// `client_id` フィルタを必ず先頭に含める。これを忘れると admin 実行時に
// 他顧客の行へ誤適用されうる (categories.js と同じ運用)。
export async function listBudgets(clientId) {
  const [b, wb, wcb] = await Promise.all([
    supabase.from(TABLES.budgets).select('*').eq('client_id', clientId),
    supabase.from(TABLES.week).select('*').eq('client_id', clientId),
    supabase.from(TABLES.weekCat).select('*').eq('client_id', clientId),
  ]);
  if (b.error) throw b.error;
  if (wb.error) throw wb.error;
  if (wcb.error) throw wcb.error;
  return {
    budgets: b.data ?? [],
    weekBudgets: wb.data ?? [],
    weekCatBudgets: wcb.data ?? [],
  };
}

// ---- budgets (月予算) --------------------------------------------
// (client_id, year, cycle_month, category_id) 複合 PK で upsert。
// onConflict 未指定時は table の PK 制約を自動採用するため省略。
export async function upsertBudget(clientId, { year, cycleMonth, categoryId, amount }) {
  const { error } = await supabase
    .from(TABLES.budgets)
    .upsert({
      client_id: clientId,
      year,
      cycle_month: cycleMonth,
      category_id: categoryId,
      amount,
    });
  if (error) throw error;
}

export async function deleteBudget(clientId, { year, cycleMonth, categoryId }) {
  const { error } = await supabase
    .from(TABLES.budgets)
    .delete()
    .eq('client_id', clientId)
    .eq('year', year)
    .eq('cycle_month', cycleMonth)
    .eq('category_id', categoryId);
  if (error) throw error;
}

// ---- week_budgets (週予算 / 全カテゴリ合計) ----------------------
// (client_id, year, cycle_month, week_num) 複合 PK で upsert。
export async function upsertWeekBudget(clientId, { year, cycleMonth, weekNum, amount }) {
  const { error } = await supabase
    .from(TABLES.week)
    .upsert({
      client_id: clientId,
      year,
      cycle_month: cycleMonth,
      week_num: weekNum,
      amount,
    });
  if (error) throw error;
}

export async function deleteWeekBudget(clientId, { year, cycleMonth, weekNum }) {
  const { error } = await supabase
    .from(TABLES.week)
    .delete()
    .eq('client_id', clientId)
    .eq('year', year)
    .eq('cycle_month', cycleMonth)
    .eq('week_num', weekNum);
  if (error) throw error;
}

// ---- week_cat_budgets (週 × カテゴリ予算) ------------------------
// (client_id, year, cycle_month, week_num, category_id) 複合 PK で upsert。
export async function upsertWeekCatBudget(clientId, { year, cycleMonth, weekNum, categoryId, amount }) {
  const { error } = await supabase
    .from(TABLES.weekCat)
    .upsert({
      client_id: clientId,
      year,
      cycle_month: cycleMonth,
      week_num: weekNum,
      category_id: categoryId,
      amount,
    });
  if (error) throw error;
}

export async function deleteWeekCatBudget(clientId, { year, cycleMonth, weekNum, categoryId }) {
  const { error } = await supabase
    .from(TABLES.weekCat)
    .delete()
    .eq('client_id', clientId)
    .eq('year', year)
    .eq('cycle_month', cycleMonth)
    .eq('week_num', weekNum)
    .eq('category_id', categoryId);
  if (error) throw error;
}
