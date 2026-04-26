import { NAVY, TEXT_MUTED } from '@shared/theme';
import { useAuth } from '../context/AuthContext';
import LoginPage from '../pages/LoginPage';
import PendingApprovalMessage from './PendingApprovalMessage';
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
  const { session, loading, role, approved } = useAuth();

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
