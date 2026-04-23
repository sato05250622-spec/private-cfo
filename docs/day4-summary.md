# Day 4 サマリ — 2026-04-23

Day 2 で定義したスキーマ 7 テーブルのうち残っていた **notifications / inquiries / appointments** を
顧客アプリ側から接続し、Supabase との実データ連携を完成させた日。
これで「client から見える / client が触れる」という観点での Supabase 連携は一通り揃った。

## コミット一覧

```
517ea65  Day 4 Phase 3: 面談予定 reschedule request to appointments
05e2d84  Day 4 Phase 2: お問い合わせ posts to inquiries
49044a5  Day 4 Phase 1: telop fetches from notifications
```

## 達成事項(Phase 別)

### Phase 1 — notifications テロップ(`49044a5`)

**実装内容**
- `src/lib/api/notifications.js`:`listLatestTelop(clientId)` — `kind='telop'` の最新 1 行を取得
- `src/hooks/useNotifications.js`:`useLatestTelop()` — `body`(取得できなければ null)/ loading / refetch を返す read-only フック
- `src/App.jsx` 差分 4 点:
  - `useLatestTelop` import
  - module-top `FALLBACK_TELOP` 定数(旧 `TELOP_TEXT` の文言を移植)
  - コンポーネント内で `const telopText = telopBody ?? FALLBACK_TELOP`
  - L1648 の `<span>{TELOP_TEXT}</span>` → `{telopText}`

**Step A 実行(SQL)**:全 profiles に 1 行ずつ telop INSERT(2 行、admin + test-client)

**動作確認**
- C-1 ✅:初期表示で DB 文言が流れる
- C-2 ✅:admin が `UPDATE ... set body=...` → F5 で新文言に差し替え
- C-3:スキップ(オフラインだと localhost 自体が落ちるため、フォールバック分岐はコードレビューで確認)

**UI / アニメーション / `showTelop` トグルは無改変**。

---

### Phase 2 — inquiries 顧客→本部問い合わせ(`05e2d84`)

**実装内容**
- `src/lib/api/inquiries.js`:`listInquiries`(履歴用、Phase 2 では未使用)/ `insertInquiry`
- `src/hooks/useInquiries.js`:`useInquiries()` — `submitting` / `error` / `sendInquiry(contactType, contactText)` を返す
  - body は `"[inquiry|bug|request|other] <text>"` 形式に整形(admin 側は `where body like '[bug]%'` で種別抽出)
  - `sendInquiry` は Promise<boolean>(throw しない設計で呼び出し側の .catch 不要)
- `src/App.jsx` 差分 3 点:
  - `useInquiries` import
  - `contactSent` 宣言の直下で hook 呼び出し
  - L1424 送信ボタンを `async onClick` + `disabled` + alert 対応に書き換え
  - 既存の `contactSent ?` 完了画面・「メニューに戻る」ボタン・UI 構造は無改変

**Step A 実行(SQL)**:既存行確認 SELECT(0 行)のみ、CREATE 不要

**動作確認**
- C-1 ✅:正常送信 → 完了画面
- C-2 ✅:DB に body プレフィクス付き 1 行、`status='open'` / `created_at` デフォルト動作
- C-3 ✅:4 種別(inquiry / bug / request / other)すべてプレフィクス確認
- C-4 ✅:連打防止(3 連打で DB 1 行)
- C-5 ✅:オフライン alert + `contactText` 保持

---

### Phase 3 — appointments 面談予定(`517ea65`)

**実装内容**
- `src/lib/api/appointments.js`:`getNextAppointment`(未来の `scheduled/confirmed/reschedule_requested` 最新 1 件)/ `requestReschedule`
- `src/hooks/useAppointments.js`:`useNextAppointment()` — `appointment` / loading / submitting / refetch / `requestReschedule(newLocalDateTime, reason)` を返す
  - UPDATE で送るのは **`status` / `requested_at` / `request_reason` の 3 列のみ**(他の列は一切送らない = 意図しない改竄の封じ込め)
  - datetime-local → `new Date(localStr).toISOString()` で UTC 変換
  - 成功時に `refetch()` 自動実行(UI が reschedule_requested 状態に遷移)
- `src/components/AppointmentCard.jsx`(新規独立ファイル、自己完結コンポーネント):
  - ヘッダ + 予定カード + ボトムシートモーダル(datetime-local + textarea + 送信)
  - status 別 UI 分岐:`scheduled`(通常予定バッジ)/ `confirmed`(確定済バッジ)/ `reschedule_requested`(🟡 変更希望中バッジ + 希望日時 + 理由表示、ボタン非表示)/ 予定なし(🤝 アイコン + 案内文)
  - LogoutButton と同じ「自己完結コンポーネントは別ファイル」方針
