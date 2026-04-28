# Git History Rewrite 記念碑 (2026-04-29)

## 背景

PUBLIC repo (https://github.com/sato05250622-spec/private-cfo) の git history に、過去 commit を経由して以下の機微情報が残存していた:

- 顧客名 (`<client_A>` 文字列、86 hits)
- 顧客 UUID partial (`<client_A>` / `<client_self>`、各 2 hits)
- `src/components/AuthGate.jsx` のコメント内に `<client_A> さん` 表記 1 件 (現 HEAD では削除済、history のみ)

2026-04-28 の `dd91e19` で全 file の現状を匿名化済 (UUID/<client_A> → `<client_A>` / `<client_self>` / `<client_A_uuid>`) だが、**git history は不可逆に残る** ため、`git filter-repo` により全コミットを書き換える運用を実施した。

実運用上のリスク (実 token / メアド / service_role key) はゼロ件で、書き換え対象は **顧客プライバシー保護観点のみ**。それでも PUBLIC repo であることから徹底削除を選択。

## 書き換え前の主要 commit hash 一覧 (30 件)

git filter-repo 実行直前 (`dd91e19` HEAD) の `git log --oneline -30` の記録。**これらの hash は filter-repo 後は無効化**される (新しい hash で commit が再発行される)。

過去 plan.md / docs 内で参照していた `bda5165` (B-3a merge) や `aa965f9` (B-3b merge) 等の参照は、本書き換え後は **存在しない hash** になる。本書類が**死後の対応表**として機能する。

```
dd91e19 docs(Phase B-3b): Step 9 後始末 - plan 改訂 (Option A→B) + SW cache memo + 完走
aa965f9 merge: Phase B-3b 段階1 完了（payment_methods / loans Supabase 移行）
d53d88e feat(Phase B-3b): payment_methods / loans の localStorage → Supabase 移行を実装 (Step 5)
baf569a feat(Phase B-3b): setPaymentMethods / setLoans shim を削除 (Step 4-2 phase 3)
c7d5148 feat(Phase B-3b): 7 callsite を hook 直呼び化 (Step 4-2 phase 2)
47b381c fix(Phase B-3b): API 層で空文字列 → null 正規化、smallint cast 防止
fcee153 feat(Phase B-3b): Step 4-1 + 4-2 prep — migration SQL + API 層 + Hook 層
ba08310 docs(Phase B-3b): 今日完走モードに合わせて plan を効率化
f0f4173 docs(Phase B-3b): 24h観察を撤廃、即時リリース方針に改訂（事業判断）
474e996 docs(Phase B-3b): 着手計画を策定
bda5165 merge: Phase B-3a 完了（予算 Supabase 移行）
ae07fea docs: 別件ToDo（B-3a 派生）を記録
5d8ae3f docs(Phase B-3a): 完了記録を追記
01f6795 feat(Phase B-3a): setBudgets / setWeekCatBudgets shim を削除 (Step 4-3 phase 3)
b789d9a feat(Phase B-3a): clear all confirm を hook 直呼び化 (Step 4-3 phase 2b-4)
1b8e03d feat(Phase B-3a): copyLastMonth を hook 直呼び化 (Step 4-3 phase 2b-3)
1cdd6af feat(Phase B-3a): allWeek 一括設定を hook 直呼び化 (Step 4-3 phase 2b-2)
ee3967d feat(Phase B-3a): saveBudgets を hook 直呼び化 (Step 4-3 phase 2b-1, unreachable)
d86ffb2 feat(Phase B-3a): simple 6 callsite を hook 直呼び化 (Step 4-3 phase 2a)
595ada2 feat(Phase B-3a): App.jsx を useBudgets に切替 (Step 4-3 phase 1)
56a0c12 feat(Phase B-3a): budgets Hook 層追加 (Step 4-2)
389b947 feat(Phase B-3a): budgets API 層追加 (Step 4-1)
c215887 docs(Phase B-3a): Step 3 (DB 検証) 完了を記録
926d635 docs(Phase B-3a): week_budgets コメント追加をバックログ化
09121ff feat(Phase B-3a): budgets テーブル DDL ファイル作成
b4f54ad docs(Phase B-2): B-3a DDL ファイル番号を 004 → 006 に繰り上げ
1dfc923 docs(Phase B-2): スキーマ設計書 + migrations/ 整備
030aa34 fix: viewport sizing for all iPhone variants
97f2f6f feat: zero-budget category shows percent and negative remaining
c9484b8 fix: month summary modal cut off by iOS home indicator
```

## 重要 milestone (旧 hash)

| マイルストーン | 旧 hash | 内容 |
|---|---|---|
| **B-3b Step 9 (本書直前 HEAD)** | `dd91e19` | plan 改訂 r3 + SW cache memo + 匿名化、本日 0:00 push 済 |
| **B-3b 段階1 merge** | `aa965f9` | feat/phase-b-3b-payments-loans → main (--no-ff) |
| **B-3a merge** | `bda5165` | feat/phase-b-3a-budgets → main (--no-ff) |
| **B-2 設計書 commit** | `1dfc923` | DB スキーマ設計書 + migrations/ 整備 |

## filter-repo 書き換え実施内容

```sh
git filter-repo --replace-text <(printf '<client_A>==><client_A>\n<client_A>==><client_A>\n<client_self>==><client_self>\n')
```

置換ルール:

| 旧 | 新 |
|---|---|
| `<client_A>` (任意位置) | `<client_A>` |
| `<client_A>` (任意位置) | `<client_A>` |
| `<client_self>` (任意位置) | `<client_self>` |

## 影響と注意

- **commit hash 全変動**: 上記 30 件すべて新 hash に再発行。書き換え後は旧 hash で `git show` 不可
- **git reflog で 30 日間は旧 hash 参照可能** (ローカルのみ): `cp -r private-cfo-app private-cfo-app.bak.20260429` で完全バックアップ済
- **過去 plan.md / 改訂履歴 / commit message 内の hash 参照** は無効化される (例: B-3b plan の改訂履歴に書いた `bda5165` 等)
- **PR / Issue / 外部参照**: 現状なし、影響範囲ローカル + GitHub origin のみ
- **Vercel 連携**: CLI deploy のため Git 連携ゼロ、影響なし
- **admin リポジトリ**: GitHub remote ゼロ + 機微情報 0 hits、書き換え対象外

## 書き換え後の検証ログ (filter-repo 実行後に追記)

```
[実行日時] 2026-04-29 __:__ JST
[git-filter-repo version] ____________
[before commit count] 30
[after commit count] ____
[書き換え後の HEAD hash] ____________

[grep 検証 (すべて 0 hits 期待)]
- <client_A> (case-insensitive): __ hits
- <client_A> (full UUID): __ hits
- <client_A> (partial): __ hits
- <client_self> (full UUID): __ hits
- <client_self> (partial): __ hits
- <client_A>0324@gmail.com: __ hits

[force push 結果]
- git push origin --force --all: ____________
- git push origin --force --tags: ____________

[特記事項]
- ____________
```

## 関連

- `docs/todo-followups.md` #5 (PUBLIC repo 過去 commit 監査) → 本作業で close
- 監査 grep の hit 内訳は会話ログ (Step 0-1) を参照
