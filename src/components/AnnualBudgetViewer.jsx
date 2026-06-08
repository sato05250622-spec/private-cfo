import { Fragment, useState, useEffect, useRef } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { listFiscalYearsByClient } from "../lib/api/annualBudgets";
import { useLoans } from "../hooks/useLoans";
import { useBudgets } from "../hooks/useBudgets";
import { useExpenses } from "../hooks/useExpenses";
import { PopoverDial } from "./MonthDialPicker";
import { cycleStart, cycleEnd, findCycleOfDate, weekInCycle, weeksInCycle, getManagementStartDay } from "../utils/cycle";
import { toDateStr } from "@shared/format";
import {
  GOLD, NAVY, NAVY2, NAVY3, CARD_BG, BORDER, RED, TEAL,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

// #2修正: 予算セルの数字色 (本部 AnnualBudgetTab の BLUE と統一)。実測セルは TEXT_PRIMARY (白系)。
const BUDGET_BLUE = "#5BA8FF";
// 本部準拠: 目標列ヘッダ用 GREEN (admin AnnualBudgetTab の '#43A047' と同色)。
const TARGET_GREEN = "#43A047";

// #1: 固定費の年間消化を「現在の進捗で進める」ため、本部 annualBudgetSheet.js の
// classifyMonth / fiscalMonthCalendarYear と同一ロジックを顧客側に再実装 (別リポのため)。
// 月 m (年度内) が past/current/future のどれかを msd 基準サイクルで判定する。
function fiscalMonthCalendarYear(fiscalYear, startMonth, m) {
  const s = Math.max(1, Math.min(12, Number(startMonth) || 1));
  return Number(m) >= s ? fiscalYear : fiscalYear + 1;
}
function classifyMonth(year, m, msd, todayStr, startMonth = 1) {
  const cy = fiscalMonthCalendarYear(year, startMonth, m);
  const startStr = toDateStr(cycleStart(cy, m - 1, msd));
  const endStr = toDateStr(cycleEnd(cy, m - 1, msd));
  if (endStr < todayStr) return "past";
  if (startStr > todayStr) return "future";
  return "current";
}

// #2: 予算VS実績 (week_cat_budgets) を繰越票の月予算の入力元にする (本部とロジック統一)。
//   useBudgets の weekCatBudgets は { '${year}-${cycleMonth}-w${weekNum}_${categoryId}': amount } の Record。
//   指定カテゴリの cycle_month ごとに Σ(週) を取り、classifyMonth が current/future の月を返す。
//   返り値: { [m(1-12)]: Σ(週) }。月対応・対象月とも本部 deriveFutureWeekBudgetForCategory と同一。
function deriveFutureWeekBudgetForCategory(weekCatRecord, categoryId, { fiscalYear, startMonth = 1, msd, todayStr }) {
  const out = {};
  if (!weekCatRecord || typeof weekCatRecord !== "object" || categoryId == null) return out;
  const byMonth = {};
  for (const key of Object.keys(weekCatRecord)) {
    // key 形式: 'YYYY-CM-wWN_categoryId' (categoryId はハイフンを含みうるので末尾 greedy)。
    const mt = key.match(/^(\d+)-(\d+)-w(\d+)_(.+)$/);
    if (!mt) continue;
    const year = Number(mt[1]);
    const cm = Number(mt[2]);
    const cid = mt[4];
    if (String(cid) !== String(categoryId)) continue;
    if (!(cm >= 1 && cm <= 12)) continue;
    const cy = fiscalMonthCalendarYear(fiscalYear, startMonth, cm);
    if (year !== cy) continue;
    byMonth[cm] = (byMonth[cm] || 0) + (Number(weekCatRecord[key]) || 0);
  }
  for (const cmStr of Object.keys(byMonth)) {
    const cm = Number(cmStr);
    const cls = classifyMonth(fiscalYear, cm, msd, todayStr, startMonth);
    if (cls === "future" || cls === "current") out[cm] = byMonth[cm];
  }
  return out;
}

// 方針A: 指定カテゴリの「全12ヶ月」week_cat_budgets 合計 (年間予算)。消化サマリーの予算用。
//   過去/当月/将来を問わず設定済みの月予算を全合算。本部 annualWeekBudgetForCategory と同一ロジック
//   (顧客の weekCatBudgets は Record なのでキーをパースする)。
function annualWeekBudgetForCategory(weekCatRecord, categoryId, { fiscalYear, startMonth = 1 }) {
  if (!weekCatRecord || typeof weekCatRecord !== "object" || categoryId == null) return 0;
  let sum = 0;
  for (const key of Object.keys(weekCatRecord)) {
    const mt = key.match(/^(\d+)-(\d+)-w(\d+)_(.+)$/);
    if (!mt) continue;
    const year = Number(mt[1]);
    const cm = Number(mt[2]);
    const cid = mt[4];
    if (String(cid) !== String(categoryId)) continue;
    if (!(cm >= 1 && cm <= 12)) continue;
    const cy = fiscalMonthCalendarYear(fiscalYear, startMonth, cm);
    if (year !== cy) continue;
    sum += Number(weekCatRecord[key]) || 0;
  }
  return sum;
}

// Phase 3 (固定費): loans (借入、useLoans の app-shape: label/amount) → 繰越票の固定費行。
// 本部アプリ annualBudgetSheet.js の buildFixedCostLines と同等 (別リポのため再実装)。
//   - row_type 'fixed_cost'、category_id に loans.id、基準月額 (amount) を monthly_amount に
//   - monthly_amounts (月別上書き jsonb) も保持 → 各月セル = monthly_amounts[m] ?? monthly_amount
//   - committed_lines には焼かれない (描画時にライブ生成し最上部に prepend)
//   - 並び順は loans の取得順 (created_at 昇順、reorder なし) をそのまま使う
function buildFixedCostLines(loans) {
  const arr = Array.isArray(loans) ? loans : [];
  return arr.map((loan, i) => ({
    category_id: loan.id,
    category_name: loan.label,
    row_type: "fixed_cost",
    monthly_amount: Number(loan.amount) || 0,
    monthly_amounts: loan.monthlyAmounts || null,
    target_value: loan.annualTarget ?? null,
    archived: false,
    display_order: i,
  }));
}

// =============================================================
// 支出管理繰越票 read-only ビューア (Phase E 最終ゴール — 顧客アプリ)。
//
// props:
//   - clientId:   顧客の profiles.id (= auth.uid())
//   - fiscalYear: (optional) 表示年度。現状 API は最新年度1件のみ返すため
//                 予約 prop。将来 年度切替を足す時に使用。
//
// 表示元は committed_lines / committed_totals (本部が「反映」した snapshot)。
// last_committed_at が無い / data が無い = 未反映 → null を返し、
// 「準備中」表示は親 (App.jsx) に委ねる。
// =============================================================

// jsonb のキーは number / string 両方あり得るため両対応で取り出す。
function pickMonth(obj, m) {
  if (!obj || typeof obj !== "object") return null;
  const v = obj[m] ?? obj[String(m)];
  return v == null ? null : Number(v);
}

// committed_lines の 1 行・1 月のセル値を解決する。
// 優先度: monthly_overrides[m] → monthly_values[m] → null。
// (admin 側の live 集計値は snapshot に含まれないため override / values のみ)
function resolveCell(line, m) {
  // Phase 3 (固定費): 各月 monthly_amounts[m] ?? monthly_amount (基準額)。読み取り専用。
  // タスクA (2026-06-07): 月セル解決順を 3 段フォールバックに拡張 (非破壊・DB変更なし)。
  //   ① 手入力 monthly_amounts[m] があればそれ優先
  //   ② 無ければ 年間目標 (target_value=loans.annual_target) / 12 を表示 (Math.round で端数丸め)
  //   ③ それも無ければ monthly_amount (基準月額)
  //   admin AnnualBudgetTab.jsx resolveCell 固定費分岐と完全同一ロジック。
  if (line?.row_type === "fixed_cost") {
    const ma = line.monthly_amounts;
    const mv = ma ? (ma[m] ?? ma[String(m)]) : null;
    const tv = Number(line.target_value);
    const perMonth = (Number.isFinite(tv) && tv > 0) ? Math.round(tv / 12) : null;
    const a = mv != null ? Number(mv) : (perMonth != null ? perMonth : Number(line.monthly_amount));
    return Number.isFinite(a) && a !== 0 ? a : null;
  }
  const ov = pickMonth(line?.monthly_overrides, m);
  if (ov != null) return ov;
  const base = pickMonth(line?.monthly_values, m);
  if (base != null) return base;
  return null;
}

function fmtDateTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const fmtCell = (n) => (n == null ? "—" : Number(n).toLocaleString());
// 金額表示 (消化サマリーの ¥実績/¥予算)。null/undefined/NaN は 0 にフォールバックして必ず数値表示。
const fmtNum = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toLocaleString();

// 既存 App.jsx「準備中」カードと見た目完全一致のステータスカード。
// loading / 未反映 / 取得失敗 / data 無し のいずれでも親に null を返さず
// この自己完結カードを表示する。
function StatusCard({ message, showBadge }) {
  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
      <div style={{ padding: "16px 18px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 44, height: 44, borderRadius: 12, background: `${GOLD}22`, border: `1px solid ${GOLD}44`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>📄</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: TEXT_PRIMARY }}>支出管理繰越票</div>
      </div>
      <div style={{ padding: "14px 18px", background: NAVY2, textAlign: "center" }}>
        <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: showBadge ? 6 : 0 }}>{message}</div>
        {showBadge && (
          <div style={{ fontSize: 10, color: `${GOLD}88`, background: `${GOLD}11`, borderRadius: 8, padding: "6px 12px", display: "inline-block" }}>準備中</div>
        )}
      </div>
    </div>
  );
}

