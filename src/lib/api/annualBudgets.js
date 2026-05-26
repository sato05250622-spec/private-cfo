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
// ③: fiscalYear 省略時は最新年度 (fiscal_year DESC, limit 1)、指定時はその年度を取得。
export async function getCommittedByClient(clientId, fiscalYear) {
  if (!clientId) return null;
  let q = supabase
    .from(TABLE)
    .select('fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at')
    .eq('client_id', clientId);
  if (fiscalYear != null) {
    q = q.eq('fiscal_year', fiscalYear);
  } else {
    q = q.order('fiscal_year', { ascending: false }).limit(1);
  }
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// ③: 指定 client の「確定済み (反映済み)」年度一覧を新しい順 (DESC) で返す。
//   条件は getCommittedByClient の対象に合わせ client_id 一致。さらに last_committed_at
//   非 null (= 反映済み = 準備中でない) に絞り、ダイヤルに出す年度を実体のあるものに限定。
//   返却: number[] (重複除去・降順)。該当無しは []。
export async function listFiscalYearsByClient(clientId) {
  if (!clientId) return [];
  const { data, error } = await supabase
    .from(TABLE)
    .select('fiscal_year')
    .eq('client_id', clientId)
    .not('last_committed_at', 'is', null)
    .order('fiscal_year', { ascending: false });
  if (error) throw error;
  const seen = new Set();
  const out = [];
  for (const r of data ?? []) {
    const y = Number(r?.fiscal_year);
    if (Number.isFinite(y) && !seen.has(y)) { seen.add(y); out.push(y); }
  }
  return out;
}
