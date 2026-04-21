# private-cfo-app

高所得者向け支出管理サービス「プライベートCFO」の **顧客アプリ**。

## 出自

`Desktop/kakeibo`(localStorage 版 MVP)をベースに、Supabase 認証・DB を追加して顧客アプリ化。
共有資産(色・アイコン・カテゴリ・フォーマッタ)は `Desktop/shared-cfo` から import。

## スタック

- React 18 + Vite 5
- Supabase (Auth + Postgres + RLS)
- recharts
- react-router-dom(ログインゲート用)
- vite-plugin-pwa

## セットアップ

```bash
npm install
cp .env.local.example .env.local   # Supabase URL / anon key を記入
npm run dev
```

## 必要な環境変数

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

招待発行は本部アプリ(`Desktop/admin175-project`)から行う。
本アプリにサインアップ画面はない — ログインのみ。

## スクリプト

- `npm run dev` — Vite dev server(ホスト公開)
- `npm run build` — 本番ビルド(`dist/`)
- `npm run preview` — ビルド結果の確認

## ディレクトリ

```
private-cfo-app/
├─ public/              # PWA アイコン等
├─ src/
│  ├─ main.jsx
│  ├─ App.jsx           # 現状は kakeibo 由来の 1878 行。段階的に分割予定
│  ├─ index.css
│  ├─ lib/              # Day 2 追加: supabaseClient, api/*
│  ├─ hooks/            # Day 2 追加: useAuth, useTransactions
│  ├─ context/          # Day 2 追加: AuthContext
│  └─ pages/            # Day 2 追加: LoginPage
├─ supabase/
│  └─ schema.sql        # Day 2 追加
├─ vite.config.js
├─ CONCEPT.md
└─ README.md
```

## 共有資産(`@shared/*`)

- `@shared/theme`      — ネイビー×ゴールドの色定数
- `@shared/icons`      — SVG アイコン 101 個
- `@shared/categories` — デフォルト支出カテゴリ・カラーパレット
- `@shared/format`     — 日付・通貨フォーマッタ

alias は `vite.config.js` の `resolve.alias` で `../shared-cfo` に解決。
`server.fs.allow` でも親ディレクトリを許可している。

## 設計メモ

- `App.jsx` は現状 1878 行。Day 3 以降で `pages/` に段階分割
- localStorage キー(`kakeibo_*`)は Day 3 で `cfo_*` に改名 + Supabase へ移行
- 「テロップ」「ポイント」「問い合わせ」「PDF 送付」UI は `kakeibo` 由来で既に実装済み。Day 3-4 で Supabase 接続
- 本部アプリ側で挿入された `transactions`(`entered_by != client_id`)は「本部入力」バッジで区別表示予定
