// プライベートCFO 共通カテゴリ定義
// 既定 9 個は Supabase 側(categories テーブル + handle_new_user トリガ)
// が唯一のソースとなったため、このファイルには配置しない。
// ここに残すのは色・支払方法カラー・定期頻度などの UI 定数のみ。

export const RECUR_OPTIONS = [
  { value: "monthly", label: "毎月" },
  { value: "weekly",  label: "毎週" },
  { value: "yearly",  label: "毎年" },
];

export const COLOR_OPTIONS = [
  "#D4A843", "#2ED8B4", "#E8425A", "#7B6CF6", "#3B9FE5",
  "#F0C040", "#38D47A", "#FF6B8A", "#00D4FF", "#FF8C42",
  "#A78BFA", "#34D399", "#F87171", "#60A5FA", "#FBBF24",
  "#C084FC", "#4ADE80", "#FB923C", "#38BDF8", "#E879F9",
];

export const PAYMENT_COLORS = [
  "#4CAF50", "#2196F3", "#E53935", "#FF9800", "#9C27B0",
  "#00BCD4", "#795548", "#607D8B", "#E91E63", "#FFC107",
  "#3F51B5", "#009688", "#FF5722", "#8BC34A", "#F44336",
];
