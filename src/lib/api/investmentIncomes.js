// 人別経費投資回収シート: 各対象者への入金明細の read-only API。
// 流用元: ./expenses.js listExpenses のパターン (顧客アプリは閲覧のみ)。
import { supabase } from '../supabaseClient';

const TABLE = 'investment_incomes';

// 指定クライアント × 指定対象者の有効な入金 (soft delete 除外) を date 昇順で取得。
export async function listIncomes(clientId, targetId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .eq('target_id', targetId)
    .is('deleted_at', null)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}
