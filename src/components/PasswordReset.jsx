import { useState } from 'react';
import {
  NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

const S = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 24, zIndex: 1000,
  },
  card: {
    width: '100%', maxWidth: 360,
    background: CARD_BG, borderRadius: 16,
    border: `1px solid ${BORDER}`, boxShadow: SHADOW,
    padding: '28px 22px',
  },
  brand: {
    fontSize: 11, color: GOLD, letterSpacing: '0.22em',
    marginBottom: 6, fontWeight: 600, textAlign: 'center',
  },
  title: {
    fontSize: 16, color: TEXT_PRIMARY, fontWeight: 700,
    marginBottom: 14, textAlign: 'center',
  },
  desc: {
    fontSize: 12, color: TEXT_SECONDARY,
    lineHeight: 1.7, marginBottom: 16, textAlign: 'center',
  },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  labelRow: {
    display: 'flex', flexDirection: 'column', gap: 6,
    fontSize: 11, color: TEXT_SECONDARY, fontWeight: 500,
  },
  input: {
    width: '100%', padding: '11px 12px',
    background: NAVY2, color: TEXT_PRIMARY,
    border: `1px solid ${BORDER}`, borderRadius: 8,
    fontSize: 14, outline: 'none', boxSizing: 'border-box',
  },
  errorBox: {
    fontSize: 12, color: RED,
    background: `${RED}22`, padding: '8px 12px',
    borderRadius: 6, lineHeight: 1.4,
  },
  successBox: {
    fontSize: 12, color: GOLD,
    background: `${GOLD}1A`, padding: '10px 12px',
    borderRadius: 6, lineHeight: 1.6,
  },
  submit: (busy) => ({
    padding: '12px',
    background: GOLD_GRAD, color: '#0A1628',
    border: 'none', borderRadius: 28,
    fontSize: 14, fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    boxShadow: `0 4px 24px ${GOLD}44`,
    opacity: busy ? 0.6 : 1,
    marginTop: 4,
  }),
  cancelBtn: {
    padding: '10px',
    background: 'transparent',
    color: TEXT_MUTED,
    border: 'none',
    fontSize: 12,
    cursor: 'pointer',
    marginTop: 4,
  },
};

export default function PasswordReset({ initialEmail = '', onClose }) {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (!email.trim()) {
      setError('メールアドレスを入力してください。');
      return;
    }
    setBusy(true);
    try {
      await resetPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(translateResetError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <div style={S.card} onClick={(e) => e.stopPropagation()}>
        <div style={S.brand}>PRIVATE CFO</div>
        <div style={S.title}>パスワード再設定</div>

        {sent ? (
          <>
            <div style={S.successBox}>
              {email} にパスワード再設定のメールを送信しました。<br />
              メール内のリンクからパスワードを再設定してください。
            </div>
            <button type="button" onClick={onClose} style={S.submit(false)}>閉じる</button>
          </>
        ) : (
          <>
            <div style={S.desc}>
              ご登録のメールアドレスに<br />
              パスワード再設定リンクをお送りします。
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
              {error && <div style={S.errorBox}>{error}</div>}
              <button type="submit" disabled={busy} style={S.submit(busy)}>
                {busy ? '送信中…' : '再設定メールを送信'}
              </button>
              <button type="button" onClick={onClose} style={S.cancelBtn}>
                キャンセル
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

function translateResetError(err) {
  const msg = err?.message || '';
  if (/rate limit/i.test(msg)) {
    return '試行回数が多すぎます。しばらく時間をおいてお試しください。';
  }
  if (/invalid email/i.test(msg)) {
    return 'メールアドレスの形式が正しくありません。';
  }
  return msg || 'メール送信に失敗しました。時間をおいて再度お試しください。';
}
