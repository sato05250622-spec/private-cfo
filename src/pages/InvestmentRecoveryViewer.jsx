// =============================================================
// 人別経費投資回収シート (顧客アプリ・閲覧専用)
// -------------------------------------------------------------
// #3-B 顧客レイアウト改修 (写真2準拠、本部とは別構造):
//   - ヘッダ: 左に氏名 + 「対象年 YYYY年MM月〜YYYY年MM月」、右上に「経費合計 ¥X円」(赤)
//   - 売上金 box: 左=total_income (赤) と 回収率%、区切り「/」、右=grandIncome (青) と 回収率%
//     - 回収率 = (額) / expensesTotal × 100 (整数)。expensesTotal=0 のとき rate は「—」
//   - 内訳テーブル: 4列 (日付 / 項目 / メモ / 入出金)
//   - フッター: 「差し引き ¥{finalDiff}」(>=0 青 +、<0 赤 −)
//
// 計算 (本部 InvestmentRecoveryView と同式):
//   expensesTotal = Σ expensesForTarget.amount
//   incomesTotal  = Σ incomes.amount
//   grandIncome   = target.total_income + incomesTotal
//   finalDiff     = grandIncome − expensesTotal
//
// 流用 (変更なし):
//   - 経費フィルタ (target_id + memo 部分一致、Map dedup)
//   - mergedRows ソート (date ASC、createdAt 2 次キー)
//   - Realtime / focus・visibility refetch (各 hook 内)
//
// 期間表示の msd:
//   utils/cycle.js: getManagementStartDay() (localStorage) → AuthContext で profile から sync。
//   取得不可 (未ログイン / 未設定) なら msd=1 フォールバック (calendar 年と等価)。
//
// テーマ: NAVY/GOLD (@shared/theme)。入金=青 (BUDGET_BLUE)、経費=赤 (RED)。
// =============================================================
import { useMemo, useState } from 'react';
import {
  GOLD, NAVY2, NAVY3, CARD_BG, BORDER, RED,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from '@shared/theme';
import { useInvestmentTargets } from '../hooks/useInvestmentTargets';
import { useInvestmentIncomes } from '../hooks/useInvestmentIncomes';
import { useExpenses } from '../hooks/useExpenses';
import { useCategories } from '../hooks/useCategories';
import { getManagementStartDay } from '../utils/cycle';
import { PopoverDial } from '../components/MonthDialPicker';

// #3-B: 予算系=青 (本部 BLUE / 顧客 BUDGET_BLUE と統一)。入金・繰越色として使用。
const BUDGET_BLUE = '#5BA8FF';
// 表のグリッド線 (Excel 風縦罫線)。本部版 GRID と同じ低透明 GOLD。
const GRID = 'rgba(212,168,67,0.28)';

// 金額表示 ¥カンマ区切り。マイナスは − プレフィクス、プラスは + 任意。null/NaN は "—"。
function fmtY(n, opts = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 0) return `−¥${Math.abs(v).toLocaleString()}`;
  return `${opts.plus && v > 0 ? '+' : ''}¥${v.toLocaleString()}`;
}

// 整数 % 表示 (回収率)。expensesTotal=0 のとき "—"。
function fmtPct(numerator, denominator) {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) return '—';
  const n = Number(numerator) || 0;
  return `${Math.round((n / d) * 100)}%`;
}

// 数値 % (達成率バーの幅算出用)。fmtPct と同じ判定ロジックを数値で返す。
//   expensesTotal<=0 のとき null → バーは描画しない。
function pctNum(numerator, denominator) {
  const d = Number(denominator);
  if (!Number.isFinite(d) || d <= 0) return null;
  return Math.round(((Number(numerator) || 0) / d) * 100);
}

// 日付短縮 (年度ブロック内のため YYYY 部を省略)。
//   "2026-04-15" → "04/15"。空/不正値は "—"。admin と同じヘルパ。
function fmtMD(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const m = iso.match(/^\d{4}-(\d{2})-(\d{2})/);
  return m ? `${m[1]}/${m[2]}` : iso;
}

