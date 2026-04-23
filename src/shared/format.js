// プライベートCFO 共通フォーマッタ
// 日付・通貨などの表示整形。

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

export const fmt = (d) =>
  `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS_JA[d.getDay()]})`;

export const fmtMonth = (y, m) => `${y}年${m + 1}月`;

export const toDateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const fmtYen = (n) => `${Number(n || 0).toLocaleString()}円`;
