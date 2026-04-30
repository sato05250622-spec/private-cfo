# 本番DB操作ルール

## 背景

2026-04-30、本番DB (Supabase project: ovpioztxlhdhwrgukijc) の `budgets` / `week_budgets` テーブル全行が消失するインシデントが発生した。
最も可能性が高い原因は **SQL Editor からの WHERE 句なし DELETE 実行**。
本ルールは、同種の事故を二度と起こさないために設定する。

---

## 鉄則

### 🚫 絶対禁止

以下は本番DBに対して**理由を問わず禁止**:

1. **SQL Editor からの DELETE / UPDATE / TRUNCATE / DROP** 
   - 顧客データに対するこれらの操作はすべて禁止
   - 「ちょっと試したい」「すぐ戻すから」も禁止
2. **WHERE 句なしの DELETE / UPDATE**
   - WHERE が無い、または WHERE が常に true になる条件 (`WHERE 1=1` など) は禁止
3. **ALTER TABLE ... DROP COLUMN / DROP CONSTRAINT**
   - スキーマ変更で既存データが消えうる操作も禁止

### ✅ 許可される操作

- **SQL Editor では SELECT のみ**
- **INSERT / UPDATE / DELETE は、アプリケーションコード経由のみ**
  - つまり顧客アプリ・本部管理画面の正規UIから実行されるもののみ
- **マイグレーション (ALTER TABLE ADD COLUMN 等の追加系) は事前に必ず以下を実施**:
  1. ローカルで dry-run
  2. バックアップが直近24時間以内に存在することを確認
  3. 1テーブルずつ実行、1件ずつ結果確認

---

## 操作前チェックリスト

本番DBに何か実行する前に、毎回自問する:

- [ ] これは SELECT か?
- [ ] SELECT でない場合、それは「絶対禁止」に該当しないか?
- [ ] 該当しない場合、直近24時間以内のバックアップは存在するか?
- [ ] 影響範囲を 1 ユーザー / 1 行に絞れているか?
- [ ] 実行後、即座に結果を確認する手段があるか?

1つでも不安があれば、**実行しない**。

---

## どうしても本番で書き込み操作が必要な場合

例: データ修正、不整合の手動解消など。

### 必須手順

1. **Supabase ダッシュボードで Backups タブを開き、直近のバックアップ時刻を確認**
2. 操作対象を SELECT で先に取得し、影響行数を確認
3. トランザクション内で実行 (`BEGIN; ... ROLLBACK;` でまず確認)
4. 期待通りなら `BEGIN; ... COMMIT;` で本実行
5. 実行後、再度 SELECT で結果確認

### トランザクション例

```sql
BEGIN;

-- 1. 影響範囲を SELECT で確認
SELECT * FROM target_table WHERE id = 'xxx';

-- 2. 実行
UPDATE target_table SET column = 'new_value' WHERE id = 'xxx';

-- 3. 結果確認
SELECT * FROM target_table WHERE id = 'xxx';

-- 4. 問題なければ COMMIT、ダメなら ROLLBACK
ROLLBACK;  -- ← まずはこれで確認
-- COMMIT;  -- ← 確信が持てたらこちらに切り替え
```

---

## 開発フェーズ別のルール

### Phase 進行中 (B-3a / B-3b 等)

- **ローカル DB / Staging プロジェクトで完全に動作確認**してから本番へ
- 本番デプロイは「Vercel が新コードを反映する」のみ。本番DBへのスキーマ変更は別作業として独立に扱う

### マイグレーション実行時

- マイグレーション SQL は git 管理 (`supabase/migrations/` 等)
- 実行前に: バックアップ存在確認 → ローカルで実行 → Staging で実行 → 本番で実行
- 一度に複数のマイグレーションをまとめて流さない

---

## 事故時の対応フロー

万が一、本番でデータ消失や破損が発生した場合:

1. **即座にすべての書き込み操作を停止** (本番デプロイも止める)
2. Supabase Dashboard → Database → Backups で直近バックアップを確認
3. 影響範囲を SELECT で特定 (どのテーブル / どの期間 / どの顧客)
4. Restore 判断:
   - 全体 restore → 「Restore to new project」で別プロジェクトに復元 → 必要データを抽出 → 本番に書き戻し
   - 部分 restore → 別プロジェクト復元後、該当テーブルのみ pg_dump → 本番に restore
5. 顧客への連絡 (テンプレートは別途整備)

---

## バックアップ体制 (2026-04-30 以降)

- **一次**: Supabase Pro 日次自動バックアップ (7日間保持)
- **二次**: GitHub Actions による自前 pg_dump (実装予定)
- **保管場所**: Supabase 側 + private GitHub repo

---

## ルール改訂履歴

- 2026-04-30: 初版作成 (budgets消失インシデントを受けて)
