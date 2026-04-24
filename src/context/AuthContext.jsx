import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

const AuthContext = createContext(null);

// 初回 profiles フェッチ / auth.getSession がネットワーク層で hang したまま
// resolve/reject しないケースに備えて、5 秒で必ず reject するタイムアウトを噛ませる。
// 前例:admin アプリで同じ構造の loadProfile が hang → LOADING で固まった問題を
// Promise.race + try/catch/finally で解消した(private-cfo-admin の AuthContext 参照)。
const PROFILE_FETCH_TIMEOUT_MS = 5000;

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout(${ms}ms): ${label}`)), ms),
    ),
  ]);
}

// 承認ゲート用の拡張:
// - session に加えて profiles.role と profiles.approved を保持
// - signUp を追加(handle_new_user トリガが profiles に role='client',
//   approved=false(Migration 1 の default)で行を生成)
// - refreshProfile を追加(承認待ち画面の「再確認」ボタン用)
// - AuthGate で role === 'client' && approved === false のとき
//   PendingApprovalMessage へ振る
export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [role, setRole] = useState(null);
  const [approved, setApproved] = useState(null);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[auth] useEffect start');
    let mounted = true;

    async function loadProfile(userId) {
      // eslint-disable-next-line no-console
      console.log('[auth] loadProfile start', userId);
      try {
        const q = supabase
          .from('profiles')
          .select('role, approved')
          .eq('id', userId)
          .maybeSingle();
        const { data, error } = await withTimeout(q, PROFILE_FETCH_TIMEOUT_MS, 'profiles fetch');
        // eslint-disable-next-line no-console
        console.log('[auth] loadProfile result', { data, error });
        if (!mounted) return;
        if (error) {
          console.error('[auth] loadProfile error', error);
          setRole(null);
          setApproved(null);
          return;
        }
        setRole(data?.role ?? null);
        setApproved(data?.approved ?? null);
      } catch (e) {
        console.error('[auth] loadProfile exception', e);
        if (!mounted) return;
        setRole(null);
        setApproved(null);
      }
    }

    (async () => {
      try {
        // eslint-disable-next-line no-console
        console.log('[auth] getSession start');
        const result = await withTimeout(
          supabase.auth.getSession(),
          PROFILE_FETCH_TIMEOUT_MS,
          'auth.getSession',
        );
        // eslint-disable-next-line no-console
        console.log('[auth] getSession result', {
          hasSession: !!result?.data?.session,
          userId: result?.data?.session?.user?.id,
        });
        if (!mounted) return;
        const s = result?.data?.session ?? null;
        setSession(s);
        if (s?.user?.id) {
          await loadProfile(s.user.id);
        }
      } catch (e) {
        console.error('[auth] init exception', e);
      } finally {
        if (mounted) {
          setLoading(false);
          // eslint-disable-next-line no-console
          console.log('[auth] setLoading(false) in finally');
        }
      }
    })();

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, next) => {
      // eslint-disable-next-line no-console
      console.log('[auth] onAuthStateChange', event, next?.user?.id);
      if (!mounted) return;
      setSession(next);
      try {
        if (next?.user?.id) {
          await loadProfile(next.user.id);
        } else {
          setRole(null);
          setApproved(null);
        }
      } catch (e) {
        console.error('[auth] onAuthStateChange loadProfile exception', e);
      }
    });

    return () => {
      // eslint-disable-next-line no-console
      console.log('[auth] cleanup');
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUp = async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
    // 成功後の profiles INSERT は handle_new_user トリガ任せ。
    // Email Confirmation が OFF なら onAuthStateChange(SIGNED_IN) が
    // 即発火 → loadProfile → role='client' / approved=false が state に入り、
    // AuthGate が PendingApprovalMessage に切り替える。
  };

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  // 承認待ち画面の「再確認」ボタンから呼ぶ。
  // profiles を再フェッチして approved=true になっていれば AuthGate が App を描画。
  const refreshProfile = useCallback(async () => {
    if (!session?.user?.id) return;
    try {
      const q = supabase
        .from('profiles')
        .select('role, approved')
        .eq('id', session.user.id)
        .maybeSingle();
      const { data, error } = await withTimeout(q, PROFILE_FETCH_TIMEOUT_MS, 'profiles refresh');
      if (error) {
        console.error('[auth] refreshProfile error', error);
        return;
      }
      setRole(data?.role ?? null);
      setApproved(data?.approved ?? null);
    } catch (e) {
      console.error('[auth] refreshProfile exception', e);
    }
  }, [session]);

  const value = {
    session,
    user: session?.user ?? null,
    loading,
    role,
    approved,
    isAdmin: role === 'admin',
    isApproved: approved === true,
    signIn,
    signUp,
    signOut,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth は AuthProvider の内側で使ってください');
  return ctx;
}
