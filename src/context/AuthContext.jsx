import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { getManagementStartDay, setManagementStartDay } from '../utils/cycle';

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
  // 2026-06-14: アプリ全体停止フラグ (profiles.app_enabled、boolean NOT NULL DEFAULT true)。
  //   admin が「アプリ停止」を押すと false になり、AuthGate が AppDisabledMessage に切替。
  //   未取得 / NULL は true 扱い (既存顧客に影響なし、DEFAULT に揃える)。
  const [appEnabled, setAppEnabled] = useState(true);
  // Phase E ⑦-2: 顧客自身の編集許可フラグ (profiles.customer_edit_enabled)。
  // 未取得 / 取得失敗 / サインアウト時は false (= ロック) を default とする。
  // App.jsx の requestEdit() がこの値を見て編集導線を許可 / トースト案内に分岐。
  const [customerEditEnabled, setCustomerEditEnabled] = useState(false);
  // Phase 3: 固定費 込み/抜きフラグ (profiles.include_fixed_expenses)。HQ が顧客ごとに切替。
  // true = 込み (固定費行を表示、DB default)。未取得 / 失敗 / サインアウト時も true を default。
  const [includeFixedExpenses, setIncludeFixedExpenses] = useState(true);
  // 2026-06-05: アプリ設定タブ 機能ゲート
  const [reportEnabled, setReportEnabled] = useState(false);
  const [meetingEnabled, setMeetingEnabled] = useState(false);
  const [fixedCostsEnabled, setFixedCostsEnabled] = useState(false);
  const [utilizationEnabled, setUtilizationEnabled] = useState(false);
  const [categoryAddEnabled, setCategoryAddEnabled] = useState(false);
  const [cardLimit, setCardLimit] = useState(null);
  // Phase A タスク3 (2026-06-06): 資産残高繰越票 機能ゲート。DB asset_sheet_enabled DEFAULT false。
  const [assetSheetEnabled, setAssetSheetEnabled] = useState(false);
  // Phase B-3 (2026-06-07): 資産残高繰越票 初期資産。DB profiles.initial_asset numeric DEFAULT 0。
  //   AssetSheetViewer が read-only で参照 (初月 balance 起点)。
  const [initialAsset, setInitialAsset] = useState(0);
  // ⑦-E: パスワードリセットメール経由のリカバリセッション中フラグ。
  // onAuthStateChange の event==='PASSWORD_RECOVERY' で true に立て、
  // AuthGate がここを最優先で見て ResetPasswordPage に切替。
  // updatePassword 成功時に false に戻し、signOut で通常 LoginPage へ。
  const [recoveryMode, setRecoveryMode] = useState(false);

  // #6 修正: profile を読み込み済みの userId。onAuthStateChange が同一ユーザーで
  // 再発火 (TOKEN_REFRESHED 等) したとき profile 再取得をスキップするための番兵。
  const loadedUserIdRef = useRef(null);

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
          .select('role, approved, app_enabled, management_start_day, customer_edit_enabled, include_fixed_expenses, report_enabled, meeting_enabled, fixed_costs_enabled, utilization_enabled, category_add_enabled, card_limit, asset_sheet_enabled, initial_asset')
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
          // #6 修正: 取得失敗時は customerEditEnabled / includeFixedExpenses を変更しない
          //   (false に落とすと予算編集が誤ロックされるため。成功時のみ更新)。
          return;
        }
        setRole(data?.role ?? null);
        setApproved(data?.approved ?? null);
        setAppEnabled(data?.app_enabled ?? true);
        setCustomerEditEnabled(data?.customer_edit_enabled ?? false);
        setIncludeFixedExpenses(data?.include_fixed_expenses ?? true);
        setReportEnabled(data?.report_enabled ?? false);
        setMeetingEnabled(data?.meeting_enabled ?? false);
        setFixedCostsEnabled(data?.fixed_costs_enabled ?? false);
        setUtilizationEnabled(data?.utilization_enabled ?? false);
        setCategoryAddEnabled(data?.category_add_enabled ?? false);
        setCardLimit(data?.card_limit ?? null);
        setAssetSheetEnabled(data?.asset_sheet_enabled ?? false);
        setInitialAsset(Number(data?.initial_asset ?? 0) || 0);
        // #6 修正: 「取得成功時のみ」ロード済み userId を記録する。
        //   こうすると失敗/タイムアウトしたロードは "未ロード" のまま残り、次の focus
        //   再発火で再試行され、customerEditEnabled の false 張り付きが自己回復する。
        //   成功後は同一ユーザーの再発火で onAuthStateChange が loadProfile を skip。
        loadedUserIdRef.current = userId;
        // B-2: profile.msd が non-null かつ localStorage と異なるとき localStorage を上書き。
        // NULL は no-op (既存 localStorage の値を破壊しない、B-1 未実施ユーザー保護)。
        // Supabase = source of truth、ただし NULL は「未充填」として扱う。
        if (data?.management_start_day != null) {
          const local = getManagementStartDay();
          if (local !== data.management_start_day) {
            setManagementStartDay(data.management_start_day);
          }
        }
      } catch (e) {
        console.error('[auth] loadProfile exception', e);
        if (!mounted) return;
        setRole(null);
        setApproved(null);
        // #6 修正: タイムアウト/例外時も customerEditEnabled は変更しない (誤ロック防止)。
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
      // ⑦-E: パスワードリセットメール経由でアクセスされた直後のイベント。
      // 一時的な recovery セッションを伴うため、通常の session 判定より先に拾って
      // AuthGate を ResetPasswordPage に切替える。以降の setSession / loadProfile は
      // 既存ロジックのまま走らせる (number/role 等の取得は副作用なし、recoveryMode
      // が AuthGate で優先されるだけ)。
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryMode(true);
      }
      setSession(next);
      try {
        const nextId = next?.user?.id ?? null;
        if (nextId) {
          // #6 修正: 同一ユーザーの再発火 (TOKEN_REFRESHED / フォーカス復帰など) では
          //   profile を再取得しない。ログイン/ユーザー変更/初回ロード時のみ取得。
          //   これにより復帰のたびの再取得失敗で customerEditEnabled が揺れるのを防ぐ。
          if (nextId === loadedUserIdRef.current) return;
          await loadProfile(nextId);
        } else {
          // サインアウト: 編集フラグを既定 (ロック) に戻し、番兵もクリア。
          setRole(null);
          setApproved(null);
          setCustomerEditEnabled(false);
          loadedUserIdRef.current = null;
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

  // ⑦-E: パスワードリセットメール送信。redirectTo は本番 origin の `/` 固定。
  // Supabase ダッシュボード Authentication → URL Configuration の
  // Redirect URLs allowlist に origin/ を登録してある前提。
  // 成功時は Supabase 側でメールがキューイングされ、エラーは throw。
  const resetPassword = async (email) => {
    const redirectTo = `${window.location.origin}/`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
  };

  // ⑦-E: リカバリセッション中の新パスワード適用。成功で recoveryMode を解除し、
  // signOut で一時セッションを完全に破棄する (リカバリトークンを残さない)。
  // signOut の onAuthStateChange(SIGNED_OUT) で session=null → AuthGate が LoginPage 復帰。
  const updatePassword = async (newPassword) => {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    setRecoveryMode(false);
    await supabase.auth.signOut();
  };

  // 承認待ち画面の「再確認」ボタンから呼ぶ。
  // profiles を再フェッチして approved=true になっていれば AuthGate が App を描画。
  const refreshProfile = useCallback(async () => {
    if (!session?.user?.id) return;
    try {
      const q = supabase
        .from('profiles')
        .select('role, approved, app_enabled, management_start_day, customer_edit_enabled, include_fixed_expenses, report_enabled, meeting_enabled, fixed_costs_enabled, utilization_enabled, category_add_enabled, card_limit, asset_sheet_enabled, initial_asset')
        .eq('id', session.user.id)
        .maybeSingle();
      const { data, error } = await withTimeout(q, PROFILE_FETCH_TIMEOUT_MS, 'profiles refresh');
      if (error) {
        console.error('[auth] refreshProfile error', error);
        return;
      }
      setRole(data?.role ?? null);
      setApproved(data?.approved ?? null);
      setAppEnabled(data?.app_enabled ?? true);
      setCustomerEditEnabled(data?.customer_edit_enabled ?? false);
      setIncludeFixedExpenses(data?.include_fixed_expenses ?? true);
      setReportEnabled(data?.report_enabled ?? false);
      setMeetingEnabled(data?.meeting_enabled ?? false);
      setFixedCostsEnabled(data?.fixed_costs_enabled ?? false);
      setUtilizationEnabled(data?.utilization_enabled ?? false);
      setCategoryAddEnabled(data?.category_add_enabled ?? false);
      setCardLimit(data?.card_limit ?? null);
      setAssetSheetEnabled(data?.asset_sheet_enabled ?? false);
      setInitialAsset(Number(data?.initial_asset ?? 0) || 0);
      // B-2: loadProfile と同じ msd sync (refresh 経路でも一貫性を保つ)
      if (data?.management_start_day != null) {
        const local = getManagementStartDay();
        if (local !== data.management_start_day) {
          setManagementStartDay(data.management_start_day);
        }
      }
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
    appEnabled,
    customerEditEnabled,
    includeFixedExpenses,
    // 2026-06-05: アプリ設定タブ 機能ゲート
    reportEnabled,
    meetingEnabled,
    fixedCostsEnabled,
    utilizationEnabled,
    categoryAddEnabled,
    cardLimit,
    assetSheetEnabled,
    initialAsset,
    isAdmin: role === 'admin',
    isApproved: approved === true,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    // ⑦-E: パスワードリセット関連 (AuthGate / LoginPage / ResetPasswordPage が consume)。
    recoveryMode,
    resetPassword,
    updatePassword,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth は AuthProvider の内側で使ってください');
  return ctx;
}
