// =============================================================
// 支出管理繰越表シート 純関数 (顧客アプリ — read-only 用の最小サブセット)
// -------------------------------------------------------------
// 本部 (private-cfo-admin) の src/utils/annualBudgetSheet.js には行構造管理 +
// 集計の純関数群が一式あるが、顧客アプリは閲覧のみのため進捗バーで使う
// sumLineYear だけを同一定義で抜き出して持つ (バンドル肥大防止)。
// =============================================================

/**
 * カテゴリ別 年間合計 (resolveCell 注入型)。
 * 1 行 (= 1 カテゴリ) の 12ヶ月セル値を合算する。
 * cell は { value } オブジェクト / 生の数値の両対応。
 * @param {object} line          - lines 配列の 1 要素
 * @param {(line, month) => any} resolveCellFn - (line, month) => cell
 * @returns {number} 12ヶ月の合計 (値が無い月は 0 換算)
 */
export function sumLineYear(line, resolveCellFn) {
  let sum = 0;
  for (let m = 1; m <= 12; m++) {
    const cell = resolveCellFn(line, m);
    const v = (cell && typeof cell === 'object' && 'value' in cell)
      ? cell.value : cell;
    sum += Number(v) || 0;
  }
  return sum;
}
