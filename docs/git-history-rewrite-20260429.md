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

## 書き換え後の検証ログ

実行結果:

| 項目 | 値 |
|---|---|
| 実行日時 | 2026-04-29 01:00 JST 頃 (徹夜モード Phase D 着手前作業) |
| git-filter-repo version | 2.47.0 (brew install via homebrew) |
| 実行 command | `git filter-repo --force --replace-text <rules>` |
| before commit count | 30 (main brranch 上の旧 HEAD 時点) |
| after commit count | 30 (filter-repo は commit 数を変えない) |
| 書き換え後の HEAD hash | `f5160b0` (旧: `32489b1`) |
| 処理時間 | New history written in 0.29 seconds + 0.41 seconds repacking |

grep 検証 (post-rewrite、置換対象すべて 0 hits 確認):

| 検証項目 | hit 数 | 判定 |
|---|---|---|
| 顧客 A の handle 名 (case-insensitive grep) | 0 | ✅ |
| 顧客 A の UUID full (36 文字、ハイフン込み) | 0 | ✅ |
| 顧客 self の UUID full (36 文字、ハイフン込み) | 0 | ✅ |
| 顧客 A の UUID partial (頭 8 文字 hex) | 0 | ✅ |
| 顧客 self の UUID partial (頭 8 文字 hex) | 0 | ✅ |
| 顧客 A の email (`@gmail.com` 形式) | 0 | ✅ |

※ 検証で grep した実際の文字列は filter-repo の置換ルール元 (`OLD==>NEW` 形式) の OLD 列。本書では機微情報を git history に再導入しないため、具体名・UUID 値を伏せる (= 検証時の grep 文字列は会話ログ + ローカル `.bak.20260429` 内 doc を参照可)。

force push 結果 (4 branches すべて成功):

| branch | 旧 hash → 新 hash | 結果 |
|---|---|---|
| main | `32489b1` → `f5160b0` | forced update ✅ |
| feat/phase-a-auth-gate | `35f1ff4` → `9eafc43` | forced update ✅ |
| feat/phase-b-3a-budgets | `ae07fea` → `2dc545c` | forced update ✅ |
| feat/phase-b-3b-payments-loans | (旧 origin になし) → `60d4a95` | new branch ref ✅ |

`git push origin --force --tags`: Everything up-to-date (tag 不在のため変更なし)。

## 旧 → 新 hash 完全対応表

過去 plan.md / docs / commit message 内で参照していた旧 hash の翻訳表。

| マイルストーン | 旧 hash | 新 hash |
|---|---|---|
| Memorial doc (filter-repo 対象自身) | `32489b1` | `f5160b0` |
| B-3b Step 9 (filter-repo 直前 HEAD) | `dd91e19` | `ab11fb9` |
| B-3b 段階1 merge | `aa965f9` | `b347322` |
| B-3b Step 5 (migrate) | `d53d88e` | `60d4a95` |
| B-3b phase 3 (shim 削除) | `baf569a` | `0f37a44` |
| B-3b phase 2 (callsite 置換) | `c7d5148` | `da702aa` |
| B-3b smallint fix | `47b381c` | `5c0124f` |
| B-3b prep (4-1+4-2) | `fcee153` | `c76f6ac` |
| B-3b plan 効率化 r2 | `ba08310` | `3e62b22` |
| B-3b plan 24h 撤廃 | `f0f4173` | `687132c` |
| B-3b plan ドラフト | `474e996` | `925bf47` |
| B-3a merge | `bda5165` | `3d50854` |
| B-3a 別件 ToDo | `ae07fea` | `2dc545c` |
| B-3a 完了記録 | `5d8ae3f` | `3e85c41` |
| B-3a phase 3 (shim 削除) | `01f6795` | `563d328` |
| B-3a phase 2b-4 (clear all) | `b789d9a` | `b1998bb` |
| B-3a phase 2b-3 (copyLastMonth) | `1b8e03d` | `02cbba0` |
| B-3a phase 2b-2 (allWeek) | `1cdd6af` | `e651d07` |
| B-3a phase 2b-1 (saveBudgets) | `ee3967d` | `4150e37` |
| B-3a phase 2a (simple 6) | `d86ffb2` | `7bdf1ad` |
| B-3a phase 1 (useBudgets 切替) | `595ada2` | `4b25eea` |
| B-3a Hook 層 | `56a0c12` | `688a302` |
| B-3a API 層 | `389b947` | `7ec87c5` |
| B-3a Step 3 完了記録 | `c215887` | `6e375dc` |
| B-3a backlog | `926d635` | `c3c54bc` |
| B-3a DDL ファイル作成 | `09121ff` | `b4eca27` |
| B-3a DDL 番号繰上げ | `b4f54ad` | `65ae16d` |
| B-2 設計書 | `1dfc923` | `9f7aeb7` |
| (filter-repo 対象外、不変) | `030aa34` | **`030aa34`** |
| (同上、不変) | `97f2f6f` | **`97f2f6f`** |
| (同上、不変) | `c9484b8` | **`c9484b8`** |

末尾 3 件 (`030aa34`/`97f2f6f`/`c9484b8`) は filter-repo の対象文字列を含まなかったため hash 不変 = 整合性確認の証拠。

## self-replacement 現象について

本書 (`docs/git-history-rewrite-20260429.md`) は filter-repo 実行**直前**に commit (旧 `32489b1`) したため、filter-repo は本書の中身も書き換え対象とした:

- 「背景」セクションで使用していた**置換ルール元 OLD 文字列** (顧客名 / UUID partial × 2) → 対応する `<client_A>` `<client_A>` `<client_self>` placeholder に self-replace
- 「filter-repo 書き換え実施内容」の置換ルール表自体 → ルールが自己参照的に置換 (元の `OLD==>NEW` 形式が、現在は `<client_A>==><client_A>` 等の OLD = NEW 縮退表示)
- 上記「30 件 hash 一覧」の hash 列 → 該当文字列を含まないため**不変**

これは予期された副作用。記念碑としての価値 (旧 hash 一覧 + マイルストーン対応表) は保持されている。git history に機微情報を再導入しないため、本書では原 OLD 文字列を literal で記述しない (= 「顧客 A の handle 名」「UUID partial」等の generic 表現に統一)。OLD 文字列の具体値が必要な場合はローカルバックアップ `~/Desktop/private-cfo-app.bak.20260429` 内の同名ファイルを参照。

## 関連

- `docs/todo-followups.md` #5 (PUBLIC repo 過去 commit 監査) → 本作業で **close**、本書が正式記録
- 監査 grep の hit 内訳は会話ログ (Step 0-1) を参照
- バックアップ: `~/Desktop/private-cfo-app.bak.20260429` (force push 前の完全 snapshot、182MB、削除可否は別途判断)
