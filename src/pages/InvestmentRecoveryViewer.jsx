// =============================================================
// 人別経費投資回収シート (顧客アプリ・閲覧専用)
// -------------------------------------------------------------
// 参考: ~/Desktop/private-cfo-admin/src/pages/InvestmentRecoveryView.jsx
// 同じ計算ロジック (総入金/経費累計/回収差額/判定) と縦罫線グリッドを踏襲。
// ただし顧客側は閲覧専用 — 追加/編集/削除/入力フォームを一切持たない。
//
// 計算 (本部版と完全一致):
//   総入金 = target.total_income + Σ incomes.amount
//   経費累計 = 経費行のみ累積 (入金行では加算しない)
//   回収差額 (経費行のみ) = 総入金 − その行までの経費累計
//   判定 = >=0「回収済」/ <0「未回収」
//
// テーマ: NAVY/GOLD (@shared/theme)。入金は TEAL (+¥)、経費は (¥xxx)。
// =============================================================
import { useMemo } from 'react';
import {
  GOLD, NAVY2, NAVY3, CARD_BG, BORDER, RED, TEAL,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from '@shared/theme';
import { useInvestmentTargets } from '../hooks/useInvestmentTargets';
import { useInvestmentIncomes } from '../hooks/useInvestmentIncomes';
import { useExpenses } from '../hooks/useExpenses';

// 表のグリッド線 (Excel 風縦罫線)。本部版 GRID と同じ低透明 GOLD。
const GRID = 'rgba(212,168,67,0.28)';

// 金額表示 ¥カンマ区切り。マイナスは (¥xxx)。null/NaN は "—"。
function fmtY(n, opts = {}) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 0) return `(¥${Math.abs(v).toLocaleString()})`;
  return `${opts.plus && v > 0 ? '+' : ''}¥${v.toLocaleString()}`;
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
      <div style={{ padding: '14px 18px', borderBottom: `1px solid ${BORDER}`, display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${TEAL}22`, border: `1px solid ${TEAL}44`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>📊</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: GOLD }}>人別経費投資回収シート</div>
          <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 3 }}>本部が管理した対象者ごとの経費・入金・回収状況</div>
        </div>
      </div>

      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {targetsLoading && <div style={{ color: TEXT_MUTED, padding: 12, fontSize: 12 }}>読込中…</div>}
        {targetsError && <div style={{ color: '#ff6b6b', padding: 12, fontSize: 12 }}>エラー: {String(targetsError?.message ?? targetsError)}</div>}
        {expError && <div style={{ color: '#ff6b6b', padding: 12, fontSize: 12 }}>支出取得エラー: {String(expError?.message ?? expError)}</div>}
        {!targetsLoading && !targetsError && targets.length === 0 && (
          <div style={{ color: TEXT_MUTED, padding: 18, textAlign: 'center', fontSize: 12 }}>
            対象者なし
          </div>
        )}

        {targets.map((t) => (
          <TargetBlock
            key={t.id}
            clientId={clientId}
            target={t}
            allExpenses={expenses || []}
            expensesLoading={expLoading}
          />
        ))}
      </div>
    </div>
  );
}

// =============================================================
// TargetBlock — 1 対象者のヘッダ + 明細テーブル (閲覧専用)
// =============================================================
function TargetBlock({ clientId, target, allExpenses, expensesLoading }) {
  const { incomes, loading: inLoading, error: inError } = useInvestmentIncomes(clientId, target.id);

  // この対象者に紐づく支出 (useExpenses の toApp で target_id が乗っている。
  // 本タスクで toApp 拡張済み。soft-delete 済み expense は API 側で除外済み)。
  const expensesForTarget = useMemo(
    () => (allExpenses || []).filter((e) => e && e.target_id === target.id),
    [allExpenses, target.id],
  );

  // 経費合計 / 総入金 / 最終回収差額 / 最終判定 — 本部版と同一ロジック。
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

  // マージ行 (date 昇順、同日は created_at 安定ソート)。経費行のみ累積。
  const mergedRows = useMemo(() => {
    const rows = [];
    for (const e of expensesForTarget) {
      rows.push({
        kind: 'expense',
        id: e.id,
        date: e.date,
        memo: e.memo ?? '',
        amount: Number(e.amount) || 0,
        // useExpenses の toApp は created_at を持たないため、ID 比較等は date 同値時のみ発生。
        // 入金 (raw row) には created_at がある一方、expense (toApp) には無い → 同日比較は安定しない場合あり。
        // 実害は少ないが、二次キーは入金側のみ created_at を使う。
        createdAt: '',
      });
    }
    for (const r of (incomes || [])) {
      rows.push({
        kind: 'income',
        id: r.id,
        date: r.date,
        memo: r.memo ?? '',
        amount: Number(r.amount) || 0,
        createdAt: r.created_at ?? '',
      });
    }
    rows.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '') < (b.date || '') ? -1 : 1;
      return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1;
    });
    let cum = 0;
    for (const r of rows) {
      if (r.kind === 'expense') {
        cum += r.amount;
        r.cum = cum;
        r.diff = grandIncome - cum;
        r.judge = r.diff >= 0 ? '回収済' : '未回収';
      }
    }
    return rows;
  }, [expensesForTarget, incomes, grandIncome]);

  return (
    <div style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${BORDER}`, borderRadius: 10, padding: 12 }}>
      {/* ヘッダ: 氏名 / 対象年 / 仕事入金額 / 総入金 (閲覧のみ) */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: GOLD }}>{target.name || '(無題)'}</div>
        <div style={{ fontSize: 11, color: TEXT_SECONDARY }}>対象年: <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>{target.target_year}</span></div>
        <div style={{ fontSize: 11, color: TEXT_SECONDARY }}>仕事入金額: <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>{fmtY(target.total_income)}</span></div>
        <div style={{ fontSize: 11, color: TEXT_SECONDARY }}>総入金: <span style={{ color: TEAL, fontWeight: 700 }}>{fmtY(grandIncome)}</span></div>
      </div>

      {inError && <div style={{ color: '#ff6b6b', fontSize: 11, marginBottom: 6 }}>入金取得エラー: {String(inError?.message ?? inError)}</div>}
      {(inLoading || expensesLoading) && <div style={{ color: TEXT_MUTED, fontSize: 11, marginBottom: 6 }}>読込中…</div>}

      {/* 明細テーブル (Excel 風縦罫線グリッド) */}
      <div style={{ overflowX: 'auto', border: `1px solid ${GRID}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720, border: `1px solid ${GRID}` }}>
          <thead>
            <tr style={{ background: NAVY3 }}>
              {['経費使用日', '用途内容', '経費額', '経費累計', '回収差額', '判定'].map((h, i) => (
                <th key={i} style={{
                  padding: '6px 8px', fontSize: 10, fontWeight: 700, color: GOLD, letterSpacing: '0.04em',
                  textAlign: i >= 2 && i <= 4 ? 'right' : 'left',
                  borderBottom: `1px solid ${BORDER}`, borderRight: `1px solid ${GRID}`,
                  whiteSpace: 'nowrap',
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {mergedRows.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: '14px 8px', color: TEXT_MUTED, textAlign: 'center', fontSize: 11 }}>明細なし</td></tr>
            ) : (
              mergedRows.map((r) => <DetailRow key={`${r.kind}-${r.id}`} row={r} />)
            )}
          </tbody>
          <tfoot>
            <tr style={{ background: NAVY2 }}>
              <td colSpan={2} style={footCell(true)}>合計</td>
              <td style={{ ...footCell(false), textAlign: 'right' }}>{fmtY(expensesTotal)}</td>
              <td style={{ ...footCell(false), textAlign: 'right', color: TEXT_MUTED }}>—</td>
              <td style={{ ...footCell(false), textAlign: 'right', color: finalDiff >= 0 ? TEAL : RED }}>
                {fmtY(finalDiff)}
              </td>
              <td style={{ ...footCell(false), color: finalDiff >= 0 ? TEAL : RED, fontWeight: 700 }}>
                {finalDiff >= 0 ? '回収済' : '未回収'}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// =============================================================
// DetailRow — マージ済 1 行 (閲覧専用、編集 UI なし)
// =============================================================
function DetailRow({ row }) {
  const isIncome = row.kind === 'income';
  const rowBg = isIncome ? `${TEAL}10` : 'transparent';
  const td = (right = false, color = TEXT_PRIMARY) => ({
    padding: '6px 8px', fontSize: 11, color,
    borderBottom: `1px solid ${BORDER}`,
    borderRight: `1px solid ${GRID}`, // Excel 風縦罫線
    textAlign: right ? 'right' : 'left', whiteSpace: 'nowrap',
  });
  return (
    <tr style={{ background: rowBg }}>
      <td style={td()}>{row.date || '—'}</td>
      <td style={td()}>{isIncome ? `💰 ${row.memo || '入金'}` : (row.memo || '—')}</td>
      <td style={{ ...td(true), color: isIncome ? TEAL : TEXT_PRIMARY, fontWeight: isIncome ? 700 : 400 }}>
        {isIncome ? fmtY(row.amount, { plus: true }) : fmtY(-row.amount)}
      </td>
      <td style={td(true, isIncome ? TEXT_MUTED : TEXT_PRIMARY)}>
        {isIncome ? '—' : fmtY(row.cum)}
      </td>
      <td style={td(true, isIncome ? TEXT_MUTED : (row.diff >= 0 ? TEAL : RED))}>
        {isIncome ? '—' : fmtY(row.diff)}
      </td>
      <td style={{ ...td(false, isIncome ? TEXT_MUTED : (row.diff >= 0 ? TEAL : RED)), fontWeight: 700 }}>
        {isIncome ? '—' : row.judge}
      </td>
    </tr>
  );
}

function footCell(strong) {
  return {
    padding: '8px 8px', fontSize: 11, color: GOLD, fontWeight: strong ? 700 : 600,
    borderTop: `2px solid ${GOLD}55`,
    borderRight: `1px solid ${GRID}`, // Excel 風縦罫線 (合計行)
    whiteSpace: 'nowrap',
  };
}