// 日付 (ISO) を FY 開始年に変換 (4 月開始)。
//   2026-04-01 → 2026  /  2026-03-31 → 2025  /  2027-03-31 → 2026
//   不正値は null (caller 側で除外)。
function expFY(date) {
  if (!date || typeof date !== 'string') return null;
  const m = date.match(/^(\d{4})-(\d{2})-/);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  return mm >= 4 ? y : y - 1;
}

// 期間ラベル: target_year を FY (4 月開始) の開始年として扱い、
//   「YYYY 年 4 月〜翌年 3 月」を組み立てる。
//   admin の target_year=FY 開始年と意味を揃える。msd 補正は本機能スコープ外
//   (旧仕様は cycleStart/cycleEnd で暦年 1 月起点 + msd 補正だったが、FY 化により撤去)。
function buildPeriodLabel(targetYear) {
  const ty = Number(targetYear);
  if (!Number.isFinite(ty)) return '';
  return `${ty}年4月〜${ty + 1}年3月`;
}

// =============================================================
// 親ビュー: 対象者一覧 (閲覧専用、追加 UI なし)
// =============================================================
export default function InvestmentRecoveryViewer({ clientId }) {
  const {
    targets, loading: targetsLoading, error: targetsError,
  } = useInvestmentTargets(clientId);
  // 全 expenses は一度に取得 (target_id でフィルタするため)。
  const { expenses, loading: expLoading, error: expError } = useExpenses();
  // カテゴリ表示用 (id → label)。読み込み中は id をそのまま出すフォールバック。
  const { categories } = useCategories();
  const categoryMap = useMemo(() => {
    const m = new Map();
    for (const c of (categories || [])) m.set(c.id, c.label);
    return m;
  }, [categories]);

  // 顧客自身の管理開始日 (1-31)。AuthContext が localStorage に同期している値を読む。
  // 未設定なら 1 にフォールバック (calendar 年と等価表示)。
  const msd = getManagementStartDay() ?? 1;

  // 年度ダイヤル: targets から年度候補を動的算出 (降順)、selectedYear=null は最新年度。
  //   PopoverDial (繰越票で実績あり) を流用。空配列のとき UI 非表示で安全。
  const fiscalYears = useMemo(
    () => [...new Set((targets || []).map((t) => t.target_year).filter((y) => Number.isFinite(Number(y))))]
      .sort((a, b) => b - a),
    [targets],
  );
  const [selectedYear, setSelectedYear] = useState(null);
  const currentYear = selectedYear ?? (fiscalYears[0] ?? null);
  const yearFilteredTargets = useMemo(
    () => (currentYear == null ? targets : targets.filter((t) => t.target_year === currentYear)),
    [targets, currentYear],
  );

  // タスク⑲ (2026-06-02): 氏名検索を廃止 (本部 admin と同仕様)。年度フィルタの結果をそのまま使う。
  const filteredTargets = yearFilteredTargets;

  // タスク⑲ (2026-06-02): 月絞り込み (案B = ブロック内 mergedRows のみ絞る、人物ブロックは全表示)。
  //   - null = 全月 (既存挙動と完全同一)
  //   - 1..12 = displayRows のみ絞り、サマリー (expensesTotal/grandIncome/finalDiff/headerPct) は
  //     mergedRows 非依存 (expensesForTarget/incomes 直接ベース) のため全月通算のまま自動維持。
  const [selectedMonth, setSelectedMonth] = useState(null);

  // アコーディオン: 撤去済 (A 確定で全展開固定)。前回の expanded Set / toggleExpanded /
  //   isOpen / onToggle / ▼/▶ ヘッダ / {isOpen && <>} Fragment ガードは全て撤去。
  //   各 TargetBlock は SalesBox + 内訳テーブル + フッターを常に表示。

  if (!clientId) {
    return (
      <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, padding: 16, color: TEXT_MUTED, fontSize: 12 }}>
        ログイン後に表示されます。
      </div>
    );
  }

  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
      {/* ヘッダ */}
      <div style={{ padding: '12px 16px', borderBottom: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 40, height: 40, borderRadius: 10, background: `${BUDGET_BLUE}22`, border: `1px solid ${BUDGET_BLUE}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>📊</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: GOLD }}>人別経費投資回収シート</div>
          <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 2 }}>本部が管理した対象者ごとの売上金・経費・差し引き</div>
        </div>
      </div>

      <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {targetsLoading && <div style={{ color: TEXT_MUTED, padding: 10, fontSize: 11 }}>読込中…</div>}
        {targetsError && <div style={{ color: '#ff6b6b', padding: 10, fontSize: 11 }}>エラー: {String(targetsError?.message ?? targetsError)}</div>}
        {expError && <div style={{ color: '#ff6b6b', padding: 10, fontSize: 11 }}>支出取得エラー: {String(expError?.message ?? expError)}</div>}
        {!targetsLoading && !targetsError && targets.length === 0 && (
          <div style={{ color: TEXT_MUTED, padding: 14, textAlign: 'center', fontSize: 11 }}>
            対象者なし
          </div>
        )}

        {/* 検索 + 年度ダイヤル: 対象者 1 名以上のときだけ表示。空 query は年度フィルタ後の全件。
            PopoverDial (繰越票で実績あり) を流用、選択肢は targets から動的算出した fiscalYears。 */}
        {!targetsLoading && targets.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 8,
            padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            {/* 年度ダイヤル: fiscalYears が 1 件以上のときだけ出す。 */}
            {fiscalYears.length > 0 && (
              <PopoverDial
                items={fiscalYears.map((y) => ({ key: y, label: `${y}年度` }))}
                value={currentYear}
                onChange={(y) => setSelectedYear(Number(y))}
                placeholder="年度"
                width={120}
              />
            )}
            {/* タスク⑲ (2026-06-02): 月ダイヤル (年度ダイヤルの隣に併設、本部 admin と同仕様)。
                全月 (null) で既存挙動と同一、1..12 で displayRows のみ絞る (案B)。 */}
            <PopoverDial
              items={[
                { key: null, label: '全月' },
                ...Array.from({ length: 12 }, (_, i) => ({ key: i + 1, label: `${i + 1}月` })),
              ]}
              value={selectedMonth}
              onChange={(m) => setSelectedMonth(m == null ? null : Number(m))}
              placeholder="月"
              width={100}
            />
            {/* カウンタ: 氏名検索廃止に伴い X / Y → 単一値 N人 に簡素化。 */}
            <span style={{ fontSize: 9, color: TEXT_MUTED, whiteSpace: 'nowrap' }}>
              {filteredTargets.length} 人
            </span>
          </div>
        )}

        {filteredTargets.map((t) => (
          <TargetBlock
            key={t.id}
            clientId={clientId}
            target={t}
            allExpenses={expenses || []}
            expensesLoading={expLoading}
            selectedMonth={selectedMonth}
            categoryMap={categoryMap}
            msd={msd}
          />
        ))}
        {!targetsLoading && !targetsError && targets.length > 0 && filteredTargets.length === 0 && (
          <div style={{ color: TEXT_MUTED, padding: 12, textAlign: 'center', fontSize: 11 }}>
            {`${currentYear ?? ''}年度の対象者はいません`}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================
// TargetBlock — 1 対象者の写真2準拠 viewer
// =============================================================
function TargetBlock({ clientId, target, allExpenses, expensesLoading, selectedMonth, categoryMap, msd }) {
  void msd; // FY 化により buildPeriodLabel から msd 引数を撤去 (本ブロックでは未使用)。
  const { incomes, loading: inLoading, error: inError } = useInvestmentIncomes(clientId, target.id);

  // この対象者に紐づく支出 (useExpenses の toApp で target_id / createdAt が乗っている。
  // soft-delete 済み expense は API 側で除外済み)。
  // 年度ダイヤル対応の二重カウント対策版:
  //   - byId : expense.target_id === target.id (明示タグ、年度判定不要)
  //   - byMemo: target_id == null かつ memo に target.name 含み、
  //             かつ expFY(date) === target.target_year のときだけ拾う。
  //             ← 同名人物の複数年度 target が並んでも同一 expense が両方の target に紐づくのを防ぐ。
  //   target.name が空白のみのときは byMemo を発火させない (全支出引き込み事故防止)。
  //   両ヒット時は id で 1 件に重複排除。
  const expensesForTarget = useMemo(() => {
    const list = allExpenses || [];
    const targetName = (target.name || '').trim();
    const ty = Number(target.target_year);
    const map = new Map();
    for (const e of list) {
      if (!e) continue;
      const byId = e.target_id === target.id;
      const byMemo = (
        e.target_id == null
        && targetName !== ''
        && e.memo != null
        && String(e.memo).includes(targetName)
        && Number.isFinite(ty)
        && expFY(e.date) === ty
      );
      if (byId || byMemo) {
        if (!map.has(e.id)) map.set(e.id, e);
      }
    }
    return Array.from(map.values());
  }, [allExpenses, target.id, target.name, target.target_year]);

  // 経費合計 / 入金合計 / 総入金 (= total_income + Σ入金) / 差し引き — 本部と同式。
  const expensesTotal = useMemo(
    () => expensesForTarget.reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [expensesForTarget],
  );
  const incomesTotal = useMemo(
    () => (incomes || []).reduce((s, r) => s + (Number(r.amount) || 0), 0),
    [incomes],
  );
  const grandIncome = (Number(target.total_income) || 0) + incomesTotal;
  const finalDiff = grandIncome - expensesTotal;

  // マージ行 (date 昇順、同日は createdAt 安定ソート、本部と同ロジック)。
  // 累計 / 差額 / 判定 は写真2 仕様で削除 — 売上金 box に集約済。
  const mergedRows = useMemo(() => {
    const rows = [];
    for (const e of expensesForTarget) {
      rows.push({
        kind: 'expense',
        id: e.id,
        date: e.date,
        // 写真2 準拠: 「項目」列はカテゴリ名 (categoryMap で id→label 解決)。未解決は id をそのまま。
        label: categoryMap.get(e.category) || e.category || '—',
        memo: e.memo ?? '',
        amount: Number(e.amount) || 0,
        // useExpenses の toApp は created_at を持たない (revert 後の安全モード) ため、
        // 二次ソートは expense 行では機能しない (常に '')。
        // 入金 (raw row) には created_at がある一方、expense (toApp) には無い → 同日比較は
        // 入金側のみ created_at を使う。実害は少ない。
        createdAt: '',
      });
    }
    for (const r of (incomes || [])) {
      rows.push({
        kind: 'income',
        id: r.id,
        date: r.date,
        // 写真2 準拠: 入金行の「項目」列は「入金」リテラル固定。
        label: '入金',
        memo: r.memo ?? '',
        amount: Number(r.amount) || 0,
        createdAt: r.created_at ?? '',
      });
    }
    rows.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '') < (b.date || '') ? -1 : 1;
      return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
    });
    return rows;
  }, [expensesForTarget, incomes, categoryMap]);

  // タスク⑲ (2026-06-02, 案B): selectedMonth で mergedRows を絞った表示用配列。
  //   - selectedMonth == null → mergedRows そのまま (全月、既存挙動と同一)
  //   - 1..12 → date='YYYY-MM-DD' の MM 部分が一致する行のみ
  //   ※ サマリー (expensesTotal/grandIncome/finalDiff/headerPct) は expensesForTarget/incomes
  //     直接ベースで mergedRows 非依存のため、月で絞っても全月通算値を維持する (顧客版は
  //     行単位の cum/diff/judge を持たない設計のため、案B の「累計を壊さない」配慮は自動成立)。
  const displayRows = useMemo(() => {
    if (selectedMonth == null) return mergedRows;
    const mm = String(selectedMonth).padStart(2, '0');
    return mergedRows.filter((r) => typeof r?.date === 'string' && r.date.substring(5, 7) === mm);
  }, [mergedRows, selectedMonth]);

  const periodLabel = buildPeriodLabel(target.target_year);
  // アコーディオン用: 畳んだ時のヘッダで表示する回収率% (SalesBox の rightPct と同式)。
  //   grandIncome / expensesTotal × 100。expensesTotal=0 のとき '—'。
  const headerPct = fmtPct(grandIncome, expensesTotal);

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 10 }}>
      {/* ヘッダ (常時表示・クリック不可): 左=氏名+期間 / 右=経費合計+回収率%。
          アコーディオン化撤去 (A 確定で全展開固定)。クリック・キーボード操作は除去。 */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 10, marginBottom: 10, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: GOLD, lineHeight: 1.2 }}>{target.name || '(無題)'}</div>
          <div style={{ fontSize: 10, color: TEXT_SECONDARY }}>対象年: <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>{periodLabel || '—'}</span></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 600, letterSpacing: '0.04em' }}>経費合計</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: RED, lineHeight: 1.1 }}>{fmtY(expensesTotal)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 600, letterSpacing: '0.04em' }}>回収率</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: BUDGET_BLUE, lineHeight: 1.1 }}>{headerPct}</div>
          </div>
        </div>
      </div>

      {/* 売上金 box (写真2 中央のメイン KPI) */}
      <SalesBox
        totalIncome={Number(target.total_income) || 0}
        grandIncome={grandIncome}
        expensesTotal={expensesTotal}
      />

      {inError && <div style={{ color: '#ff6b6b', fontSize: 10, marginTop: 6 }}>入金取得エラー: {String(inError?.message ?? inError)}</div>}
      {(inLoading || expensesLoading) && <div style={{ color: TEXT_MUTED, fontSize: 10, marginTop: 6 }}>読込中…</div>}

      {/* 内訳テーブル: 4 列 (日付 / 項目 / メモ / 入出金)。
          tableLayout:fixed + colgroup で 4 列が 1 画面に収まる。
          メモ列だけセル内部で横スクロールし、日付・項目・入出金は固定で常時表示。
          (横スクロール + sticky 両端の方式は撤去) */}
      <div style={{
        marginTop: 10, border: `1px solid ${GRID}`, borderRadius: 6, overflow: 'hidden',
      }}>
        <table style={{
          borderCollapse: 'separate', borderSpacing: 0,
          width: '100%', tableLayout: 'fixed',
          border: `1px solid ${GRID}`,
        }}>
          <colgroup>
            <col style={{ width: 52 }} />             {/* 日付: 細め */}
            <col />                                    {/* 項目: 通常 (fixed-layout の残幅で固定) */}
            <col />                                    {/* メモ: 同上、内部 overflow で長文を吸収 */}
            <col style={{ width: 84 }} />             {/* 入出金: 80-90px 範囲で 84 */}
          </colgroup>
          <thead>
            <tr style={{ background: NAVY3 }}>
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
              }}>日付</th>
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
              }}>項目</th>
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
              }}>メモ</th>
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'right', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`,
              }}>入出金</th>
            </tr>
          </thead>
          <tbody>
            {/* タスク⑲ (2026-06-02): displayRows (selectedMonth で絞った行) を描画。
                サマリー (売上金/差し引き/回収率) は mergedRows 非依存で全月通算維持。 */}
            {displayRows.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: '12px 6px', color: TEXT_MUTED, textAlign: 'center', fontSize: 10 }}>明細なし</td></tr>
            ) : (
              displayRows.map((r) => <DetailRow key={`${r.kind}-${r.id}`} row={r} />)
            )}
          </tbody>
          <tfoot>
            {/* フッター: 日付/項目/メモは空、入出金列に差し引き純額のみ。 */}
            <tr style={{ background: NAVY2 }}>
              <td style={footCell(false)} />
              <td style={footCell(false)} />
              <td style={footCell(false)} />
              <td style={{
                ...footCell(true), textAlign: 'right',
                color: finalDiff >= 0 ? BUDGET_BLUE : RED,
              }}>
                {/* finalDiff>=0 は青 + プレフィクス、<0 は赤 − プレフィクス。fmtY はマイナスを − で出す。 */}
                {finalDiff >= 0 ? fmtY(finalDiff, { plus: true }) : fmtY(finalDiff)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// =============================================================
// SalesBox — 売上金 KPI (1 値 + 1 バー)。
//   表示: 「売上金 ¥{grandIncome}」+ 「回収率 {pct}% (経費比)」+ 横棒 1 本。
//   pct  = grandIncome / expensesTotal × 100 (100% 超もラベルはそのまま)。
//   バー = 幅 Math.min(pct, 100)%、色は pct>=100 → BUDGET_BLUE (回収済) / <100 → RED (未達)。
//   分母 0 (経費 0) のときバー非表示、回収率ラベルは "—"。
//   totalIncome / leftPct / rightPct / 「/」セパレータの 2 セル分割 UI は撤去。
// =============================================================
function SalesBox({ totalIncome, grandIncome, expensesTotal }) {
  void totalIncome; // 1 本化により未使用。signature 互換のため引数据置き。
  const pctLabel = fmtPct(grandIncome, expensesTotal);
  const pctVal   = pctNum(grandIncome, expensesTotal); // null = バー非表示 (分母 0)
  const barColor = pctVal != null && pctVal >= 100 ? BUDGET_BLUE : RED;
  return (
    <div style={{
      background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '10px 12px',
    }}>
      <div style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 700, letterSpacing: '0.06em', marginBottom: 4, textAlign: 'center' }}>売上金</div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 10, flexWrap: 'wrap' }}>
        {/* 売上金 ¥grandIncome (バー色と同期: >=100 青 / <100 赤) */}
        <div style={{ fontSize: 18, fontWeight: 700, color: barColor, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
          {fmtY(grandIncome)}
        </div>
        {/* 回収率 (経費比) */}
        <div style={{ fontSize: 11, fontWeight: 700, color: barColor, whiteSpace: 'nowrap' }}>
          回収率 {pctLabel} <span style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 400 }}>(経費比)</span>
        </div>
      </div>
      {/* 横棒 1 本: 幅 = min(pct, 100)%、色 = pct>=100 ? 青 : 赤。分母 0 のとき非表示。 */}
      {pctVal != null && (
        <div style={{
          width: '100%', height: 6, background: 'rgba(255,255,255,0.08)',
          borderRadius: 3, overflow: 'hidden', marginTop: 8,
        }}>
          <div style={{
            width: `${Math.min(pctVal, 100)}%`, height: '100%',
            background: barColor,
            transition: 'width 0.3s, background 0.3s',
          }} />
        </div>
      )}
    </div>
  );
}

