import { useState, useEffect, useRef } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import { useLoans } from "../hooks/useLoans";
import {
  GOLD, NAVY, NAVY2, NAVY3, CARD_BG, BORDER, RED, TEAL,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

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
    target_value: null,
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
      // 全14列 (カテゴリ＋1〜12月＋目標) の実幅をライブ DOM から測る。
      // table は overflowX:auto ラッパー内でクリップ表示されているが、
      // scrollWidth/offsetWidth は目標列まで含む“はみ出し込みの実幅”を返す。
      const tableEl = el.querySelector("table");
      const tableW = Math.ceil(Math.max(tableEl?.scrollWidth || 0, tableEl?.offsetWidth || 0));
      // キャプチャ幅 = テーブル実幅 + 左右ボーダー/余白の保険。最低 800px は確保。
      const captureW = Math.max(tableW + 4, 800);

      const canvas = await html2canvas(el, {
        scale: 2,                   // 文字をシャープに
        backgroundColor: CARD_BG,   // 透明部分をカード地色で埋める (暗テーマのまま)
        useCORS: true,
        width: captureW,            // キャプチャ範囲を全14列の実幅まで広げる (目標列の切れ対策)
        windowWidth: captureW + 40, // レイアウト計算幅もそれ以上に
        // PDF ボタン等 (.no-print) はキャプチャから除外。
        ignoreElements: (node) => node.classList?.contains?.("no-print"),
        // 画面 (maxWidth 430px) では横スクロールラッパーが table(minWidth:720) をクリップし、
        // さらに .annual-pdf-root の inline overflow:hidden が右端 (目標列) を切り落とす。
        // クローン DOM だけを操作してクリップを全解除し、root を全14列の実幅まで広げる。
        // (live UI には一切影響しない)
        onclone: (clonedDoc) => {
          const root = clonedDoc.querySelector(".annual-pdf-root");
          if (root) {
            root.style.width = `${captureW}px`;
            root.style.maxWidth = "none";
            root.style.overflow = "visible"; // ← inline overflow:hidden を解除 (目標列クリップの元凶)
          }
          clonedDoc.querySelectorAll(".annual-pdf-scroll").forEach((n) => {
            n.style.overflow = "visible";
            n.style.width = "auto";
          });
          clonedDoc.querySelectorAll(".annual-pdf-root table").forEach((t) => {
            t.style.minWidth = "0";
            t.style.width = "100%"; // root が全幅になったので 100% で全14列が収まる
          });
        },
      });
      const imgData = canvas.toDataURL("image/png");
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();   // 297mm
      const pageH = doc.internal.pageSize.getHeight();  // 210mm
      // 画像をページ幅いっぱいに合わせ、高さはアスペクト比から算出。
      const imgW = pageW;
      const imgH = (canvas.height * imgW) / canvas.width;
      if (imgH <= pageH) {
        doc.addImage(imgData, "PNG", 0, 0, imgW, imgH);
      } else {
        // 1枚に収まらない: 同じ画像を上にずらして貼り、addPage で各ページ分のスライスを表示。
        let remaining = imgH;
        let position = 0;
        while (remaining > 0) {
          doc.addImage(imgData, "PNG", 0, position, imgW, imgH);
          remaining -= pageH;
          if (remaining > 0) {
            doc.addPage();
            position -= pageH;
          }
        }
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
  const sortedLines = [...lines].sort(
    (a, b) => (Number(a?.display_order) || 0) - (Number(b?.display_order) || 0),
  );
  // Phase 3 (固定費): 固定費行をライブ生成し、committed 由来の行の前 (最上部) に prepend。
  // 描画専用 (sortedLines は targetGrandTotal / 消化サマリーで従来どおり使用)。
  const fixedCostLines = buildFixedCostLines(loans);
  const displayLines = [...fixedCostLines, ...sortedLines];
  const totalsMonthly = data.committed_totals?.monthly || {};
  const grandTotal = data.committed_totals?.grandTotal ?? null;
  // 月合計行の目標列 = 全 line の target_value 合計 (= 年間目標合計)。
  const targetGrandTotal = sortedLines.reduce((s, l) => s + (Number(l?.target_value) || 0), 0);

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
      <div style={{
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
                  >{fmtCell(resolveCell(line, m))}</td>
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
        <div style={{
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
        <div style={{ margin: "0 16px", paddingTop: 16, paddingBottom: 16, borderTop: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 10 }}>
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
            // Phase 1c: 本部が年間総予算を設定済ならそれを全体予算に、未設定ならカテゴリ別合計へフォールバック。
            const annualSet = Number(data.committedAnnualTotalTarget) > 0;
            const totalBudget = annualSet
              ? Number(data.committedAnnualTotalTarget)
              : cats.reduce((s, l) => s + (Number(l.target_value) || 0), 0);
            const totalActual = cats.reduce((s, l) => s + sumLineSpent(l), 0);
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
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ fontWeight: 600, color: TEXT_PRIMARY }}>
                      年間予算 合計 <span style={{ fontSize: 10, color: TEXT_MUTED, fontWeight: 400 }}>{annualSet ? "(年間総予算)" : "(カテゴリ合計)"}</span>
                    </span>
                    <span style={{ color: tColor, fontWeight: 700 }}>
                      {totalBudget > 0 ? `${tPct}% 消化` : "予算未設定"}
                    </span>
                  </div>
                  <Bar budget={totalBudget} pct={tPct} color={tColor} height={6} />
                </div>

                {/* カテゴリ別 */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {cats.map((line) => {
                    const b = Number(line.target_value) || 0;
                    const a = sumLineSpent(line);
                    const p = b > 0 ? Math.round((a / b) * 100) : 0;
                    const c = p >= 100 ? RED : p >= 80 ? GOLD : TEAL;
                    return (
                      <div key={line.category_id}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                          <span style={{ color: TEXT_SECONDARY }}>{line.category_name}</span>
                          <span style={{ color: c }}>{b > 0 ? `${p}%` : "予算未設定"}</span>
                        </div>
                        <Bar budget={b} pct={p} color={c} />
                      </div>
                    );
                  })}
                </div>
              </>
            );
          })()}

          <div style={{ marginTop: 10, fontSize: 10, color: "rgba(255,255,255,0.5)" }}>
            色:〜79% TEAL / 80〜99% GOLD / 100%+ RED
          </div>
        </div>
      )}

      {hasSettled && (
        <div style={{ padding: "8px 16px", borderTop: `1px solid ${BORDER}`, fontSize: 10, color: TEXT_MUTED }}>
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
