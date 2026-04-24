import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

const S = {
  wrap: {
    minHeight: '100vh', background: NAVY,
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
  recheckBtn: (busy) => ({
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
  statusMsg: (ok) => ({
    fontSize: 11, color: ok ? GOLD : RED,
    marginTop: -8, marginBottom: 12,
    lineHeight: 1.5,
  }),
};

export default function PendingApprovalMessage() {
  const { user, refreshProfile, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState(null);

  const onRecheck = async () => {
    if (busy) return;
    setBusy(true);
    setStatusMsg(null);
    try {
      await refreshProfile();
      // 承認済になっていれば AuthGate が自動で App に切り替わる。
      // まだの時はここに残るので「承認は確認できませんでした」を一時表示。
      setStatusMsg({ ok: false, text: 'まだ承認されていません。しばらくお待ちください。' });
    } catch (e) {
      console.error(e);
      setStatusMsg({ ok: false, text: '確認中にエラーが発生しました。' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>PRIVATE CFO</div>
        <div style={S.icon}>⏳</div>
        <div style={S.title}>承認待ち</div>
        <div style={S.body}>
          ご登録ありがとうございます。<br />
          本部による承認後にご利用いただけます。<br />
          承認が完了したらお知らせいたします。
        </div>
        {user?.email && (
          <div style={S.emailBox}>登録メール: {user.email}</div>
        )}
        {statusMsg && (
          <div style={S.statusMsg(statusMsg.ok)}>{statusMsg.text}</div>
        )}
        <button onClick={onRecheck} disabled={busy} style={S.recheckBtn(busy)}>
          {busy ? '確認中…' : '承認状況を再確認'}
        </button>
        <button onClick={signOut} style={S.logoutBtn}>ログアウト</button>
        <div style={S.note}>
          お急ぎの場合は本部までご連絡ください。
        </div>
      </div>
    </div>
  );
}
