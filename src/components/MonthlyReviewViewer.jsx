import { useEffect, useState } from "react";
import { getPublishedByMonth } from "../lib/api/monthlyReviews";
import {
  GOLD, TEAL, RED, NAVY2, NAVY3, CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

// 診断: 手動設定 (over/achieved/on_budget) を優先、null は achievement_ratio から
// 自動算出する。本部 ClientFinancialDetail.jsx resolveDiagnosis 準拠
// (achievement_ratio=(予算-当月)/予算 → r>0 予算達成 / r<0 超過 / 0 予算通り)。
function resolveDiagnosis(achievementRatio, diagnosis) {
  if (diagnosis === "over")      return { label: "🔴 予算超過", color: RED };
  if (diagnosis === "achieved")  return { label: "🟢 予算達成", color: TEAL };
  if (diagnosis === "on_budget") return { label: "⚪ 予算通り", color: TEXT_SECONDARY };
  const r = Number(achievementRatio) || 0;
  if (r > 0) return { label: "🟢 予算達成", color: TEAL };
  if (r < 0) return { label: "🔴 予算超過", color: RED };
  return { label: "⚪ 予算通り", color: TEXT_SECONDARY };
}

// 明細「予算比」: r=(当月-予算)/予算。超過(r>0)=RED "+12.3%"、節約(r<0)=TEAL "(9.2%)"、
// 予算<=0 は "—"。本部 formatVarianceRatio 準拠。
function formatVarianceRatio(budget, actual) {
  const b = Number(budget) || 0;
  const a = Number(actual) || 0;
  if (b <= 0) return { text: "—", color: TEXT_MUTED };
  const r = (a - b) / b;
  if (r === 0) return { text: "—", color: TEXT_MUTED };
  if (r > 0) return { text: `+${(r * 100).toFixed(1)}%`, color: RED };
  return { text: `(${(Math.abs(r) * 100).toFixed(1)}%)`, color: TEAL };
}

// #5: 本部 computeGroupSums 相当 (別リポのため再実装)。group ごとに配下 leaf の
//   budget/actual を再帰合算した Map<groupId, {budget, actual}> を返す。
function computeGroupSums(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  const childrenOf = new Map();
  for (const l of arr) {
    const pid = l?.parent_id ?? null;
    if (!childrenOf.has(pid)) childrenOf.set(pid, []);
    childrenOf.get(pid).push(l);
  }
  const sums = new Map();
  const sumOf = (line) => {
    if (line?.type !== "group") {
      return { budget: Number(line?.budget) || 0, actual: Number(line?.actual) || 0 };
    }
    let b = 0, a = 0;
    for (const c of (childrenOf.get(line.id) || [])) {
      const s = sumOf(c);
      b += s.budget; a += s.actual;
    }
    const result = { budget: b, actual: a };
    sums.set(line.id, result);
    return result;
  };
  for (const l of arr) if (l?.type === "group") sumOf(l);
  return sums;
}

// #5/#6: ソートキー用の budget/actual (group は子合計 sums、leaf は自身値)。
function rowBudgetActual(line, sums) {
  if (line?.type === "group") {
    const s = sums?.get(line.id);
    return { budget: Number(s?.budget) || 0, actual: Number(s?.actual) || 0 };
  }
  return { budget: Number(line?.budget) || 0, actual: Number(line?.actual) || 0 };
}

// #6: 同 parent の兄弟を sortMode で並べ替える (表示専用、committed は不変)。本部 sortedSiblings 準拠。
//   'manual'=display_order 昇順 / 'overpct'=超過率降順(予算≤0は末尾) / 'amount'=当月金額降順。
//   「その他(未分類)」(display_order 9999) は全モード末尾固定。
function sortedSiblings(lines, parentId, sortMode, sums) {
  const sibs = (lines || []).filter((l) => (l?.parent_id ?? null) === (parentId ?? null));
  const byOrder = (a, b) => (Number(a.display_order) || 0) - (Number(b.display_order) || 0);
  if (sortMode === "manual") return sibs.sort(byOrder);
  const isOther = (l) => Number(l?.display_order) === 9999 || l?._readOnlyRow === true || l?.id === "__other_uncategorized__";
  const ratioKey = (l) => {
    const { budget, actual } = rowBudgetActual(l, sums);
    return budget <= 0 ? null : (actual - budget) / budget;
  };
  return sibs.slice().sort((a, b) => {
    const ao = isOther(a), bo = isOther(b);
    if (ao !== bo) return ao ? 1 : -1;
    if (ao && bo) return byOrder(a, b);
    if (sortMode === "amount") {
      return rowBudgetActual(b, sums).actual - rowBudgetActual(a, sums).actual;
    }
    const ra = ratioKey(a), rb = ratioKey(b);
    if (ra == null && rb == null) return byOrder(a, b);
    if (ra == null) return 1;
    if (rb == null) return -1;
    return rb - ra;
  });
}

// 既存 App.jsx「準備中」カードと見た目完全一致のステータスカード。
// loading / 未公開 / 該当無し / 取得失敗 のいずれでも親に null を返さず
// この自己完結カードを表示する。
function StatusCard({ year, month, message, showBadge }) {
  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${TEAL}22`, border: `1px solid ${TEAL}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>📝</div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: TEXT_PRIMARY }}>月次レビューシート</div>
          <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 2 }}>{year}年{month}月分</div>
        </div>
      </div>
      <div style={{ padding: "14px 18px", background: NAVY2, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: showBadge ? 6 : 0 }}>{message}</div>
        {showBadge && (
          <div style={{ fontSize: 10, color: `${TEAL}88`, background: `${TEAL}11`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}>準備中</div>
        )}
      </div>
    </div>
  );
}

