// =============================================================
// AssetSheetViewer — 資産残高繰越票 (顧客アプリ)
// Phase 2-4a (2026-06-11): 全面書換え。
//
// 変更点 (Phase B-3 → 2-4a):
//   - 描画ロジックを admin AssetSheetTab.jsx (1-D-3g) と同等の 4 行
//     テーブルへ刷新 (初期資産行=月見出し兼用 / 本収入 / 支出合計 / 累計残高)
//   - 計算を computeAssetSheet (src/utils/assetSheet.js, Phase 2-1 移植) に統一。
//     旧 computeAssetBalance / sumIncomeForMonth / sumExpenseForMonth 経路は撤去。
//   - データソースを committed_* (snapshot) から live (income_lines / lines /
//     profiles.initial_asset) に切替え (Phase 2-2a/b で hook が live read 拡張済)。
//   - 「準備中」ゲートを撤去 (incomeCommittedAt 判定を廃止)。常にシートを描画する。
//   - 年度セレクタ (◀ {currentYear}年度 ▶) を内部 state で実装。
//   - グラフ (累計残高推移 LineChart) はこのサブステップでは未実装 (Phase 2-4b で追加予定)。
//   - 編集 UI / writer setter 結線は read-only (Phase 2-4c で hook setter に結線予定)。
//
// データソース:
//   - 本収入        : annual_budgets.income_lines  (live, hook 経由 data.incomeLines)
//   - 支出 (Σ)      : annual_budgets.lines        (live, hook 経由 data.lines。月キーは
//                                                  jsonb {1..12} 暦月、computeAssetSheet 側で
//                                                  fiscal idx→暦月変換)
//   - 初期資産       : profiles.initial_asset      (AuthContext.initialAsset 経由)
//
// 受け取り props 契約 (App.jsx 2425 から維持):
//   { clientId }  ← それ以外の props は追加しない (新規 props が必要なら別 PR)。
// =============================================================
import { useEffect, useMemo, useState } from "react";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { useAuth } from "../context/AuthContext";
import { computeAssetSheet } from "../utils/assetSheet";
import {
  GOLD, NAVY2, NAVY3, CARD_BG, BORDER, RED,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

// ローカル色定数 (@shared/theme は BLUE=TEAL なので、admin の予算系 BLUE と
// 別物としてローカル定義。admin AssetSheetTab.jsx の BUDGET_BLUE と同値)。
const BUDGET_BLUE = "#5BA8FF";
const GREEN = "#43A047";

// ── 共通ヘルパ (admin AssetSheetTab.jsx と完全同形) ─────
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

// =============================================================
// メインコンポーネント
// =============================================================
export default function AssetSheetViewer({ clientId }) {
  // 顧客自身の profiles.initial_asset (AuthContext 経由)。read-only 表示のみ。
  const { initialAsset } = useAuth();

  // 年度セレクタの内部 state。初回は null → hook が最新年度を返す。
  // 初回ロード後 data.fiscal_year を吸い上げて以後 ◀▶ で増減する。
  const [currentYear, setCurrentYear] = useState(null);
  const { data, loading, error } = useAnnualBudgets(clientId, currentYear);

  // 初回 data 着弾時の年度同期 (currentYear が null の間だけ吸い上げ)。
  useEffect(() => {
    if (currentYear == null && data?.fiscal_year != null) {
      setCurrentYear(Number(data.fiscal_year));
    }
  }, [currentYear, data?.fiscal_year]);

  const startMonth = Number(data?.fiscal_year_start_month) || 1;
  const months = useMemo(() => monthsFromStart(startMonth), [startMonth]);

  // hook 露出フィールド (Phase 2-2a withCamel + 2-2b 再露出済)。snake fallback も保持。
  const incomeLines = Array.isArray(data?.incomeLines)
    ? data.incomeLines
    : (Array.isArray(data?.income_lines) ? data.income_lines : []);
  const expenseLines = Array.isArray(data?.lines) ? data.lines : [];

  const initialAssetValue = Number(initialAsset) || 0;

  // Phase 2-1 移植の computeAssetSheet。settledMonths は内部で自動判定 (実測>0)。
  const { rows, summary } = useMemo(
    () => computeAssetSheet({ incomeLines, expenseLines, months, initialAsset: initialAssetValue }),
    [incomeLines, expenseLines, months, initialAssetValue],
  );

  // ── スタイル定数 (admin AssetSheetTab.jsx 1-D-3g と同形) ────
  // CSS Grid: ラベル(260) + 月×12(84min) + 進捗(80) + 目標合計(110) = 15 列。
  const gridCols = "260px repeat(12, minmax(84px, 1fr)) 80px 110px";
  const headerCellStyle = {
    padding: "8px 6px", background: NAVY3, color: TEXT_SECONDARY,
    fontSize: 11, fontWeight: 700, textAlign: "center",
    borderRadius: 6, minWidth: 0, whiteSpace: "nowrap",
  };
  const cellStyle = {
    padding: "6px 6px", background: NAVY2, borderRadius: 6,
    minWidth: 0, whiteSpace: "nowrap",
    border: `1px solid ${BORDER}`, fontSize: 11,
  };
  const labelCellStyle = {
    ...cellStyle, color: TEXT_SECONDARY, fontWeight: 700, textAlign: "left",
  };
  const yearNavBtnStyle = {
    background: NAVY3, color: GOLD, border: `1px solid ${BORDER}`,
    borderRadius: 6, padding: "6px 14px", fontSize: 14, fontWeight: 700,
    cursor: "pointer", whiteSpace: "nowrap",
  };

  // 月セル 2 値表示 (上=実測 GOLD 大 / 下=予算/予想 BLUE 小)。
  //   実測 null → "—" 大きめ、ref null → "—" 小さめ。admin 1-D-3a と同パラメタ。
  const renderTwoValCell = (actualVal, refVal) => {
    const actualSize = actualVal == null ? 15 : Math.max(10, cellFontSize(fmtN(actualVal)) + 5);
    const refSize    = refVal    == null ? 8  : Math.max(7, Math.min(8, cellFontSize(fmtN(refVal)) - 3));
    return (
      <div style={{ ...cellStyle, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 }}>
        <span style={{ color: GOLD, fontSize: actualSize, fontWeight: 700, lineHeight: 1.1 }}>
          {actualVal == null ? "—" : fmtN(actualVal)}
        </span>
        <span style={{ color: BUDGET_BLUE, fontSize: refSize, fontWeight: 500, lineHeight: 1.1 }}>
          {refVal == null ? "—" : fmtN(refVal)}
        </span>
      </div>
    );
  };

  // 表示用 year ラベル (currentYear 着弾前は data.fiscal_year → 着弾も無ければ今年)。
  const yearLabel = currentYear ?? data?.fiscal_year ?? new Date().getFullYear();

  // 「準備中」ゲートは撤去 (Phase 2-4a)。loading / error はバナーで控えめに通知し、
  // データ未着・空配列でもレイアウトは常に描画する (computeAssetSheet が空集合でも
  // initialAsset 起点の forecastCum/actualCum を返すため layout が崩れない)。
  return (
    <div style={{
      background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`,
      padding: 16, color: TEXT_PRIMARY,
      display: "flex", flexDirection: "column", gap: 14,
    }}>

      {/* ① 年セレクタ — 中央寄せ + 右側に状態バッジ */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1 }} />
        <button onClick={() => setCurrentYear(Number(yearLabel) - 1)} style={yearNavBtnStyle}>◀</button>
        <span style={{ color: GOLD, fontSize: 16, fontWeight: 700, minWidth: 110, textAlign: "center" }}>
          {yearLabel}年度
        </span>
        <button onClick={() => setCurrentYear(Number(yearLabel) + 1)} style={yearNavBtnStyle}>▶</button>
        <div style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10 }}>
          {loading && (
            <span style={{ fontSize: 11, color: TEXT_MUTED, whiteSpace: "nowrap" }}>読み込み中…</span>
          )}
          {error && !loading && (
            <span style={{ fontSize: 11, color: RED, whiteSpace: "nowrap" }}>読み込みエラー</span>
          )}
        </div>
      </div>

      {/* ② 4 行テーブル (1-D-3g レイアウト) — グラフは Phase 2-4b で追加予定 */}
      <div style={{ overflowX: "auto" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: "fit-content" }}>

          {/* 行1: 初期資産 (月見出し兼用行)
              col1: 💰初期資産 ラベル + 値 (read-only span)
              col2-13: 月見出し / col14: 進捗 / col15: 目標合計 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={{
              ...labelCellStyle,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span style={{ whiteSpace: "nowrap" }}>💰 初期資産</span>
              <span style={{
                flex: 1, minWidth: 0,
                color: GOLD, fontWeight: 700, textAlign: "right",
                fontSize: Math.max(9, cellFontSize(fmtN(initialAssetValue)) + 2),
              }}>
                {initialAssetValue === 0 ? "—" : fmtN(initialAssetValue)}
              </span>
            </div>
            {months.map((m) => (
              <div key={m} style={headerCellStyle}>{m}月</div>
            ))}
            <div style={headerCellStyle}>進捗</div>
            <div style={headerCellStyle}>目標合計</div>
          </div>

          {/* セクション見出し: ⊕ 本収入 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={{ ...labelCellStyle, color: GREEN, background: "transparent", border: "none" }}>
              ⊕ 本収入
            </div>
          </div>

          {/* 本収入 行群 (read-only)。行が無いときは empty hint。 */}
          {incomeLines.length === 0 && (
            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
              <div style={{
                ...cellStyle, gridColumn: "1 / -1", background: CARD_BG,
                color: TEXT_MUTED, fontSize: 11, textAlign: "center", padding: "14px",
              }}>
                （収入行はまだありません）
              </div>
            </div>
          )}
          {incomeLines.map((l) => {
            const tArr = Array.isArray(l?.monthly_targets) ? l.monthly_targets : Array(12).fill(0);
            const aArr = Array.isArray(l?.monthly_actuals) ? l.monthly_actuals : Array(12).fill(0);
            const tSum = tArr.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
            const aSum = aArr.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
            const aFontFor = (v) => v == null ? 15 : Math.max(10, cellFontSize(fmtN(v)) + 5);
            const tFontFor = (v) => v == null ? 8 : Math.max(7, Math.min(8, cellFontSize(fmtN(v)) - 3));
            return (
              <div key={l.id ?? l.category_name} style={{
                display: "grid", gridTemplateColumns: gridCols, gap: 4,
                borderTop: `1px dashed ${BORDER}`, paddingTop: 2,
              }}>
                {/* 行名 (read-only) */}
                <div style={{ ...cellStyle, display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{
                    flex: 1, minWidth: 0,
                    color: TEXT_PRIMARY, fontWeight: 700, fontSize: 12,
                    overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {l?.category_name || "(無題)"}
                  </span>
                </div>
                {/* 月セル × 12 (read-only)。i=fiscal idx 0..11。
                    aArr/tArr は 配列 0..11 (fiscal-indexed)。0/欠損は "—" 表示。 */}
                {months.map((_m, i) => {
                  const aRaw = Number(aArr[i]);
                  const tRaw = Number(tArr[i]);
                  const aVal = Number.isFinite(aRaw) && aRaw !== 0 ? aRaw : null;
                  const tVal = Number.isFinite(tRaw) && tRaw !== 0 ? tRaw : null;
                  return (
                    <div key={`s${i}`} style={{
                      ...cellStyle, display: "flex", flexDirection: "column", gap: 1, padding: "4px 4px",
                    }}>
                      <span style={{
                        color: GOLD, fontWeight: 700,
                        fontSize: aFontFor(aVal),
                        textAlign: "right", padding: "2px 4px", lineHeight: 1.1,
                      }}>
                        {aVal == null ? "—" : fmtN(aVal)}
                      </span>
                      <span style={{
                        color: BUDGET_BLUE, fontWeight: 500,
                        fontSize: tFontFor(tVal),
                        textAlign: "right", padding: "2px 4px", lineHeight: 1.1,
                      }}>
                        {tVal == null ? "—" : fmtN(tVal)}
                      </span>
                    </div>
                  );
                })}
                {/* 進捗列: Σ実測 */}
                <div style={{
                  ...cellStyle, textAlign: "right",
                  color: GOLD, fontWeight: 700,
                  fontSize: aFontFor(aSum), padding: "6px 6px",
                }}>
                  {fmtN(aSum)}
                </div>
                {/* 目標合計列: Σ目標 */}
                <div style={{
                  ...cellStyle, textAlign: "right",
                  color: BUDGET_BLUE, fontWeight: 600,
                  fontSize: Math.max(9, cellFontSize(fmtN(tSum)) + 1),
                  padding: "6px 6px",
                }}>
                  {fmtN(tSum)}
                </div>
              </div>
            );
          })}

          {/* 行3: − 支出合計 (computeAssetSheet で集計、read-only) */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 6 }}>
            <div style={labelCellStyle}>− 支出合計</div>
            {rows.map((r, idx) => (
              <div key={idx}>
                {renderTwoValCell(
                  r.expenseActual === 0 ? null : r.expenseActual,
                  r.expenseBudget === 0 ? null : r.expenseBudget,
                )}
              </div>
            ))}
            <div style={{
              ...cellStyle, textAlign: "right",
              color: GOLD, fontWeight: 700,
              fontSize: Math.max(9, cellFontSize(fmtN(summary.expenseActualTotal)) + 2),
            }}>
              {fmtN(summary.expenseActualTotal)}
            </div>
            <div style={{
              ...cellStyle, textAlign: "right",
              color: BUDGET_BLUE, fontWeight: 600,
              fontSize: Math.max(9, cellFontSize(fmtN(summary.expenseBudgetTotal)) + 1),
            }}>
              {fmtN(summary.expenseBudgetTotal)}
            </div>
          </div>

          {/* 行4: 💎 累計残高 (上=実測 actualCum / 下=予想 forecastCum) */}
          <div style={{
            display: "grid", gridTemplateColumns: gridCols, gap: 4,
            borderTop: `2px solid ${GOLD}55`, paddingTop: 4,
          }}>
            <div style={{ ...labelCellStyle, color: GOLD }}>💎 累計残高</div>
            {rows.map((r, idx) => (
              <div key={idx}>{renderTwoValCell(r.actualCum, r.forecastCum)}</div>
            ))}
            {/* 進捗列: 着地見込み (settled?actualNet:forecastNet のΣ + initialAsset) */}
            <div style={{
              ...cellStyle, textAlign: "right", fontWeight: 700,
              color: summary.progressLanding >= 0 ? GOLD : RED,
              fontSize: Math.max(9, cellFontSize(fmtN(summary.progressLanding)) + 2),
            }}>
              {fmtN(summary.progressLanding)}
            </div>
            {/* 目標合計列: 年末予想残高 (= 最終月 forecastCum) */}
            <div style={{
              ...cellStyle, textAlign: "right", fontWeight: 600,
              color: summary.forecastCumTotal >= 0 ? BUDGET_BLUE : RED,
              fontSize: Math.max(9, cellFontSize(fmtN(summary.forecastCumTotal)) + 1),
            }}>
              {fmtN(summary.forecastCumTotal)}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
