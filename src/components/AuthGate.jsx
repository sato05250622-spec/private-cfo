import { NAVY, TEXT_MUTED } from '@shared/theme';
import { useAuth } from '../context/AuthContext';
import LoginPage from '../pages/LoginPage';
import PendingApprovalMessage from './PendingApprovalMessage';
import ResetPasswordPage from '../pages/ResetPasswordPage';
import App from '../App';

const S = {
  loading: {
    minHeight: '100dvh',
    background: NAVY,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: TEXT_MUTED,
    fontSize: 12,
    letterSpacing: '0.15em',
  },
};

export default function AuthGate() {
  const { session, loading, role, approved, recoveryMode } = useAuth();

  // ⑦-E: パスワードリセットメール経由のリカバリ中は他の全分岐より優先。
  // 一時的な recovery セッションを伴うため loading/!session/approved の判定より前に置く
  // (そうしないと LoginPage や App が一瞬描かれてから ResetPasswordPage に切り替わる)。
  if (recoveryMode) {
    return <ResetPasswordPage />;
  }

  if (loading) {
    return <div style={S.loading}>LOADING…</div>;
  }

  if (!session) {
    return <LoginPage />;
  }

  // 承認ゲート:client ロールかつ未承認のみ弾く。
  // admin はそのまま通す / role が未取得(null)は App に任せる(ネットワーク再読み込みで復帰)。
  if (role === 'client' && approved === false) {
    return <PendingApprovalMessage />;
  }

  return <App />;
}