export default function AnnualBudgetViewer({ clientId, fiscalYear }) {
  // fiscalYear は予約 prop (現状は未使用、年度ダイヤルで上書き制御)。明示参照して lint 回避。
  void fiscalYear;
  // ③: 表示年度 (null = 最新年度)。年度ダイヤルで切替。
  const [selectedYear, setSelectedYear] = useState(null);
  // ③: 確定済み年度の一覧 (DESC)。年度ダイヤルの候補。
  const [fiscalYears, setFiscalYears] = useState([]);
  const { data, loading, error } = useAnnualBudgets(clientId, selectedYear);
  // 修正2(b): 繰越票の月ダイヤル。選択月 (初期=当月) の列へ横スクロール＆ハイライト。
  const [selectedMonth, setSelectedMonth] = useState(() => new Date().getMonth() + 1);
  // 固定費合計 / 変動費合計 の独立アコーディオン state (画面表示のみ。PDF/合計計算には影響しない)。
  //   subtotal 行をホストにして三角トグルで配下の内訳行 (固定費=loans/変動費=カテゴリ+特殊) を開閉。
  const [fixedCollapsed, setFixedCollapsed] = useState(false);
  const [variableCollapsed, setVariableCollapsed] = useState(false);
  const monthThRefs = useRef({}); // { [month]: <th> } 選択月へ scrollIntoView するため
  useEffect(() => {
    const el = monthThRefs.current[selectedMonth];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    }
  }, [selectedMonth, data]);
  useEffect(() => {
    let alive = true;
    if (!clientId) { setFiscalYears([]); return undefined; }
    listFiscalYearsByClient(clientId)
      .then((ys) => { if (alive) setFiscalYears(Array.isArray(ys) ? ys : []); })
      .catch((e) => { console.error("[fiscalYears]", e); if (alive) setFiscalYears([]); });
    return () => { alive = false; };
  }, [clientId]);
  // Phase 3 (固定費): データ源は loans (借入)。ログイン顧客の loans を購読 (auth ベース)。
  // 繰越票最上部にライブ生成行として描画する (committed_lines には含まれない)。
  const { loans } = useLoans();
  // #2: 予算VS実績 (week_cat_budgets) を将来月予算の入力元にするため購読 (auth ベース)。
  //   カテゴリ将来月セルを Σ(週) で上書き表示する (本部 resolveCell とロジック統一)。
  const { weekCatBudgets } = useBudgets();
  // Step2 (金バー週刻み): 今月サイクル内の実支出を週単位で進めるため raw expenses を取得。
  //   useExpenses() は内部で auth user 経由で client_id を引いて自分の expenses を返す。
  //   今月 (未確定) の expense を「今月 cycle 開始日〜今日」で合算し、金バー長を進める用途のみで使用。
  //   既存 settledCum (snapshot monthly_spent 由来) と重複しないよう、現在月が未確定のときだけ加算。
  const { expenses: liveExpenses } = useExpenses();

  // 横画面検出 (Rules of Hooks: 早期 return より前で呼ぶ)。
  // landscape のときだけ繰越票テーブルを全画面パネル化し、12ヶ月を横スクロール無しで表示する。
  // (アプリ全体は S.app maxWidth:430 + overflowX:hidden で囲われているため、
  //  position:fixed でビューポート全幅へ breakout する。S.app に transform は無いので
  //  fixed はビューポート基準で解決し 430px 枠とクリップの両方を逃れる。)
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

  // PDF 出力 (C 案): window.print() は iOS/iPadOS Safari が @page landscape を無視し
  // 縦向き＋途中列クリップになるため廃止。繰越票カード全体 (テーブル＋消化サマリー) を
  // html2canvas でキャプチャ → jsPDF で A4 横に貼り付ける。
  // ・ページ幅にフィット (アスペクト比維持) させるため全15列が必ず1枚の横幅に収まる。
  // ・縦に長く1枚に収まらない場合は画像を上方向にずらしながら複数ページへ分割。
  // 修正③: 15列で onclone リフロー時の列幅再配分による右端見切れを防ぐため、
  //   table-layout:fixed + colgroup で列幅を明示する。
  // 修正①: live DOM (モバイル横スクロール幅) と cloneDoc (captureW 幅) の行高差で
  //   chunk が破綻するため、同じ変形を施した temp clone を offscreen に置いて再測定する。
  // 修正②: 表外 [data-pdf="grandtotal"] div は #2② で削除済 → 年間合計サマリーを文字列で
  //   合成し、measureEl & cloneDoc 双方に挿入して tail unit として復活させる。
  const pdfRef = useRef(null);
  const pdfBusy = useRef(false);
  const handlePrint = async () => {
    const el = pdfRef.current;
    if (!el || pdfBusy.current) return;
    pdfBusy.current = true;
    try {
      const scale = 2;
      const marginMm = 8;
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();   // 297mm
      const pageH = doc.internal.pageSize.getHeight();  // 210mm
      const contentWmm = pageW - marginMm * 2;
      const contentHmm = pageH - marginMm * 2;

      // 全15列 (項目+1〜12月+実測+目標) の実幅をライブ DOM から測りキャプチャ幅を決める。
      const tableEl = el.querySelector("table");
      const tableW = Math.ceil(Math.max(tableEl?.scrollWidth || 0, tableEl?.offsetWidth || 0));
      const captureW = Math.max(tableW + 4, 800);
      // 1ページ分の縦容量 (CSS px)。captureW px 幅を contentWmm に写すスケールで換算。
      const pageContentPx = (contentHmm * captureW) / contentWmm;

      // 修正③: 15列固定レイアウト用の列幅 (項目=130 / 各月=等分 / 実測=100 / 目標=100)。
      //   table-layout:fixed + colgroup で onclone のリフロー時に列幅が再配分されて
      //   右が見切れる問題を防ぐ。
      const FIXED_CAT_W = 130;
      const FIXED_ACT_W = 100;
      const FIXED_TGT_W = 100;
      const FIXED_MONTH_W = Math.max(40, Math.floor((captureW - FIXED_CAT_W - FIXED_ACT_W - FIXED_TGT_W) / 12));

      // PDF キャプチャ用の変形を適用 (幅展開・列幅明示・sticky 解除)。measureEl と cloneDoc 双方に
      // 同じ変形を効かせる (live 測定と clone 描画のズレを無くす)。
      const applyPdfLayout = (rootEl, ownerDocument) => {
        if (!rootEl) return;
        rootEl.style.width = `${captureW}px`;
        rootEl.style.maxWidth = "none";
        rootEl.style.overflow = "visible";
        rootEl.querySelectorAll(".annual-pdf-scroll").forEach((n) => { n.style.overflow = "visible"; n.style.width = "auto"; });
        rootEl.querySelectorAll("table").forEach((t) => {
          t.style.minWidth = "0";
          t.style.width = "100%";
          t.style.tableLayout = "fixed";
          // 既存 colgroup があれば差し替え (再適用時の二重挿入を防ぐ)。
          const existingCg = t.querySelector("colgroup");
          if (existingCg) existingCg.remove();
          const cg = ownerDocument.createElement("colgroup");
          const addCol = (w) => { const c = ownerDocument.createElement("col"); c.style.width = `${w}px`; cg.appendChild(c); };
          addCol(FIXED_CAT_W);
          for (let i = 0; i < 12; i++) addCol(FIXED_MONTH_W);
          addCol(FIXED_ACT_W);
          addCol(FIXED_TGT_W);
          t.insertBefore(cg, t.firstChild);
        });
        rootEl.querySelectorAll("th, td").forEach((c) => {
          if (c.style.position === "sticky") { c.style.position = "static"; c.style.left = "auto"; }
        });
      };

      // 修正②: 「年間合計」サマリー (NAVY/GOLD体裁) を文字列で合成して挿入する。
      //   #2② で表外 [data-pdf="grandtotal"] div を削除済 → ここで合成して tail unit 復活。
      const grandTotalVal = data.committed_totals?.grandTotal ?? null;
      // #4 色テーマ: 年間合計=確定系=白 (#F0EAD6 = TEXT_PRIMARY)、年間目標=予算系=青 (#5BA8FF = BUDGET_BLUE)。
      const synthGrandHtml = (
        `<div data-pdf="grandtotal" data-pdf-synth="1" style="margin:12px 16px;padding:14px 16px;border-top:1px solid rgba(212,168,67,0.22);display:flex;justify-content:space-between;gap:16px;align-items:baseline;">` +
          `<div>` +
            `<div style="font-size:10px;color:rgba(240,234,214,0.55);margin-bottom:4px;">年間合計</div>` +
            `<div style="font-size:18px;font-weight:700;color:#F0EAD6;">¥${Number(grandTotalVal || 0).toLocaleString()}</div>` +
          `</div>` +
          `<div style="text-align:right;">` +
            `<div style="font-size:10px;color:rgba(240,234,214,0.55);margin-bottom:4px;">年間目標</div>` +
            `<div style="font-size:18px;font-weight:700;color:#5BA8FF;">¥${Number(targetGrandTotal || 0).toLocaleString()}</div>` +
          `</div>` +
        `</div>`
      );
      const injectSynthGrand = (rootEl, ownerDocument) => {
        if (!rootEl) return null;
        const existing = rootEl.querySelector('[data-pdf="grandtotal"][data-pdf-synth="1"]');
        if (existing) return existing;
        const wrap = ownerDocument.createElement("div");
        wrap.innerHTML = synthGrandHtml;
        const node = wrap.firstElementChild;
        // 挿入位置: 消化サマリー [data-pdf="summary"] の直前 (テーブル直下)。
        const summaryEl = rootEl.querySelector('[data-pdf="summary"]');
        if (summaryEl && summaryEl.parentNode) summaryEl.parentNode.insertBefore(node, summaryEl);
        else rootEl.appendChild(node);
        return node;
      };

      // 修正①: clone ベースで行高 / ヘッダ高 / tail unit 高を再測定する。
      //   live DOM はモバイル幅 (横スクロール) で nowrap、html2canvas が捕る幅 captureW で
      //   再配分された行高と一致しない → live 測定の rowHs で chunk すると budget 超過 → 縦clamp
      //   発火 → 画像縮小/見切れ (症状 ①④)。同じ変形を施した temp clone を offscreen に置き、
      //   offsetHeight で測ることで chunk 精度を確保する。
      const measureRoot = el.cloneNode(true);
      measureRoot.style.position = "absolute";
      measureRoot.style.left = "-99999px";
      measureRoot.style.top = "0";
      measureRoot.style.visibility = "hidden";
      measureRoot.style.pointerEvents = "none";
      document.body.appendChild(measureRoot);
      applyPdfLayout(measureRoot, document);
      const synthMeasureNode = injectSynthGrand(measureRoot, document);

      const headerH = measureRoot.querySelector('[data-pdf="header"]')?.offsetHeight || 0;
      const theadH  = measureRoot.querySelector("thead")?.offsetHeight || 0;
      const rowHs = Array.from(measureRoot.querySelectorAll("tbody tr")).map((r) => r.offsetHeight || 1);
      const synthGrandH = synthMeasureNode?.offsetHeight || 0;
      const sumTitleH   = measureRoot.querySelector('[data-pdf-unit="sum-title"]')?.offsetHeight || 0;
      const sumOverallH = measureRoot.querySelector('[data-pdf-unit="sum-overall"]')?.offsetHeight || 0;
      const sumBarHs    = Array.from(measureRoot.querySelectorAll('[data-pdf-unit="sum-bar"]')).map((n) => n.offsetHeight || 1);
      const sumNoteH    = measureRoot.querySelector('[data-pdf-unit="sum-note"]')?.offsetHeight || 0;
      const legendH     = measureRoot.querySelector('[data-pdf="legend"]')?.offsetHeight || 0;
      document.body.removeChild(measureRoot);

      // ---- テーブルページ: 行を「行境界で」チャンク化 (各ページ thead 分、先頭は header も確保) ----
      const tablePages = [];
      {
        let i = 0; let first = true;
        while (i < rowHs.length) {
          const budget = pageContentPx - theadH - (first ? headerH : 0);
          let used = 0; const start = i;
          while (i < rowHs.length && (used === 0 || used + rowHs[i] <= budget)) { used += rowHs[i]; i += 1; }
          tablePages.push({ start, end: i, showHeader: first });
          first = false;
        }
        if (tablePages.length === 0) tablePages.push({ start: 0, end: 0, showHeader: true });
      }

      // ---- 末尾セクション (合成 年間合計 + 消化サマリー + 凡例) を unit 単位でページ詰め ----
      // 修正②: grandtotal は DOM 依存 ([data-pdf="grandtotal"] node 検索) を廃止し、
      //   measureRoot で測った合成 div の高さを使う。
      const tailUnits = [];
      if (synthGrandH > 0) tailUnits.push({ key: "grandtotal", h: synthGrandH });
      if (sumTitleH > 0)   tailUnits.push({ key: "sum-title",  h: sumTitleH });
      if (sumOverallH > 0) tailUnits.push({ key: "sum-overall", h: sumOverallH });
      sumBarHs.forEach((h, idx) => tailUnits.push({ key: `sum-bar:${idx}`, h }));
      if (sumNoteH > 0)    tailUnits.push({ key: "sum-note",   h: sumNoteH });
      if (legendH > 0)     tailUnits.push({ key: "legend",     h: legendH });
      const tailPages = [];
      {
        let used = 0; let cur = [];
        for (const u of tailUnits) {
          if (cur.length > 0 && used + u.h > pageContentPx) { tailPages.push(cur); cur = []; used = 0; }
          cur.push(u.key); used += u.h;
        }
        if (cur.length > 0) tailPages.push(cur);
      }

      const setDisp = (cd, sel, show) => { const n = cd.querySelector(sel); if (n) n.style.display = show ? "" : "none"; };
      // 共通 onclone: 幅展開・列幅明示・sticky 解除 + 合成 年間合計 div を挿入。
      const capture = (configure) => html2canvas(el, {
        scale, backgroundColor: CARD_BG, useCORS: true,
        width: captureW, windowWidth: captureW + 40,
        ignoreElements: (node) => node.classList?.contains?.("no-print"),
        onclone: (clonedDoc) => {
          const root = clonedDoc.querySelector(".annual-pdf-root");
          applyPdfLayout(root, clonedDoc);
          injectSynthGrand(root, clonedDoc);
          configure(clonedDoc);
        },
      });

      // 各ページ canvas を A4 横に貼付 (左右に marginMm、横中央寄せ、高さは念のため clamp)。
      let pageIndex = 0;
      const addCanvasPage = (canvas) => {
        if (pageIndex > 0) doc.addPage();
        pageIndex += 1;
        let w = contentWmm;
        let h = (canvas.height * w) / canvas.width;
        if (h > contentHmm) { h = contentHmm; w = (canvas.width * h) / canvas.height; }
        doc.addImage(canvas.toDataURL("image/png"), "PNG", (pageW - w) / 2, marginMm, w, h);
      };

      // テーブルページ (thead は各ページ自動的に含まれる = 見出し繰り返し)。
      for (const tp of tablePages) {
        // eslint-disable-next-line no-await-in-loop
        const canvas = await capture((cd) => {
          setDisp(cd, '[data-pdf="header"]', tp.showHeader);
          setDisp(cd, '[data-pdf="grandtotal"]', false);
          setDisp(cd, '[data-pdf="summary"]', false);
          setDisp(cd, '[data-pdf="legend"]', false);
          cd.querySelectorAll(".annual-pdf-root tbody tr").forEach((tr, i) => {
            tr.style.display = (i >= tp.start && i < tp.end) ? "" : "none";
          });
        });
        addCanvasPage(canvas);
      }

      // 末尾ページ (年間合計 / 消化サマリー / 凡例)。
      for (const units of tailPages) {
        const set = new Set(units);
        const hasSummary = set.has("sum-title") || set.has("sum-overall") || set.has("sum-note") || units.some((k) => k.startsWith("sum-bar"));
        // eslint-disable-next-line no-await-in-loop
        const canvas = await capture((cd) => {
          setDisp(cd, '[data-pdf="header"]', false);
          setDisp(cd, ".annual-pdf-scroll", false);
          setDisp(cd, '[data-pdf="grandtotal"]', set.has("grandtotal"));
          setDisp(cd, '[data-pdf="legend"]', set.has("legend"));
          setDisp(cd, '[data-pdf="summary"]', hasSummary);
          if (hasSummary) {
            setDisp(cd, '[data-pdf-unit="sum-title"]', set.has("sum-title"));
            setDisp(cd, '[data-pdf-unit="sum-overall"]', set.has("sum-overall"));
            setDisp(cd, '[data-pdf-unit="sum-note"]', set.has("sum-note"));
            cd.querySelectorAll('[data-pdf-unit="sum-bar"]').forEach((b, i) => {
              b.style.display = set.has(`sum-bar:${i}`) ? "" : "none";
            });
          }
        });
        addCanvasPage(canvas);
      }

      doc.save(`支出管理繰越票_${data?.fiscal_year ?? ""}年度.pdf`);
    } finally {
      pdfBusy.current = false;
    }
  };

  // A4 横 1 枚・左右 2 カラム PDF。
  //   左: 繰越テーブル (cloneNode) + 年間合計サマリー (handlePrint L295-310 と同形を簡略合成)。
  //   右: 消化サマリー [data-pdf="summary"] (cloneNode)。
  // オフスクリーン (position:fixed; left:-99999px) に固定サイズコンテナを構築し、
  //   はみ出る場合は transform:scale で 1 ページに fit。html2canvas → jsPDF.addImage で 1 ページ。
  // 既存 handlePrint は壊さず温存。📄ボタン onClick だけ差し替える。
  const handlePrintOnePage = async () => {
    const el = pdfRef.current;
    if (!el || pdfBusy.current) return;
    pdfBusy.current = true;
    let container = null;
    try {
      const tableEl = el.querySelector("table");
      const summaryEl = el.querySelector('[data-pdf="summary"]');
      if (!tableEl) { console.warn("[handlePrintOnePage] no table"); return; }

      // A4 横 297×210mm。1mm≈3.78px @96dpi → 1123×794px。
      // margin 8mm = 30px → 内寸 1063×734px。
      const A4_W = 1123;
      const A4_H = 794;
      const MARGIN_PX = 30;
      const INNER_W = A4_W - MARGIN_PX * 2;
      const INNER_H = A4_H - MARGIN_PX * 2;
      const NAVY_BG = "#0D1E36";

      container = document.createElement("div");
      container.style.cssText =
        `position:fixed;left:-99999px;top:0;width:${A4_W}px;height:${A4_H}px;` +
        `background:${NAVY_BG};box-sizing:border-box;padding:${MARGIN_PX}px;` +
        `font-family:-apple-system,BlinkMacSystemFont,"Helvetica Neue","Hiragino Sans","Yu Gothic",sans-serif;` +
        `color:#F0EAD6;overflow:hidden;`;

      // 内側コンテナ: scale 用 transform-origin: top left。flex 2 カラム。
      const inner = document.createElement("div");
      inner.style.cssText =
        `width:${INNER_W}px;display:flex;gap:12px;transform-origin:top left;` +
        `align-items:flex-start;`;

      // ---- 左カラム: テーブル + 年間合計 ----
      const leftCol = document.createElement("div");
      leftCol.style.cssText =
        `flex:3;min-width:0;display:flex;flex-direction:column;gap:10px;`;

      const tableWrap = document.createElement("div");
      tableWrap.style.cssText =
        `background:${CARD_BG};border-radius:12px;padding:8px;overflow:hidden;`;
      const tableClone = tableEl.cloneNode(true);
      // table-layout:fixed + colgroup を強制 (handlePrint L259-289 と同方針)。
      tableClone.style.minWidth = "0";
      tableClone.style.width = "100%";
      tableClone.style.tableLayout = "fixed";
      const existingCg = tableClone.querySelector("colgroup");
      if (existingCg) existingCg.remove();
      const cg = document.createElement("colgroup");
      // 15 列: 項目 / 1-12月 / 実測 / 目標。% 配分で固定。
      const addColPct = (w) => {
        const c = document.createElement("col");
        c.style.width = `${w}%`;
        cg.appendChild(c);
      };
      // 桁切れ修正: 実測・目標が 7% (≈55px) では "1,440,000" 9 文字が入らないため
      //   CAT=14 / 各月=5(×12=60) / 実測=13 / 目標=13 (合計100) に再配分。
      //   月列は 5%×~787px ≈ 39px/列 → fontSize 8px + 小 padding で 7 桁 "293,382" が収まる。
      const CAT_PCT = 14;
      const ACT_PCT = 13;
      const TGT_PCT = 13;
      const MONTH_PCT = 5; // (100 - 14 - 13 - 13) / 12 = 60/12 = 5
      addColPct(CAT_PCT);
      for (let i = 0; i < 12; i++) addColPct(MONTH_PCT);
      addColPct(ACT_PCT);
      addColPct(TGT_PCT);
      tableClone.insertBefore(cg, tableClone.firstChild);
      // Phase 1 (DOM 追加前): sticky 解除 + 折返し防止 + padding 詰め + 右寄せフォールバック。
      //   fontSize はここでは設定しない (offsetWidth が 0 なので、第2パスで動的に決める)。
      //   tableClone.style.fontSize はベースの cascade (各セル未設定時の保険) として 8px をセット。
      tableClone.style.fontSize = "8px";
      tableClone.querySelectorAll("th, td").forEach((c) => {
        if (c.style.position === "sticky") {
          c.style.position = "static";
          c.style.left = "auto";
        }
        c.style.whiteSpace = "nowrap";
        c.style.padding = "3px 3px";
        if (!c.style.textAlign) c.style.textAlign = "right";
      });
      tableWrap.appendChild(tableClone);
      leftCol.appendChild(tableWrap);

      // 年間合計サマリー (handlePrint L295-310 の synthGrandHtml を簡略再利用)。
      const grandTotalVal = data?.committed_totals?.grandTotal ?? null;
      const grandWrap = document.createElement("div");
      grandWrap.innerHTML =
        `<div style="background:${CARD_BG};border-radius:12px;padding:12px 16px;` +
        `display:flex;justify-content:space-between;gap:16px;align-items:baseline;">` +
          `<div>` +
            `<div style="font-size:10px;color:rgba(240,234,214,0.55);margin-bottom:4px;">年間合計</div>` +
            `<div style="font-size:18px;font-weight:700;color:#F0EAD6;">¥${Number(grandTotalVal || 0).toLocaleString()}</div>` +
          `</div>` +
          `<div style="text-align:right;">` +
            `<div style="font-size:10px;color:rgba(240,234,214,0.55);margin-bottom:4px;">年間目標</div>` +
            `<div style="font-size:18px;font-weight:700;color:#5BA8FF;">¥${Number(targetGrandTotal || 0).toLocaleString()}</div>` +
          `</div>` +
        `</div>`;
      leftCol.appendChild(grandWrap.firstElementChild);
      inner.appendChild(leftCol);

      // ---- 右カラム: 消化サマリー ----
      if (summaryEl) {
        const rightCol = document.createElement("div");
        rightCol.style.cssText =
          `flex:1;min-width:0;background:${CARD_BG};border-radius:12px;` +
          `padding:8px;overflow:hidden;`;
        const summaryClone = summaryEl.cloneNode(true);
        // margin / 既存 borderTop / padding をリセット (右カラム自身が枠を持つため)。
        summaryClone.style.margin = "0";
        summaryClone.style.padding = "0";
        summaryClone.style.borderTop = "none";
        rightCol.appendChild(summaryClone);
        inner.appendChild(rightCol);
      }

      container.appendChild(inner);
      document.body.appendChild(container);

      // Phase 2: 動的フォントサイズ (offsetWidth ベース)。
      //   レイアウト完了後 (DOM attach 済) に各セルの実幅を測り、収まる最大 fontSize を逆算。
      //   経験則: 数字/カンマ 1 文字幅 ≈ fontSize × 0.58 → avail / (len × 0.58)。
      //   下限 6px / 上限 11px でクランプ (極端な空セル/単文字でも視認可能、長文も最低 6px で残す)。
      //   offsetWidth が 0 (レイアウト未確定) のときは cellIndex + 列% からフォールバック算出。
      const TABLE_W_EST = 772; // INNER_W(1063) × flex 3/4 ≈ 787 − padding 16 ≈ 772 (fallback)
      const FALLBACK_W = [CAT_PCT, ...Array(12).fill(MONTH_PCT), ACT_PCT, TGT_PCT]
        .map((p) => (TABLE_W_EST * p) / 100);
      tableClone.querySelectorAll("th, td").forEach((c) => {
        const txt = (c.textContent || "").trim();
        const len = Math.max(1, txt.length);
        let cellW = c.offsetWidth;
        if (!cellW || cellW <= 0) {
          const idx = c.cellIndex;
          cellW = (idx >= 0 && idx < FALLBACK_W.length) ? FALLBACK_W[idx] : 40;
        }
        const avail = cellW - 6; // padding 3px × 2
        let fs = avail / (len * 0.58);
        fs = Math.max(6, Math.min(11, fs));
        c.style.fontSize = fs.toFixed(1) + "px";
      });

      // 自然高さ計測 → INNER_H を超える場合は uniform scale で 1 ページ fit。
      const naturalH = inner.scrollHeight;
      if (naturalH > INNER_H) {
        const s = INNER_H / naturalH;
        inner.style.transform = `scale(${s})`;
      }

      const canvas = await html2canvas(container, {
        scale: 2,
        backgroundColor: NAVY_BG,
        useCORS: true,
        width: A4_W,
        height: A4_H,
        windowWidth: A4_W,
        windowHeight: A4_H,
      });

      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const imgData = canvas.toDataURL("image/png");
      doc.addImage(imgData, "PNG", 0, 0, pageW, pageH);
      doc.save(`支出管理繰越票_1枚_${data?.fiscal_year ?? ""}年度.pdf`);
    } catch (err) {
      console.error("[handlePrintOnePage]", err);
    } finally {
      if (container && container.parentNode) container.parentNode.removeChild(container);
      pdfBusy.current = false;
    }
  };

  // ロード中・未反映・取得失敗・data 無しは「準備中」カードを表示。
  if (loading) return <StatusCard message="読み込み中..." />;
  const lines = Array.isArray(data?.committed_lines) ? data.committed_lines : [];
  if (error || !data || !data.last_committed_at || lines.length === 0) {
    return <StatusCard message="Supabase連携後に本部から送付されます" showBadge />;
  }

  const startMonth = Number(data.fiscal_year_start_month) || 1;
  const monthOrder = Array.from({ length: 12 }, (_, i) => ((startMonth - 1 + i) % 12) + 1);
  // #1: 固定費の月区分判定 (classifyMonth) に使う年度・管理開始日・今日。
  //   fyYear = 年度の暦年、msd = 管理スタート日 (localStorage)、todayStr = 'YYYY-MM-DD'。
  const fyYear = Number(data.fiscal_year) || new Date().getFullYear();
  const msd = getManagementStartDay();
  const todayStr = toDateStr(new Date());
  // タスクE (2026-06-08): 現在進行中の管理サイクル月 (calendar 1-12)。
  //   thead の月列ヘッダで黄色ハイライトに使う (IIFE 内 L1108 の同名と等価、ここに hoist)。
  //   msd null フォールバック: findCycleOfDate(date, null) は 1 日起点で today の calendar 月を返す。
  const currentCycleMonth = findCycleOfDate(new Date(), msd).month + 1;
  const sortedLines = [...lines].sort(
    (a, b) => (Number(a?.display_order) || 0) - (Number(b?.display_order) || 0),
  );
  // Phase 3 (固定費): 固定費行をライブ生成し、committed 由来の行の前 (最上部) に prepend。
  // 描画専用 (sortedLines は targetGrandTotal / 消化サマリーで従来どおり使用)。
  const fixedCostLines = buildFixedCostLines(loans);
  const displayLines = [...fixedCostLines, ...sortedLines];
  // #2: カテゴリ×将来月の week_cat_budgets 由来 monthly_budget (Σ週)。{ categoryId → { m: Σ週 } }。
  //   committed の将来月セルより優先して表示する (本部の resolveCell と挙動を揃える)。
  const weekBudgetByCat = {};
  for (const line of sortedLines) {
    if (line?.row_type === "category" && line?.category_id) {
      weekBudgetByCat[line.category_id] = deriveFutureWeekBudgetForCategory(
        weekCatBudgets, line.category_id, { fiscalYear: fyYear, startMonth, msd, todayStr },
      );
    }
  }
  // committed セル解決 (resolveCell) の上に、カテゴリの「当月＋将来月」は週予算 Σ を被せる
  // 表示用リゾルバ。返り値 { value, kind }。kind で色分け (budget=青 / actual=白)。
  //   - 過去月: committed の実測表示 (actual)。
  //   - 将来月: 週予算ライブ (budget)。無ければ committed (budget)。
  //   - 当月: committed の実測 (monthly_spent あり) があれば実測表示、無ければ週予算 (budget)。
  //     ※ 本部はライブ expenses で判定するが、顧客 viewer は committed の monthly_spent を
  //       実測有無の根拠にする (反映後に整合。反映前の当月実測は次回反映で反映)。
  const resolveCellDisplay = (line, m) => {
    if (line?.row_type === "category" && line?.category_id) {
      const wb = weekBudgetByCat[line.category_id];
      const liveBudget = wb && wb[m] != null ? wb[m] : null;
      const committedVal = resolveCell(line, m);
      const cls = classifyMonth(fyYear, m, msd, todayStr, startMonth);
      if (cls === "current") {
        const spent = pickMonth(line?.monthly_spent, m);
        if (spent != null) return { value: committedVal != null ? committedVal : spent, kind: "actual" };
        if (liveBudget != null) return { value: liveBudget, kind: "budget" };
        return { value: committedVal, kind: committedVal != null ? "actual" : "none" };
      }
      if (cls === "future") {
        if (liveBudget != null) return { value: liveBudget, kind: "budget" };
        return { value: committedVal, kind: committedVal != null ? "budget" : "none" };
      }
      // past
      return { value: committedVal, kind: committedVal != null ? "actual" : "none" };
    }
    const v = resolveCell(line, m);
    return { value: v, kind: v != null ? "actual" : "none" };
  };
  const totalsMonthly = data.committed_totals?.monthly || {};
  const grandTotal = data.committed_totals?.grandTotal ?? null;
  // 月合計行の目標列 = 全 line の target_value 合計 (= 年間目標合計)。
  // Phase 3 (固定費): committed 由来 (sortedLines) に加え、固定費行 (loans 由来) の
  // 目標 (annual_target → target_value) も加算する → displayLines で集計。
  const targetGrandTotal = displayLines.reduce((s, l) => s + (Number(l?.target_value) || 0), 0);

  // Phase 1: 本部が確定した月 (committed_settled_months)。該当月セルを赤塗りする。
  const committedSettledMonths = Array.isArray(data?.committedSettledMonths)
    ? data.committedSettledMonths : [];
  const isMonthSettled = (m) =>
    committedSettledMonths.includes(m) || committedSettledMonths.includes(String(m));
  // C-2: hasSettled は凡例の表示条件を撤去 (常時表示化) したため不要 → 削除。
  // C-2: 未確定月判定 (確定済の補集合)。色分けで「青=未確定 (予算扱い)」を全箇所に適用するため、
  //   committedSettledMonths の対称で 1 行ヘルパ化。テーブル th / 各セル / 合計行 / 累計バー /
  //   凡例 で参照する (確定済の赤と対称化される位置に BUDGET_BLUE 系を入れる)。
  const isUnsettledMonth = (m) => !isMonthSettled(m);

  // 本部準拠: 行ごとの年間「実測」算出 (rowYearSpent 相当)。
  // - カテゴリ/特殊行: 本部が反映時に焼いた monthly_spent (実支出シリーズ) を 12 月合算。
  //   旧 committed (monthly_spent 無し) は 0 にフォールバック (エラーにしない)。
  // - 固定費 (committed に monthly_spent 無し): Σ (monthly_amounts[m] ?? monthly_amount)。
  //   タスク⑮ (2026-06-02): 本部 admin の rowYearSpent + resolveCell 固定費分岐は
  //     classifyMonth/settled を見ず全月 monthly_amounts[m] ?? base を返すため、
  //     顧客側も同様に future skip を撤廃して年間満額 (着地見込み) で揃える。
  //     これにより実測列の固定費合計 grand (computeSubtotalsForType=全12ヶ月Σ) と
  //     個別行が完全一致する (合計 = 個別行の Σ が成立)。
  // 明細テーブルの「実測」列と消化サマリーの実測の両方から参照する。
  const sumLineSpent = (l) => {
    const s = l?.monthly_spent;
    if (!s || typeof s !== "object") return 0;
    let sum = 0;
    for (const k of Object.keys(s)) sum += Number(s[k]) || 0;
    return sum;
  };
  const lineYearSpent = (l) => {
    if (l?.row_type === "fixed_cost") {
      const ma = l.monthly_amounts;
      const base = Number(l.monthly_amount) || 0;
      let s = 0;
      for (let m = 1; m <= 12; m++) {
        const v = ma ? (ma[m] ?? ma[String(m)]) : null;
        s += (v != null ? Number(v) : base) || 0;
      }
      return s;
    }
    return sumLineSpent(l);
  };

  // タスク⑭ (2026-06-02): 確定済み月の実績のみを合算 (本部 rowSettledActual 相当)。
  //   旧仕様: 累計バー IIFE 内に同名関数があり消化サマリー IIFE から参照不可だったため、
  //     行レベル (sumLineSpent / lineYearSpent と同スコープ) に hoist して両方から参照可能に。
  //   - 固定費 → settled月の monthly_amounts[m] ?? base のみ合算 (admin と同じく future skip)
  //   - その他行 → settled月の monthly_spent[m] のみ合算 (admin 焼きの実支出シリーズ)
  //   外スコープ参照: isMonthSettled (L524), classifyMonth, fyYear, msd, todayStr, startMonth。
  const settledLineSpent = (l) => {
    if (l?.row_type === "fixed_cost") {
      const ma = l.monthly_amounts;
      const base = Number(l.monthly_amount) || 0;
      let s = 0;
      for (let m = 1; m <= 12; m++) {
        if (!isMonthSettled(m)) continue;
        if (classifyMonth(fyYear, m, msd, todayStr, startMonth) === "future") continue;
        const v = ma ? (ma[m] ?? ma[String(m)]) : null;
        s += (v != null ? Number(v) : base) || 0;
      }
      return s;
    }
    const ms = l?.monthly_spent;
    if (!ms || typeof ms !== "object") return 0;
    let sum = 0;
    for (const k of Object.keys(ms)) {
      if (!isMonthSettled(Number(k))) continue;
      sum += Number(ms[k]) || 0;
    }
    return sum;
  };

  // #2 固定費合計 / 変動費合計 subtotal の事前計算 (b4bcfa2 revert からの再導入、findLastIndex 排除版)。
  //   - 元実装 (916c1ce) は displayLines.findLastIndex(...) を使っていたが iOS Safari 15.4 未満で
  //     TypeError を投げるため、forward 1 パス for ループに置換 (pure ES2017)。
  //   - displayLines = [...fixedCostLines, ...sortedLines] の順 (L474) で並ぶが、
  //     row_type で判定して **最後に出現した index を上書き** すれば findLastIndex と等価。
  //   - 副作用なし、render 中の純粋計算。
  let lastFixedIdx = -1;
  let lastVariableIdx = -1;
  for (let i = 0; i < displayLines.length; i++) {
    const l = displayLines[i];
    if (!l) continue;
    if (l.row_type === "fixed_cost") {
      lastFixedIdx = i;
    } else {
      lastVariableIdx = i;
    }
  }
  // subtotal 値: resolveCell ベースで partition 集計 → 月別 / grand 実測 / grand 目標。
  // サニティ: fixed + variable = 「支出合計」行 (snapshot 由来、loans 不変時に一致)。
  const computeSubtotalsForType = (predicate) => {
    const monthly = {};
    let grand = null;
    for (let m = 1; m <= 12; m++) {
      let s = 0;
      let any = false;
      for (const line of displayLines) {
        if (!line || !predicate(line)) continue;
        const v = resolveCell(line, m);
        if (v == null) continue;
        s += Number(v) || 0;
        any = true;
      }
      monthly[m] = any ? s : null;
      if (any) grand = (grand ?? 0) + s;
    }
    let target = 0;
    for (const line of displayLines) {
      if (!line || !predicate(line)) continue;
      target += Number(line?.target_value) || 0;
    }
    return { monthly, grand, target };
  };
  const fixedSubtotals    = computeSubtotalsForType((l) => l.row_type === "fixed_cost");
  const variableSubtotals = computeSubtotalsForType((l) => l.row_type !== "fixed_cost");

  // P4-C: 累計支出を local 再計算 (snapshot 直読みを撤去)。
  //   - 月別「支出合計」(= fixedSubtotals.monthly + variableSubtotals.monthly) を
  //     monthOrder (msd-fiscal 順) で累積し、累計支出[m] を導出。
  //   - started フラグ: 支出が出始めた月以降は 0 でも数値表示、未着月は null (「—」表示)。
  //   - これで「支出合計」「固定費合計」「変動費合計」「累計支出」の 4 表が
  //     loans / monthly_overrides 編集後も常に整合 (snapshot 凍結の影響を断つ)。
  const localCumByMonth = (() => {
    const out = {};
    let running = 0;
    let started = false;
    for (let i = 0; i < monthOrder.length; i++) {
      const m = monthOrder[i];
      const f = fixedSubtotals?.monthly?.[m];
      const v = variableSubtotals?.monthly?.[m];
      const hasAny = (f != null) || (v != null);
      if (hasAny) {
        started = true;
        running += (f ?? 0) + (v ?? 0);
      }
      out[m] = started ? running : null;
    }
    return out;
  })();

  // P4-横画面全列フィット: landscape 時は padding/fontSize/minWidth を圧縮して
  //   15 列 (カテゴリ + 12月 + 実測 + 目標) を画面幅内に横スクロール無しで収める。
  //   - cellPadX: 8 → 2 (landscape、合計行の大桁数字が隣セルに被るのを防ぐ最終調整)
  //   - fontSize: 11 → 8 (landscape、可読下限。10px だと月合計 8 文字が 6%列を溢れて被る)
  //   - tableStyle.minWidth: 800 → 0 (landscape) ← iPhone 横画面で溢れる主因
  //   portrait は従来通り (padding 8 / fontSize 11 / minWidth 800)。
  const cellPadX = isLandscape ? 2 : 8;
  // 旧 cellFontSize 二値固定 (isLandscape ? 8 : 11) は項目名/ヘッダ/空白セル用に baseCellFontSize へ改名。
  // 数字 td は下で定義する関数 cellFontSize(text, avail) を使って桁数から確定計算で縮小する。
  const baseCellFontSize = isLandscape ? 8 : 11;
  // #6 (2026-06-03): メインテーブルの全列境界に縦区切り線 (1px solid ${GOLD}40)。
  //   各行先頭=カテゴリ列セルは labelWrapStyle / stickyBase + 個別 borderLeft:none で覆い、
  //   月セル・実測セル・目標セルの 14 個に borderLeft が出る。
  //   既存 borderBottom (1px solid ${BORDER}) は維持し、行下罫線と組み合わせて格子化。
  //   先頭セルだけ borderLeft 無効化は JSX 側で個別に `borderLeft: 'none'` を override する方針。
  const cellStyle = {
    padding: `6px ${cellPadX}px`, textAlign: "right", fontSize: baseCellFontSize,
    color: TEXT_PRIMARY,
    borderBottom: `1px solid ${BORDER}`,
    borderLeft: `1px solid ${GOLD}40`,
    whiteSpace: "nowrap",
  };
  const headCellStyle = {
    padding: `6px ${cellPadX}px`, textAlign: "right", fontSize: baseCellFontSize, fontWeight: 700,
    color: GOLD,
    borderBottom: `1px solid ${BORDER}`,
    borderLeft: `1px solid ${GOLD}40`,
    whiteSpace: "nowrap",
    background: NAVY3,
  };
  // 桁数から確定式でフォントサイズを返す (下限 5px / 上限 11px)。avail = 列幅 - 横padding。
  //   landscape: 月列 avail=40 (5.5%×798 ≈44 − pad 4)、grand 列 avail=84 (11%×798 ≈88 − pad 4)。
  //   portrait は tableLayout:auto のため avail を渡さずデフォルト 60 で控えめに動作。
  //   下限 5px: 月 40px 列で 9〜11 文字 (1,254,382〜123,456,789) を先頭桁切れなく収めるため。
  const cellFontSize = (text, avail = 60) => {
    const len = String(text ?? '').length;
    if (len <= 1) return 11;
    return Math.max(5, Math.min(11, Math.floor(avail / (len * 0.85))));
  };
  // 数字 td 用の avail (landscape 列幅から横padding 4px 控除)。portrait は 60 / 100 で控えめ動作。
  const monthAvail = isLandscape ? 40 : 60;
  const grandAvail = isLandscape ? 84 : 100;
  // 行頭 (カテゴリ名) 列は縦・横ともスクロール時に固定 (sticky)。
  const stickyBase = { position: "sticky", left: 0, zIndex: 1, textAlign: "left" };
  // 縦・横とも auto layout + 親 div overflowX:auto による横スクロールに統一。
  // 目標列(+1)を見込み minWidth を 640→720 に拡張 (各列が読める幅を保つ)。
  // 横画面で tableLayout:fixed をやめたため iOS Safari の sticky×fixed ゴーストバグは発生しない。
  // 本部準拠: 15列化 (項目+12月+実測+目標) で minWidth 720→800 に拡張。
  // P4-横画面: landscape では minWidth=0 + tableLayout:fixed + colgroup で
  //   全 15 列を画面幅に強制配分する (auto-layout だと中身幅で伸びてスクロール残存)。
  //   portrait は従来通り (tableLayout:auto / minWidth:800)。
  const tableStyle = {
    borderCollapse: "collapse", width: "100%",
    minWidth: isLandscape ? 0 : 800,
    tableLayout: isLandscape ? "fixed" : "auto",
  };
  // P4-横画面 colgroup: 3 領域分配。
  //   カテゴリ 12% + 12月 各 5.5% + 実測 11% + 目標 11% = 100%。
  //   iPhone 横 ~798px 利用幅で カテゴリ ~96px / 月列 ~44px / 実測・目標 ~88px。
  //   合計行 (年間実測・目標 grand) で 9-10 文字 (1,254,382〜99,999,999) が出るため
  //   実測・目標列を月列の 2 倍幅にして大桁数字の被りを根絶。
  //   landscape 時のみ挿入。portrait は colgroup 無しで従来挙動を維持。
  const lsColCategory = 12;
  const lsColMonth = 5.5;
  const lsColEdge = 11;
  // landscape 時、カテゴリ列ラベルが ~128px に収まらないとき折り返し可とする
  //   (sticky 列のクリップ防止、portrait は nowrap 据え置き)。
  const labelWrapStyle = isLandscape
    ? { whiteSpace: "normal", wordBreak: "break-all", lineHeight: 1.2 }
    : null;

  // #2 subtotal 行 (固定/変動 で形は同一、ラベルと値だけ切替)。
  //   - 月別セル: 確定系=TEXT_PRIMARY (#4 色テーマ準拠)
  //   - 実測 grand: TEXT_PRIMARY、目標 grand: BUDGET_BLUE
  //   - 強調: NAVY2 背景 + 上下 2px GOLD55 border、fontWeight 600
  // collapsed / onToggle はアコーディオン用 (省略時はトグル非表示で従来挙動)。
  //   三角 (▼=展開 / ▶=折りたたみ) は no-print + GOLD 色 + cursor:pointer。
  //   subtotal 行の見た目 (NAVY2 / GOLD55 border / 数値色) は現状維持。
  const renderSubtotalRow = (label, sub, collapsed, onToggle) => (
    <tr>
      <td
        style={{
          ...cellStyle, ...stickyBase, background: NAVY2,
          fontWeight: 600, color: TEXT_PRIMARY,
          borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
          // #6: 先頭=カテゴリ列セルは borderLeft 無効化 (cellStyle の borderLeft を override)。
          borderLeft: 'none',
          cursor: onToggle ? 'pointer' : undefined,
        }}
        onClick={onToggle || undefined}
      >
        {onToggle && (
          <span
            className="no-print"
            style={{ color: GOLD, marginRight: 6, fontSize: 10, userSelect: 'none' }}
            aria-label={collapsed ? '展開' : '折りたたみ'}
          >{collapsed ? '▶' : '▼'}</span>
        )}
        {label}
      </td>
      {monthOrder.map((m) => {
        const v = pickMonth(sub.monthly, m);
        const txt = fmtCell(v);
        // タスク⑯ (2026-06-02): 本部 admin (AnnualBudgetTab L1200-1203) と一致。
        //   確定月=白 (TEXT_PRIMARY)、未確定月で値あり=青 (BUDGET_BLUE)、null=灰 (TEXT_MUTED)。
        const isActualCell = isMonthSettled(m);
        const cellColor = isActualCell ? TEXT_PRIMARY
          : v == null ? TEXT_MUTED
          : BUDGET_BLUE;
        return (
          <td key={m} style={{
            ...cellStyle, background: NAVY2,
            fontWeight: 600, color: cellColor,
            borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            fontSize: cellFontSize(txt, monthAvail), overflow: 'hidden',
          }}>
            {txt}
          </td>
        );
      })}
      {/* 実測 grand (subtotal 内 partition の Σ resolveCell)。
          タスク⑯ (2026-06-02): 着地見込み (確定実績+未確定予算) のため青字 (BUDGET_BLUE) に統一 (admin L1221 一致)。
          2026-06-04 ⑤: subtotal (固定費合計/変動費合計) の実測が目標合計 (sub.target) を
            超えたら RED に切替。sub.target=0/null は予算未設定として青のまま。admin 同形。 */}
      {(() => {
        const txt = fmtCell(sub.grand);
        const subTarget = sub.target || 0;
        const isOverBudget = subTarget > 0 && sub.grand != null && sub.grand > subTarget;
        return (
          <td style={{
            ...cellStyle, background: NAVY2,
            fontWeight: 600,
            color: sub.grand == null ? TEXT_MUTED : (isOverBudget ? RED : BUDGET_BLUE),
            borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden',
          }}>
            {txt}
          </td>
        );
      })()}
      {/* 目標 grand (subtotal 内 Σ target_value) — 予算系=青 */}
      {(() => {
        const txt = fmtCell((sub.target || 0) > 0 ? sub.target : null);
        return (
          <td style={{
            ...cellStyle, background: NAVY2,
            fontWeight: 600, color: (sub.target || 0) > 0 ? BUDGET_BLUE : TEXT_MUTED,
            borderTop: `2px solid ${GOLD}55`, borderBottom: `2px solid ${GOLD}55`,
            fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden',
          }}>
            {txt}
          </td>
        );
      })()}
    </tr>
  );

  const card = (
    <div ref={pdfRef} className="annual-pdf-root" style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
      <div data-pdf="header" style={{
        padding: "12px 16px", borderBottom: `1px solid ${BORDER}`,
        display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12,
      }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: TEXT_PRIMARY }}>
            支出管理繰越票 <span style={{ color: TEXT_MUTED, fontSize: 11 }}>{data.fiscal_year}年度</span>
          </div>
          <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 3 }}>
            本部反映: {fmtDateTime(data.last_committed_at)}
          </div>
        </div>
        <button
          className="no-print"
          onClick={handlePrintOnePage}
          style={{
            background: GOLD, color: NAVY, border: "none", borderRadius: 8,
            padding: "6px 12px", fontSize: 12, fontWeight: 700,
            cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
          }}
        >
          📄 PDF
        </button>
      </div>
      {/* ③: 年度ダイヤル (確定済み年度が 2 件以上のときのみ表示。PDF には出さない) */}
      {/* A/B: 年度ピッカー + 修正2(b): 月ピッカー (どちらもタップ式 PopoverDial)。 */}
      <div className="no-print" style={{ padding: "10px 16px 0", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {fiscalYears.length >= 1 && (
          <>
            <span style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 700 }}>表示年度</span>
            <PopoverDial
              items={fiscalYears.map((y) => ({ key: y, label: `${y}年度` }))}
              value={selectedYear ?? Number(data.fiscal_year)}
              onChange={(y) => setSelectedYear(Number(y))}
              placeholder="年度を選択"
              width={140}
            />
          </>
        )}
        <span style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 700 }}>月</span>
        <PopoverDial
          items={monthOrder.map((m) => ({ key: m, label: `${m}月` }))}
          value={monthOrder.includes(selectedMonth) ? selectedMonth : monthOrder[0]}
          onChange={(m) => setSelectedMonth(Number(m))}
          placeholder="月を選択"
          width={110}
        />
      </div>
      {/* #5 年間累計プログレスバー (msd 基準会計年度の月軸付き、テーブル直前に挿入)。
          - 累計確定 = data.committed_totals.grandTotal (snapshot)
          - 年間予算 = yearBudgetTotal:
              カテゴリ行 → annualWeekBudgetForCategory(weekCatBudgets, ...) (= 全12月×全週Σ)
              固定費/特殊行 → target_value (= 年間目標 annualTarget)
              ※ 消化サマリー L842 totalBudget と完全同一ロジック (スコープ独立)
              ※ targetGrandTotal は他箇所で使用継続のため触らない
          - 月軸    = monthOrder (msd/fiscal_year_start_month で並べ替えた 1-12)
          - 現在サイクル = findCycleOfDate(new Date(), msd).month + 1 (calendar 月、1-12)
          - over/under pace 色分け:
              expectedPct = (currentCycleMonth / 12) × 100  (今月末時点の期待消化率)
              バー fill % > expectedPct → RED グラデ (オーバーペース)
              累計 > yearBudgetTotal の overflow → fill 100% で RED 維持
              その他 → GOLD グラデ
          - 0 除算回避: 年間予算 0 → pct=0、バー塗りは描画しない (背景のみ)
      */}
      {(() => {
        // バー専用の「累計（確定分）」: lineYearSpent は将来月除外済
        // （admin が monthly_spent を焼く際に classifyMonth='future' を除外して合算）。
        // data.committed_totals.grandTotal は予算込みの年間見込み合計として
        // 支出合計 grand cell で引き続き使用するため変更しない。
        const cum = displayLines.reduce((s, l) => s + (lineYearSpent(l) || 0), 0);
        // タスク⑭ (2026-06-02): settledLineSpent は L559 付近に hoist 済 (消化サマリー IIFE と共用)。
        //   旧定義は削除し、上位スコープの関数を参照する。
        const settledCum = displayLines.reduce((s, l) => s + (settledLineSpent(l) || 0), 0);
        // タスク⑭ (2026-06-02): 本部準拠 (admin AnnualBudgetTab summaryBudget) に統一。
        //   - カテゴリも target_value を採用 (旧: annualWeekBudgetForCategory による週Σ)
        //     → 本部 annualTargetTotal (=Σ target_value) と完全一致、9,225 ズレを解消。
        //   - 固定費は target_value (annual_target) 優先、未設定なら monthly_amounts ×12 で満額補填。
        const summaryBudget = (l) => {
          const tv = Number(l?.target_value);
          if (Number.isFinite(tv) && tv > 0) return tv;
          if (l?.row_type === "fixed_cost") {
            const ma = l?.monthly_amounts;
            const base = Number(l?.monthly_amount) || 0;
            let s = 0;
            for (let m = 1; m <= 12; m++) {
              const v = ma ? (ma[m] ?? ma[String(m)]) : null;
              s += (v != null ? Number(v) : base) || 0;
            }
            return s;
          }
          return 0;
        };
        const yearBudgetTotal = displayLines.reduce((s, l) => s + (summaryBudget(l) || 0), 0);
        const _today = new Date();
        const _cyc = findCycleOfDate(_today, msd);
        const currentCycleMonth = _cyc.month + 1;
        // Step1 (週刻み青バー): 現在週情報。cycle.js の API を流用 (週は常時 1..4)。
        //   weekInCycle: 第N週 (1..4) / weeksInCycle: 各週の境界配列 (length は常時 4)。
        const currentCycleWeek = weekInCycle(_today, msd);
        const _weeks = weeksInCycle(_cyc.year, _cyc.month, msd);
        const totalWeeksInMonth = _weeks.length || 4;
        // P4-B (α): 「現在月までの予算累計」を 100% の基準とする (案 I)。
        //   バー全幅 = 12ヶ月維持、fill 終端が現在月マーカー (▼) 位置に到達したら 100%。
        //   月境界 dashed line 11 本は 12 等分のまま (案 II と違い C-1 の意味を保持)。
        //
        // monthlyBudget[m]: 行ごと summaryBudget を月単位に分解した {1..12: Σ全行 for month m}。
        //   - 固定費行: monthly_amounts[m] ?? monthly_amount (基準月額)
        //   - カテゴリ行: weekCatBudgets を月別にパース＆Σ
        //   - その他特殊行: target_value / 12 で按分 (fallback)
        const currentMonthIdx = Math.max(0, monthOrder.indexOf(currentCycleMonth));
        const monthlyBudget = {};
        for (let m = 1; m <= 12; m++) monthlyBudget[m] = 0;
        for (const l of displayLines) {
          if (l?.row_type === "fixed_cost") {
            const ma = l.monthly_amounts;
            const base = Number(l.monthly_amount) || 0;
            for (let m = 1; m <= 12; m++) {
              const v = ma ? (ma[m] ?? ma[String(m)]) : null;
              monthlyBudget[m] += (v != null ? Number(v) : base) || 0;
            }
          } else if (l?.row_type === "category" && l?.category_id) {
            for (const key of Object.keys(weekCatBudgets || {})) {
              const mt = key.match(/^(\d+)-(\d+)-w(\d+)_(.+)$/);
              if (!mt) continue;
              if (String(mt[4]) !== String(l.category_id)) continue;
              const cm = Number(mt[2]);
              if (!(cm >= 1 && cm <= 12)) continue;
              if (Number(mt[1]) !== fiscalMonthCalendarYear(fyYear, startMonth, cm)) continue;
              monthlyBudget[cm] += Number(weekCatBudgets[key]) || 0;
            }
          } else {
            const tv = Number(l?.target_value);
            if (Number.isFinite(tv) && tv > 0) {
              const per = tv / 12;
              for (let m = 1; m <= 12; m++) monthlyBudget[m] += per;
            }
          }
        }
        // タスク⑭ (2026-06-02): 分母を Σ summaryBudget (= 本部 annualTargetTotal、Σ target_value) に統一。
        //   旧: monthlyBudget (固定費 monthly_amounts + カテゴリ週Σ + 特殊行 target/12) で 9,225 ズレ。
        //   新: summaryBudget は target_value 一本化 (固定費フォールバック含む) → 本部と完全一致。
        // タスク⑭: バー fill 計算 (pct/overflow/s1Pct) も白字 cum → settledCum に統一。
        //   累計トップ表示と整合させ、確定月実績のみで進捗を計算する。
        const annualTargetTotal = displayLines.reduce((s, l) => s + (summaryBudget(l) || 0), 0);
        const pct = annualTargetTotal > 0
          ? Math.min((settledCum / annualTargetTotal) * 100, 100)
          : 0;
        const overflow = annualTargetTotal > 0 && settledCum > annualTargetTotal;
        // 案 B (2026-06-04): 上段予算棒を「選択月までの累計予算」で伸縮させる
        //   ため、selectedMonthIdx → cumBudgetToSelected → budgetPct を派生計算する。
        //   selectedMonth は月ダイヤル (L843-847) 連動なので、ダイヤルでバーが動的に変化する。
        //   monthOrder.indexOf(selectedMonth) で年度内インデックスを取り (msd 基準)、
        //   その月までの monthlyBudget (L903-930 で既に算出済) を Σ して累計予算を得る。
        //   分母は annualTargetTotal 据置 (バー全幅 = 年間予算満額に対する 100% スケール、admin と同じ)。
        const selectedMonthIdx = Math.max(0, monthOrder.indexOf(selectedMonth));
        // Step1 (週刻み青バー): 現在月の貢献を「週単位まで」に圧縮する partial 値を別途算出。
        //   - 固定費/特殊行 → その月の月額満額 (按分しない、実測の固定費と整合)
        //   - カテゴリ行 → weekCatBudgets の 第1〜currentCycleWeek 週分のみ加算
        //   monthlyBudget の同じ分岐ロジックを再走査 (依存変数: displayLines, weekCatBudgets,
        //   fyYear, startMonth, currentCycleMonth, currentCycleWeek)。
        let currentMonthPartialBudget = 0;
        for (const l of displayLines) {
          if (l?.row_type === "fixed_cost") {
            const ma = l.monthly_amounts;
            const base = Number(l.monthly_amount) || 0;
            const v = ma ? (ma[currentCycleMonth] ?? ma[String(currentCycleMonth)]) : null;
            currentMonthPartialBudget += (v != null ? Number(v) : base) || 0;
          } else if (l?.row_type === "category" && l?.category_id) {
            for (const key of Object.keys(weekCatBudgets || {})) {
              const mt = key.match(/^(\d+)-(\d+)-w(\d+)_(.+)$/);
              if (!mt) continue;
              if (String(mt[4]) !== String(l.category_id)) continue;
              const cm = Number(mt[2]);
              if (cm !== currentCycleMonth) continue;
              if (Number(mt[1]) !== fiscalMonthCalendarYear(fyYear, startMonth, cm)) continue;
              const wn = Number(mt[3]);
              if (!(wn >= 1 && wn <= currentCycleWeek)) continue;
              currentMonthPartialBudget += Number(weekCatBudgets[key]) || 0;
            }
          } else {
            const tv = Number(l?.target_value);
            if (Number.isFinite(tv) && tv > 0) currentMonthPartialBudget += tv / 12;
          }
        }
        // 走査は月ダイヤルの選択月まで。各月 m を fiscal 位置 i で判定:
        //   i < currentMonthIdx → monthlyBudget[m] 満額
        //   i === currentMonthIdx → currentMonthPartialBudget (週単位 partial)
        //   i > currentMonthIdx → 0 (未来分は青バーに含めない=今期待消化を超えない)
        const cumBudgetToSelected = monthOrder
          .slice(0, selectedMonthIdx + 1)
          .reduce((s, m, i) => {
            if (i < currentMonthIdx) return s + (monthlyBudget[m] || 0);
            if (i === currentMonthIdx) return s + currentMonthPartialBudget;
            return s;
          }, 0);
        // タスク (方式B 2026-06-08): 予算バー右端をカレンダー(月+週)基準にスナップ。
        //   過去月選択 → 月末(= (selectedMonthIdx+1)/12)
        //   現在月以降選択 → 現在月+週進捗((currentMonthIdx + (currentCycleWeek-1)/totalWeeksInMonth)/12)
        //   cumBudgetToSelected / cumBudgetToCurrent は色判定 (isOverPace) 等で参照されるため残置 (未使用化しない)。
        const budgetPct = annualTargetTotal > 0
          ? Math.min(
              (selectedMonthIdx < currentMonthIdx)
                ? ((selectedMonthIdx + 1) / 12) * 100
                : ((currentMonthIdx + (currentCycleWeek - 1) / totalWeeksInMonth) / 12) * 100,
              100
            )
          : 0;
        // Step2 (金バー週刻み): 今月サイクル内の生 expenses から
        //   「今月 cycle 開始日〜今日」の実支出を合算 → settledCum に足して金バー長を進める。
        //   - 現在月が確定済 (isMonthSettled) のときは monthly_spent[currentMonth] が
        //     既に settledCum に含まれているため二重計上回避で加算しない (_addCurMonth=false)。
        //   - liveExpenses は loading 中 [] のことがあるが、`for-of (...||[])` で安全。
        //   - 数字表示 (¥settledCum) は触らない (snapshot 由来の確定月のみで明示)。
        const _cycleStartDate = _cyc.startDate;
        let currentMonthSpentToToday = 0;
        for (const e of (liveExpenses || [])) {
          if (!e?.date) continue;
          const d = new Date(e.date);
          if (Number.isNaN(d.getTime())) continue;
          if (d >= _cycleStartDate && d <= _today) {
            currentMonthSpentToToday += Number(e.amount) || 0;
          }
        }
        const _addCurMonth = !isMonthSettled(currentCycleMonth);
        const settledCumForBar = settledCum + (_addCurMonth ? currentMonthSpentToToday : 0);
        // 金バー幅は settledCumForBar 基準。色判定は settledCumForBar vs cumBudgetToSelected で
        //   青(週単位 partial)と追っかけっこできる。overflow は annualTargetTotal を超えたら依然 RED。
        const isOverPace = settledCumForBar > cumBudgetToSelected;
        const overflowForBar = annualTargetTotal > 0 && settledCumForBar > annualTargetTotal;
        const isRed = overflowForBar || isOverPace;
        const barGrad = isRed
          ? 'linear-gradient(90deg, #FF5252 0%, #C62828 100%)'
          : 'linear-gradient(90deg, #D4A843 0%, #B88E33 100%)';
        // #2 (2026-06-03): 単一 fill % (= settledCumForBar / annualTargetTotal)。
        //   旧 s2Pct (未確定セグメント) は廃止 — 薄ブルー全幅土台 (L2) で年間予算満額を可視化する方針に変更。
        //   背景の残り (100-pct)% は薄ブルー土台が露出し、未消化分として可視化される。
        const s1Pct = annualTargetTotal > 0
          ? Math.min((settledCumForBar / annualTargetTotal) * 100, 100)
          : 0;
        return (
          <div style={{
            padding: '16px 12px',
            margin: '12px 16px 20px',
            background: NAVY2,
            borderRadius: 8,
            border: `1px solid ${GOLD}45`,
          }}>
            {/* タイトル */}
            <div style={{ fontSize: 14, fontWeight: 600, color: GOLD, marginBottom: 8 }}>
              年間累計
            </div>
            {/* タスク⑭ (2026-06-02): 累計表示を本部と完全一致させる。
                白字 = settledCum (確定月実績のみ、admin rowSettledActual 相当)。
                青字 = annualTargetTotal (Σ summaryBudget = Σ target_value)。 */}
            <div style={{ marginBottom: 10, lineHeight: 1.2, fontWeight: 700 }}>
              <span style={{ color: TEXT_PRIMARY, fontSize: 20 }}>¥{settledCum.toLocaleString()}</span>
              <span style={{ color: TEXT_MUTED, margin: '0 8px', fontWeight: 400, fontSize: 14 }}>/</span>
              <span style={{ color: BUDGET_BLUE, fontSize: 14 }}>¥{Math.round(annualTargetTotal).toLocaleString()}</span>
            </div>
            {/* #2 (2026-06-03 後修正): 1 本構成 → 2 本構成へ。
                理由: 「予算満額の可視化」と「確定実績の進捗」を 1 本に重ねると、
                    予算が常時全幅で見えづらく、進捗 fill との重なりで色解釈が曖昧だった。
                構造: position:relative の wrapper (高さ 6+3+6=15px) 内に縦並びで:
                  - 上段「予算棒」: NAVY3 背景 / BUDGET_BLUE 全幅 100% fill (annualTargetTotal=年間予算満額)
                  - gap 3px (空白)
                  - 下段「実測棒」: NAVY3 背景 / GOLD or RED fill 幅 s1Pct% (settledCum/annualTargetTotal)
                月境界 dashed 線 11 本は wrapper 全体に position:absolute で被せ、2 本バーを縦断する。
                各棒 height 6px / borderRadius 3px (=高さ/2) で角丸感は維持。 */}
            {/* タスクF (2026-06-08): バー左に行ラベル列 (予算/現進捗) を追加。
                外側 flex (alignItems:center, gap:6) で「ラベル列(40px)」と「バーラッパ(flex:1)」を横並びに。
                既存バーラッパの marginBottom:4 は外側 flex に移管。バー本体・進捗計算・▼マーカー・月境界・月軸は無改修。
                色はハードコードせず予算=BUDGET_BLUE、現進捗=isRed?RED:GOLD でバーと同期。 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              {/* タスクF 微調整 (2026-06-08): ラベル列を棒ラッパと同じ縦構造に作り直す。
                  棒の実値 (青棒 height:6 + marginBottom:3 + 赤棒 height:6 = 総高 15) を
                  ハードコード値ではなく行構造でミラー: 行(6) / gap(3) / 行(6)。
                  各行内は display:flex, alignItems:center で text 中心を行中心に固定 →
                  ラベル中心が棒中心 (y=3 / y=12) に一致する。 */}
              <div style={{
                width: 40,
                fontSize: 10,
                lineHeight: 1,
                whiteSpace: 'nowrap',
              }}>
                <div style={{ height: 6, display: 'flex', alignItems: 'center', color: BUDGET_BLUE }}>予算</div>
                <div style={{ height: 3 }} />
                <div style={{ height: 6, display: 'flex', alignItems: 'center', color: isRed ? RED : GOLD }}>現進捗</div>
              </div>
            <div style={{
              position: 'relative',
              flex: 1,
            }}>
              {/* 上段: 予算棒 (BUDGET_BLUE)。案 B (2026-06-04): 幅 = 選択月までの累計予算 ÷ 年間予算満額。
                  selectedMonth (月ダイヤル連動) で動的に伸縮、月を変えると ▼ マーカー位置に合わせて
                  予算棒の右端も移動する。annualTargetTotal>0 のときだけ青 fill を出す。 */}
              <div style={{
                width: '100%', height: 6, borderRadius: 3,
                background: NAVY3, overflow: 'hidden', marginBottom: 3,
              }}>
                {annualTargetTotal > 0 && (
                  <div style={{
                    width: `${budgetPct}%`, height: '100%',
                    background: BUDGET_BLUE,
                    transition: 'width 0.3s',
                  }} />
                )}
              </div>
              {/* 下段: 実測棒 (GOLD or RED fill 幅 s1Pct%)。
                  未到達部分は NAVY3 の container 背景が露出する。 */}
              <div style={{
                width: '100%', height: 6, borderRadius: 3,
                background: NAVY3, overflow: 'hidden',
              }}>
                {annualTargetTotal > 0 && s1Pct > 0 && (
                  <div style={{
                    width: `${s1Pct}%`, height: '100%',
                    background: barGrad,
                    transition: 'width 0.3s, background 0.3s',
                  }} />
                )}
              </div>
              {/* 月境界 dashed 線 11 本: wrapper 全体に被せ、2 本バーを縦断する (top:0 bottom:0)。 */}
              {Array.from({ length: 11 }, (_, i) => (
                <div key={i} style={{
                  position: 'absolute', top: 0, bottom: 0,
                  left: `${((i + 1) / 12) * 100}%`, width: 0,
                  borderLeft: `1px dashed ${GOLD}66`,
                  pointerEvents: 'none',
                }} />
              ))}
              {/* Step1 (週境界): 現在月の区間内に dotted で週境界を控えめに引く。
                  totalWeeksInMonth は常時 4 だが weeksInCycle.length に追従させる。
                  月境界より控えめな 1px dotted ${GOLD}40 (月の半透明よりさらに薄め)。 */}
              {Array.from({ length: Math.max(0, totalWeeksInMonth - 1) }, (_, i) => {
                const w = i + 1;
                const left = ((currentMonthIdx + w / totalWeeksInMonth) / 12) * 100;
                return (
                  <div key={`w${w}`} style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: `${left}%`, width: 0,
                    borderLeft: `1px dotted ${GOLD}40`,
                    pointerEvents: 'none',
                  }} />
                );
              })}
            </div>
            </div>
            {/* 月軸: monthOrder の順、刻み線 GOLD 25% 透過 (=`${GOLD}40`)、
                現在サイクルのみ GOLD 強調 + 上に ▼ マーカー */}
            {/* タスクF (2026-06-08): 月軸の左端をバーの左端 (ラベル列40px + gap6px) に揃える。
                外側 flex (gap:6) の子1 = 空スペーサ(width:40)、子2 = 既存月軸div (flex:1 付与)。
                月軸の内容(monthOrder/刻み線/▼マーカー)は無改修。 */}
            <div style={{ display: 'flex', gap: 6 }}>
              <div style={{ width: 40 }} />
            <div style={{ display: 'flex', paddingTop: 12, position: 'relative', flex: 1 }}>
              {monthOrder.map((m, i) => {
                const isCurrent = m === currentCycleMonth;
                return (
                  <div key={m} style={{
                    position: 'relative', flex: 1, textAlign: 'center',
                    fontSize: 10,
                    color: isCurrent ? GOLD : TEXT_SECONDARY,
                    fontWeight: isCurrent ? 700 : 400,
                    borderLeft: i === 0 ? 'none' : `1px solid ${GOLD}40`,
                  }}>
                    {isCurrent && (
                      <div style={{
                        position: 'absolute', top: -10, left: '50%',
                        transform: 'translateX(-50%)',
                        fontSize: 9, color: GOLD, lineHeight: 1,
                      }}>▼</div>
                    )}
                    {m}月
                  </div>
                );
              })}
            </div>
            </div>
          </div>
        );
      })()}
      <div className="annual-pdf-scroll" style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          {isLandscape && (
            <colgroup>
              <col style={{ width: `${lsColCategory}%` }} />
              {Array.from({ length: 12 }, (_, i) => (
                <col key={`m${i}`} style={{ width: `${lsColMonth}%` }} />
              ))}
              <col style={{ width: `${lsColEdge}%` }} />
              <col style={{ width: `${lsColEdge}%` }} />
            </colgroup>
          )}
          <thead>
            <tr>
              {/* #6: 先頭=カテゴリ列ヘッダは borderLeft 無効化 (headCellStyle の borderLeft を override)。 */}
              <th style={{ ...headCellStyle, ...stickyBase, background: NAVY3, ...labelWrapStyle, borderLeft: 'none' }}>カテゴリ</th>
              {monthOrder.map((m) => {
                const sel = m === selectedMonth;
                // タスクE (2026-06-08): 現在進行中の管理サイクル月を明るい黄色でハイライト。
                //   優先順: isCurrent > sel(selectedMonth GOLD22) > NAVY3 (デフォルト)。
                //   #FFD60055 = 明るい黄色 (selectedMonth GOLD22 と区別、文字色 RED/BLUE は不変)。
                const isCurrent = m === currentCycleMonth;
                // P4-赤青枠撤去: 月見出しの border (赤/青) を撤去。文字色は確定=RED/未確定=BLUE で
                //   識別性を残しつつ、外枠は headCellStyle の borderBottom (BORDER グレー) に統一。
                //   選択ハイライト (GOLD背景) は確定/未確定どちらでも上から重ねる。
                const bgColor = isCurrent ? '#FFD60055' : (sel ? `${GOLD}22` : NAVY3);
                const thStyle = isMonthSettled(m)
                  ? { ...headCellStyle, color: RED,         background: bgColor }
                  : { ...headCellStyle, color: BUDGET_BLUE, background: bgColor };
                return (
                  <th key={m} ref={(el) => { monthThRefs.current[m] = el; }} style={thStyle}
                    title={isCurrent
                      ? "この月は現在進行中の管理サイクル月"
                      : (isMonthSettled(m) ? "この月は確定済 (凍結実測)" : "この月は未確定 (予算扱い)")}
                  >{m}月</th>
                );
              })}
              {/* #4 色テーマ: 確定系=白 (TEXT_PRIMARY)、予算系=青 (BUDGET_BLUE)。
                  headCellStyle.color のデフォルトは GOLD なので「実測」だけ override で白に上書き。
                  2026-06-04 ④: 「目標」ヘッダも BUDGET_BLUE → TEXT_PRIMARY に変更し、
                    「実測」「目標」両ヘッダを白で揃える (青はセル値の予算系のみ)。admin 6ba3b33 同形。 */}
              <th style={{ ...headCellStyle, color: TEXT_PRIMARY }}>実測</th>
              <th style={{ ...headCellStyle, color: TEXT_PRIMARY }}>目標</th>
            </tr>
          </thead>
          <tbody>
            {displayLines.map((line, i) => {
              // 固定費行は確定塗り (赤) を適用しない (毎月同額の予算=実測。本部 Phase 2a と整合)。
              const isFixed = line?.row_type === "fixed_cost";
              const rowKey = line?.category_id || line?.row_type || i;
              // アコーディオン: collapsed のとき行本体だけ描画スキップ (subtotal は外側で必ず出す)。
              const collapsed = isFixed ? fixedCollapsed : variableCollapsed;
              return (
              <Fragment key={rowKey}>
              {!collapsed && (
              <tr>
                {/* #6: 行先頭=カテゴリ列セルは borderLeft 無効化。 */}
                <td style={{
                  ...cellStyle, ...stickyBase, background: CARD_BG,
                  fontWeight: 600, color: line?.archived ? TEXT_MUTED : TEXT_SECONDARY,
                  ...labelWrapStyle,
                  borderLeft: 'none',
                }}
                  title={line?.category_name || undefined}
                >
                  {line?.category_name || "(無題)"}
                </td>
                {monthOrder.map((m) => {
                  const cell = resolveCellDisplay(line, m);
                  const settledCell = isMonthSettled(m) && !isFixed;
                  const sel = m === selectedMonth;
                  // P4-A 再仕様 (未確定→全青): 数字の色を「確定月=白/未確定月=青」の 2 値に統一。
                  //   - 値なし → TEXT_MUTED
                  //   - 確定月 (isMonthSettled(m)=true) → TEXT_PRIMARY (白): 凍結実測扱い。
                  //   - 未確定月 → BUDGET_BLUE (青): 固定費・カテゴリ・kind 問わず予算扱いで統一。
                  //   旧仕様 (cell.kind === "budget" || isFixed ? BLUE : TEXT_PRIMARY) では
                  //   未確定月のカテゴリ kind='actual' (当月実支出あり) が白に落ちて
                  //   「未確定なのに白」が混在していた。背景・border・ティントは未変更。
                  const numColor = cell.value == null ? TEXT_MUTED
                    : isMonthSettled(m) ? TEXT_PRIMARY
                    : BUDGET_BLUE;
                  // P4-赤青背景撤去: tdStyle から確定セルの赤背景/赤枠、未確定セルの青背景/青枠を撤去。
                  //   残すのは:
                  //     - 数字色 (numColor: 確定=白 / 未確定=青)
                  //     - グレー行区切り (cellStyle.borderBottom = BORDER)
                  //     - 選択月の薄い GOLD ハイライト (background ${GOLD}14)
                  //   確定/未確定の判定 (settledCell / unsettledCell) は title (下) で引き続き使うため保持。
                  const unsettledCell = !settledCell && isUnsettledMonth(m);
                  const cellText = fmtCell(cell.value);
                  const tdStyle = sel
                    ? { ...cellStyle, color: numColor, background: `${GOLD}14`,
                        fontSize: cellFontSize(cellText, monthAvail), overflow: 'hidden' }
                    : { ...cellStyle, color: numColor,
                        fontSize: cellFontSize(cellText, monthAvail), overflow: 'hidden' };
                  return (
                    <td key={m}
                      style={tdStyle}
                      title={settledCell ? "この月は確定済 (凍結実測)"
                        : unsettledCell ? "この月は未確定 (予算扱い)"
                        : cell.kind === "budget" ? "予算 (予算VS実績の週予算合計)"
                        : undefined}
                    >{cellText}</td>
                  );
                })}
                {/* タスク⑰ (2026-06-02): 個別行の実測列 grand を本部 admin (タスク②/⑬で BLUE 統一済) と一致。
                    実測列 grand は「着地見込み (確定実績+未確定予算)」のため青字 (BUDGET_BLUE)。
                    null 時のみ TEXT_MUTED で「無し」表示 (admin renderSubtotalRow L1221 のパターン準拠)。
                    2026-06-04 ⑤: 個別行の実測が目標 (line.target_value) を超えたら RED に切替。
                      予算未設定 (target_value=0/null) は青のまま (「予算がないのに超過」を避ける)。
                      admin 6ba3b33 同形。 */}
                {(() => {
                  const grand = lineYearSpent(line);
                  const txt = fmtCell(grand);
                  const lineTarget = Number(line?.target_value) || 0;
                  const isOverBudget = lineTarget > 0 && grand != null && grand > lineTarget;
                  return (
                    <td style={{ ...cellStyle, fontWeight: 700,
                      color: grand == null ? TEXT_MUTED : (isOverBudget ? RED : BUDGET_BLUE),
                      fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden' }}>
                      {txt}
                    </td>
                  );
                })()}
                {(() => {
                  const txt = fmtCell(line?.target_value);
                  return (
                    <td style={{ ...cellStyle, fontWeight: 700,
                      color: line?.target_value == null ? TEXT_MUTED : BUDGET_BLUE,
                      fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden' }}>
                      {txt}
                    </td>
                  );
                })()}
              </tr>
              )}
              {/* #2 各グループ末尾の直後に subtotal 行を 1 本挿入。
                  既存「支出合計」「累計支出」より前 = 月合計の手前で固定/変動の分解を提示。
                  lastFixedIdx / lastVariableIdx は forward 1 パス計算 (findLastIndex 不使用)。
                  collapsed 中でも subtotal は必ず出す (三角トグルのホスト)。 */}
              {i === lastFixedIdx    && renderSubtotalRow("固定費合計", fixedSubtotals, fixedCollapsed, () => setFixedCollapsed((v) => !v))}
              {i === lastVariableIdx && renderSubtotalRow("変動費合計", variableSubtotals, variableCollapsed, () => setVariableCollapsed((v) => !v))}
              </Fragment>
              );
            })}
            {/* 本部準拠: 合計行① 支出合計 (月別 + 年間実測 grand + 目標 grand)
                #4 色テーマ: 支出合計=確定系=白 (TEXT_PRIMARY)、目標 grand=予算系=青 (BUDGET_BLUE)。
                赤確定月の数値も TEXT_PRIMARY 化 (背景の赤で「確定」を表示、文字色は確定系統一)。 */}
            <tr>
              {/* #6: 行先頭=ラベル列セルは borderLeft 無効化。 */}
              <td style={{
                ...cellStyle, ...stickyBase, background: NAVY2,
                fontWeight: 700, color: TEXT_PRIMARY,
                borderLeft: 'none',
              }}>
                支出合計
              </td>
              {monthOrder.map((m) => {
                const sel = m === selectedMonth;
                // C-3 案A: 月別「支出合計」も local 再計算 (固定費+変動費 subtotal の和) に統一。
                const gMonth = (fixedSubtotals?.monthly?.[m] ?? 0) + (variableSubtotals?.monthly?.[m] ?? 0);
                const txt = fmtCell(gMonth);
                // タスク⑯ (2026-06-02): 本部 admin (L1725-1728) と一致。
                //   gMonth は ?? 0 で必ず数値になるため、null 判定は fixed/variable monthly が両方 null の場合で代替。
                const fM = fixedSubtotals?.monthly?.[m];
                const vM = variableSubtotals?.monthly?.[m];
                const allNull = fM == null && vM == null;
                const isActualCell = isMonthSettled(m);
                const cellColor = isActualCell ? TEXT_PRIMARY
                  : allNull ? TEXT_MUTED
                  : BUDGET_BLUE;
                const tdStyle = {
                  ...cellStyle,
                  background: sel ? `${GOLD}22` : NAVY2,
                  fontWeight: 700, color: cellColor,
                  fontSize: cellFontSize(txt, monthAvail), overflow: 'hidden',
                };
                return (
                  <td key={m} style={tdStyle}>
                    {txt}
                  </td>
                );
              })}
              {/* 年間実測 grand: タスク⑯ (2026-06-02) で本部 admin (L1744) と一致させ青字 (BUDGET_BLUE) に統一。
                  着地見込み (確定実績+未確定予算) を表す。
                  2026-06-04 ⑤: 全体の実測が目標合計 (targetGrandTotal) を超えたら RED に切替。
                    targetGrandTotal=0 は予算未設定として青のまま。admin 同形。 */}
              {(() => {
                const grandActual = (fixedSubtotals?.grand ?? 0) + (variableSubtotals?.grand ?? 0);
                const txt = fmtCell(grandActual);
                const isOverBudget = targetGrandTotal > 0 && grandActual > targetGrandTotal;
                return (
                  <td style={{ ...cellStyle, background: NAVY2, fontWeight: 700,
                    color: isOverBudget ? RED : BUDGET_BLUE,
                    fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden' }}>
                    {txt}
                  </td>
                );
              })()}
              {(() => {
                const txt = fmtCell(targetGrandTotal || null);
                return (
                  <td style={{ ...cellStyle, background: NAVY2, fontWeight: 700,
                    color: (targetGrandTotal || 0) > 0 ? BUDGET_BLUE : TEXT_MUTED,
                    fontSize: cellFontSize(txt, grandAvail), overflow: 'hidden' }}>
                    {txt}
                  </td>
                );
              })()}
            </tr>
            {/* P4-C: 合計行② 累計支出 を local 再計算で再構築 (snapshot 直読みを撤去)。
                旧: data.committed_totals.cumulative (snapshot 焼き) → loans 編集後に支出合計とズレる
                新: fixed/variable subtotals.monthly を monthOrder 順に累積 (localCumByMonth、body 側で計算)
                    → 「累計支出[m] = 累計支出[m-1] + 支出合計[m]」が常に成立
                    → 「累計支出[最終月] = 支出合計.grand = 固定費合計.grand + 変動費合計.grand」も常に成立
                #4 色テーマ: 累計支出=確定系=白 (ラベルも TEXT_PRIMARY 化、TEXT_SECONDARY 廃止)。 */}
            <tr>
              {/* #6: 行先頭=ラベル列セルは borderLeft 無効化。 */}
              <td style={{
                ...cellStyle, ...stickyBase, background: NAVY2,
                fontWeight: 700, color: TEXT_PRIMARY,
                borderLeft: 'none',
              }}>
                累計支出
              </td>
              {monthOrder.map((m) => {
                const v = localCumByMonth[m];
                const txt = fmtCell(v);
                // P4-赤青枠撤去: 累計支出行の月セルから赤背景・青背景・赤枠・青枠を撤去。
                //   他の合計セル (実測/目標 L1149-1150) と同様 NAVY2 ベースに統一。
                //   cellStyle.borderBottom (BORDER グレー) で行下罫線は維持。
                // タスク⑯ (2026-06-02): 本部 admin (L1768-1771) と一致。
                //   確定月=白 (TEXT_PRIMARY)、未確定月で値あり=青 (BUDGET_BLUE)、null=灰 (TEXT_MUTED)。
                const isActualCell = isMonthSettled(m);
                const cellColor = isActualCell ? TEXT_PRIMARY
                  : v == null ? TEXT_MUTED
                  : BUDGET_BLUE;
                const tdStyle = {
                  ...cellStyle, background: NAVY2,
                  fontWeight: 600, color: cellColor,
                  fontSize: cellFontSize(txt, monthAvail), overflow: 'hidden',
                };
                return (
                  <td key={m} style={tdStyle}>
                    {txt}
                  </td>
                );
              })}
              {/* 実測 / 目標 セルは admin 準拠で空白 */}
              <td style={{ ...cellStyle, background: NAVY2, color: TEXT_MUTED }} />
              <td style={{ ...cellStyle, background: NAVY2, color: TEXT_MUTED }} />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Phase 2: カテゴリ別 目標消化率 (進捗バー) */}
      {sortedLines.filter((l) => l.row_type === "category" && !l.archived).length > 0 && (
        <div data-pdf="summary" style={{ margin: "0 16px", paddingTop: 16, paddingBottom: 16, borderTop: `1px solid ${BORDER}` }}>
          <div data-pdf-unit="sum-title" style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10 }}>
            📊 年間予算 消化サマリー
          </div>

          {(() => {
            const cats = sortedLines.filter((l) => l.row_type === "category" && !l.archived);
            // 消化(実支出)= 本部が焼いた実支出シリーズ monthly_spent の合計。
            // sumLineSpent / lineYearSpent は本部準拠で viewer スコープに引き上げ済み (上 L443/L450)。
            // ここからは両関数を直接参照する (重複定義を削除)。
            // タスク⑭ (2026-06-02): 本部準拠 summaryBudget に統一 (カテゴリも target_value)。
            //   年間累計バー側 (L851-869) と完全同一定義。本部 annualTargetTotal と一致。
            const summaryBudget = (l) => {
              const tv = Number(l?.target_value);
              if (Number.isFinite(tv) && tv > 0) return tv;
              if (l?.row_type === "fixed_cost") {
                const ma = l?.monthly_amounts;
                const base = Number(l?.monthly_amount) || 0;
                let s = 0;
                for (let m = 1; m <= 12; m++) {
                  const v = ma ? (ma[m] ?? ma[String(m)]) : null;
                  s += (v != null ? Number(v) : base) || 0;
                }
                return s;
              }
              return 0;
            };
            // 総予算 = 全行 summaryBudget 合計、実績 = 全行 settledLineSpent 合計 (確定月のみ)。
            // タスク⑭: lineYearSpent (着地見込み) → settledLineSpent (確定月実績のみ) に変更。
            //   本部 admin の rowSettledActual と同方針。
            const totalBudget = displayLines.reduce((s, l) => s + (summaryBudget(l) || 0), 0);
            const totalActual = displayLines.reduce((s, l) => s + (settledLineSpent(l) || 0), 0);
            const tPct = totalBudget > 0 ? Math.round((totalActual / totalBudget) * 100) : 0;
            const tColor = tPct >= 100 ? RED : tPct >= 80 ? GOLD : TEAL;

            const Bar = ({ budget, pct, color, height = 4 }) => (
              <div style={{ height, background: "rgba(255,255,255,0.08)", borderRadius: height / 2, overflow: "hidden" }}>
                {budget > 0 && (
                  <div style={{
                    height: "100%", width: `${Math.min(pct, 100)}%`,
                    background: color, borderRadius: height / 2, transition: "width 0.3s",
                  }} />
                )}
              </div>
            );

            return (
              <>
                {/* 全体 */}
                <div data-pdf-unit="sum-overall" style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: TEXT_PRIMARY }}>
                      年間予算 合計 <span style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 400 }}>(全行合計・固定費込み)</span>
                    </span>
                    <span style={{ color: tColor, fontWeight: 700 }}>
                      {totalBudget > 0 ? `${tPct}% 消化` : "予算未設定"}
                    </span>
                  </div>
                  {/* 実績 / 予算 の金額 (本部 ProgressCard と同形式)。
                      #4 色テーマ: 実績=確定系=白 (TEXT_PRIMARY)、予算=予算系=青 (BUDGET_BLUE)。 */}
                  <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 4 }}>
                    <span style={{ color: TEXT_PRIMARY, fontWeight: 700 }}>¥{fmtNum(totalActual)}</span>
                    {" / "}<span style={{ color: BUDGET_BLUE }}>¥{fmtNum(totalBudget)}</span>
                  </div>
                  <Bar budget={totalBudget} pct={tPct} color={tColor} height={6} />
                </div>

                {/* #1: 1 行分のバー描画 (固定費・カテゴリで共通)。actualFn で実測の出し方を切替。 */}
                {(() => {
                  // 固定費行 (displayLines 由来。actual は現在の進捗で進む lineYearSpent)。
                  const fixedCosts = displayLines.filter((l) => l?.row_type === "fixed_cost" && !l?.archived);
                  const renderBar = (line, actualFn) => {
                    const b = summaryBudget(line);
                    const a = actualFn(line) || 0;
                    const p = b > 0 ? Math.round((a / b) * 100) : 0;
                    const c = p >= 100 ? RED : p >= 80 ? GOLD : TEAL;
                    return (
                      <div key={line.category_id} data-pdf-unit="sum-bar">
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                          <span style={{ color: TEXT_SECONDARY }}>{line.category_name}</span>
                          <span style={{ color: c, fontWeight: 700 }}>{b > 0 ? `${p}%` : "予算未設定"}</span>
                        </div>
                        {/* 実績 / 予算 の金額 (本部 ProgressCard と同形式)。
                            #4 色テーマ: 実績=確定系=白、予算=予算系=青 (BUDGET_BLUE)。 */}
                        <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 3 }}>
                          <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>¥{fmtNum(a)}</span>
                          {" / "}<span style={{ color: BUDGET_BLUE }}>¥{fmtNum(b)}</span>
                        </div>
                        <Bar budget={b} pct={p} color={c} />
                      </div>
                    );
                  };
                  return (
                    <>
                      {/* 固定費 (グルーピング小見出し付き。バーはカテゴリと共通) */}
                      {fixedCosts.length > 0 && (
                        <div data-pdf-unit="sum-fixed-group" style={{ marginBottom: 12 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_SECONDARY, marginBottom: 6 }}>固定費</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {/* タスク⑭ (2026-06-02): 固定費個別バーも確定月実績のみで進捗計算。 */}
                            {fixedCosts.map((line) => renderBar(line, settledLineSpent))}
                          </div>
                        </div>
                      )}

                      {/* 変動費 (旧「カテゴリ」、2026-06-04 ①): subtotal「変動費合計」と表記統一。
                          上の「固定費」(L1398) とペアになる。admin 6ba3b33 同形。 */}
                      {cats.length > 0 && (
                        <div data-pdf-unit="sum-cat-group">
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_SECONDARY, marginBottom: 6 }}>変動費</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {/* タスク⑭ (2026-06-02): カテゴリ個別バーも確定月実績のみで進捗計算。 */}
                            {cats.map((line) => renderBar(line, settledLineSpent))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            );
          })()}

          <div data-pdf-unit="sum-note" style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
            色:〜79% TEAL / 80〜99% GOLD / 100%+ RED
          </div>
        </div>
      )}

      {/* C-2: 凡例 hasSettled 条件撤去 → 常時表示。赤 (確定月) と 青 (未確定月=予算扱い) を併記。 */}
      <div data-pdf="legend" style={{ padding: "8px 16px", borderTop: `1px solid ${BORDER}`, fontSize: 10, color: TEXT_MUTED, display: "flex", gap: 16, flexWrap: "wrap" }}>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: `${RED}1A`, border: `1px solid ${RED}`, marginRight: 6, verticalAlign: "middle" }} />
          赤背景 = 確定月 (凍結実測)
        </span>
        <span>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: `${BUDGET_BLUE}1A`, border: `1px solid ${BUDGET_BLUE}66`, marginRight: 6, verticalAlign: "middle" }} />
          青背景 = 未確定月 (予算扱い)
        </span>
      </div>
    </div>
  );

  // 横画面: 繰越票テーブルを全画面パネル化 (S.app の 430px 枠 / overflowX:hidden を
  // position:fixed で breakout)。縦画面に戻すと matchMedia リスナで自動的に通常表示へ。
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
