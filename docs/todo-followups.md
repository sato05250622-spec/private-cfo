# 別件 ToDo（後日対応）

Phase B-3a で発生した scope 外項目を記録。各項目は独立しているので、優先度順に着手可能。

## 1. L221-225 useLocalStorage rollback breadcrumb 整理
- **場所**: src/App.jsx L221-225
- **内容**: useLocalStorage backup の commented-out 行が残存
- **問題**: L222 の "(Phase 3 で削除予定)" 注記が現状と乖離（Phase 3 完了済）
- **対応**: rollback 安全性が不要と判断した時点で削除 or 注記更新
- **優先度**: 低（動作影響なし、コメントのみ）

## 2. catBudget OK で budgetDraft 更新されない sync 漏れ
- **発生 commit**: ee3967d（phase 2b-1: saveBudgets unreachable）
- **症状**: showBudgetModal 再有効化時に catBudget 確定後 budgetDraft が同期されない
- **対応**: showBudgetModal 再有効化のタイミングで修正必要
- **優先度**: 中（modal 再有効化までは顕在化しない）

## 3. auth context timeout 5000ms console エラー多発
- **症状**: auth context の timeout が 5000ms で console エラーが頻発
- **発生条件**: Phase 2 とは無関係、認証基盤側の問題
- **対応**: timeout 値の見直し or リトライ戦略の検討
- **優先度**: 中（UX 影響あり、ただし機能は動作）
