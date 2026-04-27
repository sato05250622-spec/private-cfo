import {
  NAVY, NAVY2, GOLD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

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
  icon: { fontSize: 48, marginBottom: 12 },
  title: { fontSize: 18, color: TEXT_PRIMARY, fontWeight: 700, marginBottom: 16 },
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
  logoutBtn: {
    width: '100%', padding: '12px',
    background: 'transparent', color: RED,
    border: `1px solid ${RED}55`, borderRadius: 24,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  note: {
    marginTop: 18, fontSize: 10, color: TEXT_MUTED,
    lineHeight: 1.6,
  },
};

export default function AppDisabled() {
  const { user, signOut } = useAuth();

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.brand}>PRIVATE CFO</div>
        <div style={S.icon}>🔒</div>
        <div style={S.title}>ご利用停止中</div>
        <div style={S.body}>
          現在こちらのアカウントは<br />
          ご利用が停止されています。<br />
          サポートまでご連絡ください。
        </div>
        {user?.email && (
          <div style={S.emailBox}>登録メール: {user.email}</div>
        )}
        <button onClick={signOut} style={S.logoutBtn}>ログアウト</button>
        <div style={S.note}>
          ご不明点は本部までお問い合わせください。
        </div>
      </div>
    </div>
  );
}
