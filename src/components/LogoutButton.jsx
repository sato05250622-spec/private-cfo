import { useState } from 'react';
import { RED, CARD_BG, BORDER, TEXT_MUTED } from '@shared/theme';
import { useAuth } from '../context/AuthContext';

export default function LogoutButton() {
  const { signOut, user } = useAuth();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    if (!window.confirm('ログアウトしますか?')) return;
    setBusy(true);
    try {
      await signOut();
    } catch (e) {
      console.error(e);
      alert('ログアウトに失敗しました。');
      setBusy(false);
    }
    // 成功時は AuthGate が LoginPage に切り替えるので setBusy 不要
  };

  return (
    <div style={{ margin: '24px 16px 0', background: CARD_BG, borderRadius: 12, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
      {user?.email && (
        <div style={{ padding: '10px 16px', fontSize: 11, color: TEXT_MUTED, borderBottom: `1px solid ${BORDER}` }}>
          ログイン中: {user.email}
        </div>
      )}
      <button
        onClick={onClick}
        disabled={busy}
        style={{
          width: '100%',
          padding: '14px',
          background: 'transparent',
          border: 'none',
          fontSize: 14,
          fontWeight: 600,
          color: RED,
          cursor: busy ? 'wait' : 'pointer',
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? 'ログアウト中…' : 'ログアウト'}
      </button>
    </div>
  );
}