// =============================================================
// DetailRow — マージ済 1 行 (4 列: 日付 / 項目 / メモ / 入出金)
// =============================================================
function DetailRow({ row }) {
  const isIncome = row.kind === 'income';
  const rowBg = isIncome ? `${BUDGET_BLUE}12` : 'transparent';
  const td = (right = false, color = TEXT_PRIMARY) => ({
    padding: '4px 6px', fontSize: 10, color,
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${GRID}`,
    textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap',
  });
  return (
    <tr style={{ background: rowBg }}>
      {/* 日付: 52px (colgroup) に MM/DD で収容。 */}
      <td style={td()}>{fmtMD(row.date)}</td>
      {/* 項目: 固定列。長文は ellipsis でクリップ (スクロール無し)。 */}
      <td style={{ ...td(false, isIncome ? BUDGET_BLUE : TEXT_PRIMARY), overflow: 'hidden', textOverflow: 'ellipsis' }}
        title={row.label || ''}
      >{row.label || '—'}</td>
      {/* メモ: セル内部だけ横スクロール (overflowX:auto)。長文は中身が動く。
          中身 <span> を whiteSpace:nowrap で 1 行固定し、td の overflowX で横スクロール。 */}
      <td style={{ ...td(), overflowX: 'auto', whiteSpace: 'nowrap', padding: 0 }}>
        <span style={{
          display: 'inline-block', whiteSpace: 'nowrap',
          padding: '4px 6px',
        }}>{row.memo || '—'}</span>
      </td>
      {/* 入出金: 84px (colgroup) に常時表示。 */}
      <td style={{ ...td(true), color: isIncome ? BUDGET_BLUE : RED, fontWeight: 700, borderRight: 'none' }}>
        {isIncome ? fmtY(row.amount, { plus: true }) : fmtY(-row.amount)}
      </td>
    </tr>
  );
}

function footCell(strong) {
  return {
    padding: '6px 6px', fontSize: 10, color: GOLD, fontWeight: strong ? 700 : 600,
    borderTop: `2px solid ${GOLD}55`,
    borderRight: `1px solid ${GRID}`,
    whiteSpace: 'nowrap',
  };
}
