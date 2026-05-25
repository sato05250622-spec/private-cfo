import { useEffect, useRef } from "react";
import { GOLD, NAVY2, BORDER, TEXT_MUTED } from "@shared/theme";

// =============================================================
// MonthDialPicker — iOS 風の縦スクロール・ホイール月ピッカー (顧客アプリ・モバイル前提)。
//   CSS scroll-snap (y mandatory) で各月セルが中央にスナップ。中央のセル = 選択月。
//
// props:
//   - months: [{ y, m, label }]  古い順 (昇順) で渡す想定。先頭=最古、末尾=当月。
//   - value:  { y, m }           現在の選択月。
//   - onChange({ y, m })         スクロール停止 / タップで選択月が変わったとき。
//
// 幾何: VISIBLE 個 (奇数) を表示、各セル ITEM_H。上下に PAD のスペーサを置き、
//   セルは scroll-snap-align:center。これで「中央セル中心 = スクロールポート中心」が
//   scrollTop = index*ITEM_H にぴったり一致する (PAD と H/2 が相殺)。
//   index = round(scrollTop / ITEM_H)。
// =============================================================

const ITEM_H = 38;
const VISIBLE = 5;                       // 奇数
const PAD = ((VISIBLE - 1) / 2) * ITEM_H; // 上下スペーサ

export default function MonthDialPicker({ months = [], value, onChange }) {
  const ref = useRef(null);
  const timer = useRef(null);

  const selectedIdx = Math.max(
    0,
    months.findIndex((mo) => mo.y === value?.y && mo.m === value?.m),
  );

  // value 変化 / 月候補変化で該当位置へスクロール (アニメ)。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = months.findIndex((mo) => mo.y === value?.y && mo.m === value?.m);
    if (idx < 0) return;
    // smooth だと連続変更で揺れるため、初期化系は instant、以降も誤差が出ないよう top 指定。
    el.scrollTo({ top: idx * ITEM_H, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.y, value?.m, months.length]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const idx = Math.min(months.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM_H)));
      const mo = months[idx];
      if (mo && (mo.y !== value?.y || mo.m !== value?.m)) onChange?.({ y: mo.y, m: mo.m });
    }, 120);
  };

  return (
    <div style={{
      position: "relative", height: VISIBLE * ITEM_H,
      background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 12,
      overflow: "hidden", marginBottom: 12,
    }}>
      {/* 中央ハイライト帯 (選択位置) */}
      <div style={{
        position: "absolute", top: PAD, left: 10, right: 10, height: ITEM_H,
        borderTop: `1px solid ${GOLD}55`, borderBottom: `1px solid ${GOLD}55`,
        background: `${GOLD}11`, borderRadius: 8, pointerEvents: "none", zIndex: 1,
      }} />
      {/* 上下フェード (任意の見た目) */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: PAD, background: `linear-gradient(${NAVY2}, ${NAVY2}00)`, pointerEvents: "none", zIndex: 2 }} />
      <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: PAD, background: `linear-gradient(${NAVY2}00, ${NAVY2})`, pointerEvents: "none", zIndex: 2 }} />

      <div
        ref={ref}
        onScroll={handleScroll}
        style={{
          height: "100%", overflowY: "auto", scrollSnapType: "y mandatory",
          WebkitOverflowScrolling: "touch", position: "relative", zIndex: 0,
          scrollbarWidth: "none",
        }}
      >
        <div style={{ height: PAD }} />
        {months.map((mo, i) => {
          const active = i === selectedIdx;
          return (
            <div
              key={`${mo.y}-${mo.m}`}
              onClick={() => onChange?.({ y: mo.y, m: mo.m })}
              style={{
                height: ITEM_H, scrollSnapAlign: "center",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", userSelect: "none",
                fontSize: active ? 15 : 13,
                fontWeight: active ? 700 : 500,
                color: active ? GOLD : TEXT_MUTED,
                transition: "color .15s, font-size .15s",
              }}
            >
              {mo.label}
            </div>
          );
        })}
        <div style={{ height: PAD }} />
      </div>
    </div>
  );
}
