import { NAVY, TEXT_MUTED } from '@shared/theme';
import { useAuth } from '../context/AuthContext';
import LoginPage from '../pages/LoginPage';
import PendingApprovalMessage from './PendingApprovalMessage';
import AppDisabled from './AppDisabled';
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
  const { session, loading, role, approved, appEnabled } = useAuth();

  if (loading) {
    return <div style={S.loading}>LOADING…</div>;
  }

  if (!session) {
    return <LoginPage />;
  }

  // 利用停止ゲート:admin/client 問わず app_enabled=false なら停止画面。
  // null(未取得)は通す(既存の <client_A> さん等、新カラム未取得のケースで誤停止しないため)。
  if (appEnabled === false) {
    return <AppDisabled />;
  }

  // 承認ゲート:client ロールかつ未承認のみ弾く。
  // admin はそのまま通す / role が未取得(null)は App に任せる(ネットワーク再読み込みで復帰)。
  if (role === 'client' && approved === false) {
    return <PendingApprovalMessage />;
  }

  return <App />;
}
