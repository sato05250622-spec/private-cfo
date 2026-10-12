// =============================================================
// カテゴリの表示色 (2026-10-12)。本部アプリ・顧客アプリで同じ内容を持つ。
//   隣り合うカテゴリが似た色にならないよう、色相環で反対側の色を交互に並べた 12 色。
//   (青↔オレンジ、緑↔マゼンタ、黄↔紫、シアン↔赤、黄緑↔すみれ、緑青↔ピンク)
//   NAVY #0D1E36 背景に対するコントラスト比は 5.7〜12.0 (文字にも使える明度)。
//   DB の categories.color・カテゴリ ID は変更しない。表示時に並び順 (sort_order) で割り当てるだけ。
//   元の保存色は storedColor に残す (編集保存で保存色を書き換えないため)。
// =============================================================
export const CATEGORY_PALETTE = [
  "#60A8FB", // 青
  "#FA9938", // オレンジ
  "#2FDA76", // 緑
  "#F471CD", // マゼンタ
  "#F4DB34", // 黄
  "#B98EF6", // 紫
  "#20CFDF", // シアン
  "#F76964", // 赤
  "#91D742", // 黄緑
  "#D68BEE", // すみれ
  "#26D99D", // 緑青
  "#F877A2", // ピンク
];

export function categoryDisplayColor(index) {
  const i = Number.isInteger(index) && index >= 0 ? index : 0;
  return CATEGORY_PALETTE[i % CATEGORY_PALETTE.length];
}

// 並び順 (sort_order → 作成日時 → 元の並び) で表示色を割り当てた新しい配列を返す。配列の並び自体は変えない。
//   sortKey: 行オブジェクトの並び順キー名 (顧客アプリ 'sortOrder' / 本部 'sort_order')。
export function withCategoryDisplayColors(list, sortKey = "sortOrder") {
  const arr = Array.isArray(list) ? list : [];
  const order = arr
    .map((c, i) => ({ i, s: Number(c?.[sortKey]), t: String(c?.created_at ?? c?.createdAt ?? "") }))
    .sort((a, b) => {
      const sa = Number.isFinite(a.s) ? a.s : 0, sb = Number.isFinite(b.s) ? b.s : 0;
      if (sa !== sb) return sa - sb;
      if (a.t !== b.t) return a.t < b.t ? -1 : 1;
      return a.i - b.i;
    });
  const rank = new Array(arr.length);
  order.forEach((o, r) => { rank[o.i] = r; });
  return arr.map((c, i) => (c && typeof c === "object"
    ? { ...c, storedColor: c.storedColor ?? c.color, color: categoryDisplayColor(rank[i]) }
    : c));
}
