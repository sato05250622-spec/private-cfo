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

// 指定 client の繰越票を 1 件取得。
// 返却 shape:
//   { fiscal_year, fiscal_year_start_month,
//     committed_lines, committed_totals, last_committed_at }
//   - last_committed_at が null のレコードは「未反映 = 準備中」。
//     指定年度 (fiscalYear) 取得時はフィルタせずそのまま返し、準備中判定は呼び側に委ねる。
// 該当レコードが無い場合は null を返す。
// ③/修正B: fiscalYear 指定時はその年度。省略時は「最新の“反映済み”年度」(last_committed_at
//   not null の最大 fiscal_year)。年度ダイヤル候補 (listFiscalYearsByClient) と既定表示を
//   揃え、年度ロールオーバー直後の未反映年度 (例: FY2026) を既定で掴んで "準備中" に
//   落ちるのを防ぐ。反映済みが1件も無いときのみ、絶対最新年度 (未反映含む) にフォールバック。
export async function getCommittedByClient(clientId, fiscalYear) {
  if (!clientId) return null;
  if (fiscalYear != null) {
    const { data, error } = await supabase
      .from(TABLE)
      .select('fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at')
      .eq('client_id', clientId)
      .eq('fiscal_year', fiscalYear)
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  }
  const SELECT = 'fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at';
  // 既定: 反映済み (last_committed_at not null) の最新年度を優先。
  const committed = await supabase
    .from(TABLE)
    .select(SELECT)
    .eq('client_id', clientId)
    .not('last_committed_at', 'is', null)
    .order('fiscal_year', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (committed.error) throw committed.error;
  if (committed.data) return committed.data;
  // 反映済みが無い場合のみ、絶対最新年度 (未反映含む) を返す (従来挙動のフォールバック)。
  const latest = await supabase
    .from(TABLE)
    .select(SELECT)
    .eq('client_id', clientId)
    .order('fiscal_year', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw latest.error;
  return latest.data ?? null;
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
