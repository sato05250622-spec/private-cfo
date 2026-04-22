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

export async function updateCategory(id, patch) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// カテゴリは admin 物理削除・顧客物理削除どちらも OK(expenses との FK なし)。
export async function deleteCategory(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
}