- `src/App.jsx` 差分 3 点:
  - `AppointmentCard` import
  - `menuGroups` のトップに `{ icon:"🤝", label:"面談予定", action:()=>setMenuScreen("appointment") }` 追加
  - `if (menuScreen === "appointment") return <AppointmentCard onBack={...}/>` ルートを `contact` 分岐の直前に追加

**Step A 実行(SQL)**:全 profiles に `now() + interval '1 day'` で 1 行ずつ予定 INSERT

**動作確認**
- C-1 ✅:メニュー → 🤝 面談予定 で予定カード表示、通常予定バッジ、変更ボタン
- C-2 ✅:変更希望モーダル → 日時 + 理由送信 → 自動で reschedule_requested 状態に切替、希望内容下段表示
- C-3 ✅:DB 検証で `status='reschedule_requested'` / `requested_at` UTC ISO / `request_reason` 正しい値、`scheduled_at` / `duration_min` / `created_by` は不変
- C-4 / C-5:スキップ

---

## Day 4 で新規作成されたファイル

```
src/
├─ lib/api/
│  ├─ notifications.js     [Phase 1] listLatestTelop
│  ├─ inquiries.js         [Phase 2] listInquiries / insertInquiry
│  └─ appointments.js      [Phase 3] getNextAppointment / requestReschedule
├─ hooks/
│  ├─ useNotifications.js  [Phase 1] useLatestTelop
│  ├─ useInquiries.js      [Phase 2] useInquiries
│  └─ useAppointments.js   [Phase 3] useNextAppointment
└─ components/
   └─ AppointmentCard.jsx  [Phase 3] 自己完結の面談予定画面
```

Day 3 + Day 4 合わせて、3 層アーキテクチャ(`api/*` 薄ラッパ → `hooks/use*` 状態 + adapter → 画面)で
expenses / categories / points / notifications / inquiries / appointments の 6 機能が揃った。

## 各テーブルの client 側書き込みパターン

| テーブル | SELECT | INSERT | UPDATE | DELETE | 送信するカラム |
|---|---|---|---|---|---|
| `profiles` | ✅ 自分の行のみ | (trigger のみ) | — | — | — |
| `expenses` | ✅ 自分の client_id | ✅ 自分の client_id | ✅ 自分の行 | ❌(soft delete のみ) | date / amount / category / memo / payment_method / is_recurring / recur_id(INSERT)+ `deleted_at`(soft delete UPDATE) |
| `categories` | ✅ 自分の client_id | ✅ 自分の client_id | ✅ 自分の行 | ✅ 自分の行 | label / icon_key / color / sort_order(client_id は `delete patch.client_id` で除外) |
| `notifications` | ✅ 自分の client_id | ❌ | (read_at 用途、Day 4 未使用) | ❌ | — |
| `inquiries` | ✅(Day 4 では未使用) | ✅ 自分の client_id | ❌(ポリシーなし) | ❌ | `client_id` + `body`(プレフィクス付き) |
| `points_ledger` | ✅ 自分の client_id | ❌ | ❌ | ❌ | — |
| `appointments` | ✅ 自分の行 | ❌(ポリシーなし、admin のみ) | ✅ 自分の行 | ❌ | `status` / `requested_at` / `request_reason` の 3 列のみ |

※ `points_balances` ビューは `security_invoker=true` なので呼び出し元の RLS(client SELECT ポリシー)が継承される。

## トライアル開始時点での「client から触れる状態にあるが、admin 側の書き手が未接続」な UI

以下は顧客アプリでは表示できる・送れるが、**admin アプリがまだ無いため本部側の応答が手動運用**になっている箇所。
Day 5 で admin アプリを接続するときの優先順位の参考。

| 機能 | 顧客 UI | admin 側に必要なもの | 現状の運用 |
|---|---|---|---|
| テロップ | 表示のみ(最新 1 件 + フォールバック) | 本文編集 UI、ブロードキャスト投稿 UI | admin が SQL Editor で `UPDATE` or `INSERT`(N 行挿入方式) |
| ポイント残高 | 残高 + 履歴表示 | 付与 / 取消 UI(`points_ledger` INSERT) | admin が SQL Editor で `INSERT` |
| 問い合わせ | 送信のみ | **受信ボックス UI / 返信入力 / status 変更** | admin が SQL Editor で `UPDATE ... replied_body=...`、顧客側は返信を読む画面が未実装 |
| 面談予定 | 次回 1 件表示 + 変更希望送信 | 予定作成 / status 変更(scheduled → confirmed → completed)/ キャンセル UI | admin が SQL Editor で `INSERT` と `UPDATE status`、作成・確定を手動運用 |
| 代行入力 | 顧客画面に「本部入力」バッジ描画ロジック実装済 | admin が他 client_id で expenses を INSERT する UI | admin が SQL Editor で `INSERT`、`entered_by=admin_id` / `client_id=顧客id`(Phase 5 で実地検証未完) |
| PDF 送付 | 「Supabase連携後に本部から送付されます」プレースホルダのまま | PDF 生成 + アップロード + 送付 UI(`pdf_documents` テーブルもまだ無い) | Phase 2(5/10)スコープ |

