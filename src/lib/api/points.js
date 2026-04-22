// ポイント関連の読み取り API(顧客は付与不可、admin のみ INSERT)。
import { supabase } from '../supabaseClient';

// 現在残高を points_balances ビューから取得。
// 台帳に 1 行も無いユーザーはビューに行が無いので 0 を返す。
export async function getBalance(clientId) {
  const { data, error } = await supabase
    .from('points_balances')
    .select('balance')
    .eq('client_id', clientId)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.balance ?? 0);
}

// ポイント履歴(新しい順)。
export async function listHistory(clientId) {
  const { data, error } = await supabase
    .from('points_ledger')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}
