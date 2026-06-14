import React from 'react'
import ReactDOM from 'react-dom/client'
import { AuthProvider } from './context/AuthContext.jsx'
import AuthGate from './components/AuthGate.jsx'
import './index.css'
import { registerSW } from 'virtual:pwa-register'

// 2026-06-14: PWA 自動更新の確実化。
//   - autoUpdate モード + skipWaiting + clientsClaim は vite.config.js で設定済。
//   - plugin の auto inject は injectRegister:null で停止し、ここで一回だけ明示登録。
//   - iOS PWA は SW の update チェックタイミングが OS スリープに引きずられて遅れ、
//     古いバンドルを掴み続ける症状があるため、明示的に 2 系統で update() を叩く:
//       (a) 60 秒ごとの定期チェック (起動中ずっと走る、低コスト)
//       (b) visibilitychange の visible 復帰時 (バックグラウンド復帰直後にも更新を取りに行く)
//   - autoUpdate のため新 SW 検出時はキャッシュ更新 + ページ自動 reload が走る。
//     onNeedRefresh の手動 UI は不要。
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(swUrl, r) {
    if (!r) return;
    setInterval(() => { r.update(); }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') r.update();
    });
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  </React.StrictMode>,
)
