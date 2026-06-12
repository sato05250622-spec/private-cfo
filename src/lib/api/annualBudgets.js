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

// Phase 2-2a (2026-06-11): live 読取列を camelCase でも返却に露出する shim。
//   既存 snake_case (income_lines / lines / annual_total_target) は ...row により
//   そのまま残す。incomeLines / annualTotalTarget の camelCase mirror を追加。
//   lines は既に小文字1単語なので snake/camel が同名 (null→[] のデフォルトのみ)。
//   既存 committed_* キーは無改変 (hook 側で従来通り snake_case を読める)。
function withCamel(row) {
  if (!row) return null;
  return {
    ...row,
    incomeLines: row.income_lines ?? [],
    lines: row.lines ?? [],
    annualTotalTarget: row.annual_total_target ?? null,
  };
}

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
      // Phase G 反映バグ Fix (2026-06-12): settled_months (LIVE) を追加。
      //   D-B で useAnnualBudgets.js:54 が `settled_months: row.settled_months ?? []` を露出した際に
      //   SELECT 側への追加が抜けて、AssetSheetViewer の settledMonths が常に [] にフォールバックしていた。
      //   admin AssetSheetTab L148-151 が currentBudget?.settled_months を参照するのと同源 (LIVE 列)。
      //   committed_settled_months は別カラム (snapshot 用)、これは無改変。
      .select('fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at, committed_income_lines, income_committed_at, income_lines, lines, annual_total_target, settled_months')
      .eq('client_id', clientId)
      .eq('fiscal_year', fiscalYear)
      .maybeSingle();
    if (error) throw error;
    return withCamel(data);
  }
  // Phase G 反映バグ Fix (2026-06-12): settled_months (LIVE) を追加 (同上理由)。
  const SELECT = 'fiscal_year, fiscal_year_start_month, committed_lines, committed_totals, committed_settled_months, committed_annual_total_target, last_committed_at, committed_income_lines, income_committed_at, income_lines, lines, annual_total_target, settled_months';
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
  if (committed.data) return withCamel(committed.data);
  // 反映済みが無い場合のみ、絶対最新年度 (未反映含む) を返す (従来挙動のフォールバック)。
  const latest = await supabase
    .from(TABLE)
    .select(SELECT)
    .eq('client_id', clientId)
    .order('fiscal_year', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) throw latest.error;
  return withCamel(latest.data);
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

// =============================================================
// Phase 2-2a (2026-06-11): 顧客直接編集に向けた write API。
//   admin リポ src/lib/api/annualBudgets.js (updateIncomeLines L307 /
//   setInitialAsset L363) をロジック完全一致で顧客側へ移植。
//   顧客は自分の行のみ更新するので entered_by 等の proxy フィールドは不要。
//   所有権は RLS (Phase 2-3 で追加予定の annual_budgets_client_update_own:
//   client_id = auth.uid()) が担保する前提。
//
//   ※ Phase 2-3 までは顧客 UPDATE 用 RLS が未追加のため、本ターン時点で
//      実行すると RLS により拒否される想定。UI からは未呼出のため本番影響なし。
// =============================================================

// annual_budgets.income_lines (jsonb 配列) をピンポイント更新。
//   対象行: client_id = clientId AND fiscal_year = fiscalYear (二重絞り込み)。
//   incomeLines は jsonb 配列をそのまま保存 (caller が構築済み)。null は [] に正規化。
export async function updateIncomeLines(clientId, fiscalYear, incomeLines) {
  if (!clientId) throw new Error('clientId required');
  if (fiscalYear == null) throw new Error('fiscalYear required');
  const { data, error } = await supabase
    .from(TABLE)
    .update({ income_lines: incomeLines ?? [] })
    .eq('client_id', clientId)
    .eq('fiscal_year', fiscalYear)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// profiles.initial_asset のみ列限定 update (他列を絶対に触らない)。
//   対象: id = clientId (= auth.uid())。NaN/非数は 0 に正規化。
export async function setInitialAsset(clientId, value) {
  if (!clientId) throw new Error('clientId required');
  const n = Number(value);
  const safe = Number.isFinite(n) ? n : 0;
  const { data, error } = await supabase
    .from('profiles')
    .update({ initial_asset: safe })
    .eq('id', clientId)
    .select()
    .single();
  if (error) throw error;
  return data;
}
