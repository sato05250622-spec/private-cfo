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

  // 人名検索 query。空文字なら全件、それ以外は name.includes(query) でフィルタ (admin と同パターン)。
  const [query, setQuery] = useState('');
  const filteredTargets = useMemo(() => {
    const q = query.trim();
    if (!q) return targets;
    return targets.filter((t) => (t?.name || '').includes(q));
  }, [targets, query]);

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

        {/* 人名検索: 対象者 1 名以上のときだけ表示。空 query は全件 (filteredTargets = targets)。 */}
        {!targetsLoading && targets.length > 0 && (
          <div style={{
            background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 8,
            padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{ fontSize: 11, color: TEXT_MUTED, fontWeight: 700, whiteSpace: 'nowrap' }}>🔍</span>
            <input
              type="text" placeholder="氏名で検索" value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{
                flex: '1 1 auto', minWidth: 100, background: NAVY2, color: TEXT_PRIMARY,
                border: `1px solid ${BORDER}`, borderRadius: 6, padding: '4px 8px', fontSize: 11, outline: 'none',
              }}
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                style={{
                  padding: '3px 8px', borderRadius: 5, background: 'transparent',
                  border: `1px solid ${GOLD}55`, color: GOLD, fontSize: 10, fontWeight: 700,
                  cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >クリア</button>
            )}
            <span style={{ fontSize: 9, color: TEXT_MUTED, whiteSpace: 'nowrap' }}>
              {filteredTargets.length} / {targets.length} 人
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
            categoryMap={categoryMap}
            msd={msd}
          />
        ))}
        {!targetsLoading && !targetsError && targets.length > 0 && filteredTargets.length === 0 && (
          <div style={{ color: TEXT_MUTED, padding: 12, textAlign: 'center', fontSize: 11 }}>
            「{query}」に一致する人はいません
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================
// TargetBlock — 1 対象者の写真2準拠 viewer
// =============================================================
function TargetBlock({ clientId, target, allExpenses, expensesLoading, categoryMap, msd }) {
  void msd; // FY 化により buildPeriodLabel から msd 引数を撤去 (本ブロックでは未使用)。
  const { incomes, loading: inLoading, error: inError } = useInvestmentIncomes(clientId, target.id);

  // この対象者に紐づく支出 (useExpenses の toApp で target_id / createdAt が乗っている。
  // soft-delete 済み expense は API 側で除外済み)。
  // Task #4: 明示タグ (target_id) と memo 部分一致の OR で引き取る。
  //   - byId : expense.target_id === target.id (既存の明示タグ)
  //   - byMemo: target.name.trim() が非空 AND memo が非nullで target.name を substring 含む
  // target.name が空白のみのときは byMemo を発火させない (全支出引き込み事故防止)。
  // 両ヒット時は id で 1 件に重複排除して 1 回だけ集計する。本部と完全一致のロジック。
  const expensesForTarget = useMemo(() => {
    const list = allExpenses || [];
    const targetName = (target.name || '').trim();
    const map = new Map();
    for (const e of list) {
      if (!e) continue;
      const byId = e.target_id === target.id;
      const byMemo = targetName !== '' && e.memo != null && String(e.memo).includes(targetName);
      if (byId || byMemo) {
        if (!map.has(e.id)) map.set(e.id, e);
      }
    }
    return Array.from(map.values());
  }, [allExpenses, target.id, target.name]);

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
          横スクロール + 両端固定: 日付列 (左) と 入出金列 (右) を position:sticky で常時表示、
          中央 (項目・メモ) のみ横スクロールで動く。縦の maxHeight/overflowY は撤去。 */}
      <div style={{
        marginTop: 10, overflowX: 'auto',
        border: `1px solid ${GRID}`, borderRadius: 6,
      }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 0, width: '100%', minWidth: 480, border: `1px solid ${GRID}` }}>
          <thead>
            <tr style={{ background: NAVY3 }}>
              {/* 日付 (sticky left): 細幅 56px。Excel 風縦罫線 + 下罫線。 */}
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
                position: 'sticky', left: 0, background: NAVY3, zIndex: 2,
                width: 56, minWidth: 56,
              }}>日付</th>
              {/* 項目 (通常列、横スクロールで動く) */}
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
              }}>項目</th>
              {/* メモ (通常列、横スクロールで動く、広め) */}
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'left', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
              }}>メモ</th>
              {/* 入出金 (sticky right): 常時右端表示。背景色でスクロール下を隠す。 */}
              <th style={{
                padding: '5px 6px', fontSize: 9, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                textAlign: 'right', whiteSpace: 'nowrap',
                borderBottom: `1px solid ${BORDER}`,
                position: 'sticky', right: 0, background: NAVY3, zIndex: 2,
                borderLeft: `1px solid ${GRID}`,
              }}>入出金</th>
            </tr>
          </thead>
          <tbody>
            {mergedRows.length === 0 ? (
              <tr><td colSpan={4} style={{ padding: '12px 6px', color: TEXT_MUTED, textAlign: 'center', fontSize: 10 }}>明細なし</td></tr>
            ) : (
              mergedRows.map((r) => <DetailRow key={`${r.kind}-${r.id}`} row={r} />)
            )}
          </tbody>
          <tfoot>
            {/* フッター: 日付/項目/メモは空、入出金 (sticky right) に差し引き純額のみ。 */}
            <tr style={{ background: NAVY2 }}>
              <td style={{ ...footCell(false), position: 'sticky', left: 0, background: NAVY2, zIndex: 2 }} />
              <td style={footCell(false)} />
              <td style={footCell(false)} />
              <td style={{
                ...footCell(true), textAlign: 'right', color: finalDiff >= 0 ? BUDGET_BLUE : RED,
                position: 'sticky', right: 0, background: NAVY2, zIndex: 2,
                borderLeft: `1px solid ${GRID}`,
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
// SalesBox — 写真2 の「売上金」KPI ブロック
//   左: total_income (赤) と 回収率% (= total_income / expensesTotal × 100)
//   区切り: 「/」
//   右: grandIncome (青) と 回収率% (= grandIncome / expensesTotal × 100)
//   expensesTotal=0 のとき rate は「—」表示。
// =============================================================
function SalesBox({ totalIncome, grandIncome, expensesTotal }) {
  const leftPct  = fmtPct(totalIncome, expensesTotal);
  const rightPct = fmtPct(grandIncome, expensesTotal);
  // 達成率バーの幅算出用 (fmtPct と同じ判定の数値版)。null のときバー非表示 (分母 0)。
  const leftNum  = pctNum(totalIncome, expensesTotal);
  const rightNum = pctNum(grandIncome, expensesTotal);
  const cellStyle = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 2, flex: '1 1 0', minWidth: 0 };
  // 達成率バー (横棒): 全幅 100% で fill = Math.min(pctNum, 100)%。
  //   色は %で動的: >=100% (回収済み) → BUDGET_BLUE / <100% (未達) → RED。
  //   数字ラベルは本当の値 (233%/300% もそのまま) を別表示、バーは 100% 頭打ち。
  //   分母 0 (pctNum == null) のとき非表示。
  const Bar = ({ pct }) => (
    pct == null ? null : (
      <div style={{
        width: '100%', height: 4, background: 'rgba(255,255,255,0.08)',
        borderRadius: 2, overflow: 'hidden', marginTop: 2,
      }}>
        <div style={{
          width: `${Math.min(pct, 100)}%`, height: '100%',
          background: pct >= 100 ? BUDGET_BLUE : RED,
          transition: 'width 0.3s, background 0.3s',
        }} />
      </div>
    )
  );
  return (
    <div style={{
      background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 8,
      padding: '8px 10px',
    }}>
      <div style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 700, letterSpacing: '0.06em', marginBottom: 4, textAlign: 'center' }}>売上金</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* 左: total_income (RED) */}
        <div style={cellStyle}>
          <div style={{ fontSize: 14, fontWeight: 700, color: RED, lineHeight: 1.1, whiteSpace: 'nowrap', textAlign: 'center' }}>
            {fmtY(totalIncome)}
          </div>
          <div style={{ fontSize: 9, color: RED, fontWeight: 700, textAlign: 'center' }}>回収率 {leftPct}</div>
          <Bar pct={leftNum} />
        </div>
        {/* 区切り */}
        <div style={{ fontSize: 14, color: TEXT_MUTED, fontWeight: 400, flexShrink: 0 }}>/</div>
        {/* 右: grandIncome (BUDGET_BLUE) */}
        <div style={cellStyle}>
          <div style={{ fontSize: 14, fontWeight: 700, color: BUDGET_BLUE, lineHeight: 1.1, whiteSpace: 'nowrap', textAlign: 'center' }}>
            {fmtY(grandIncome)}
          </div>
          <div style={{ fontSize: 9, color: BUDGET_BLUE, fontWeight: 700, textAlign: 'center' }}>回収率 {rightPct}</div>
          <Bar pct={rightNum} />
        </div>
      </div>
    </div>
  );
}

