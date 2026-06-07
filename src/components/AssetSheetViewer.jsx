// =============================================================
// AssetSheetViewer — 資産残高繰越票 (顧客アプリ・read-only)
// Phase B-3 (2026-06-07)
//
// admin AssetSheetTab (src/pages/AssetSheetTab.jsx) の表構造を read-only で再現。
// データソース:
//   - 収入        : annual_budgets.committed_income_lines (admin commitIncomeSnapshot で焼かれた snapshot)
//   - 支出 (Σ)    : annual_budgets.committed_lines (admin commitBudgetSnapshot で焼かれた snapshot)
//   - 初期資産     : profiles.initial_asset (AuthContext.initialAsset 経由)
//
// 「準備中」ゲート:
//   loading                             → 「読み込み中…」
//   error/data 無し/incomeCommittedAt 無し/committedIncomeLines 空 → 「資産残高繰越票は本部からの反映待ちです」
//   else                                → 本体描画
//
// テーマ: @shared/theme (顧客アプリ共通)。admin の繰越票専用色とは別系統。
// =============================================================
import { useMemo } from "react";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { useAuth } from "../context/AuthContext";
import { computeAssetBalance, sumIncomeForMonth, sumExpenseForMonth } from "../utils/assetSheet";
import {
  GOLD, NAVY2, CARD_BG, BORDER, RED, TEAL,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

// 緑色 (収入/累計残高 正値の強調)。
const GREEN = "#43A047";
// 予算系青 (admin AssetSheetTab に合わせる目標列の色)。
const BLUE = "#5BA8FF";

// ── 共通ヘルパ ──────────────────────────────────────
const fmtY = (n) => (n == null ? "" : `¥${Number(n).toLocaleString("ja-JP")}`);
const fmtN = (n) => (n == null ? "" : Number(n).toLocaleString("ja-JP"));
const cellFontSize = (text) => {
  const len = String(text ?? "").length;
  if (len <= 1) return 11;
  return Math.max(6, Math.min(11, Math.floor(60 / (len * 0.85))));
};
function monthsFromStart(startMonth) {
  const s = Math.max(1, Math.min(12, Number(startMonth) || 1));
  const out = [];
  for (let i = 0; i < 12; i++) out.push(((s - 1 + i) % 12) + 1);
  return out;
}
function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── ステータスカード (AnnualBudgetViewer L161-176 と同パターン) ─
function StatusCard({ message, showBadge }) {
  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: `${GOLD}22`, border: `1px solid ${GOLD}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 24, flexShrink: 0,
        }}>📈</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: TEXT_PRIMARY }}>資産残高繰越票</div>
      </div>
      <div style={{ padding: "14px 18px", background: NAVY2, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: showBadge ? 6 : 0 }}>{message}</div>
        {showBadge && (
          <div style={{
            fontSize: 10, color: `${GOLD}88`, background: `${GOLD}11`,
            borderRadius: 8, padding: "6px 12px", display: "inline-block",
          }}>準備中</div>
        )}
      </div>
    </div>
  );
}

// =============================================================
// メインコンポーネント
// =============================================================
export default function AssetSheetViewer({ clientId }) {
  // 自分の profiles.initial_asset (AuthContext 経由)。
  const { initialAsset } = useAuth();
  // annual_budgets の最新確定年度 (camelCase で committedIncomeLines / incomeCommittedAt / committedLines 露出済)。
  const { data, loading, error } = useAnnualBudgets(clientId);

  const startMonth = Number(data?.fiscal_year_start_month) || 1;
  const months = useMemo(() => monthsFromStart(startMonth), [startMonth]);

  const incomeLines = Array.isArray(data?.committedIncomeLines) ? data.committedIncomeLines : [];
  const expenseLines = Array.isArray(data?.committedLines) ? data.committedLines : [];

  const balance = useMemo(
    () => computeAssetBalance({ initialAsset, incomeLines, expenseLines }),
    [initialAsset, incomeLines, expenseLines],
  );

  // ── 準備中ゲート ────────────────────────────────
  if (loading) return <StatusCard message="読み込み中…" />;
  if (error || !data || !data.incomeCommittedAt || incomeLines.length === 0) {
    return <StatusCard message="資産残高繰越票は本部からの反映待ちです" showBadge />;
  }

  // ── 月別合計 ────────────────────────────────────
  const monthlyIncome = months.map((_, idx) => sumIncomeForMonth(incomeLines, idx, true));
  const monthlyExpense = months.map((_, idx) => sumExpenseForMonth(expenseLines, idx, true));
  const monthlyNet = months.map((_, idx) => monthlyIncome[idx] - monthlyExpense[idx]);
  const yearIncome = monthlyIncome.reduce((s, v) => s + v, 0);

  // ── 行ごとの年間収入合計 ──────────────────────────
  const sumIncomeRow = (line) => {
    const arr = Array.isArray(line?.monthly_actuals) ? line.monthly_actuals : [];
    let s = 0;
    for (let i = 0; i < 12; i++) {
      const v = Number(arr[i]);
      s += Number.isFinite(v) ? v : 0;
    }
    return s;
  };

  // ── CSS Grid 列構成 ────────────────────────────
  // 項目(160) + 月×12(minmax 64) + 年間目標(88) + 年合計/年末残高(100)
  const gridCols = "160px repeat(12, minmax(64px, 1fr)) 88px 100px";

  // ── セルスタイル共通 ──────────────────────────
  const headerCellStyle = {
    padding: "8px 6px", background: NAVY2, color: TEXT_SECONDARY,
    fontSize: 11, fontWeight: 700, textAlign: "right",
    borderRadius: 6, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
  };
  const headerCellLeft = { ...headerCellStyle, textAlign: "left" };
  const cellStyle = {
    padding: "6px 6px", background: CARD_BG, borderRadius: 6,
    minWidth: 0, whiteSpace: "nowrap", overflow: "hidden",
    border: `1px solid ${BORDER}`,
  };
  const numCellStyle = (color = TEXT_PRIMARY) => ({
    ...cellStyle, textAlign: "right", color, fontSize: 11, fontWeight: 600,
  });

  // ── 本体描画 ────────────────────────────────────
  return (
    <div style={{
      background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`,
      overflow: "hidden",
    }}>
      {/* ヘッダ */}
      <div style={{
        padding: "14px 18px", borderBottom: `1px solid ${BORDER}`,
        display: "flex", alignItems: "center", gap: 12,
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: 12,
          background: `${GOLD}22`, border: `1px solid ${GOLD}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22, flexShrink: 0,
        }}>📈</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: TEXT_PRIMARY }}>
            資産残高繰越票
            <span style={{ marginLeft: 8, fontSize: 11, color: TEXT_MUTED, fontWeight: 400 }}>
              {data.fiscal_year} 年度
            </span>
          </div>
          <div style={{ fontSize: 10, color: TEXT_SECONDARY, marginTop: 3 }}>
            最終反映 {fmtDateTime(data.incomeCommittedAt)}
          </div>
        </div>
      </div>

      {/* 補足説明 */}
      <div style={{
        padding: "10px 18px", background: NAVY2, borderBottom: `1px solid ${BORDER}`,
        fontSize: 10, color: TEXT_SECONDARY, lineHeight: 1.5,
      }}>
        月次資産残高 = 前月残高 + 収入実測 − 支出実測 (初月は初期資産起点)
      </div>

      {/* テーブル本体 (横スクロール対応) */}
      <div style={{ overflowX: "auto", padding: "14px 16px" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: "fit-content" }}>
          {/* ヘッダ行 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={headerCellLeft}>項目</div>
            {months.map((m) => (
              <div key={m} style={headerCellStyle}>{m}月</div>
            ))}
            <div style={headerCellStyle}>年間目標</div>
            <div style={headerCellStyle}>年合計 / 年末残高</div>
          </div>

          {/* ── 初期資産行 ────────────────────────── */}
          <div style={{
            display: "grid", gridTemplateColumns: gridCols, gap: 4,
            borderTop: `2px solid ${GOLD}33`, paddingTop: 4,
          }}>
            <div style={{
              ...cellStyle, color: TEXT_SECONDARY, fontSize: 12, fontWeight: 700,
            }}>💰 初期資産</div>
            {months.map((_, idx) => (
              <div key={idx} style={{ ...cellStyle, textAlign: "right", color: TEXT_MUTED, fontSize: 11 }}>−</div>
            ))}
            <div style={{ ...cellStyle, textAlign: "right", color: TEXT_MUTED, fontSize: 11 }}>−</div>
            <div style={numCellStyle(GOLD)}>
              <span style={{ fontSize: cellFontSize(fmtY(initialAsset)), fontWeight: 700 }}>
                {fmtY(initialAsset)}
              </span>
            </div>
          </div>

          {/* ── 収入セクション見出し ───────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 6 }}>
            <div style={{
              gridColumn: "1 / -1", color: GREEN, fontSize: 12, fontWeight: 700,
              padding: "6px 6px 2px",
            }}>📥 収入</div>
          </div>

          {/* ── 収入行群 (read-only) ──────────────────── */}
          {incomeLines.map((line) => {
            const yearSum = sumIncomeRow(line);
            return (
              <div key={line.id ?? line.category_name} style={{
                display: "grid", gridTemplateColumns: gridCols, gap: 4,
              }}>
                {/* 行名 */}
                <div style={{
                  ...cellStyle, color: TEXT_PRIMARY, fontSize: 12, fontWeight: 500,
                  textOverflow: "ellipsis",
                }}>
                  {line?.category_name || "(無題)"}
                </div>
                {/* 月別実測セル × 12 */}
                {months.map((m, idx) => {
                  const v = Number(line?.monthly_actuals?.[idx]) || 0;
                  return (
                    <div key={m} style={numCellStyle(v === 0 ? TEXT_MUTED : TEXT_PRIMARY)}>
                      <span style={{ fontSize: cellFontSize(fmtN(v)), fontWeight: 500 }}>
                        {v === 0 ? "−" : fmtN(v)}
                      </span>
                    </div>
                  );
                })}
                {/* 年間目標 */}
                <div style={numCellStyle(line?.target_value ? BLUE : TEXT_MUTED)}>
                  <span style={{
                    fontSize: cellFontSize(fmtN(line?.target_value)),
                    fontStyle: "italic", fontWeight: 600,
                  }}>
                    {line?.target_value ? fmtN(line.target_value) : "−"}
                  </span>
                </div>
                {/* 行年合計 */}
                <div style={numCellStyle(yearSum === 0 ? TEXT_MUTED : GREEN)}>
                  <span style={{ fontSize: cellFontSize(fmtY(yearSum)), fontWeight: 700 }}>
                    {fmtY(yearSum)}
                  </span>
                </div>
              </div>
            );
          })}

          {/* 収入小計行 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 8 }}>
            <div style={{ ...cellStyle, background: NAVY2, color: GREEN, fontSize: 12, fontWeight: 700 }}>
              📥 収入合計
            </div>
            {months.map((_, idx) => (
              <div key={idx} style={numCellStyle(monthlyIncome[idx] === 0 ? TEXT_MUTED : GREEN)}>
                <span style={{ fontSize: cellFontSize(fmtN(monthlyIncome[idx])) }}>
                  {monthlyIncome[idx] === 0 ? "−" : fmtN(monthlyIncome[idx])}
                </span>
              </div>
            ))}
            <div style={numCellStyle(TEXT_MUTED)}>−</div>
            <div style={numCellStyle(yearIncome === 0 ? TEXT_MUTED : GREEN)}>
              <span style={{ fontSize: cellFontSize(fmtY(yearIncome)) }}>{fmtY(yearIncome)}</span>
            </div>
          </div>

          {/* ── 支出セクション ───────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 12 }}>
            <div style={{
              gridColumn: "1 / -1", color: RED, fontSize: 12, fontWeight: 700,
              padding: "6px 6px 2px",
            }}>📤 支出 (支出管理繰越票より自動連動)</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={{ ...cellStyle, background: NAVY2, color: RED, fontSize: 12, fontWeight: 700 }}>
              📤 支出合計
            </div>
            {months.map((_, idx) => (
              <div key={idx} style={numCellStyle(monthlyExpense[idx] === 0 ? TEXT_MUTED : RED)}>
                <span style={{ fontSize: cellFontSize(fmtN(monthlyExpense[idx])) }}>
                  {monthlyExpense[idx] === 0 ? "−" : fmtN(monthlyExpense[idx])}
                </span>
              </div>
            ))}
            <div style={numCellStyle(TEXT_MUTED)}>−</div>
            <div style={numCellStyle(TEXT_MUTED)}>−</div>
          </div>

          {/* ── 月次資産残高 (自動) ────────────────────── */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 12 }}>
            <div style={{
              gridColumn: "1 / -1", color: GOLD, fontSize: 12, fontWeight: 700,
              padding: "6px 6px 2px",
            }}>💎 月次資産残高</div>
          </div>
          {/* 月次純増減 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={{ ...cellStyle, background: NAVY2, color: TEXT_SECONDARY, fontSize: 11, fontWeight: 700 }}>
              純増減 (収入−支出)
            </div>
            {months.map((_, idx) => {
              const v = monthlyNet[idx];
              const color = v > 0 ? GREEN : v < 0 ? RED : TEXT_MUTED;
              return (
                <div key={idx} style={numCellStyle(color)}>
                  <span style={{ fontSize: cellFontSize(fmtN(v)) }}>
                    {v === 0 ? "−" : fmtN(v)}
                  </span>
                </div>
              );
            })}
            <div style={numCellStyle(TEXT_MUTED)}>−</div>
            <div style={numCellStyle(TEXT_MUTED)}>−</div>
          </div>
          {/* 累計残高 */}
          <div style={{
            display: "grid", gridTemplateColumns: gridCols, gap: 4,
            borderTop: `2px solid ${GOLD}55`, paddingTop: 4,
          }}>
            <div style={{
              ...cellStyle, background: NAVY2, color: GOLD,
              fontSize: 12, fontWeight: 700,
              borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            }}>💎 累計残高</div>
            {months.map((_, idx) => {
              const v = balance.byMonth[idx];
              const color = v >= 0 ? GOLD : RED;
              return (
                <div key={idx} style={{
                  ...numCellStyle(color), fontWeight: 700,
                  borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
                }}>
                  <span style={{ fontSize: cellFontSize(fmtN(v)) }}>{fmtN(v)}</span>
                </div>
              );
            })}
            <div style={{
              ...numCellStyle(TEXT_MUTED),
              borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            }}>−</div>
            <div style={{
              ...numCellStyle(balance.yearEnd >= 0 ? GOLD : RED), fontWeight: 700,
              borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            }}>
              <span style={{ fontSize: cellFontSize(fmtY(balance.yearEnd)) }}>{fmtY(balance.yearEnd)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* 抑止のための未使用変数 (TEAL は将来用、現状未参照) */}
      {(() => { void TEAL; return null; })()}
    </div>
  );
}