// =============================================================
// 月次レビューシート read-only ビューア (Phase E 最終ゴール — 顧客アプリ)。
//
// props:
//   - clientId / year / month: 表示対象の公開済みレビュー 1 件を特定。
//
// 表示元は is_published=true のレコードのみ (getPublishedByMonth が RLS と
// API 両方で担保)。該当無し / 未公開 / 取得失敗 / ロード中は null を返し、
// 「準備中」表示は親 (App.jsx) に委ねる。
// コメント返信機能は本 phase 対象外。
// =============================================================

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

const fmtNum = (n) => Number(n || 0).toLocaleString();

// 本文セクション (summary / advice 等)。値が空なら描画しない。
function Section({ label, value }) {
  if (!value || !String(value).trim()) return null;
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 12, color: GOLD, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{
        fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.7,
        background: NAVY2, borderRadius: 12, padding: 14, whiteSpace: "pre-wrap",
        border: "1px solid rgba(212,168,67,0.12)",
      }}>
        {value}
      </div>
    </div>
  );
}

export default function MonthlyReviewViewer({ clientId, year, month }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // #6: 明細ソートモード (表示専用)。'manual'/'overpct'/'amount'。既定は手動。
  const [sortMode, setSortMode] = useState("manual");

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    getPublishedByMonth(clientId, year, month)
      .then((row) => { if (mounted) { setData(row); setError(null); } })
      .catch((e) => { if (mounted) { console.error("[MonthlyReviewViewer]", e); setError(e); } })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [clientId, year, month]);

  // ロード中・未公開・該当無し・取得失敗は「準備中」カードを表示。
  if (loading) return <StatusCard year={year} month={month} message="読み込み中..." />;
  if (error || !data) {
    return <StatusCard year={year} month={month} message="Supabase連携後に本部から送付されます" showBadge />;
  }

  const lines = Array.isArray(data.lines) ? data.lines : [];
  const totals = data.totals || {};
  // 診断は手動設定優先・null は達成率から自動算出 (本部準拠)。常にバッジ表示。
  const diag = resolveDiagnosis(totals.achievement_ratio, data.diagnosis);

  const cellStyle = {
    padding: "5px 8px", fontSize: 11, color: TEXT_PRIMARY,
    borderBottom: `1px solid ${BORDER}`,
  };

  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden", boxShadow: SHADOW }}>
      {/* ヘッダ (繰越票・StatusCard と統一感: 44px TEAL アイコンボックス + GOLD タイトル) */}
      <div style={{ padding: "14px 18px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${TEAL}22`, border: `1px solid ${TEAL}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>📝</div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: GOLD }}>
            {year}年{month}月 月次レビュー
          </div>
          <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap" }}>
            {data.staff_name && <span>担当: {data.staff_name}</span>}
            {data.published_at && <span>公開: {fmtDateTime(data.published_at)}</span>}
          </div>
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {/* 診断バッジ (常に表示: 手動 or 達成率自動) */}
        <div style={{
          display: "inline-block", fontSize: 11, fontWeight: 700, color: diag.color,
          background: `${diag.color}22`, border: `1px solid ${diag.color}44`,
          borderRadius: 8, padding: "4px 10px", marginBottom: 12,
        }}>
          {diag.label}
        </div>

        {/* 本文セクション */}
        <Section label="📝 今月の振り返り" value={data.summary} />
        <Section label="💡 CFOからのアドバイス" value={data.advice} />
        <Section label="🚀 来月のアクションプラン" value={data.next_month_plan} />
        <Section label="📌 次回アクションコメント" value={data.next_action_comment} />
        <Section label="🗒 担当者コメント" value={data.staff_comment} />

        {/* 明細テーブル (#5: ツリー表示 + #6: 表示専用ソート) */}
        {lines.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 700 }}>📊 明細</div>
              {/* #6: 並び替えトグル (表示専用、手動/予算超過%順/金額順) */}
              <div style={{ display: "inline-flex", background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 999, padding: 2 }}>
                {[["manual", "手動"], ["overpct", "超過%"], ["amount", "金額"]].map(([mode, label]) => {
                  const active = sortMode === mode;
                  return (
                    <button key={mode} onClick={() => setSortMode(mode)}
                      style={{
                        border: "none", cursor: "pointer", borderRadius: 999,
                        padding: "3px 9px", fontSize: 10, fontWeight: 700, whiteSpace: "nowrap",
                        background: active ? GOLD : "transparent",
                        color: active ? NAVY2 : TEXT_SECONDARY,
                      }}>{label}</button>
                  );
                })}
              </div>
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 360 }}>
                <thead>
                  <tr>
                    <th style={{ ...cellStyle, textAlign: "left", color: GOLD, fontWeight: 700, background: NAVY3 }}>項目</th>
                    <th style={{ ...cellStyle, textAlign: "right", color: GOLD, fontWeight: 700, background: NAVY3 }}>予算</th>
                    <th style={{ ...cellStyle, textAlign: "right", color: GOLD, fontWeight: 700, background: NAVY3 }}>当月金額</th>
                    <th style={{ ...cellStyle, textAlign: "right", color: GOLD, fontWeight: 700, background: NAVY3 }}>予算比</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    // #5/#6: parent_id ツリーを depth 優先で再帰描画。各階層の兄弟を sortMode でソート。
                    const sums = computeGroupSums(lines);
                    const renderRows = (parentId, depth) => {
                      const rows = [];
                      for (const line of sortedSiblings(lines, parentId, sortMode, sums)) {
                        const isGroup = line?.type === "group";
                        // group は子合計 (sums)、leaf は自身値。予算比は両方で算出 (本部 LineRow 準拠)。
                        const { budget, actual } = rowBudgetActual(line, sums);
                        const vr = formatVarianceRatio(budget, actual);
                        const reason = !isGroup && line?.variance_reason ? String(line.variance_reason).trim() : "";
                        rows.push(
                          <tr key={line?.id || `${parentId}-${depth}-${rows.length}`} style={{ background: isGroup ? "rgba(212,168,67,0.06)" : "transparent" }}>
                            <td style={{ ...cellStyle, fontWeight: isGroup ? 700 : 400, paddingLeft: 8 + depth * 10 }}>
                              {isGroup ? "📁 " : ""}{line?.label || "(無題)"}
                              {/* 差異理由: 列を増やさず項目名の下にサブ表示 (空なら出さない) */}
                              {reason && (
                                <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 2, fontWeight: 400 }}>↳ {reason}</div>
                              )}
                            </td>
                            <td style={{ ...cellStyle, textAlign: "right" }}>{fmtNum(budget)}</td>
                            <td style={{ ...cellStyle, textAlign: "right" }}>{fmtNum(actual)}</td>
                            <td style={{ ...cellStyle, textAlign: "right", color: vr ? vr.color : TEXT_MUTED, fontWeight: 600 }}>
                              {vr ? vr.text : "—"}
                            </td>
                          </tr>,
                        );
                        if (isGroup) rows.push(...renderRows(line.id, depth + 1));
                      }
                      return rows;
                    };
                    return renderRows(null, 0);
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 合計サマリー */}
        {(totals.total_budget != null || totals.total_actual != null || totals.achievement_ratio != null) && (
          <div style={{
            marginTop: 12, padding: 14, background: NAVY2,
            borderRadius: 12, borderTop: `2px solid ${GOLD}55`,
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            {totals.total_budget != null && (
              <Row label="予算合計" value={`${fmtNum(totals.total_budget)}円`} />
            )}
            {totals.total_actual != null && (
              <Row label="当月合計" value={`${fmtNum(totals.total_actual)}円`} />
            )}
            {/* 予算超過額 / 節約額 (本部 ManagementSummary と揃える、0 は表示しない) */}
            {Number(totals.over_amount) > 0 && (
              <Row label="予算超過額" value={`¥${Number(totals.over_amount).toLocaleString("ja-JP")}`} valueColor={RED} />
            )}
            {Number(totals.save_amount) > 0 && (
              <Row label="予算節約額" value={`¥${Number(totals.save_amount).toLocaleString("ja-JP")}`} valueColor={TEAL} />
            )}
            {totals.achievement_ratio != null && (() => {
              // achievement_ratio は 0〜1 の分数 (本部 recalcTotals)。×100 して % 化。
              // ratioPct>0=予算内(TEAL) / <0=超過(RED) / 0=MUTED。バー幅は正の残率を 0-100 でクランプ。
              const ratioPct = Number(totals.achievement_ratio) * 100;
              const barColor = ratioPct > 0 ? TEAL : ratioPct < 0 ? RED : TEXT_MUTED;
              return (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 4 }}>
                    <span style={{ color: TEXT_MUTED }}>予算達成率</span>
                    <span style={{ color: barColor, fontWeight: 700 }}>{ratioPct.toFixed(1)}%</span>
                  </div>
                  <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.min(Math.max(ratioPct, 0), 100)}%`, background: barColor, borderRadius: 3, transition: "width 0.3s" }} />
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, valueColor }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11 }}>
      <span style={{ color: TEXT_MUTED }}>{label}</span>
      <span style={{ color: valueColor || TEXT_PRIMARY, fontWeight: 700 }}>{value}</span>
    </div>
  );
}
