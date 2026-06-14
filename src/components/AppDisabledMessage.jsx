import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

// 2026-06-14: アプリ全体停止画面 (profiles.app_enabled === false のとき表示)。
//   AuthGate が approved 通過後にこの分岐へ振る (承認ゲートとは独立した別ゲート)。
//   PendingApprovalMessage と同構造・同デザインで雛形を維持。
//   - 再読み込み: 本部が再開したら手動で復帰できるよう window.location.reload()
//     (realtime/postgres_changes 禁止のため自動復帰はしない)。
//   - ログアウト: 既存 useAuth().signOut を使用 (PendingApprovalMessage と同方式)。

const S = {
  wrap: {
    minHeight: '100dvh', background: NAVY,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24,
  },
  card: {
    width: '100%', maxWidth: 380,
    background: CARD_BG, borderRadius: 16,
    border: `1px solid ${BORDER}`, boxShadow: SHADOW,
    padding: '32px 24px', textAlign: 'center',
  },
  brand: {
    fontSize: 11, color: GOLD, letterSpacing: '0.22em',
    marginBottom: 6, fontWeight: 600,
  },
  title: { fontSize: 18, color: TEXT_PRIMARY, fontWeight: 700, marginBottom: 16 },
  icon: { fontSize: 48, marginBottom: 12 },
  body: {
    fontSize: 13, color: TEXT_SECONDARY,
    lineHeight: 1.8, marginBottom: 20,
  },
  emailBox: {
    background: NAVY2, border: `1px solid ${BORDER}`,
    borderRadius: 8, padding: '10px 14px', marginBottom: 20,
    fontSize: 12, color: TEXT_PRIMARY,
    wordBreak: 'break-all',
  },
  reloadBtn: (busy) => ({
    width: '100%', padding: '12px',
    background: GOLD_GRAD, color: '#0A1628',
    border: 'none', borderRadius: 28,
    fontSize: 14, fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    boxShadow: `0 4px 24px ${GOLD}44`,
    opacity: busy ? 0.6 : 1,
    marginBottom: 12,
  }),
  logoutBtn: {
    width: '100%', padding: '10px',
    background: 'transparent', color: RED,
    border: `1px solid ${RED}55`, borderRadius: 24,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
  note: {
    marginTop: 18, fontSize: 10, color: TEXT_MUTED,
    lineHeight: 1.6,
  },
};

export default function AppDisabledMessage() {
  const { user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);

  const onReload = () => {
    if (busy) return;
    setBusy(true);
    // 本部が app_enabled=true に戻したら、リロードで再フェッチ→通常 App に復帰する。
    window.location.reload();
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>PRIVATE CFO</div>
        <div style={S.icon}>🔒</div>
        <div style={S.title}>アプリの利用が停止されています</div>
        <div style={S.body}>
          ご不明な点は本部までお問い合わせください。
        </div>
        {user?.email && (
          <div style={S.emailBox}>登録メール: {user.email}</div>
        )}
        <button onClick={onReload} disabled={busy} style={S.reloadBtn(busy)}>
          {busy ? '再読み込み中…' : '再読み込み'}
        </button>
        <button onClick={signOut} style={S.logoutBtn}>ログアウト</button>
        <div style={S.note}>
          再開後はこの画面で「再読み込み」を押してください。
        </div>
      </div>
    </div>
  );
}
