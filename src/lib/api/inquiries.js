// inquiries テーブルの CRUD 薄ラッパ。
// 顧客アプリでは主に INSERT(送信)のみ使う。
// listInquiries は将来の履歴画面で使う想定で残しておく。
import { supabase } from '../supabaseClient';

const TABLE = 'inquiries';

// 自分の問い合わせ履歴を新しい順で取得(Day 4 Phase 2 では未使用)。
export async function listInquiries(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// 問い合わせ 1 件を挿入。
// status / created_at は DB 側のデフォルトに任せる。
export async function insertInquiry(row) {
  const { data, error } = await supabase
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}
