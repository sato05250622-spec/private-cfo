// =============================================================
// monthly_reviews の read-only 薄ラッパ (Phase E 最終ゴール — 顧客アプリ)。
//
// 顧客は RLS `monthly_reviews_client_select_published`
//   (client_id = auth.uid() AND is_published = true)
// により自分の公開済みレビューしか取得できないが、admin ロールでも誤って
// 他顧客行や未公開行を触らないよう API 側でも client_id / is_published を
// 明示する (budgets.js / categories.js と同じ運用)。
//
// 書き込みメソッドは持たない (顧客アプリは閲覧のみ)。
// =============================================================
import { supabase } from '../supabaseClient';

const TABLE = 'monthly_reviews';

// 顧客視点の表示に必要な列のみ取得 (admin 専用の ai_* 等は除外)。
const SELECT_COLS =
  'id, year, month, summary, advice, next_month_plan, staff_name, ' +
  'staff_comment, diagnosis, lines, totals, next_action_comment, published_at';

// 指定 client の公開済み月次レビューを全件、新しい月順 (year/month DESC) で返す。
// 返却: 配列 (該当無しは空配列)。
export async function listPublishedByClient(clientId) {
  if (!clientId) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLS)
    .eq('client_id', clientId)
    .eq('is_published', true)
    .order('year', { ascending: false })
    .order('month', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// 指定 client の特定 year/month の公開済みレビューを 1 件取得。
// 返却: オブジェクト or null (未公開 / 該当無しは null)。
export async function getPublishedByMonth(clientId, year, month) {
  if (!clientId || year == null || month == null) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select(SELECT_COLS)
    .eq('client_id', clientId)
    .eq('is_published', true)
    .eq('year', year)
    .eq('month', month)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}
