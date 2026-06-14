import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED, RED,
} from '@shared/theme';
import { useAuth } from '../context/AuthContext';

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
  // ⑦-E: resetPassword を追加 (forgot モードでメール送信に使う)。
  const { signIn, signUp, resetPassword } = useAuth();
  const [mode, setMode] = useState('login'); // 'login' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // 2026-06-14: 送信連打防止。busy と独立に持つことで「未来 await 中にもう一度クリック」を
  //   厳密にブロックする (busy は state 更新のフレーム遅延で次クリックを取りこぼす場合がある)。
  const [isSubmitting, setIsSubmitting] = useState(false);
  // ⑦-E: forgot モードでのリセットメール送信完了表示用。mode 切替時にリセット。
  const [forgotSent, setForgotSent] = useState(false);

  const switchTo = (next) => {
    if (next === mode) return;
    setMode(next);
    setError(null);
    setPassword('');
    setPasswordConfirm('');
    // ⑦-E: モード切替時は forgot 送信状態もクリア (戻り時に「送りました」が残らない)。
    setForgotSent(false);
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    // 2026-06-14: 連打防止。isSubmitting 中は二重実行禁止。
    if (isSubmitting || busy) return;
    setError(null);

    if (mode === 'signup') {
      if (password.length < 6) {
        setError('パスワードは 6 文字以上で入力してください。');
        return;
      }
      if (password !== passwordConfirm) {
        setError('パスワード(確認)が一致しません。');
        return;
      }
    }

    setIsSubmitting(true);
    setBusy(true);
    try {
      if (mode === 'signup') {
        await signUp(email.trim(), password);
        // signUp 成功後、Email Confirmation が OFF なら自動でセッションが発行され、
        // onAuthStateChange → loadProfile → role='client' / approved=false 。
        // AuthGate がそのまま PendingApprovalMessage に切り替わる。
      } else if (mode === 'forgot') {
        // ⑦-E: リセットメール送信。成功でも失敗 (=メール存在しない) でも
        //   ユーザー列挙を許さないため同じ画面に進めるのが推奨だが、
        //   Supabase 既定の resetPasswordForEmail は存在しないメールでもエラーを
        //   返さないので、ここでは単純に「送りました」を表示する。
        await resetPassword(email.trim());
        setForgotSent(true);
      } else {
        await signIn(email.trim(), password);
      }
    } catch (err) {
      setError(translateAuthError(err, mode));
    } finally {
      // 成功時は SIGNED_IN で AuthGate がアンマウントするため state 更新が捨てられても問題なし。
      // エラー時に必ず再試行可能なよう両方戻す。
      setBusy(false);
      setIsSubmitting(false);
    }
  };

  const isSignup = mode === 'signup';
  // ⑦-E: forgot 専用フラグ (既存 isSignup の読みやすさを壊さないよう別変数で導入)。
  const isForgot = mode === 'forgot';

  // ⑦-E: タイトル文言は 3 モード分岐。
  const headerTitle = isForgot ? 'パスワード再設定' : (isSignup ? '新規登録' : 'ログイン');
  // ⑦-E: submit ボタン文言。
  const submitLabel = busy
    ? (isForgot ? '送信中…' : (isSignup ? '登録中…' : 'ログイン中…'))
    : (isForgot ? 'リセットメールを送る' : (isSignup ? '新規登録' : 'ログイン'));

  return (
    <div style={S.wrap}>
      <div style={S.card}>
        <div style={S.header}>
          <div style={S.brand}>PRIVATE CFO</div>
          <div style={S.title}>{headerTitle}</div>
        </div>

        {/* ⑦-E: タブは login/signup の時のみ表示。forgot は専用画面扱いで隠す。 */}
        {!isForgot && (
          <div style={S.tabs}>
            <button type="button" onClick={() => switchTo('login')}  style={S.tab(!isSignup)}>ログイン</button>
            <button type="button" onClick={() => switchTo('signup')} style={S.tab(isSignup)}>新規登録</button>
          </div>
        )}

        {/* ⑦-E: forgot かつ送信完了は専用の確認ビューに差し替え (フォームを出さない)。 */}
        {isForgot && forgotSent ? (
          <>
            <div style={{
              fontSize: 12,
              color: TEXT_PRIMARY,
              background: `${GOLD}22`,
              border: `1px solid ${GOLD}55`,
              padding: '12px 14px',
              borderRadius: 8,
              lineHeight: 1.6,
              textAlign: 'center',
            }}>
              リセットメールを送信しました。<br />
              受信箱をご確認のうえ、メール内のリンクから<br />
              新しいパスワードを設定してください。
            </div>
            <button
              type="button"
              onClick={() => switchTo('login')}
              style={{
                ...S.submit(false),
                background: 'transparent',
                color: GOLD,
                border: `1px solid ${GOLD}`,
                boxShadow: 'none',
                marginTop: 14,
              }}
            >
              ログインに戻る
            </button>
          </>
        ) : (
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
            {/* ⑦-E: forgot ではパスワード入力を非表示 (email のみ送信)。既存 login/signup の挙動は不変。 */}
            {!isForgot && (
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
            )}
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
            <button type="submit" disabled={busy || isSubmitting} style={S.submit(busy || isSubmitting)}>
              {submitLabel}
            </button>
            {/* ⑦-E: login モードのみ「パスワードを忘れた」リンクを submit 直後に表示。 */}
            {!isSignup && !isForgot && (
              <button
                type="button"
                onClick={() => switchTo('forgot')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: TEXT_MUTED,
                  fontSize: 11,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  marginTop: 2,
                  padding: 0,
                  alignSelf: 'center',
                }}
              >
                パスワードを忘れた方はこちら
              </button>
            )}
            {/* ⑦-E: forgot モードでは「ログインに戻る」を form 内末尾に表示。 */}
            {isForgot && (
              <button
                type="button"
                onClick={() => switchTo('login')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: TEXT_MUTED,
                  fontSize: 11,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  marginTop: 2,
                  padding: 0,
                  alignSelf: 'center',
                }}
              >
                ログインに戻る
              </button>
            )}
          </form>
        )}

        <div style={S.footer}>
          {isForgot ? (
            <>
              ご登録のメールアドレス宛にリセット用リンクをお送りします。<br />
              届かない場合は迷惑メールフォルダもご確認ください。
            </>
          ) : isSignup ? (
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
    </div>
  );
}

function translateAuthError(err, mode) {
  const msg = err?.message || '';
  const code = err?.code || '';
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
  // 2026-06-14: メールアドレスが Supabase 側に弾かれたケース (無効/許可外ドメイン等)。
  //   error.code === 'email_address_invalid' or message に "is invalid" / "invalid email" を含む。
  if (code === 'email_address_invalid' || /(is invalid|invalid email)/i.test(msg)) {
    return 'このメールアドレスは登録できません。別のアドレスをお試しください。';
  }
  // ⑦-E: forgot モード用フォールバック文言 (生英語を返さず日本語で統一)。
  if (mode === 'forgot') return 'リセットメールの送信に失敗しました。時間をおいて再度お試しください。';
  // 2026-06-14: 未知エラーの最終フォールバックも生英語ではなく日本語固定にする。
  return mode === 'signup'
    ? '新規登録に失敗しました。時間をおいて再度お試しください。'
    : 'ログインに失敗しました。時間をおいて再度お試しください。';
}
