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
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.ico',
        'apple-touch-icon.png',
        'icon.svg',
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
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
})
