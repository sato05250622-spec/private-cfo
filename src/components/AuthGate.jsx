import { NAVY, TEXT_MUTED } from '@shared/theme';
import { useAuth } from '../context/AuthContext';
import LoginPage from '../pages/LoginPage';
import App from '../App';

const S = {
  loading: {
    minHeight: '100vh',
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
  const { session, loading } = useAuth();

  if (loading) {
    return <div style={S.loading}>LOADING…</div>;
  }

  if (!session) {
    return <LoginPage />;
  }

  return <App />;
}
