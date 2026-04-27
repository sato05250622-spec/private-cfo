import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';
import PasswordReset from '../components/PasswordReset';

const S = {
  wrap: {
    minHeight: '100dvh',
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
  header: { textAlign: 'center', marginBottom: 22 },
  brand: {
    fontSize: 11,
    color: GOLD,
    letterSpacing: '0.22em',
    marginBottom: 6,
    fontWeight: 600,
  },
  title: { fontSize: 18, color: TEXT_PRIMARY, fontWeight: 600 },
  tabs: {
    display: 'flex',
    background: NAVY2,
    border: `1px solid ${BORDER}`,
    borderRadius: 10,
    padding: 3,
    marginBottom: 20,
    gap: 2,
  },
  tab: (active) => ({
    flex: 1,
    padding: '8px 0',
    background: active ? GOLD_GRAD : 'transparent',
    color: active ? '#0A1628' : TEXT_SECONDARY,
    border: 'none',
    borderRadius: 7,
    fontSize: 12,
    fontWeight: active ? 700 : 500,
    cursor: 'pointer',
  }),
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
  forgotBtn: {
    marginTop: 10,
    background: 'transparent',
    border: 'none',
    color: TEXT_SECONDARY,
    fontSize: 11,
    textDecoration: 'underline',
    cursor: 'pointer',
    padding: 4,
    alignSelf: 'center',
  },
};

export default function LoginPage() {
  const { signIn, signUp } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);

  const switchTo = (next) => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setPassword('');
    setPasswordConfirm('');
    setDisplayName('');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (mode === 'signup') {
      if (!displayName.trim()) {
        setError('氏名を入力してください。');
        return;
      }
      if (password.length < 6) {
        setError('パスワードは 6 文字以上で入力してください。');
        return;
      }
      if (password !== passwordConfirm) {
        setError('パスワード(確認)が一致しません。');
        return;
      }
    }

    setBusy(true);
    try {
      if (mode === 'signup') {
        await signUp(email.trim(), password, displayName.trim());
        // signUp 成功後、Email Confirmation が OFF なら自動でセッションが発行され、
        // onAuthStateChange → loadProfile → role='client' / approved=false 。
        // AuthGate がそのまま PendingApprovalMessage に切り替わる。
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(translateAuthError(err, mode));
    } finally {
      setBusy(false);
    }
  };

  const isSignup = mode === 'signup';

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header}>
          <div style={S.brand}>PRIVATE CFO</div>
          <div style={S.title}>{isSignup ? '新規登録' : 'ログイン'}</div>
        </div>

        <div style={S.tabs}>
          <button type="button" onClick={() => switchTo('login')}  style={S.tab(!isSignup)}>ログイン</button>
          <button type="button" onClick={() => switchTo('signup')} style={S.tab(isSignup)}>新規登録</button>
        </div>

        <form onSubmit={onSubmit} style={S.form}>
          {isSignup && (
            <label style={S.labelRow}>
              氏名
              <input
                type="text"
                required
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={S.input}
              />
            </label>
          )}
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
            パスワード{isSignup && <span style={{ color: TEXT_MUTED, fontSize: 10 }}> (6 文字以上)</span>}
            <input
              type="password"
              required
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={S.input}
            />
          </label>
          {isSignup && (
            <label style={S.labelRow}>
              パスワード(確認)
              <input
                type="password"
                required
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(e) => setPasswordConfirm(e.target.value)}
                style={S.input}
              />
            </label>
          )}
          {error && <div style={S.errorBox}>{error}</div>}
          <button type="submit" disabled={busy} style={S.submit(busy)}>
            {busy
              ? (isSignup ? '登録中…' : 'ログイン中…')
              : (isSignup ? '新規登録' : 'ログイン')}
          </button>
          {!isSignup && (
            <button type="button" onClick={() => setResetOpen(true)} style={S.forgotBtn}>
              パスワードをお忘れの方
            </button>
          )}
        </form>

        <div style={S.footer}>
          {isSignup ? (
            <>
              ご登録後、本部の承認をお待ちください。<br />
              承認後にご利用いただけます。
            </>
          ) : (
            <>
              アカウントをお持ちでない方は「新規登録」から。<br />
              ログインできない場合は本部までお問い合わせください。
            </>
          )}
        </div>
      </div>
      {resetOpen && (
        <PasswordReset
          initialEmail={email}
          onClose={() => setResetOpen(false)}
        />
      )}
    </div>
  );
}

function translateAuthError(err, mode) {
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
  if (/user already registered/i.test(msg)) {
    return 'このメールアドレスは既に登録されています。ログインタブからお進みください。';
  }
  if (/password.*6|weak password|should be at least/i.test(msg)) {
    return 'パスワードが弱すぎます。6 文字以上を入れてください。';
  }
  return msg || (mode === 'signup' ? '新規登録に失敗しました。' : 'ログインに失敗しました。');
}
