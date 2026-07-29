import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      // shared-cfo から同期した資産を src/shared 配下に置き、
      // Vercel 等のビルド環境で親ディレクトリへ辿らずとも解決できるようにする。
      // 元ソースは Desktop/shared-cfo リポジトリ。同期は手動コピー運用。
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          // supabase-js は起動時に eager import されるため初回ロードで取得されるが、
          // アプリコードと分離しておくことでデプロイ間のブラウザキャッシュ効率を上げる。
          supabase: ['@supabase/supabase-js'],
          // recharts はあえて manualChunks で固定しない。固定すると Vite が index.html に
          // modulepreload を挿入し初回ロードで先読みされてしまうため、自動コード分割に任せて
          // (DashboardCharts / AssetSheetViewer の dynamic import 経由の共有 async チャンク)、
          // チャート表示時に初めて取得されるようにする。
        },
      },
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 2026-06-14: plugin の auto inject を止めて src/main.jsx の手動 registerSW に一本化
      //   (二重登録防止 + 定期/復帰時 update チェックを差し込めるようにする)。
      injectRegister: null,
      includeAssets: [
        'favicon.ico',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'apple-touch-icon.png',
      ],
      manifest: {
        name: 'プライベートCFO',
        short_name: 'CFO',
        description: '高所得者向け支出管理サービス',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#0A1628',
        theme_color: '#0A1628',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        // デプロイ後の最初のリロードで即新コードに切替えるための 2 設定。
        // これがないと「autoUpdate」モードでも新 SW が install 後 waiting に留まり、
        // ユーザーがタブを完全に閉じない限り旧バンドルが serve され続けていた。
        skipWaiting: true,   // 新 SW が install 後すぐ active 化
        clientsClaim: true,  // 既に開いているクライアントも新 SW の制御下に取り込む
        // 2026-07-29: Google Fonts (Noto Sans JP) を SW キャッシュ対象に追加。
        //   globPatterns はビルド成果物のみを precache するため、クロスオリジンの
        //   fonts.googleapis.com / fonts.gstatic.com は従来 SW を素通りして毎回
        //   ネットワークへ出ていた (index.html の render-blocking と合わせて起動を遅延)。
        //   - CSS (googleapis): StaleWhileRevalidate = キャッシュから即返しつつ裏で更新
        //   - フォント本体 (gstatic): CacheFirst = 実質不変なのでネットワークに出ない
        //   statuses に 0 を含めるのは opaque レスポンスも保存するため (workbox 標準レシピ)。
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
})
