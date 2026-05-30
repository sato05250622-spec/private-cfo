import { useEffect, useRef, useState } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { getPublishedByMonth } from "../lib/api/monthlyReviews";
import {
  GOLD, NAVY, TEAL, RED, NAVY2, NAVY3, CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

// B-3 案A: 消化率の色分け用ローカル定数。@shared/theme には未収録のため、
// 本ファイル内で定義 (BUDGET_BLUE をローカル定数化していた既存パターンと同方針)。
//   GREEN  = 消化率 80-99% (ペース)
//   YELLOW = 消化率 100-110% (超過警告)
//   既存 TEAL / RED は formatVarianceRatio 内で「余裕」「大幅超過」として再利用。
const RV_GREEN  = "#22c55e";
const RV_YELLOW = "#F9A825";

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

// B-3 案A: 消化率 (consumption ratio): actual / budget × 100。本部 formatVarianceRatio と同期。
//   ≤79%       → 青 (TEAL)     余裕
//   80-99%     → 緑 (RV_GREEN) ペース
//   100-110%   → 黄 (RV_YELLOW) 超過警告
//   >110%      → 赤 (RED)      大幅超過
//   budget<=0  → 「ー」
//   関数名は formatVarianceRatio で据置 (呼出側の影響を最小化、参照名不変)。
function formatVarianceRatio(budget, actual) {
  const b = Number(budget) || 0;
  const a = Number(actual) || 0;
  if (b <= 0) return { text: "ー", color: TEXT_MUTED };
  const pct = (a / b) * 100;
  const text = `${pct.toFixed(1)}%`;
  if (pct >= 110) return { text, color: RED };
  if (pct >= 100) return { text, color: RV_YELLOW };
  if (pct >= 80)  return { text, color: RV_GREEN };
  return { text, color: TEAL };
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
  // ⑥: 旧フォーマット (振り返り/アドバイス/プラン) アコーディオン開閉 (本部準拠、既定 閉)。
  const [legacyOpen, setLegacyOpen] = useState(false);
  // PDF 出力: 繰越票 (AnnualBudgetViewer.handlePrint) と同方式 (jsPDF + html2canvas)。
  // pdfRef = ルート div、pdfBusy = 二重押下防止。
  const pdfRef = useRef(null);
  const pdfBusy = useRef(false);

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

  // 修正1: スマホ幅で「予算比」まで横スクロールなしに収まるよう padding/フォント圧縮。
  const cellStyle = {
    padding: "3px 5px", fontSize: 10, color: TEXT_PRIMARY,
    borderBottom: `1px solid ${BORDER}`,
  };
  // 修正1: 数字3列 (予算/当月金額/予算比) は等幅数字で桁を揃える。
  const numCell = { ...cellStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" };
  // 修正1: 「項目」列の右に縦罫線 (項目↔予算の区切り)。
  const itemColStyle = { ...cellStyle, borderRight: `1px solid ${BORDER}` };

  // PDF 出力 (繰越票 AnnualBudgetViewer.handlePrint と同方式: jsPDF + html2canvas)。
  // 本部 pdf.jsx (window.print) は iOS PWA で不安定 → 採用せず。
  // multi-page 分割は繰越票準拠: 明細表=行単位 (tablePages)、コメント section=section 単位 (tailPages)。
  // 月次レビューは縦長 → A4 portrait。
  const handlePrint = async () => {
    const el = pdfRef.current;
    if (!el || pdfBusy.current) return;
    pdfBusy.current = true;
    try {
      const scale = 2;
      const marginMm = 8;
      const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();   // 210mm
      const pageH = doc.internal.pageSize.getHeight();  // 297mm
      const contentWmm = pageW - marginMm * 2;          // 194mm
      const contentHmm = pageH - marginMm * 2;          // 281mm

      // 横幅: ルートの自然幅 (>=480px)。月次レビューは横スクロール不要なので繰越票より単純。
      const captureW = Math.max(el.scrollWidth || 0, el.offsetWidth || 0, 480);
      const pageContentPx = (contentHmm * captureW) / contentWmm;

      // 繰越票 applyPdfLayout の簡略版: 幅展開 + 横スクロールラッパ解除。
      // colgroup 列幅固定 / sticky 解除は不要 (月次レビュー table は 5 列・sticky なし)。
      const applyPdfLayout = (rootEl) => {
        if (!rootEl) return;
        rootEl.style.width = `${captureW}px`;
        rootEl.style.maxWidth = "none";
        rootEl.style.overflow = "visible";
        rootEl.querySelectorAll(".review-pdf-scroll").forEach((n) => {
          n.style.overflow = "visible";
          n.style.width = "auto";
        });
      };

      // 繰越票同様、clone を offscreen に置いて行高/セクション高を再測定。
      // live DOM (モバイル overflowX:auto) と cloneDoc (展開後 captureW) で
      // 行高がズレるのを吸収する。
      const measureRoot = el.cloneNode(true);
      measureRoot.style.position = "absolute";
      measureRoot.style.left = "-99999px";
      measureRoot.style.top = "0";
      measureRoot.style.visibility = "hidden";
      measureRoot.style.pointerEvents = "none";
      document.body.appendChild(measureRoot);
      applyPdfLayout(measureRoot);

      const headerH = measureRoot.querySelector('[data-pdf="header"]')?.offsetHeight || 0;
      const diagH = measureRoot.querySelector('[data-pdf-unit="diag-badge"]')?.offsetHeight || 0;
      const tableTitleH = measureRoot.querySelector('[data-pdf-unit="table-title"]')?.offsetHeight || 0;
      const tableEl = measureRoot.querySelector('[data-pdf="table-block"] table');
      const theadH = tableEl?.querySelector("thead")?.offsetHeight || 0;
      const rowHs = tableEl ? Array.from(tableEl.querySelectorAll("tbody tr")).map((r) => r.offsetHeight || 1) : [];

      const unitH = (sel) => measureRoot.querySelector(sel)?.offsetHeight || 0;
      const mgmtH         = unitH('[data-pdf-unit="mgmt-summary"]');
      const nextActionH   = unitH('[data-pdf-unit="next-action"]');
      const staffCommentH = unitH('[data-pdf-unit="staff-comment"]');
      const legacySummH   = unitH('[data-pdf-unit="legacy-summary"]');
      const legacyAdvH    = unitH('[data-pdf-unit="legacy-advice"]');
      const legacyPlanH   = unitH('[data-pdf-unit="legacy-plan"]');

      document.body.removeChild(measureRoot);

      // ---- table pages: 行を「行境界で」チャンク化。
      //   1ページ目は header + diag + table-title + thead を上に置き、残りで rows 詰め。
      //   2ページ目以降は thead だけ。
      const tablePages = [];
      if (rowHs.length > 0) {
        let i = 0; let first = true;
        while (i < rowHs.length) {
          const overhead = first ? (headerH + diagH + tableTitleH) : 0;
          const budget = pageContentPx - theadH - overhead;
          let used = 0; const start = i;
          while (i < rowHs.length && (used === 0 || used + rowHs[i] <= budget)) {
            used += rowHs[i]; i += 1;
          }
          tablePages.push({ start, end: i, isFirst: first });
          first = false;
        }
      }

      // ---- tail pages: 末尾セクションを unit 単位でページ詰め (繰越票 tailPages 準拠)。
      //   table がない場合は最初の tail page にも header + diag を載せる。
      const tailFirstNeedsHeader = tablePages.length === 0;
      const firstTailOverhead = tailFirstNeedsHeader ? (headerH + diagH) : 0;
      const tailUnits = [];
      if (mgmtH > 0)         tailUnits.push({ key: 'mgmt-summary',   h: mgmtH });
      if (nextActionH > 0)   tailUnits.push({ key: 'next-action',    h: nextActionH });
      if (staffCommentH > 0) tailUnits.push({ key: 'staff-comment',  h: staffCommentH });
      if (legacySummH > 0)   tailUnits.push({ key: 'legacy-summary', h: legacySummH });
      if (legacyAdvH > 0)    tailUnits.push({ key: 'legacy-advice',  h: legacyAdvH });
      if (legacyPlanH > 0)   tailUnits.push({ key: 'legacy-plan',    h: legacyPlanH });
      const tailPages = [];
      {
        let used = 0; let cur = [];
        for (const u of tailUnits) {
          const pageBudget = pageContentPx - (tailPages.length === 0 ? firstTailOverhead : 0);
          if (cur.length > 0 && used + u.h > pageBudget) {
            tailPages.push(cur); cur = []; used = 0;
          }
          cur.push(u.key); used += u.h;
        }
        if (cur.length > 0) tailPages.push(cur);
      }

      const setDisp = (cd, sel, show) => {
        const n = cd.querySelector(sel);
        if (n) n.style.display = show ? "" : "none";
      };
      // 共通 onclone: applyPdfLayout 適用 + ページごとの表示/非表示は configure で差分指定。
      const capture = (configure) => html2canvas(el, {
        scale, backgroundColor: CARD_BG, useCORS: true,
        width: captureW, windowWidth: captureW + 40,
        ignoreElements: (node) => node.classList?.contains?.("no-print"),
        onclone: (clonedDoc) => {
          const root = clonedDoc.querySelector(".review-pdf-root");
          applyPdfLayout(root);
          configure(clonedDoc);
        },
      });

      // 各ページの canvas を A4 縦に貼付 (左右に marginMm、横中央寄せ、縦 clamp)。
      let pageIndex = 0;
      const addCanvasPage = (canvas) => {
        if (pageIndex > 0) doc.addPage();
        pageIndex += 1;
        let w = contentWmm;
        let h = (canvas.height * w) / canvas.width;
        if (h > contentHmm) { h = contentHmm; w = (canvas.width * h) / canvas.height; }
        doc.addImage(canvas.toDataURL("image/png"), "PNG", (pageW - w) / 2, marginMm, w, h);
      };

      // テーブルページ (thead は table 内に常にあるので各ページ自動的に含まれる)。
      for (const tp of tablePages) {
        // eslint-disable-next-line no-await-in-loop
        const canvas = await capture((cd) => {
          setDisp(cd, '[data-pdf="header"]',            tp.isFirst);
          setDisp(cd, '[data-pdf-unit="diag-badge"]',   tp.isFirst);
          setDisp(cd, '[data-pdf-unit="table-title"]',  tp.isFirst);
          setDisp(cd, '[data-pdf="table-block"]',       true);
          setDisp(cd, '[data-pdf-unit="mgmt-summary"]',  false);
          setDisp(cd, '[data-pdf-unit="next-action"]',   false);
          setDisp(cd, '[data-pdf-unit="staff-comment"]', false);
          setDisp(cd, '[data-pdf-unit="legacy-summary"]', false);
          setDisp(cd, '[data-pdf-unit="legacy-advice"]',  false);
          setDisp(cd, '[data-pdf-unit="legacy-plan"]',    false);
          cd.querySelectorAll('[data-pdf="table-block"] tbody tr').forEach((tr, i) => {
            tr.style.display = (i >= tp.start && i < tp.end) ? "" : "none";
          });
        });
        addCanvasPage(canvas);
      }

      // 末尾ページ (管理サマリー / コメント / 旧フォーマット)。
      for (let pi = 0; pi < tailPages.length; pi++) {
        const units = tailPages[pi];
        const set = new Set(units);
        const isFirstTail = pi === 0 && tailFirstNeedsHeader;
        // eslint-disable-next-line no-await-in-loop
        const canvas = await capture((cd) => {
          setDisp(cd, '[data-pdf="header"]',          isFirstTail);
          setDisp(cd, '[data-pdf-unit="diag-badge"]', isFirstTail);
          setDisp(cd, '[data-pdf="table-block"]',     false);
          setDisp(cd, '[data-pdf-unit="mgmt-summary"]',   set.has('mgmt-summary'));
          setDisp(cd, '[data-pdf-unit="next-action"]',    set.has('next-action'));
          setDisp(cd, '[data-pdf-unit="staff-comment"]',  set.has('staff-comment'));
          setDisp(cd, '[data-pdf-unit="legacy-summary"]', set.has('legacy-summary'));
          setDisp(cd, '[data-pdf-unit="legacy-advice"]',  set.has('legacy-advice'));
          setDisp(cd, '[data-pdf-unit="legacy-plan"]',    set.has('legacy-plan'));
        });
        addCanvasPage(canvas);
      }

      // フォールバック: テーブルもセクションも何も無い場合は素のキャプチャを 1 枚だけ。
      if (pageIndex === 0) {
        const canvas = await capture(() => {});
        addCanvasPage(canvas);
      }

      doc.save(`月次レビュー_${year}年${String(month).padStart(2, '0')}月.pdf`);
    } catch (err) {
      console.error('[MonthlyReviewViewer.handlePrint]', err);
      // eslint-disable-next-line no-alert
      window.alert('PDF 出力に失敗しました: ' + (err?.message ?? err));
    } finally {
      pdfBusy.current = false;
    }
  };

  return (
    <div ref={pdfRef} className="review-pdf-root" style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden", boxShadow: SHADOW }}>
      {/* ヘッダ (繰越票・StatusCard と統一感: 44px TEAL アイコンボックス + GOLD タイトル)
          data-pdf="header" は handlePrint 内で 1 ページ目のみ表示するためのマーカ。
          📄 PDF ボタンは className="no-print" で html2canvas キャプチャ時に除外される。 */}
      <div data-pdf="header" style={{ padding: "14px 18px", borderBottom: `1px solid ${BORDER}`, display: "flex", alignItems: "center", gap: 12 }}>
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
        <button
          className="no-print"
          onClick={handlePrint}
          style={{
            marginLeft: "auto",
            background: GOLD, color: NAVY, border: "none", borderRadius: 8,
            padding: "6px 12px", fontSize: 12, fontWeight: 700,
            cursor: "pointer", whiteSpace: "nowrap", flexShrink: 0,
          }}
        >
          📄 PDF
        </button>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {/* 診断バッジ (常に表示: 手動 or 達成率自動) — data-pdf-unit でユニット管理。 */}
        <div data-pdf-unit="diag-badge" style={{
          display: "inline-block", fontSize: 11, fontWeight: 700, color: diag.color,
          background: `${diag.color}22`, border: `1px solid ${diag.color}44`,
          borderRadius: 8, padding: "4px 10px", marginBottom: 12,
        }}>
          {diag.label}
        </div>

        {/* ⑥: 明細テーブル — 本部 LineRow と同じ 5 列 (項目/予算/当月金額/予算比/差異理由)。
            ツリー(#5) + 表示専用ソート(#6) + 合計行(TotalsRow 相当)。閲覧専用 (編集列なし)。
            data-pdf="table-block" は handlePrint 内で table page 時にのみ表示。
            data-pdf-unit="table-title" は table 1 ページ目のみ表示。
            ソートトグルは className="no-print" で PDF には含めない。
            .review-pdf-scroll は overflow:auto を PDF キャプチャ時に解除する用。 */}
        {lines.length > 0 && (
          <div data-pdf="table-block" style={{ marginTop: 4 }}>
            <div data-pdf-unit="table-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 700 }}>📊 明細</div>
              {/* #6: 並び替えトグル (表示専用、手動/予算超過%順/金額順)。PDF 出力時は no-print で除外。 */}
              <div className="no-print" style={{ display: "inline-flex", background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 999, padding: 2 }}>
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
            <div className="review-pdf-scroll" style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 450 }}>
                <thead>
                  <tr>
                    <th style={{ ...itemColStyle, textAlign: "left", color: GOLD, fontWeight: 700, background: NAVY3, minWidth: 96 }}>項目</th>
                    <th style={{ ...numCell, color: GOLD, fontWeight: 700, background: NAVY3, minWidth: 62 }}>予算</th>
                    <th style={{ ...numCell, color: GOLD, fontWeight: 700, background: NAVY3, minWidth: 62 }}>当月金額</th>
                    <th style={{ ...numCell, color: GOLD, fontWeight: 700, background: NAVY3, minWidth: 54 }}>消化率</th>
                    <th style={{ ...cellStyle, textAlign: "left", color: GOLD, fontWeight: 700, background: NAVY3, minWidth: 120 }}>差異理由</th>
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
                        // ⑥: 差異理由は独立列 (leaf のみ。group/合成行は "—")。本部 LineRow と同じ列構成。
                        const reason = !isGroup && line?.variance_reason ? String(line.variance_reason).trim() : "";
                        rows.push(
                          <tr key={line?.id || `${parentId}-${depth}-${rows.length}`} style={{ background: isGroup ? "rgba(212,168,67,0.06)" : "transparent" }}>
                            <td style={{ ...itemColStyle, fontWeight: isGroup ? 700 : 400, paddingLeft: 5 + depth * 10 }}>
                              {isGroup ? "📁 " : ""}{line?.label || "(無題)"}
                            </td>
                            <td style={numCell}>{fmtNum(budget)}</td>
                            <td style={numCell}>{fmtNum(actual)}</td>
                            <td style={{ ...numCell, color: vr ? vr.color : TEXT_MUTED, fontWeight: 600 }}>
                              {vr ? vr.text : "—"}
                            </td>
                            <td style={{ ...cellStyle, color: reason ? TEXT_SECONDARY : TEXT_MUTED }}>
                              {reason || "—"}
                            </td>
                          </tr>,
                        );
                        if (isGroup) rows.push(...renderRows(line.id, depth + 1));
                      }
                      return rows;
                    };
                    const body = renderRows(null, 0);
                    // 合計行 (本部 TotalsRow 相当)。予算合計 / 当月合計 / 予算比。
                    if (totals.total_budget != null || totals.total_actual != null) {
                      const tb = Number(totals.total_budget) || 0;
                      const ta = Number(totals.total_actual) || 0;
                      const tvr = formatVarianceRatio(tb, ta);
                      body.push(
                        <tr key="__totals__" style={{ background: NAVY2, borderTop: `2px solid ${GOLD}55` }}>
                          <td style={{ ...itemColStyle, fontWeight: 700, color: GOLD }}>合計</td>
                          <td style={{ ...numCell, fontWeight: 700, color: TEXT_PRIMARY }}>{fmtNum(tb)}</td>
                          <td style={{ ...numCell, fontWeight: 700, color: TEXT_PRIMARY }}>{fmtNum(ta)}</td>
                          <td style={{ ...numCell, fontWeight: 700, color: tvr ? tvr.color : TEXT_MUTED }}>{tvr ? tvr.text : "—"}</td>
                          <td style={{ ...cellStyle, color: TEXT_MUTED }}>—</td>
                        </tr>,
                      );
                    }
                    return body;
                  })()}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ⑥: 管理サマリー (本部 ManagementSummary と同じ MetricCard 3枚)。
            data-pdf-unit="mgmt-summary" は handlePrint の tailPages 用マーカ。
            条件 false 時は wrapper は空で h=0、tailUnits からは自動除外される。 */}
        <div data-pdf-unit="mgmt-summary">
          {(totals.total_budget != null || totals.total_actual != null || totals.achievement_ratio != null) && (
            <ManagementSummaryView totals={totals} />
          )}
        </div>

        {/* ⑥: コメント類 (明細・サマリーの下、本部と同じ並び: 次回対策 → 担当者)。
            各 Section を data-pdf-unit でラップ (Section は value 空時 null を返すので wrapper 空=h=0)。 */}
        <div style={{ marginTop: 14 }}>
          <div data-pdf-unit="next-action">
            <Section label="🎯 次回対策コメント" value={data.next_action_comment} />
          </div>
          <div data-pdf-unit="staff-comment">
            <Section label="💬 担当者コメント" value={data.staff_comment} />
          </div>
        </div>

        {/* ⑥: 旧フォーマット (参考) アコーディオン — 本部 ReviewCard と同じく下部に格納。
            今月の振り返り / CFOからのアドバイス / 来月のアクションプラン。
            開閉ボタンは className="no-print" で PDF 出力時は除外。
            legacy section は accordion 開時のみ DOM 描画 → 閉じてる場合は PDF にも出ない (UI と一貫)。 */}
        {(data.summary || data.advice || data.next_month_plan) && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
            <button
              className="no-print"
              onClick={() => setLegacyOpen((o) => !o)}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "4px 0", background: "transparent", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 700, color: TEXT_MUTED, textAlign: "left" }}
            >
              <span>{legacyOpen ? "▼" : "▶"}</span>
              <span>📁 旧フォーマット (参考)</span>
            </button>
            {legacyOpen && (
              <div style={{ marginTop: 8 }}>
                <div data-pdf-unit="legacy-summary">
                  <Section label="📝 今月の振り返り" value={data.summary} />
                </div>
                <div data-pdf-unit="legacy-advice">
                  <Section label="💡 CFOからのアドバイス" value={data.advice} />
                </div>
                <div data-pdf-unit="legacy-plan">
                  <Section label="🚀 来月のアクションプラン" value={data.next_month_plan} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ⑥: 管理サマリー (本部 ManagementSummary 準拠の MetricCard 3枚)。
function MetricCard({ label, value, color }) {
  return (
    <div style={{ background: NAVY3, border: `1px solid ${BORDER}`, borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 9, color: TEXT_MUTED, fontWeight: 700, letterSpacing: "0.04em", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function ManagementSummaryView({ totals }) {
  const ratio = Number(totals?.achievement_ratio) || 0;
  const over = Number(totals?.over_amount) || 0;
  const save = Number(totals?.save_amount) || 0;
  const ratioPct = (ratio * 100).toFixed(1) + "%";
  const ratioColor = ratio > 0 ? TEAL : ratio < 0 ? RED : TEXT_MUTED;
  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: GOLD, marginBottom: 8, letterSpacing: "0.06em" }}>🧾 管理サマリー</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
        <MetricCard label="予算達成率" value={ratioPct} color={ratioColor} />
        <MetricCard label="予算超過額" value={over > 0 ? `¥${over.toLocaleString("ja-JP")}` : "—"} color={over > 0 ? RED : TEXT_MUTED} />
        <MetricCard label="予算剰余金" value={save > 0 ? `¥${save.toLocaleString("ja-JP")}` : "—"} color={save > 0 ? TEAL : TEXT_MUTED} />
      </div>
    </div>
  );
}
