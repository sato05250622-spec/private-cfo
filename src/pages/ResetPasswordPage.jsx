import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

// ⑦-E: リカバリメール経由でアクセスされた直後に表示する「新しいパスワード」入力画面。
// AuthGate が recoveryMode === true の時に最優先でこれを描画する。
// 成功すると updatePassword(AuthContext) 内で signOut + setRecoveryMode(false) が走り、
// onAuthStateChange(SIGNED_OUT) → session=null → AuthGate が通常 LoginPage に復帰する。
// 失敗時は画面に留まり再試行可能 (リカバリトークンの有効期限内のみ)。
// デザインは LoginPage の S.* に揃え、揺らがない静かなトーンを維持。

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
  intro: {
    fontSize: 12,
    color: TEXT_SECONDARY,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 1.6,
  },
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
    fontSize: 16,
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
  doneBox: {
    fontSize: 12,
    color: TEXT_PRIMARY,
    background: `${GOLD}22`,
    border: `1px solid ${GOLD}55`,
    padding: '12px 14px',
    borderRadius: 8,
    lineHeight: 1.6,
    textAlign: 'center',
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

export default function ResetPasswordPage() {
  const { updatePassword } = useAuth();
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(null);

    if (password.length < 8) {
      setError('パスワードは 8 文字以上で入力してください。');
      return;
    }
    if (password !== passwordConfirm) {
      setError('パスワード(確認)が一致しません。');
      return;
    }

    setBusy(true);
    try {
      await updatePassword(password);
      // 成功: updatePassword 内で signOut + recoveryMode=false。
      // signOut の onAuthStateChange は非同期で走るため、完了メッセージは
      // ここで即出して数秒見せる (その間に AuthGate が LoginPage に戻る)。
      setDone(true);
    } catch (err) {
      setError(translateUpdateError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header}>
          <div style={S.brand}>PRIVATE CFO</div>
          <div style={S.title}>新しいパスワードを設定</div>
        </div>

        {done ? (
          <>
            <div style={S.doneBox}>
              パスワードを変更しました。<br />
              新しいパスワードでログインしてください。
            </div>
            <div style={S.footer}>
              数秒後にログイン画面に戻ります。
            </div>
          </>
        ) : (
          <>
            <div style={S.intro}>
              リカバリリンクから開きました。<br />
              新しいパスワードを 8 文字以上で設定してください。
            </div>
            <form onSubmit={onSubmit} style={S.form}>
              <label style={S.labelRow}>
                新しいパスワード <span style={{ color: TEXT_MUTED, fontSize: 10 }}>(8 文字以上)</span>
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={S.input}
                />
              </label>
              <label style={S.labelRow}>
                新しいパスワード(確認)
                <input
                  type="password"
                  required
                  autoComplete="new-password"
                  value={passwordConfirm}
                  onChange={(e) => setPasswordConfirm(e.target.value)}
                  style={S.input}
                />
              </label>
              {error && <div style={S.errorBox}>{error}</div>}
              <button type="submit" disabled={busy} style={S.submit(busy)}>
                {busy ? '変更中…' : 'パスワードを変更'}
              </button>
            </form>
            <div style={S.footer}>
              リンクの有効期限が切れた場合は、再度「パスワードを忘れた」から
              メールを送信してください。
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// updateUser 系で起き得るエラーを日本語化。Supabase の代表的なメッセージのみ。
function translateUpdateError(err) {
  const msg = err?.message || '';
  if (/password.*8|weak password|should be at least/i.test(msg)) {
    return 'パスワードが弱すぎます。8 文字以上を入れてください。';
  }
  if (/same.*password|new password should be different/i.test(msg)) {
    return '現在のパスワードと同じものは設定できません。';
  }
  if (/rate limit/i.test(msg)) {
    return '試行回数が多すぎます。しばらく時間をおいてお試しください。';
  }
  if (/expired|invalid.*token|jwt|session/i.test(msg)) {
    return 'リカバリリンクの有効期限が切れています。再度メールを送信してください。';
  }
  return msg || 'パスワードの変更に失敗しました。';
}
