// =============================================================
// annual_budgets の read-only 薄ラッパ (Phase E 最終ゴール — 顧客アプリ)。
//
// 顧客は RLS `annual_budgets_client_select_own`
//   (client_id = auth.uid() AND visible_to_client = true)
// により自分の可視レコードしか取得できないが、admin ロールでも誤って
// 他顧客行を触らないよう API 側でも client_id フィルタを明示する
// (budgets.js / categories.js と同じ運用)。
//
// 書き込みメソッドは持たない (顧客アプリは閲覧のみ)。
// =============================================================
import { supabase } from '../supabaseClient';

const TABLE = 'annual_budgets';

// 指定 client の最新年度 (fiscal_year DESC) の繰越票を 1 件取得。
// 返却 shape:
//   { fiscal_year, fiscal_year_start_month,
//     committed_lines, committed_totals, last_committed_at }
//   - last_committed_at が null のレコードは「未反映 = 準備中」。
//     フィルタせずそのまま返し、準備中判定は呼び側 (Hook/UI) が行う。
// 該当レコードが無い場合は null を返す。
export async function getCommittedByClient(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at')
    .eq('client_id', clientId)
    .order('fiscal_year', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}