// =============================================================
// DetailRow — マージ済 1 行 (4 列: 日付 / 項目 / メモ / 入出金)
// =============================================================
function DetailRow({ row }) {
  const isIncome = row.kind === 'income';
  // 横スクロール sticky 両端のため、行 background は <td> 個別に塗る (sticky 列は親 <tr>
  //   の背景を継承せず透過するため、入金行のティント色を sticky 側にも明示適用)。
  const rowBg = isIncome ? `${BUDGET_BLUE}12` : 'transparent';
  const stickyBg = isIncome ? '#0B1A2E' : NAVY3; // sticky 列のスクロール下を隠す不透明背景
  const td = (right = false, color = TEXT_PRIMARY) => ({
    padding: '4px 6px', fontSize: 10, color,
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${GRID}`,
    textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap',
  });
  return (
    <tr style={{ background: rowBg }}>
      {/* 日付 (sticky left): MM/DD 表示で sticky 56px 幅に収まる。 */}
      <td style={{
        ...td(),
        position: 'sticky', left: 0, background: stickyBg, zIndex: 1,
        width: 56, minWidth: 56,
      }}>{fmtMD(row.date)}</td>
      <td style={td(false, isIncome ? BUDGET_BLUE : TEXT_PRIMARY)}>{row.label || '—'}</td>
      <td style={{ ...td(), whiteSpace: 'normal', maxWidth: 220 }}>{row.memo || '—'}</td>
      {/* 入出金 (sticky right): 常に右端表示。 */}
      <td style={{
        ...td(true), color: isIncome ? BUDGET_BLUE : RED, fontWeight: 700,
        position: 'sticky', right: 0, background: stickyBg, zIndex: 1,
        borderLeft: `1px solid ${GRID}`, borderRight: 'none',
      }}>
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
