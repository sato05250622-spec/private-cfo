// expenses テーブルの CRUD 薄いラッパ。
// アプリの形状 → DB の形状 への変換は呼び出し側(useExpenses)で行う。
import { supabase } from '../supabaseClient';

const TABLE = 'expenses';

// 指定クライアントの有効な支出(soft delete 除外)を日付降順で取得。
export async function listExpenses(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// 1 行挿入し、DB 側で付与された id / timestamps を含む行を返す。
export async function insertExpense(row) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 部分更新。patch は DB カラム名。
export async function updateExpense(id, patch) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// 顧客は RLS で物理削除できないため、deleted_at を UPDATE して隠す。
export async function softDeleteExpense(id) {
  const { error } = await supabase
    .from(TABLE)
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}
