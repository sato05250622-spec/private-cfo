import { useAnnualBudgets } from "../hooks/useAnnualBudgets";
import {
  GOLD, NAVY2, NAVY3, CARD_BG, BORDER,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
} from "@shared/theme";

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
  const totalsMonthly = data.committed_totals?.monthly || {};
  const grandTotal = data.committed_totals?.grandTotal ?? null;

  const cellStyle = {
    padding: "6px 8px", textAlign: "right", fontSize: 11,
    color: TEXT_PRIMARY, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
  };
  const headCellStyle = {
    padding: "6px 8px", textAlign: "right", fontSize: 11, fontWeight: 700,
    color: GOLD, borderBottom: `1px solid ${BORDER}`, whiteSpace: "nowrap",
    background: NAVY3,
  };
  // 行頭 (カテゴリ名) 列は横スクロール時も固定。
  const stickyBase = { position: "sticky", left: 0, zIndex: 1, textAlign: "left" };

  return (
    <div style={{ background: CARD_BG, borderRadius: 16, border: `1px solid ${BORDER}`, overflow: "hidden" }}>
      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${BORDER}` }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: TEXT_PRIMARY }}>
          支出管理繰越票 <span style={{ color: TEXT_MUTED, fontSize: 11 }}>{data.fiscal_year}年度</span>
        </div>
        <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 3 }}>
          本部反映: {fmtDateTime(data.last_committed_at)}
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
          <thead>
            <tr>
              <th style={{ ...headCellStyle, ...stickyBase, background: NAVY3 }}>カテゴリ</th>
              {monthOrder.map((m) => (
                <th key={m} style={headCellStyle}>{m}月</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedLines.map((line, i) => (
              <tr key={line?.category_id || line?.row_type || i}>
                <td style={{
                  ...cellStyle, ...stickyBase, background: CARD_BG,
                  fontWeight: 600, color: line?.archived ? TEXT_MUTED : TEXT_SECONDARY,
                }}>
                  {line?.category_name || "(無題)"}
                </td>
                {monthOrder.map((m) => (
                  <td key={m} style={cellStyle}>{fmtCell(resolveCell(line, m))}</td>
                ))}
              </tr>
            ))}
            <tr>
              <td style={{
                ...cellStyle, ...stickyBase, background: NAVY2,
                fontWeight: 700, color: GOLD,
              }}>
                月合計
              </td>
              {monthOrder.map((m) => (
                <td key={m} style={{ ...cellStyle, background: NAVY2, fontWeight: 700, color: GOLD }}>
                  {fmtCell(pickMonth(totalsMonthly, m))}
                </td>
              ))}
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
    </div>
  );
}
