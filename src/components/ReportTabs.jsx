import { useState } from "react";
import { GOLD_GRAD, NAVY, NAVY3, BORDER, TEXT_SECONDARY } from "@shared/theme";

// =============================================================
// レポート画面のセグメント切替。
//   "budget"   → 📊 繰越票  (viewer)
//   "review"   → 📝 レビュー (review)
//   "recovery" → 👥 投資回収 (recovery、省略時は 3 つ目タブ非表示)
// viewer / review / recovery に各ビューア要素を渡し、選択側のみマウントする。
// =============================================================
export default function ReportTabs({ viewer, review, recovery, defaultTab = "budget" }) {
  const [tab, setTab] = useState(defaultTab);
  const hasRecovery = recovery !== undefined && recovery !== null;

  const btnStyle = (active) => ({
    flex: 1,
    borderRadius: 20,
    background: active ? GOLD_GRAD : "transparent",
    color: active ? NAVY : TEXT_SECONDARY,
    border: "none",
    padding: "8px 8px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background 0.2s, color 0.2s",
    whiteSpace: "nowrap",
  });

  // 選択側のみ描画 (マウント切替)。
  let content;
  if (tab === "recovery" && hasRecovery) content = recovery;
  else if (tab === "review") content = review;
  else content = viewer;

  return (
    <div>
      {/* セグメント pill タブ */}
      <div style={{
        display: "flex",
        background: NAVY3,
        borderRadius: 24,
        padding: 2,
        border: `1px solid ${BORDER}`,
        width: "100%",
        marginBottom: 12,
      }}>
        <button type="button" style={btnStyle(tab === "budget")} onClick={() => setTab("budget")}>
          📊 繰越票
        </button>
        <button type="button" style={btnStyle(tab === "review")} onClick={() => setTab("review")}>
          📝 レビュー
        </button>
        {hasRecovery && (
          <button type="button" style={btnStyle(tab === "recovery")} onClick={() => setTab("recovery")}>
            👥 投資回収
          </button>
        )}
      </div>

      {content}
    </div>
  );
}
