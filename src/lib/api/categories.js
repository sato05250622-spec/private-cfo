// カスタムカテゴリ(DB)の CRUD。
// 既定 9 個は shared-cfo/categories.js 側にあり、DB には存在しない。
import { supabase } from '../supabaseClient';

const TABLE = 'categories';

export async function listCategories(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function insertCategory(row) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// UPDATE は (client_id, id) の複合キーで絞る。
// admin ロールは RLS `is_admin()` で全行を触れるため、id 単独だと
// 同じ id を持つ他顧客の行まで巻き込んでしまい .single() が
// PGRST116(複数行)で落ちる。client_id フィルタ必須。
export async function updateCategory(id, patch, clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('client_id', clientId)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// DELETE も同様に client_id + id で絞る(admin の誤操作防止 + 対称性)。
export async function deleteCategory(id, clientId) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('client_id', clientId)
    .eq('id', id);
  if (error) throw error;
}

// 2026-10-14 v5: カテゴリの論理削除 (archived_at)。行は残し、過去の支出・予算・本部の繰越票/月次レビューから消さない。
//   keepThrough { year, cycleMonth(1-12) } より「後」の週予算だけ削除する (当月までの予算は記録として残す)。
export async function archiveCategory(id, clientId, keepThrough = null) {
  const { error } = await supabase
    .from(TABLE)
    .update({ archived_at: new Date().toISOString() })
    .eq('client_id', clientId)
    .eq('id', id);
  if (error) throw error;
  if (keepThrough && keepThrough.year && keepThrough.cycleMonth) {
    const Y = Number(keepThrough.year), M = Number(keepThrough.cycleMonth);
    const { error: e2 } = await supabase
      .from('week_cat_budgets')
      .delete()
      .eq('client_id', clientId)
      .eq('category_id', id)
      .or(`year.gt.${Y},and(year.eq.${Y},cycle_month.gt.${M})`);
    if (e2) throw e2;
  }
}
