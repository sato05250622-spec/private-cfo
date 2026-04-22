// notifications テーブルの読み取り薄ラッパ。
// 顧客アプリでは書き込まない(RLS は SELECT / UPDATE(read_at)のみ)。
import { supabase } from '../supabaseClient';

const TABLE = 'notifications';

// 顧客向けの最新テロップ 1 件を取得。
// kind='telop' に限定し、published_at 降順で先頭 1 行のみ。
// 行が無い場合は空配列を返す(呼び出し側でフォールバック)。
export async function listLatestTelop(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .eq('kind', 'telop')
    .order('published_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return data ?? [];
}
