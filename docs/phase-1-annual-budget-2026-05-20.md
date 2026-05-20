# Phase 1 - 年間予算 月別確定機能 / 参照・復活手順

## 概要
- 機能: 月別確定 + 先月コピー + 確定月赤塗り(本部+顧客)
- 本番 deploy 日: 2026-05-20
- admin commit: 1dbe64d (5 files, +444/-19)
- customer commit: 940b9f3 (4 files, +63/-6)
- 本番 alias: https://private-cfo-app.vercel.app, https://private-cfo-admin.vercel.app

## DB Migration (Supabase production, project ovpioztxlhdhwrgukijc)
ファイル: supabase/migrations/20260520_phase1_settled_months.sql

再適用 SQL (冪等):
ALTER TABLE public.annual_budgets
  ADD COLUMN IF NOT EXISTS settled_months jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS committed_settled_months jsonb NOT NULL DEFAULT '[]'::jsonb;

確認 SQL:
select column_name, data_type, column_default
from information_schema.columns
where table_name = 'annual_budgets'
  and column_name in ('settled_months', 'committed_settled_months');

## 主要ファイル (admin)
- src/utils/annualBudgetSheet.js
  - 純関数: recomputeMonthlyValuesForLine / settleMonthInLines /
    unsettleMonthInLines / copyFromPreviousMonthInLines
  - resolveCell 優先度: override → actuals(確定月) → live集計 → values → null
- src/lib/api/annualBudgets.js: settleMonth / unsettleMonth /
  copyFromPreviousMonth / commitSnapshot 拡張
- src/hooks/useAnnualBudgets.js: 3メソッド露出
- src/pages/AnnualBudgetTab.jsx: 月ヘッダーボタン(確定/取消・先月コピー)
  monthBusy state, isMonthSettled, 確認モーダル, 月セル赤塗り

## 主要ファイル (customer)
- src/lib/api/annualBudgets.js (getCommittedByClient)
- src/hooks/useAnnualBudgets.js (committedSettledMonths camelCase 露出)
- src/components/AnnualBudgetViewer.jsx (確定月赤塗り + 凡例チップ)
- 色: @shared/theme の RED(#FF4757) 使用

## 動作確認(smoke test)
1. 本部アプリで顧客選択 → 支出管理繰越票タブ
2. 任意月の「確定」ボタン押下 → 確認モーダル → 確定済になる
3. 月セルが赤縁/赤背景に変化、← 先月 で前月値コピー(月>1)
4. 「✓確定済」で取消可
5. 「反映」で snapshot 公開 → 顧客アプリで赤塗り表示

## 一時無効化(問題が出た場合)
- UI 側: 確定/コピーボタンを disabled 固定、isSettled 判定を false 固定
- customer: committedSettledMonths を [] フォールバック
- DB は触らない(snapshot 残す)

## DB ロールバック(非推奨、業務利用後は実施しない)
ALTER TABLE public.annual_budgets DROP COLUMN IF EXISTS settled_months;
ALTER TABLE public.annual_budgets DROP COLUMN IF EXISTS committed_settled_months;

## 復活(無効化を解除する場合)
1. UI 側の disabled / [] フォールバック を削除
2. DB カラムは IF NOT EXISTS 付きなので migration 再実行で安全
3. 両アプリ commit + vercel --prod
4. 反映確認: curl で committedSettledMonths バンドルヒット