加えて、**admin アプリなしでは機能しないが client UI も持っていない**もの:
- 顧客側の問い合わせ履歴画面(Day 4 Phase 2 では送信のみで履歴未実装)
- 面談履歴(過去の completed 予定の振り返り)
- 通知センター(`kind='notice'` 使うなら)

## 現状 Supabase に接続されていない client ローカル機能(想定内)

`cfo_*` プレフィクスの localStorage に残している。トライアル初期は DB に載せない判断:

- `cfo_budgets` / `cfo_weekBudgets` / `cfo_weekCatBudgets`(予算設定)
- `cfo_paymentMethods`(支払方法)
- `cfo_loans`(定期引き落とし)
- `recurringList`(定期支出、in-memory のみ)

端末跨ぎ同期や admin からの可視化が要望として出たら Phase 1 以降で着手。

## Day 5(admin アプリ接続)時の注意点

1. **admin176.jsx の扱い** — 次セッションの起点は `admin176.jsx`(本部アプリの種)。`Desktop/admin175-project/`(Day 2 調査で Vite テンプレ空のまま)と、ホーム直下 `kakeibo/src/admin176.jsx`(CLAUDE.md の「near-duplicate backup」の 1 つ)のどちらをベースにするか冒頭で方針決定。
2. **service_role key は絶対に admin クライアントバンドルに入れない**
   - `VITE_` プレフィックスの変数は必ずブラウザに出荷される
   - 本部側も anon key + admin ロールの profile で運用する(RLS の `is_admin()` で全権が効く)
   - どうしても service_role が要る処理(例:顧客招待の `inviteUserByEmail`)は Supabase Edge Functions or バックエンド経由
3. **admin ロール昇格の運用**
   - 現在は Dashboard → Table Editor で手動 `role='admin'` 書き換え
   - 本部メンバーが複数人になる前提なので、将来 admin-of-admins(= super admin)が同 UI で昇格できる仕組みが要る
4. **RLS 動作確認**:admin アプリから読み書きして、policies `*_admin_all` が全テーブルで期待どおり全権を返すか 2 ブラウザで追試(Day 3 Phase 5 で client 側は確認済、admin 側は未)
5. **代行入力時の `entered_by`**:`entered_by = auth.uid()`(= admin)、`client_id = 対象顧客の uuid`。顧客アプリ側の `useExpenses.toApp` が `isProxyEntry` を生成し「本部入力」バッジを出す(Day 3 Phase 2 実装、admin 代行の実地確認は Day 5 でまとめて)
6. **通知ブロードキャスト**:admin UI で「全顧客にテロップ配信」を押したら `profiles` を全 SELECT → N 行 `notifications` INSERT。Day 4 Phase 1 は顧客 1 人あたり 1 行が正しく SELECT されることは確認済。
7. **appointments の admin 側ステートマシン**:
   - 作成: `status='scheduled'`
   - 顧客変更希望着: `status='reschedule_requested'` を拾う
   - 応答: `status='confirmed'` に戻す(`scheduled_at` を `requested_at` 値で上書きするか、予定自体は変えず確認だけ返すかは業務フロー次第)
   - キャンセル: `status='cancelled'`
   - 実施後: `status='completed'`
8. **2 アプリで `shared-cfo` を共有**
   - 顧客アプリの `vite.config.js` は `@shared` alias 済
   - admin 側も同じ `resolve.alias` + `server.fs.allow: [..]` を設定
   - 色・アイコン・フォーマッタを両方の UI で一致させる
   - 破壊的変更時は両アプリでビルド確認
9. **categories の admin ビュー**
   - `admin is_admin()` で全顧客のカスタムが見える
   - 「顧客 A のカテゴリを編集」のような画面では `client_id` 絞り込みを忘れない(admin が意図せず他顧客に波及させない)
10. **Day 5 開始前に確認すること**
    - `docs/todo.md` の UI 3 項目を Day 5 の合間に消化するか、Day 6 以降に回すか
    - Phase 5 Part D/E/F(代行入力バッジ実地確認 / points フロー / ログアウト再ログイン)は admin アプリができた時に一気に回収
