import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sharedDir = path.resolve(__dirname, '../shared-cfo')

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@shared': sharedDir,
    },
  },
  server: {
    port: 5173,
    fs: {
      // 親ディレクトリの shared-cfo を読めるように許可
      allow: [__dirname, sharedDir],
    },
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
      },
      devOptions: {
        enabled: false,
        type: 'module',
      },
    }),
  ],
})
