import { useEffect, useRef, useState } from "react";
import { GOLD, NAVY2, BORDER, TEXT_MUTED } from "@shared/theme";

// =============================================================
// DialPicker — iOS 風の縦スクロール・ホイール（汎用）。
//   CSS scroll-snap (y mandatory) で各セルが中央にスナップ。中央のセル = 選択値。
//   ⑤: 以前より細く・コンパクトに (ITEM_H 38→28、横幅は maxWidth で絞る)。
//
// props (汎用):
//   - items: [{ key, label }]   昇順で渡す想定。key は一意 (文字列/数値)。
//   - value: key                現在の選択キー。
//   - onChange(key)             スクロール停止 / タップで選択が変わったとき。
//   - width: number             最大横幅 (px、既定 200)。
//
// 幾何: VISIBLE 個 (奇数) を表示、各セル ITEM_H。上下に PAD スペーサ + セル
//   scroll-snap-align:center で「中央セル中心 = スクロールポート中心」が
//   scrollTop = index*ITEM_H に一致 (index = round(scrollTop/ITEM_H))。
// =============================================================

const ITEM_H = 28;                        // ⑤: 38 → 28 に縮小
const VISIBLE = 5;                        // 奇数 (据え置き)
const PAD = ((VISIBLE - 1) / 2) * ITEM_H; // 上下スペーサ

export function DialPicker({ items = [], value, onChange, width = 200 }) {
  const ref = useRef(null);
  const timer = useRef(null);

  const selectedIdx = Math.max(0, items.findIndex((it) => it.key === value));

  // value 変化 / 候補変化で該当位置へスクロール (アニメ)。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const idx = items.findIndex((it) => it.key === value);
    if (idx < 0) return;
    el.scrollTo({ top: idx * ITEM_H, behavior: "smooth" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, items.length]);

  const handleScroll = () => {
    const el = ref.current;
    if (!el) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const idx = Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM_H)));
      const it = items[idx];
      if (it && it.key !== value) onChange?.(it.key);
    }, 120);
  };

  return (
    <div style={{
      position: "relative", height: VISIBLE * ITEM_H,
      width: "100%", maxWidth: width, margin: "0 auto 10px",
      background: NAVY2, border: `1px solid ${BORDER}`, borderRadius: 10,
      overflow: "hidden",
    }}>
      {/* 中央ハイライト帯 (選択位置) */}
      <div style={{
        position: "absolute", top: PAD, left: 8, right: 8, height: ITEM_H,
        borderTop: `1px solid ${GOLD}55`, borderBottom: `1px solid ${GOLD}55`,
        background: `${GOLD}11`, borderRadius: 7, pointerEvents: "none", zIndex: 1,
      }} />
      {/* 上下フェード */}
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
        {items.map((it, i) => {
          const active = i === selectedIdx;
          return (
            <div
              key={it.key}
              onClick={() => onChange?.(it.key)}
              style={{
                height: ITEM_H, scrollSnapAlign: "center",
                display: "flex", alignItems: "center", justifyContent: "center",
                cursor: "pointer", userSelect: "none",
                fontSize: active ? 14 : 12,
                fontWeight: active ? 700 : 500,
                color: active ? GOLD : TEXT_MUTED,
                transition: "color .15s, font-size .15s",
              }}
            >
              {it.label}
            </div>
          );
        })}
        <div style={{ height: PAD }} />
      </div>
    </div>
  );
}

// 月ダイヤル (既存 API 維持: months=[{y,m,label}] / value={y,m} / onChange({y,m}))。
// 内部は汎用 DialPicker に委譲 (key = "y-m")。
export default function MonthDialPicker({ months = [], value, onChange }) {
  const items = months.map((mo) => ({ key: `${mo.y}-${mo.m}`, label: mo.label }));
  const valueKey = value ? `${value.y}-${value.m}` : null;
  return (
    <DialPicker
      items={items}
      value={valueKey}
      onChange={(key) => {
        const [y, m] = String(key).split("-").map(Number);
        onChange?.({ y, m });
      }}
    />
  );
}

// =============================================================
// PopoverDial — A/B: コンパクトなチップ + タップで DialPicker を展開するラッパー。
//   既定は「選択中ラベル + ▾」の小さいチップだけ表示。タップでチップ直下に
//   DialPicker をポップアップ。値を選ぶ (タップ/スクロール確定) と閉じてチップに戻る。
//   外側タップでも閉じる (透明 backdrop)。
//
// props: items=[{key,label}] / value=key / onChange(key) / placeholder / width
// =============================================================
export function PopoverDial({ items = [], value, onChange, width = 170, placeholder = "選択" }) {
  const [open, setOpen] = useState(false);
  const current = items.find((it) => it.key === value);
  const label = current ? current.label : placeholder;
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          background: NAVY2, border: `1px solid ${open ? GOLD : BORDER}`, borderRadius: 999,
          padding: "5px 12px", cursor: "pointer", color: GOLD, fontSize: 12, fontWeight: 700,
          whiteSpace: "nowrap",
        }}
      >
        <span>{label}</span>
        <span style={{ fontSize: 9, color: TEXT_MUTED, transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▾</span>
      </button>
      {open && (
        <>
          {/* 外側タップで閉じる透明 backdrop */}
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          {/* チップ直下にダイヤルをポップアップ */}
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 41,
            background: NAVY2, border: `1px solid ${GOLD}55`, borderRadius: 12,
            boxShadow: "0 6px 20px rgba(0,0,0,0.5)", padding: 6,
          }}>
            <DialPicker
              items={items}
              value={value}
              onChange={(key) => { onChange?.(key); setOpen(false); }}
              width={width}
            />
          </div>
        </>
      )}
    </div>
  );
}

// 月用ラッパー (months=[{y,m,label}] / value={y,m} / onChange({y,m}))。PopoverDial に委譲。
export function MonthPopoverDial({ months = [], value, onChange }) {
  const items = months.map((mo) => ({ key: `${mo.y}-${mo.m}`, label: mo.label }));
  const valueKey = value ? `${value.y}-${value.m}` : null;
  return (
    <PopoverDial
      items={items}
      value={valueKey}
      placeholder="月を選択"
      onChange={(key) => {
        const [y, m] = String(key).split("-").map(Number);
        onChange?.({ y, m });
      }}
    />
  );
}
