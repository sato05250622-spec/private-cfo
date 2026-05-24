import { useState, useEffect, useRef } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { useLoans } from "../hooks/useLoans";
import { useBudgets } from "../hooks/useBudgets";
import { cycleStart, cycleEnd, getManagementStartDay } from "../utils/cycle";
import { toDateStr } from "@shared/format";
import {
  GOLD, NAVY, NAVY2, NAVY3, CARD_BG, BORDER, RED, TEAL,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

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

// #2: 予算VS実績 (week_cat_budgets) を繰越票の将来月予算の入力元にする (本部とロジック統一)。
//   useBudgets の weekCatBudgets は { '${year}-${cycleMonth}-w${weekNum}_${categoryId}': amount } の Record。
//   指定カテゴリの cycle_month ごとに Σ(週) を取り、classifyMonth が future の月だけ返す。
//   返り値: { [m(1-12)]: Σ(週) }。月対応は本部 deriveFutureWeekBudgetForCategory と同一。
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
    if (classifyMonth(fiscalYear, cm, msd, todayStr, startMonth) === "future") out[cm] = byMonth[cm];
  }
  return out;
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
  if (line?.row_type === "fixed_cost") {
    const ma = line.monthly_amounts;
    const mv = ma ? (ma[m] ?? ma[String(m)]) : null;
    const a = mv != null ? Number(mv) : Number(line.monthly_amount);
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
  // fiscalYear は予約 prop (現状 API は最新年度のみ)。明示参照して lint 回避。
  void fiscalYear;
  const { data, loading, error } = useAnnualBudgets(clientId);
  // Phase 3 (固定費): データ源は loans (借入)。ログイン顧客の loans を購読 (auth ベース)。
  // 繰越票最上部にライブ生成行として描画する (committed_lines には含まれない)。
  const { loans } = useLoans();
  // #2: 予算VS実績 (week_cat_budgets) を将来月予算の入力元にするため購読 (auth ベース)。
  //   カテゴリ将来月セルを Σ(週) で上書き表示する (本部 resolveCell とロジック統一)。
  const { weekCatBudgets } = useBudgets();

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
  // ・ページ幅にフィット (アスペクト比維持) させるため全14列が必ず1枚の横幅に収まる。
  // ・縦に長く1枚に収まらない場合は画像を上方向にずらしながら複数ページへ分割。
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

      // 全14列 (カテゴリ＋1〜12月＋目標) の実幅をライブ DOM から測りキャプチャ幅を決める。
      const tableEl = el.querySelector("table");
      const tableW = Math.ceil(Math.max(tableEl?.scrollWidth || 0, tableEl?.offsetWidth || 0));
      const captureW = Math.max(tableW + 4, 800);
      // 1ページ分の縦容量 (CSS px)。captureW px 幅を contentWmm に写すスケールで換算。
      const pageContentPx = (contentHmm * captureW) / contentWmm;

      // ---- live DOM から各行/セクションの高さを測る (行は nowrap で一定高さ) ----
      const headerH = el.querySelector('[data-pdf="header"]')?.offsetHeight || 0;
      const theadH = el.querySelector("thead")?.offsetHeight || 0;
      const bodyRows = Array.from(el.querySelectorAll("tbody tr"));
      const rowHs = bodyRows.map((r) => r.offsetHeight || 1);

      // ---- テーブルページ: 行を「行境界で」チャンク化 (各ページ thead 分、先頭は header も確保) ----
      const tablePages = [];
      {
        let i = 0; let first = true;
        while (i < bodyRows.length) {
          const budget = pageContentPx - theadH - (first ? headerH : 0);
          let used = 0; const start = i;
          while (i < bodyRows.length && (used === 0 || used + rowHs[i] <= budget)) { used += rowHs[i]; i += 1; }
          tablePages.push({ start, end: i, showHeader: first });
          first = false;
        }
        if (tablePages.length === 0) tablePages.push({ start: 0, end: 0, showHeader: true });
      }

      // ---- 末尾セクション (年間合計 + 消化サマリー + 凡例) を unit 単位でページ詰め ----
      const tailUnits = [];
      const pushUnit = (key, node) => { if (node) tailUnits.push({ key, h: node.offsetHeight || 1 }); };
      pushUnit("grandtotal", el.querySelector('[data-pdf="grandtotal"]'));
      pushUnit("sum-title", el.querySelector('[data-pdf-unit="sum-title"]'));
      pushUnit("sum-overall", el.querySelector('[data-pdf-unit="sum-overall"]'));
      Array.from(el.querySelectorAll('[data-pdf-unit="sum-bar"]')).forEach((n, idx) => pushUnit(`sum-bar:${idx}`, n));
      pushUnit("sum-note", el.querySelector('[data-pdf-unit="sum-note"]'));
      pushUnit("legend", el.querySelector('[data-pdf="legend"]'));
      const tailPages = [];
      {
        let used = 0; let cur = [];
        for (const u of tailUnits) {
          if (cur.length > 0 && used + u.h > pageContentPx) { tailPages.push(cur); cur = []; used = 0; }
          cur.push(u.key); used += u.h;
        }
        if (cur.length > 0) tailPages.push(cur);
      }

      // 共通 onclone: 幅展開・クリップ解除・カテゴリ列の sticky 解除 (左端ずれ防止)。
      const baseClone = (clonedDoc) => {
        const root = clonedDoc.querySelector(".annual-pdf-root");
        if (root) { root.style.width = `${captureW}px`; root.style.maxWidth = "none"; root.style.overflow = "visible"; }
        clonedDoc.querySelectorAll(".annual-pdf-scroll").forEach((n) => { n.style.overflow = "visible"; n.style.width = "auto"; });
        clonedDoc.querySelectorAll(".annual-pdf-root table").forEach((t) => { t.style.minWidth = "0"; t.style.width = "100%"; });
        clonedDoc.querySelectorAll(".annual-pdf-root th, .annual-pdf-root td").forEach((c) => {
          if (c.style.position === "sticky") { c.style.position = "static"; c.style.left = "auto"; }
        });
      };
      const setDisp = (cd, sel, show) => { const n = cd.querySelector(sel); if (n) n.style.display = show ? "" : "none"; };
      const capture = (configure) => html2canvas(el, {
        scale, backgroundColor: CARD_BG, useCORS: true,
        width: captureW, windowWidth: captureW + 40,
        ignoreElements: (node) => node.classList?.contains?.("no-print"),
        onclone: (clonedDoc) => { baseClone(clonedDoc); configure(clonedDoc); },
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
  // committed セル解決 (resolveCell) の上に、カテゴリ将来月だけ週予算 Σ を被せる表示用リゾルバ。
  const resolveCellDisplay = (line, m) => {
    if (line?.row_type === "category" && line?.category_id) {
      const wb = weekBudgetByCat[line.category_id];
      if (wb && wb[m] != null) return wb[m];
    }
    return resolveCell(line, m);
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
  const hasSettled = committedSettledMonths.length > 0;

  // 横画面では横方向 padding を詰めて 12ヶ月 + カテゴリ列が横スクロール無しで収まるようにする。
  // fontSize は可読下限 11px 維持。
  const cellPadX = isLandscape ? 5 : 8;
  const cellStyle = {
    padding: `6px ${cellPadX}px`, textAlign: "right", fontSize: 11,
    color: TEXT_PRIMARY, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
  };
  const headCellStyle = {
    padding: `6px ${cellPadX}px`, textAlign: "right", fontSize: 11, fontWeight: 700,
    color: GOLD, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
    background: NAVY3,
  };
  // 行頭 (カテゴリ名) 列は縦・横ともスクロール時に固定 (sticky)。
  const stickyBase = { position: "sticky", left: 0, zIndex: 1, textAlign: "left" };
  // 縦・横とも auto layout + 親 div overflowX:auto による横スクロールに統一。
  // 目標列(+1)を見込み minWidth を 640→720 に拡張 (各列が読める幅を保つ)。
  // 横画面で tableLayout:fixed をやめたため iOS Safari の sticky×fixed ゴーストバグは発生しない。
  const tableStyle = { borderCollapse: "collapse", width: "100%", minWidth: 720 };
  // isLandscape は PDF 全画面化 (横画面 breakout) で引き続き使用するため残置。
  void isLandscape;

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
          onClick={handlePrint}
          style={{
            background: GOLD, color: NAVY, border: "none", borderRadius: 8,
            padding: "6px 12px", fontSize: 12, fontWeight: 700,
            cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
          }}
        >
          📄 PDF
        </button>
      </div>
      <div className="annual-pdf-scroll" style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...headCellStyle, ...stickyBase, background: NAVY3 }}>カテゴリ</th>
              {monthOrder.map((m) => (
                <th key={m} style={isMonthSettled(m)
                  ? { ...headCellStyle, border: `1px solid ${RED}`, color: RED }
                  : headCellStyle}
                  title={isMonthSettled(m) ? "この月は確定済 (凍結実測)" : undefined}
                >{m}月</th>
              ))}
              <th style={{ ...headCellStyle }}>目標</th>
            </tr>
          </thead>
          <tbody>
            {displayLines.map((line, i) => {
              // 固定費行は確定塗り (赤) を適用しない (毎月同額の予算=実測。本部 Phase 2a と整合)。
              const isFixed = line?.row_type === "fixed_cost";
              return (
              <tr key={line?.category_id || line?.row_type || i}>
                <td style={{
                  ...cellStyle, ...stickyBase, background: CARD_BG,
                  fontWeight: 600, color: line?.archived ? TEXT_MUTED : TEXT_SECONDARY,
                }}
                  title={line?.category_name || undefined}
                >
                  {line?.category_name || "(無題)"}
                </td>
                {monthOrder.map((m) => (
                  <td key={m}
                    style={(isMonthSettled(m) && !isFixed)
                      ? { ...cellStyle, background: `${RED}1A`, border: `1px solid ${RED}` }
                      : cellStyle}
                    title={(isMonthSettled(m) && !isFixed) ? "この月は確定済 (凍結実測)" : undefined}
                  >{fmtCell(resolveCellDisplay(line, m))}</td>
                ))}
                <td style={{ ...cellStyle, fontWeight: 700, color: line?.target_value == null ? TEXT_MUTED : GOLD }}>
                  {fmtCell(line?.target_value)}
                </td>
              </tr>
              );
            })}
            <tr>
              <td style={{
                ...cellStyle, ...stickyBase, background: NAVY2,
                fontWeight: 700, color: GOLD,
              }}>
                月合計
              </td>
              {monthOrder.map((m) => (
                <td key={m} style={isMonthSettled(m)
                  ? { ...cellStyle, background: `${RED}1A`, border: `1px solid ${RED}`, fontWeight: 700, color: GOLD }
                  : { ...cellStyle, background: NAVY2, fontWeight: 700, color: GOLD }}>
                  {fmtCell(pickMonth(totalsMonthly, m))}
                </td>
              ))}
              <td style={{ ...cellStyle, background: NAVY2, fontWeight: 700, color: GOLD }}>
                {fmtCell(targetGrandTotal || null)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      {grandTotal != null && (
        <div data-pdf="grandtotal" style={{
          padding: "10px 16px", borderTop: `1px solid ${BORDER}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ fontSize: 11, color: TEXT_MUTED }}>年間合計</span>
          <span style={{ fontSize: 14, fontWeight: 700, color: GOLD }}>
            {Number(grandTotal).toLocaleString()}円
          </span>
        </div>
      )}

      {/* Phase 2: カテゴリ別 目標消化率 (進捗バー) */}
      {sortedLines.filter((l) => l.row_type === "category" && !l.archived).length > 0 && (
        <div data-pdf="summary" style={{ margin: "0 16px", paddingTop: 16, paddingBottom: 16, borderTop: `1px solid ${BORDER}` }}>
          <div data-pdf-unit="sum-title" style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10 }}>
            📊 年間予算 消化サマリー
          </div>

          {(() => {
            const cats = sortedLines.filter((l) => l.row_type === "category" && !l.archived);
            // 消化(実支出)= 本部が焼いた実支出シリーズ monthly_spent の合計。
            // 将来月の予算配分は含まない (確定実測+経過月/当月ライブ実支出のみ)。
            // 旧 committed データ (monthly_spent 無し) は消化 0 にフォールバック (エラーにしない)。
            const sumLineSpent = (l) => {
              const s = l?.monthly_spent;
              if (!s || typeof s !== "object") return 0;
              let sum = 0;
              for (const k of Object.keys(s)) sum += Number(s[k]) || 0;
              return sum;
            };
            // 固定費行 (committed に monthly_spent 無し) の年間実測 = Σ(monthly_amounts[m] ?? monthly_amount)。
            // 本部 rowYearSpent の固定費分岐と同等。
            // #1 修正: 12ヶ月全合算 (常に満額) をやめ、classifyMonth が past/current の月だけ合算
            //   (将来月は不算入)。カテゴリ行 (monthly_spent ベース) と同じ「現在の進捗で進む」挙動に揃える。
            const lineYearSpent = (l) => {
              if (l?.row_type === "fixed_cost") {
                const ma = l.monthly_amounts; const base = Number(l.monthly_amount) || 0;
                let s = 0;
                for (let m = 1; m <= 12; m++) {
                  if (classifyMonth(fyYear, m, msd, todayStr, startMonth) === "future") continue;
                  const v = ma ? (ma[m] ?? ma[String(m)]) : null;
                  s += (v != null ? Number(v) : base) || 0;
                }
                return s;
              }
              return sumLineSpent(l);
            };
            // 総予算・実測とも全行 (固定費＋カテゴリー＋特殊行) で集計しスコープ一致 (本部と同方針)。
            //   totalBudget = 全行の target_value 合計 (= targetGrandTotal、月合計行の目標と同値)
            //   totalActual = 全行の年間実測合計 (固定費込み)
            // committedAnnualTotalTarget の手入力値依存は廃止。
            const totalBudget = targetGrandTotal;
            const totalActual = displayLines.reduce((s, l) => s + (lineYearSpent(l) || 0), 0);
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
                  <Bar budget={totalBudget} pct={tPct} color={tColor} height={6} />
                </div>

                {/* #1: 1 行分のバー描画 (固定費・カテゴリで共通)。actualFn で実測の出し方を切替。 */}
                {(() => {
                  // 固定費行 (displayLines 由来。actual は現在の進捗で進む lineYearSpent)。
                  const fixedCosts = displayLines.filter((l) => l?.row_type === "fixed_cost" && !l?.archived);
                  const renderBar = (line, actualFn) => {
                    const b = Number(line.target_value) || 0;
                    const a = actualFn(line) || 0;
                    const p = b > 0 ? Math.round((a / b) * 100) : 0;
                    const c = p >= 100 ? RED : p >= 80 ? GOLD : TEAL;
                    return (
                      <div key={line.category_id} data-pdf-unit="sum-bar">
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                          <span style={{ color: TEXT_SECONDARY }}>{line.category_name}</span>
                          <span style={{ color: c }}>{b > 0 ? `${p}%` : "予算未設定"}</span>
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
                            {fixedCosts.map((line) => renderBar(line, lineYearSpent))}
                          </div>
                        </div>
                      )}

                      {/* カテゴリ別 */}
                      {cats.length > 0 && (
                        <div data-pdf-unit="sum-cat-group">
                          <div style={{ fontSize: 11, fontWeight: 700, color: TEXT_SECONDARY, marginBottom: 6 }}>カテゴリ</div>
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {cats.map((line) => renderBar(line, sumLineSpent))}
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

      {hasSettled && (
        <div data-pdf="legend" style={{ padding: "8px 16px", borderTop: `1px solid ${BORDER}`, fontSize: 10, color: TEXT_MUTED }}>
          <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: `${RED}1A`, border: `1px solid ${RED}`, marginRight: 6, verticalAlign: "middle" }} />
          赤背景 = 確定月 (凍結実測)
        </div>
      )}
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
      }}>
        {card}
      </div>
    );
  }
  return card;
}
