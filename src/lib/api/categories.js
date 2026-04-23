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
