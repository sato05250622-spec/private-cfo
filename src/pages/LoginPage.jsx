import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

const S = {
  wrap: {
    minHeight: '100vh',
    background: NAVY,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
  },
  card: {
    width: '100%',
    maxWidth: 380,
    background: CARD_BG,
    borderRadius: 16,
    border: `1px solid ${BORDER}`,
    boxShadow: SHADOW,
    padding: '32px 24px',
  },
  header: { textAlign: 'center', marginBottom: 28 },
  brand: {
    fontSize: 11,
    color: GOLD,
    letterSpacing: '0.22em',
    marginBottom: 6,
    fontWeight: 600,
  },
  title: { fontSize: 18, color: TEXT_PRIMARY, fontWeight: 600 },
  form: { display: 'flex', flexDirection: 'column', gap: 14 },
  labelRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    fontSize: 11,
    color: TEXT_SECONDARY,
    fontWeight: 500,
  },
  input: {
    width: '100%',
    padding: '11px 12px',
    background: NAVY2,
    color: TEXT_PRIMARY,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
  },
  errorBox: {
    fontSize: 12,
    color: RED,
    background: `${RED}22`,
    padding: '8px 12px',
    borderRadius: 6,
    lineHeight: 1.4,
  },
  submit: (busy) => ({
    padding: '12px',
    background: GOLD_GRAD,
    color: '#0A1628',
    border: 'none',
    borderRadius: 28,
    fontSize: 14,
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    boxShadow: `0 4px 24px ${GOLD}44`,
    opacity: busy ? 0.6 : 1,
    marginTop: 4,
  }),
  footer: {
    marginTop: 22,
    fontSize: 11,
    color: TEXT_MUTED,
    textAlign: 'center',
    lineHeight: 1.6,
  },
};

export default function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(translateAuthError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header}>
          <div style={S.brand}>PRIVATE CFO</div>
          <div style={S.title}>ログイン</div>
        </div>
        <form onSubmit={onSubmit} style={S.form}>
          <label style={S.labelRow}>
            メールアドレス
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={S.input}
            />
          </label>
          <label style={S.labelRow}>
            パスワード
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={S.input}
            />
          </label>
          {error && <div style={S.errorBox}>{error}</div>}
          <button type="submit" disabled={busy} style={S.submit(busy)}>
            {busy ? 'ログイン中…' : 'ログイン'}
          </button>
        </form>
        <div style={S.footer}>
          アカウントは本部からの招待制です。
          <br />
          ログインできない場合は本部までお問い合わせください。
        </div>
      </div>
    </div>
  );
}

function translateAuthError(err) {
  const msg = err?.message || '';
  if (/invalid login credentials/i.test(msg)) {
    return 'メールアドレスまたはパスワードが正しくありません。';
  }
  if (/email not confirmed/i.test(msg)) {
    return '招待メールからの初回パスワード設定が完了していません。';
  }
  if (/rate limit/i.test(msg)) {
    return '試行回数が多すぎます。しばらく時間をおいてお試しください。';
  }
  return msg || 'ログインに失敗しました。';
}
