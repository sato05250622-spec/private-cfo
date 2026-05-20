import { useState } from "react";
import { GOLD_GRAD, NAVY, NAVY3, BORDER, TEXT_SECONDARY } from "@shared/theme";

// =============================================================
// レポート画面の「📊 繰越票 / 📝 レビュー」セグメント切替。
// 当月レポート / 月別レポートの 2 画面で共用 (App.jsx)。
// viewer / review に各ビューア要素を渡し、選択側のみマウントする。
// =============================================================
export default function ReportTabs({ viewer, review, defaultTab = "budget" }) {
  const [tab, setTab] = useState(defaultTab);

  const btnStyle = (active) => ({
    flex: 1,
    borderRadius: 20,
    background: active ? GOLD_GRAD : "transparent",
    color: active ? NAVY : TEXT_SECONDARY,
    border: "none",
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    transition: "background 0.2s, color 0.2s",
    whiteSpace: "nowrap",
  });

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
      </div>

      {/* 選択側のみ描画 (マウント切替) */}
      {tab === "budget" ? viewer : review}
    </div>
  );
}
