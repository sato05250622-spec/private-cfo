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

## 4. PWA Service Worker キャッシュによる新デプロイ反映遅延
- **症状**: Vercel deploy 後、本番 URL を開いても旧バンドルが serve され続ける
- **再現条件**: `vite.config.js` で `registerType: 'autoUpdate'` + `skipWaiting: true` + `clientsClaim: true` でも、初回再アクセス時に発生 (workbox 設定だけでは防げない)
- **発生例**: B-3b Step 7 動作確認時、deploy 直後に migrate ログが出ない症状で発覚
  → hard reload (Cmd+Shift+R) で migrate 走り直し → 9 必須項目 PASS
- **回避策**:
  - hard reload (Cmd+Shift+R) で旧 bundle を bypass
  - DevTools → Application → Service Workers → Unregister → リロード
  - 本番運用では deploy 直後ユーザーに「リロード推奨」周知
- **対応案** (将来検討):
  - `registerType: 'prompt'` に変更してユーザー明示の更新適用に切替 (即時性 vs 安定性のトレードオフ)
  - `skipWaiting` に加えて update-prompt UI を実装
- **優先度**: 低 (機能は動作、回避策あり、本番ユーザー周知で当座 OK)

## 5. PUBLIC repo の過去コミット監査
- **背景**: 本リポジトリは PUBLIC 設定。今後の commit は匿名化済 (本 commit 以降) だが、**過去 commit に機微情報が残っている可能性**あり
- **監査対象** (git log --all -p / git grep --all で確認):
  - 顧客名 (例: 旧文書中の `<client_A>` 等の文字列)
  - UUID 平文 (`[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}` パターン)
  - メールアドレス (`@gmail.com` 等)
  - Supabase service_role key / API key 等の機密 token
  - `cfo-backup-*.csv` の commit 漏れ (現状 `.gitignore` で `backups/` は除外されているが、Desktop 直下の手動 dump は別経路)
- **対応**:
  - `git log --all --oneline -p | grep -E "<client_A>|@gmail\.com|<uuid pattern>|service_role"` で機微情報を検出
  - 必要なら `git filter-repo` (or `bfg-repo-cleaner`) で history を書き換え + force push
  - `.gitignore` の網羅性を再点検 (Desktop 直下の手動 backup file 名パターンも追加検討)
- **優先度**: 中 (Phase C 着手前に実施推奨)
- **着手時期**: 翌朝 Phase C 着手前 (本日完走スコープ外)
