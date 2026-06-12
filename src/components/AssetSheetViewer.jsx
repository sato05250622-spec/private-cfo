// =============================================================
// AssetSheetViewer — 資産残高繰越票 (顧客アプリ)
// Phase 2-4b (2026-06-11): read-only → 編集 UI 化。
//
// 変更点 (Phase 2-4a → 2-4b):
//   - 初期資産セル / 本収入 各月実測・各月予算 / 行名 を EditableCell 化。
//   - 行追加 (＋ 収入項目を追加) / 行削除 (×) ボタンを配備。
//   - 反映ボタンは配備しない (last-write-wins・writer 成功 = 即反映)。
//   - 支出合計行 / 累計残高行 は **read-only 維持** (集計・計算結果のため)。
//   - 初期資産は方針(a) local mirror:
//       useAuth().initialAsset を初期値に localInitialAsset を useState、
//       useEffect で auth 値が動いたら同期 (初回ロード吸い上げ)、
//       セル編集 → setLocalInitialAsset で即 UI 反映 → await setInitialAsset →
//       失敗時 useAuth 値へ rollback。
//
//   - EditableCell は admin リポ src/components/EditableCell.jsx (Phase E-d)
//     をこのファイル内 local component として移植 (scope を本ファイルに閉じる)。
//
//   - グラフ (LineChart 累計残高推移) は Phase 2-4c 予定 (今回未配備)。
//
// データソース (2-4a から変更なし):
//   - 本収入        : annual_budgets.income_lines  (live, hook 経由 data.incomeLines)
//   - 支出 (Σ)      : annual_budgets.lines        (live, hook 経由 data.lines)
//   - 初期資産       : profiles.initial_asset      (AuthContext.initialAsset 経由 + local mirror)
//
// 受け取り props 契約 (App.jsx 2425 から維持): { clientId }
//
// 動作前提:
//   - Phase 2-3 RLS (annual_budgets_client_update_own / select_own from visible 撤去) 適用済。
//   - writer (Phase 2-2b hook) は楽観 update + rollback 完成済。
// =============================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { useAuth } from "../context/AuthContext";
import {
  computeAssetSheet,
  aggregateCellsFromExpenses,
  buildFixedCostLines,
  deriveFutureWeekBudgetForCategory,
  computeMonthlyExpenseBudgetTotals,
} from "../utils/assetSheet";
import {
  GOLD, NAVY2, NAVY3, CARD_BG, BORDER, RED,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";
// Phase 2-4c: 累計残高推移グラフ (recharts は既存 package.json 導入済 ^2.12.7、App.jsx 等で利用中)。
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";
import { getManagementStartDay } from "../utils/cycle";
import { toDateStr } from "@shared/format";
import { useClientBudgetRows } from "../hooks/useClientBudgetRows";
import { useClientLoanRows } from "../hooks/useClientLoanRows";
import { useExpenses } from "../hooks/useExpenses";

// ローカル色定数 (@shared/theme は BLUE=TEAL なのでローカル定義)。admin と同値。
const BUDGET_BLUE = "#5BA8FF";
const GREEN = "#43A047";

// ── 共通ヘルパ (admin AssetSheetTab.jsx と同形) ─────
const fmtN = (n) => (n == null ? "" : Number(n).toLocaleString("ja-JP"));
// 表示用：1万未満は円フル桁、1万以上は「万」表記（小数1桁）。資産シート 表セル/合計セル/グラフ Tooltip 用。
const fmtC = (n) => {
  if (n == null) return "";
  const num = Number(n);
  if (!Number.isFinite(num)) return "";
  if (Math.abs(num) < 10000) return num.toLocaleString("ja-JP");
  const m = Math.round((num / 10000) * 10) / 10;
  return m.toLocaleString("ja-JP") + "万";
};
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
// EditableCell (local) — admin src/components/EditableCell.jsx をそのまま inline 移植。
//
//   - 通常時は <input>、focused 中は親 value で上書きしない (flicker 防止)
//   - blur / Enter で commit
//   - 差分が無いとき (v === value) は commit せず無駄 API 呼出を抑止
//   - readOnly=true は <span>
//   - emptyAsNull=true: 数値空入力 → null commit (削除セマンティクス)
//   - commaFormat=true: 3桁カンマ表示 / 編集中は生数値 / commit 時はカンマ除去
// =============================================================
function EditableCell({
  value,
  onCommit,
  type = "text",
  placeholder,
  style,
  readOnly = false,
  emptyAsNull = false,
  commaFormat = false,
  // Phase G-4 (2026-06-12): 非 focus 時の表示のみ任意のフォーマッタで上書きするためのフック。
  //   null → 従来の fmtComma を使用。fmtC を渡すと万表記表示になるが、編集時 (focus 時) と
  //   commit ロジックは raw 数値のまま (生値編集を維持)。null/空は fmtComma フォールバック。
  displayFormatter = null,
}) {
  const [local, setLocal] = useState(value ?? "");
  const [focused, setFocused] = useState(false);
  const lastSeen = useRef(value);

  useEffect(() => {
    if (!focused && value !== lastSeen.current) {
      lastSeen.current = value;
      setLocal(value ?? "");
    }
  }, [value, focused]);

  const fmtComma = (v) => {
    if (!commaFormat) return String(v);
    const n = Number(String(v).replace(/,/g, ""));
    return Number.isFinite(n) && String(v).trim() !== "" ? n.toLocaleString() : String(v);
  };
  // 非 focus 表示用: displayFormatter が指定されかつ値が数値化できるならそれを通す、それ以外は fmtComma。
  const fmtDisplay = (v) => {
    if (displayFormatter && v != null && String(v).trim() !== "") {
      const n = Number(String(v).replace(/,/g, ""));
      if (Number.isFinite(n)) return displayFormatter(n);
    }
    return fmtComma(v);
  };

  if (readOnly) {
    const isPlaceholder = value == null || value === "";
    const display = isPlaceholder ? (placeholder ?? "—") : fmtDisplay(value);
    return (
      <span style={{
        display: "inline-block", width: "100%", boxSizing: "border-box",
        padding: "4px 6px", fontSize: 11,
        color: isPlaceholder ? TEXT_MUTED : TEXT_PRIMARY,
        whiteSpace: "pre-wrap",
        ...style,
      }}>
        {display}
      </span>
    );
  }

  const commit = () => {
    let v = local;
    const raw = commaFormat ? String(local).replace(/,/g, "") : local;
    if (type === "number") {
      if (raw === "") {
        v = emptyAsNull ? null : 0;
      } else {
        v = Number(raw);
      }
    } else {
      v = raw;
    }
    if (v !== value) {
      lastSeen.current = v;
      onCommit(v);
    }
  };

  return (
    <input
      className="editable-cell-input"
      type={commaFormat ? "text" : type}
      inputMode={commaFormat ? "numeric" : undefined}
      value={focused ? local : fmtDisplay(local)}
      onChange={(e) => setLocal(commaFormat ? e.target.value.replace(/,/g, "") : e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      placeholder={placeholder}
      style={{
        width: "100%", boxSizing: "border-box",
        background: focused ? "rgba(255,255,255,0.06)" : "transparent",
        color: TEXT_PRIMARY,
        border: `1px solid ${focused ? `${GOLD}55` : "transparent"}`,
        borderRadius: 6,
        padding: "4px 6px", fontSize: 11, outline: "none",
        ...style,
      }}
    />
  );
}

// =============================================================
// メインコンポーネント
// =============================================================
export default function AssetSheetViewer({ clientId }) {
  // 顧客自身の profiles.initial_asset (AuthContext 経由)。
  const { initialAsset: authInitialAsset } = useAuth();

  // 年度セレクタ。初回 null → hook が最新年度を返す。
  const [currentYear, setCurrentYear] = useState(null);
  const {
    data, loading, error,
    addIncomeRow, removeIncomeRow, setIncomeLineName,
    setIncomeMonthlyActual, setIncomeMonthlyTarget,
    setInitialAsset: persistInitialAsset,
  } = useAnnualBudgets(clientId, currentYear);

  // 初回 data 着弾時の年度同期。
  useEffect(() => {
    if (currentYear == null && data?.fiscal_year != null) {
      setCurrentYear(Number(data.fiscal_year));
    }
  }, [currentYear, data?.fiscal_year]);

  // ── 初期資産 local mirror (Phase 2-4b 方針(a)) ────────
  // useAuth().initialAsset を初期値、auth 値が動いたら同期。
  // 編集時は setLocalInitialAsset で即UI反映 → await persistInitialAsset → 失敗rollback。
  const [localInitialAsset, setLocalInitialAsset] = useState(Number(authInitialAsset) || 0);
  useEffect(() => {
    setLocalInitialAsset(Number(authInitialAsset) || 0);
  }, [authInitialAsset]);

  // ── Phase G-2 (2026-06-12): 横画面検出 (AnnualBudgetViewer L227-241 と同形) ─
  //   landscape のとき:
  //     - 4 行テーブル全体を viewport 全幅へ position:fixed で breakout (S.overlay maxWidth:430 を逃れる)
  //     - gridCols を 12% + 12×minmax(0,5.5%) + 11% + 11% = 100% の厳密配分に切替
  //     - overflowX を hidden、minWidth:0、width:100% で 12 ヶ月フィット
  //     - 縦線 left を calc(12% + 2px) に追従
  //     - セル padding/fontSize を圧縮 (8/6/11 → 6/2/9)
  //   portrait は従来通り (gridCols 160px / overflowX:auto / left:162)。
  const [isLandscape, setIsLandscape] = useState(
    typeof window !== "undefined"
      && window.matchMedia("(orientation: landscape)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mq = window.matchMedia("(orientation: landscape)");
    const handler = (e) => setIsLandscape(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const initialAssetValue = Number(localInitialAsset) || 0;

  const handleInitialAssetCommit = async (v) => {
    const n = Number(v) || 0;
    const prev = localInitialAsset;
    setLocalInitialAsset(n); // optimistic
    try {
      await persistInitialAsset?.(n);
    } catch (e) {
      console.error("[AssetSheetViewer.setInitialAsset]", e);
      // 失敗 → useAuth 由来の元値へ rollback (prev ではなく authInitialAsset 起点に戻すと
      //   useEffect 同期と整合する)。
      setLocalInitialAsset(Number(authInitialAsset) || prev || 0);
    }
  };

  const startMonth = Number(data?.fiscal_year_start_month) || 1;
  const months = useMemo(() => monthsFromStart(startMonth), [startMonth]);

  const incomeLines = Array.isArray(data?.incomeLines)
    ? data.incomeLines
    : (Array.isArray(data?.income_lines) ? data.income_lines : []);
  const expenseLines = Array.isArray(data?.lines) ? data.lines : [];

  // Phase E-1 (2026-06-11): admin AssetSheetTab.jsx L117-190 と同経路で
  //   expenseBudgetCtx を組み立てる。yearLabel/fy はここで前置宣言し、以降
  //   全派生で fiscalYear=fy を共有する。E-1 では描画は触らず derive のみ追加。
  // 表示用 year ラベル (writer 引数にもこの値を使う)。
  const yearLabel = currentYear ?? data?.fiscal_year ?? new Date().getFullYear();
  const fy = Number(yearLabel);

  // ── Phase E-1: ctx 構築用 hook 3 本 (read-only / focus refetch あり) ──
  const { weekCatBudgetRows } = useClientBudgetRows();
  const { loanRows } = useClientLoanRows();
  const { expenses } = useExpenses();

  // ── Phase E-1: 派生 (admin L141-190 と対応) ─────────────────
  const fixedCostLines = useMemo(() => buildFixedCostLines(loanRows), [loanRows]);
  const linesForBudget = useMemo(
    () => [...fixedCostLines, ...expenseLines],
    [fixedCostLines, expenseLines],
  );
  const todayStr = useMemo(() => toDateStr(new Date()), []);
  const msdVal = getManagementStartDay();
  const settledMonths = useMemo(
    () => (Array.isArray(data?.settledMonths) ? data.settledMonths : []),
    [data?.settledMonths],
  );
  const aggregatedCells = useMemo(() => {
    try {
      return aggregateCellsFromExpenses(msdVal, fy, expenses, startMonth);
    } catch (err) {
      console.error("[AssetSheetViewer.aggregatedCells]", err);
      return new Map();
    }
  }, [msdVal, fy, expenses, startMonth]);
  const weekBudgetByCatMonth = useMemo(() => {
    const map = new Map();
    for (const line of linesForBudget) {
      if (line && line.row_type === "category" && line.category_id) {
        map.set(
          line.category_id,
          deriveFutureWeekBudgetForCategory(weekCatBudgetRows, line.category_id, { fiscalYear: fy, startMonth, msd: msdVal, todayStr }),
        );
      }
    }
    return map;
  }, [linesForBudget, weekCatBudgetRows, fy, startMonth, msdVal, todayStr]);
  const expenseBudgetCtx = useMemo(
    () => ({ currentYear: fy, msdVal, todayStr, startMonth, settledMonths, weekBudgetByCatMonth, aggregatedCells }),
    [fy, msdVal, todayStr, startMonth, settledMonths, weekBudgetByCatMonth, aggregatedCells],
  );
  // 下段(青) = 全月予算経路 (admin L178-181 と同式)
  const expenseBudgetMonthly = useMemo(
    () => computeMonthlyExpenseBudgetTotals(linesForBudget, expenseBudgetCtx, startMonth, { budgetOnly: true }).monthly,
    [linesForBudget, expenseBudgetCtx, startMonth],
  );
  // 上段(金) = 既定経路、settledMonths で月セル時にゲート (admin L187-190 と同式)
  const expenseResolvedMonthly = useMemo(
    () => computeMonthlyExpenseBudgetTotals(linesForBudget, expenseBudgetCtx, startMonth, {}).monthly,
    [linesForBudget, expenseBudgetCtx, startMonth],
  );

  const { rows, summary } = useMemo(
    () => computeAssetSheet({ incomeLines, expenseLines, months, initialAsset: initialAssetValue }),
    [incomeLines, expenseLines, months, initialAssetValue],
  );

  // Phase 1-D-3h (2026-06-11): 累計残高行「目標合計」列の派生計算 (案②: UI 側のみ)。
  //   admin AssetSheetTab.jsx と同式・同意味:
  //   expenseTargetTotal = Σ linesForBudget.target_value (固定費込み、admin L218-221 と完全一致)
  //   targetNetTotal     = 年間目標差額 (初期資産抜き) = 目標収入 − 目標支出
  //   ※ 既存 summary.forecastCumTotal は「年末予想残高 (初期資産起点・monthly_budget ベース)」で別物。
  //      グラフ (forecastCum/actualCum) や月次累計表示には影響させない。
  // Phase E-2 (2026-06-12): 集計スコープを expenseLines → linesForBudget (固定費込み) に拡張。
  //   admin AssetSheetTab.jsx L218-221 と 1 円一致 (= AnnualBudgetTab targetGrandTotal と同経路)。
  const expenseTargetTotal = (linesForBudget || []).reduce(
    (s, l) => s + (Number(l?.target_value) || 0),
    0,
  );
  const targetNetTotal = summary.incomeTargetTotal - expenseTargetTotal;

  // ── Phase E-2 (2026-06-12): admin AssetSheetTab.jsx L228-300 をバイト一致移植 ─────
  //   E-1 で構築した settledMonths / expenseResolvedMonthly / expenseBudgetMonthly /
  //   rows / targetNetTotal を消費。シンボル名は admin と同名で一致するため
  //   コードは 1 文字も改変せず append (1 円一致の肝)。
  const expenseActualSettledTotal = useMemo(() => {
    let s = 0;
    for (let i = 0; i < months.length; i++) {
      const cm = Number(months[i]);
      const settled = settledMonths.includes(cm) || settledMonths.includes(String(cm));
      if (!settled) continue;
      const v = expenseResolvedMonthly?.[cm];
      const n = Number(v);
      if (v != null && Number.isFinite(n)) s += n;
    }
    return s;
  }, [months, settledMonths, expenseResolvedMonthly]);

  // Phase D (2026-06-11): 累計残高行を「目標管理ビュー」に刷新 (UI 派生、computeAssetSheet 無改変)。
  //   - actualNetByIdx[i]    : 月 i の純損益 (確定月のみ、未確定月は null)
  //                            = rows[i].incomeActual − expenseResolvedMonthly[cm]
  //                              (★初期資産抜き、★支出固定費込み = Phase C 上段と同経路)
  //   - actualCumByIdx[i]    : 累計実測 (確定月のみ伸ばし、未確定月は前月までの累計を維持)
  //                            ※決定2-b: 未確定月でも前月累計を表示し続け、視覚的に連続させる
  //                            ※startMonth より前 (未スタート) のみ null
  //   - budgetRemainByIdx[i] : 目標残 = targetNetTotal − (累計実測 ?? 0)
  //                            <0 で RED 切替 (決定6)
  //   - progressLandingNew   : 着地見込み = Σ(settled ? actualNetNew : forecastNetNew)
  //                            forecastNetNew = rows[i].incomeTarget − expenseBudgetMonthly[cm]
  //                            (★初期資産抜き、★固定費込み = 行と同経路)
  //   グラフ chartData は決定1-β で旧 rows.forecastCum/actualCum を温存 (無改変)。
  const actualNetByIdx = useMemo(() => {
    return months.map((m, i) => {
      const cm = Number(m);
      const settled = settledMonths.includes(cm) || settledMonths.includes(String(cm));
      if (!settled) return null;
      const inc = Number(rows[i]?.incomeActual) || 0;
      const exp = Number(expenseResolvedMonthly?.[cm]) || 0;
      return inc - exp;
    });
  }, [months, rows, settledMonths, expenseResolvedMonthly]);
  const actualCumByIdx = useMemo(() => {
    const out = [];
    let run = 0;
    let started = false;
    for (let i = 0; i < months.length; i++) {
      const v = actualNetByIdx[i];
      if (v != null) {
        run += v;
        started = true;
        out.push(run);
      } else {
        out.push(started ? run : null);
      }
    }
    return out;
  }, [months, actualNetByIdx]);
  const budgetRemainByIdx = useMemo(
    () => actualCumByIdx.map((cum) => targetNetTotal - (cum ?? 0)),
    [actualCumByIdx, targetNetTotal],
  );
  const progressLandingNew = useMemo(() => {
    let s = 0;
    for (let i = 0; i < months.length; i++) {
      const cm = Number(months[i]);
      const settled = settledMonths.includes(cm) || settledMonths.includes(String(cm));
      if (settled) {
        const inc = Number(rows[i]?.incomeActual) || 0;
        const exp = Number(expenseResolvedMonthly?.[cm]) || 0;
        s += inc - exp;
      } else {
        const inc = Number(rows[i]?.incomeTarget) || 0;
        const exp = Number(expenseBudgetMonthly?.[cm]) || 0;
        s += inc - exp;
      }
    }
    return s;
  }, [months, rows, settledMonths, expenseResolvedMonthly, expenseBudgetMonthly]);

  // ── Phase F-1 (2026-06-12): 「予想ロジック」3 本 ─────
  //   累計残高 月セル下段を「目標残 (budgetRemainByIdx)」から「予想累計 (forecastCumByIdx)」に
  //   置換するため。settled ゲート無し、全月一律で
  //     forecastNet = incomeTarget − expenseBudgetMonthly (固定費込み・予算経路)
  //   を累積。グランド目標列にも forecastNetTotal を表示する。
  //   ※ .at() / findLast は iOS 互換ガードに引っかかるため [length-1] で末尾取得。
  const forecastNetByIdx = useMemo(() => {
    return months.map((m, i) => {
      const cm = Number(m);
      const inc = Number(rows[i]?.incomeTarget) || 0;
      const exp = Number(expenseBudgetMonthly?.[cm]) || 0;
      return inc - exp;
    });
  }, [months, rows, expenseBudgetMonthly]);
  const forecastCumByIdx = useMemo(() => {
    const out = [];
    let run = 0;
    for (let i = 0; i < forecastNetByIdx.length; i++) {
      run += (Number(forecastNetByIdx[i]) || 0);
      out.push(run);
    }
    return out;
  }, [forecastNetByIdx]);
  const forecastNetTotal = (forecastCumByIdx.length > 0)
    ? forecastCumByIdx[forecastCumByIdx.length - 1]
    : 0;

  // LineChart 用 chartData。表の「累計残高」行と同じ derive ソースに繋ぎ替え:
  //   - actual   = actualCumByIdx[i] (確定月のみ伸びる純累計、初期資産抜き、未確定月は前月までを維持)
  //   - forecast = Σ forecastNetByIdx (= 初期資産抜きの予想累計)。actualCumByIdx と同じ土俵に揃える。
  //   累計残高行コメント (本ファイル下部) 通り actualCumByIdx は「固定費込み・初期資産抜き」なので、
  //   予想線も initialAssetValue を足さず fcum のみで表示する（両線とも表と同じ単位）。
  const chartData = useMemo(() => {
    let fcum = 0;
    return rows.map((r, i) => {
      const fn = Number(forecastNetByIdx[i]);
      fcum += Number.isFinite(fn) ? fn : 0;
      return {
        label: `${r.month}月`,
        actual: actualCumByIdx[i],
        forecast: fcum,
      };
    });
  }, [rows, forecastNetByIdx, actualCumByIdx]);

  // Phase 2-4c: 累計残高推移グラフ用データは forecastNetByIdx / actualCumByIdx 定義後に
  //   組み立てる (定義より上に書くと TDZ で参照不可)。下の useMemo 群末尾に移設済。

  // ── スタイル定数 (admin 1-D-3g と同形) ────────────────
  // Phase G-1.5 (2026-06-12): ラベル列を 260→160 に縮小し左寄せ密着レイアウトに。
  //   月セル minmax / 進捗 80 / 目標 110 は不変 (数字ロジック・固定列幅は temas)。
  // Phase G-2 (2026-06-12): landscape では 12 ヶ月フィット用に厳密 % 配分へ切替。
  //   12% + 12×minmax(0,5.5%) + 11% + 11% = 100%。column-gap 4 × 14 ギャップ = 56px は
  //   minmax(0, 5.5%) の 0 下限が吸収して overflowX:hidden 下でも目標列が溢れない。
  //   ※ "5.5%" 直書きフォールバックは禁止 (column-gap 56px を吸収できず右端クリップ)。
  const gridCols = isLandscape
    ? "12% repeat(12, minmax(0, 5.5%)) 11% 11%"
    : "160px repeat(12, minmax(84px, 1fr)) 80px 110px";
  // Phase G-2: landscape ではセル padding / フォントを圧縮 (AnnualBudgetViewer の cellPadX/baseCellFontSize 思想)。
  const headerCellStyle = {
    padding: isLandscape ? "6px 2px" : "8px 6px",
    background: NAVY3, color: TEXT_SECONDARY,
    fontSize: isLandscape ? 9 : 11, fontWeight: 700, textAlign: "center",
    borderRadius: 6, minWidth: 0, whiteSpace: "nowrap",
  };
  // Phase G-3 (2026-06-12): 支出シート (AnnualBudgetViewer L893-900) 方式を移植。
  //   列幅から確定計算でフォントを縮めるための avail (列幅 − 横padding) 定数。
  //   landscape 月列: 5.5% × ~798 ≈ 44 − pad 4 = 40
  //   landscape grand 列: 11% × ~798 ≈ 88 − pad 4 = 84
  //   portrait は tableLayout 相当が無いため控えめなデフォルト (60 / 100)。
  const monthAvail = isLandscape ? 40 : 60;
  const grandAvail = isLandscape ? 84 : 100;
  // Phase G-3: cellStyle に overflow:'hidden' を追加し、隣セルへの物理侵入を遮断 (支出シート td 仕様と一致)。
  const cellStyle = {
    padding: isLandscape ? "4px 2px" : "6px 6px",
    background: NAVY2, borderRadius: 6,
    minWidth: 0, overflow: 'hidden', whiteSpace: "nowrap",
    border: `1px solid ${BORDER}`, fontSize: isLandscape ? 9 : 11,
  };
  const labelCellStyle = {
    ...cellStyle, color: TEXT_SECONDARY, fontWeight: 700, textAlign: "left",
  };
  const yearNavBtnStyle = {
    background: NAVY3, color: GOLD, border: `1px solid ${BORDER}`,
    borderRadius: 6, padding: "6px 14px", fontSize: 14, fontWeight: 700,
    cursor: "pointer", whiteSpace: "nowrap",
  };

  // 月セル 2 値 read-only 表示 (支出合計 / 累計残高 行用)。
  // Phase E-2 (2026-06-12): refColor を第3引数で受け取り (default=BUDGET_BLUE)。
  //   累計残高行で目標残 <0 のとき RED に切替えるため。既存呼出 (引数 2 個) は default で挙動不変。
  // Phase F-1 (2026-06-12): 上段(金) を実測<0 のとき RED に切替 (累計残高がマイナスに沈んだ月で視認性確保)。
  //   支出合計 上段は値が常に >=0 のため挙動不変。
  // Phase G-3 (2026-06-12): 支出シート (AnnualBudgetViewer L893-900 cellFontSize(text, avail)) 方式を移植。
  //   列幅 avail に応じて確定計算でフォントを縮める。月セル既定は monthAvail、grand 列は呼出側が grandAvail を渡す。
  //   外側 div に overflow:'hidden' を付与、lineHeight:1.0 + gap:0 で 2 段スタックの縦侵入も抑制。
  // Phase G-5 (2026-06-12): 1 円フル桁 fmtN 表示に戻し、avail 連動式の下限を 5px まで開放
  //   (支出シート AnnualBudgetViewer L893-897 と同流儀)。長桁でも文字化けせず収まる。
  const renderTwoValCell = (actualVal, refVal, refColor = BUDGET_BLUE, avail = monthAvail) => {
    const actualSize = actualVal == null ? 12 : Math.max(5, Math.min(13, Math.floor(avail / (String(fmtN(actualVal)).length * 0.85))));
    const refSize    = refVal    == null ? 8  : Math.max(5, Math.min(9,  Math.floor(avail / (String(fmtN(refVal)).length * 0.95))));
    const actualColor = (actualVal != null && actualVal < 0) ? RED : GOLD;
    return (
      <div style={{ ...cellStyle, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0, overflow: 'hidden' }}>
        <span style={{ color: actualColor, fontSize: actualSize, fontWeight: 700, lineHeight: 1.0, whiteSpace: 'nowrap' }}>
          {actualVal == null ? '—' : fmtN(actualVal)}
        </span>
        <span style={{ color: refColor, fontSize: refSize, fontWeight: 500, lineHeight: 1.0, whiteSpace: 'nowrap' }}>
          {refVal == null ? '—' : fmtN(refVal)}
        </span>
      </div>
    );
  };

  // Phase G-2 (2026-06-12): 既存 JSX 全体を card 変数に格納し、
  //   landscape 時は viewport 全幅へ position:fixed で breakout する (AnnualBudgetViewer L1792-1805 同形)。
  //   portrait 時はそのまま card を return → 挙動完全不変。
  const card = (
    <div style={{
      background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`,
      padding: 16, color: TEXT_PRIMARY,
      display: "flex", flexDirection: "column", gap: 14,
    }}>

      {/* ① 年セレクタ */}
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

      {/* ② 累計残高 推移グラフ (実測 GOLD / 予想 BLUE) — read-only。
          admin AssetSheetTab.jsx L248-273 と同形 (recharts LineChart 2 本線)。
          実測線は actualCum=null の未確定月で connectNulls={false} により線が切れる。 */}
      <div style={{
        background: CARD_BG, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 12,
      }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 8 }}>
          累計残高 推移 (実測 / 予想)
        </div>
        <div style={{ width: "100%", height: 240 }}>
          <ResponsiveContainer>
            <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid stroke={BORDER} strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" stroke={TEXT_SECONDARY} tick={{ fill: TEXT_SECONDARY, fontSize: 10 }} />
              <YAxis
                stroke={TEXT_SECONDARY}
                tick={{ fill: TEXT_SECONDARY, fontSize: 10 }}
                tickFormatter={(v) => Math.round(v / 10000)}
              />
              <Tooltip
                contentStyle={{ background: NAVY3, border: `1px solid ${BORDER}`, color: TEXT_PRIMARY, fontSize: 11 }}
                formatter={(v) => fmtN(v)}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: TEXT_SECONDARY }} />
              <Line dataKey="forecast" name="予想" stroke={BUDGET_BLUE} dot={false} />
              <Line dataKey="actual" name="実測" stroke={GOLD} dot={false} connectNulls={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ③ 4 行テーブル (1-D-3g レイアウト・編集可)
          Phase G-2 (2026-06-12): landscape では overflowX:hidden + 内側 width:100% で
            grid を viewport 幅に追従させ、横スクロール無しで 12 ヶ月フィット。 */}
      <div style={{ overflowX: isLandscape ? "hidden" : "auto" }}>
        <div style={{
          display: "flex", flexDirection: "column", gap: 4,
          minWidth: isLandscape ? 0 : "fit-content",
          width: isLandscape ? "100%" : undefined,
          position: "relative",
        }}>
          {/* Phase G-1 / G-1.5 (2026-06-12): ラベル列 (col1=160px) と月セル群 (col2..) の境界に縦線を 1 本敷く。
              位置 left:162 = col1(160px) + gap4 の中央。スクロール内側に置くので月セルと一緒に水平スクロールする。
              Phase G-2 (2026-06-12): landscape では col1=12% に追従させるため left=calc(12% + 2px)。 */}
          <div style={{
            position: "absolute",
            left: isLandscape ? "calc(12% + 2px)" : 162,
            top: 0, bottom: 0, width: 1, background: BORDER, pointerEvents: "none",
          }} />

          {/* 行1: 初期資産 (月見出し兼用) — 初期資産セルを EditableCell 化 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
            <div style={{
              ...labelCellStyle,
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
            }}>
              <span style={{ whiteSpace: "nowrap" }}>💰 初期資産</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <EditableCell
                  type="number"
                  commaFormat
                  emptyAsNull
                  value={initialAssetValue === 0 ? null : initialAssetValue}
                  placeholder="0"
                  onCommit={handleInitialAssetCommit}
                  style={{
                    color: GOLD, fontWeight: 700, textAlign: "right",
                    fontSize: Math.max(9, cellFontSize(fmtN(initialAssetValue)) + 2),
                  }}
                />
              </div>
            </div>
            {months.map((m) => (
              <div key={m} style={headerCellStyle}>{m}月</div>
            ))}
            <div style={headerCellStyle}>進捗</div>
            <div style={headerCellStyle}>目標合計</div>
          </div>

          {/* セクション見出し: ⊕ 本収入 — Phase G-1.5 (2026-06-12): 初期資産直下に密着 (marginTop:-2)、
              右隣に小さい ＋ 行追加ボタンを配置。旧 standalone「＋ 収入項目を追加」ボタンは撤去。 */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: -2 }}>
            <div style={{
              ...labelCellStyle, color: GREEN, background: "transparent", border: "none",
              display: "flex", alignItems: "center", gap: 8,
            }}>
              <span>⊕ 本収入</span>
              <button
                onClick={() => addIncomeRow?.(fy)}
                title="収入項目を追加"
                style={{
                  background: "transparent", color: GREEN,
                  border: `1px dashed ${GREEN}66`, borderRadius: 4,
                  fontSize: 11, fontWeight: 700, padding: "1px 8px",
                  cursor: "pointer", whiteSpace: "nowrap", lineHeight: 1.2,
                }}
              >＋</button>
            </div>
          </div>

          {/* 本収入 行群 (編集可)。empty hint は別ブロック。 */}
          {incomeLines.length === 0 && (
            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4 }}>
              <div style={{
                ...cellStyle, gridColumn: "1 / -1", background: CARD_BG,
                color: TEXT_MUTED, fontSize: 11, textAlign: "center", padding: "14px",
              }}>
                （収入行はまだありません。本収入の ＋ から行を追加してください）
              </div>
            </div>
          )}
          {incomeLines.map((l) => {
            const tArr = Array.isArray(l?.monthly_targets) ? l.monthly_targets : Array(12).fill(0);
            const aArr = Array.isArray(l?.monthly_actuals) ? l.monthly_actuals : Array(12).fill(0);
            const tSum = tArr.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
            const aSum = aArr.reduce((s, v) => s + (Number.isFinite(Number(v)) ? Number(v) : 0), 0);
            // Phase G-5 (2026-06-12): monthAvail 連動・下限 5px / 上限 13(上段)/9(下段)。長桁フル桁でも縮みきって収まる。
            const aFontFor = (v) => v == null ? 11 : Math.max(5, Math.min(13, Math.floor(monthAvail / (String(fmtN(v)).length * 0.85))));
            const tFontFor = (v) => v == null ? 8 : Math.max(5, Math.min(9, Math.floor(monthAvail / (String(fmtN(v)).length * 0.95))));
            return (
              <div key={l.id ?? l.category_name} style={{
                display: "grid", gridTemplateColumns: gridCols, gap: 4,
                borderTop: `1px dashed ${BORDER}`, paddingTop: 2,
              }}>
                {/* 行名 EditableCell + × 削除 */}
                <div style={{ ...cellStyle, display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <EditableCell
                      type="text"
                      value={l?.category_name ?? ""}
                      placeholder="収入項目名"
                      onCommit={(v) => setIncomeLineName?.(fy, l.id, v)}
                      style={{ color: TEXT_PRIMARY, fontWeight: 700, fontSize: 12 }}
                    />
                  </div>
                  <button
                    onClick={() => {
                      const name = l?.category_name || "(無題)";
                      if (window.confirm(`収入行「${name}」を削除しますか?`)) {
                        removeIncomeRow?.(fy, l.id);
                      }
                    }}
                    title="この収入行を削除"
                    style={{
                      background: "transparent", color: RED,
                      border: `1px solid ${RED}55`, borderRadius: 4,
                      fontSize: 10, fontWeight: 700, padding: "0 6px",
                      cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >×</button>
                </div>
                {/* 月セル × 12 (1 セル内に 上=実測GOLD / 下=予算BLUE の編集スタック) */}
                {months.map((_m, i) => {
                  const aRaw = Number(aArr[i]);
                  const tRaw = Number(tArr[i]);
                  const aVal = Number.isFinite(aRaw) && aRaw !== 0 ? aRaw : null;
                  const tVal = Number.isFinite(tRaw) && tRaw !== 0 ? tRaw : null;
                  return (
                    <div key={`s${i}`} style={{
                      ...cellStyle, display: "flex", flexDirection: "column", gap: 1, padding: "4px 4px",
                    }}>
                      <EditableCell
                        type="number" commaFormat emptyAsNull
                        value={aVal}
                        placeholder="—"
                        onCommit={(v) => setIncomeMonthlyActual?.(fy, l.id, i, v)}
                        style={{
                          color: GOLD, fontWeight: 700,
                          fontSize: aFontFor(aVal),
                          textAlign: "right", padding: "2px 4px", lineHeight: 1.0,
                        }}
                      />
                      <EditableCell
                        type="number" commaFormat emptyAsNull
                        value={tVal}
                        placeholder="—"
                        onCommit={(v) => setIncomeMonthlyTarget?.(fy, l.id, i, v)}
                        style={{
                          color: BUDGET_BLUE, fontWeight: 500,
                          fontSize: tFontFor(tVal),
                          textAlign: "right", padding: "2px 4px", lineHeight: 1.0,
                        }}
                      />
                    </div>
                  );
                })}
                {/* 進捗列: Σ実測 (read-only) — Phase G-5: grandAvail 連動, min5 */}
                <div style={{
                  ...cellStyle, textAlign: "right",
                  color: GOLD, fontWeight: 700,
                  fontSize: Math.max(5, Math.min(13, Math.floor(grandAvail / (String(fmtN(aSum)).length * 0.85)))),
                  padding: "6px 6px",
                }}>
                  {fmtN(aSum)}
                </div>
                {/* 目標合計列: Σ目標 (read-only) — Phase G-5: grandAvail 連動, min5 */}
                <div style={{
                  ...cellStyle, textAlign: "right",
                  color: BUDGET_BLUE, fontWeight: 600,
                  fontSize: Math.max(5, Math.min(9, Math.floor(grandAvail / (String(fmtN(tSum)).length * 0.95)))),
                  padding: "6px 6px",
                }}>
                  {fmtN(tSum)}
                </div>
              </div>
            );
          })}

          {/* Phase G-1.5 (2026-06-12): 旧 standalone「＋ 収入項目を追加」ボタンは撤去。
              代わりに 本収入 ヘッダー内に小さい ＋ ボタンを配置 (上 ⊕ 本収入 セクション参照)。 */}

          {/* 行3: − 支出合計 (read-only 維持) */}
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 4, marginTop: 6 }}>
            <div style={labelCellStyle}>− 支出合計</div>
            {/* Phase E-2 (2026-06-12): 上段(金)=確定月のみ実測(固定費込み, expenseResolvedMonthly)、
                下段(青)=月別予算 (expenseBudgetMonthly)。admin AssetSheetTab.jsx L620-627 と完全同形。 */}
            {rows.map((r, idx) => {
              const cm = Number(months[idx]);
              const isSettledM = settledMonths.includes(cm) || settledMonths.includes(String(cm));
              const upperVal  = isSettledM ? (expenseResolvedMonthly?.[cm] ?? null) : null;
              const budgetVal = expenseBudgetMonthly?.[cm] ?? null;
              return <div key={idx}>{renderTwoValCell(upperVal, budgetVal)}</div>;
            })}
            {/* 進捗列: Σ実測支出 (固定費込み) — admin L628-635 と同経路 */}
            <div style={{
              ...cellStyle, textAlign: "right",
              color: GOLD, fontWeight: 700,
              fontSize: Math.max(5, Math.min(13, Math.floor(grandAvail / (String(fmtN(expenseActualSettledTotal)).length * 0.85)))),
            }}>
              {fmtN(expenseActualSettledTotal)}
            </div>
            {/* 目標合計列: Σ予算支出 (BLUE, 600) — admin L640-643 と同じく summary.expenseBudgetTotal を温存。Phase G-5: grandAvail 連動, min5 */}
            <div style={{
              ...cellStyle, textAlign: "right",
              color: BUDGET_BLUE, fontWeight: 600,
              fontSize: Math.max(5, Math.min(9, Math.floor(grandAvail / (String(fmtN(summary.expenseBudgetTotal)).length * 0.95)))),
            }}>
              {fmtN(summary.expenseBudgetTotal)}
            </div>
          </div>

          {/* 行4: 💎 累計残高 (read-only 維持) */}
          <div style={{
            display: "grid", gridTemplateColumns: gridCols, gap: 4,
            borderTop: `2px solid ${GOLD}55`, paddingTop: 4,
          }}>
            <div style={{ ...labelCellStyle, color: GOLD }}>💎 累計残高</div>
            {/* Phase E-2 (2026-06-12): admin AssetSheetTab.jsx L658-663 と完全同形 (定数名のみ
                customer ローカル BUDGET_BLUE に置換、色値は admin BLUE と一致 #5BA8FF)。
                上段(金)=累計実測 (固定費込み・初期資産抜き)、下段(青)=目標残、<0 で RED 切替。 */}
            {/* Phase F-1 (2026-06-12): 月セル下段を「目標残 (budgetRemainByIdx)」から
                「予想累計 (forecastCumByIdx)」に差替 (settled ゲート無し・全月予算ベース累積)。
                グランド目標列も同様に forecastNetTotal へ差替。
                旧 budgetRemainByIdx / targetNetTotal の定義は無使用扱いだが残す (最小差分)。 */}
            {/* Phase F-2 (2026-06-12): 月セル下段を「予想累計 (forecastCumByIdx)」から
                「単月予想 (forecastNetByIdx, =本収入予算−支出予算)」に差替。累積廃止。
                グランド目標列は forecastNetTotal (=Σ単月) を温存 → 行/列で意味が一致。
                forecastCumByIdx の定義は無使用扱いだが残す (最小差分)。 */}
            {rows.map((_r, idx) => {
              const upperVal = actualCumByIdx[idx];
              const lowerVal = forecastNetByIdx[idx];
              const lowerColor = (lowerVal != null && lowerVal < 0) ? RED : BUDGET_BLUE;
              return <div key={idx}>{renderTwoValCell(upperVal, lowerVal, lowerColor)}</div>;
            })}
            {/* 進捗列: 着地見込み (progressLandingNew, GOLD/RED) — admin L665-671 と同経路 */}
            <div style={{
              ...cellStyle, textAlign: "right", fontWeight: 700,
              color: progressLandingNew >= 0 ? GOLD : RED,
              fontSize: Math.max(5, Math.min(13, Math.floor(grandAvail / (String(fmtN(progressLandingNew)).length * 0.85)))),
            }}>
              {fmtN(progressLandingNew)}
            </div>
            {/* 目標合計列: Phase F-1 (2026-06-12) で年間予想差額 (forecastNetTotal)
                = Σ(月予想 = 目標収入 − 予算支出、初期資産抜き、全月累計) に差替。
                BLUE/RED, 600, 自動縮小。正負で色を判定 (≥0=BLUE / <0=RED)。 */}
            <div
              title="年間予想差額 (Σ(月予想 = 目標収入 − 予算支出)、初期資産抜き)"
              style={{
                ...cellStyle, textAlign: "right", fontWeight: 600,
                color: forecastNetTotal >= 0 ? BUDGET_BLUE : RED,
                fontSize: Math.max(5, Math.min(9, Math.floor(grandAvail / (String(fmtN(forecastNetTotal)).length * 0.95)))),
              }}
            >
              {fmtN(forecastNetTotal)}
            </div>
          </div>

        </div>
      </div>
    </div>
  );

  // Phase G-2: landscape 時のみ viewport 全幅 breakout (S.overlay maxWidth:430 を逃れる)。
  //   親 (App.jsx の menuScreen==="assetSheet" wrapper / S.overlay) には transform が無いため
  //   position:fixed が viewport 基準で解決し、確実に全幅に乗る。
  //   env(safe-area-inset-*) でノッチ・ダイナミックアイランドを回避。
  if (isLandscape) {
    return (
      <div style={{
        position: "fixed", inset: 0, zIndex: 400, background: NAVY2,
        overflow: "auto", padding: 8, boxSizing: "border-box",
        paddingTop: "calc(8px + env(safe-area-inset-top))",
        paddingBottom: "calc(8px + env(safe-area-inset-bottom))",
        paddingLeft: "calc(8px + env(safe-area-inset-left))",
        paddingRight: "calc(8px + env(safe-area-inset-right))",
      }}>
        {card}
      </div>
    );
  }
  return card;
}
