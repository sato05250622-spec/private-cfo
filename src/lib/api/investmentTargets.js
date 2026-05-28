// 人別経費投資回収シート: 投資対象者 (人物) の read-only API。
// 流用元: ./expenses.js listExpenses のパターン (顧客アプリは閲覧のみ)。
import { supabase } from '../supabaseClient';

const TABLE = 'investment_targets';

// 指定クライアントの有効な投資対象者 (soft delete 除外) を取得。
// sort_order 昇順 → created_at 昇順 で安定ソート。
export async function listTargets(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .is('deleted_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
