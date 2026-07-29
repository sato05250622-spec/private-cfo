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

// F: profiles の SELECT 列 (14 列)。loadProfile / refreshProfile の 2 箇所で使うため
//    定数で 1 箇所定義にする (片方だけ列を足す事故の防止)。
const PROFILE_COLUMNS = 'role, approved, app_enabled, management_start_day, customer_edit_enabled, include_fixed_expenses, report_enabled, meeting_enabled, fixed_costs_enabled, utilization_enabled, category_add_enabled, card_limit, asset_sheet_enabled, initial_asset';

// -----------------------------------------------------------------
// profiles の localStorage キャッシュ (stale-while-revalidate)。
//   起動時に getSession + profiles SELECT の直列待ちのうち後者 (1RTT ~100-400ms) を、
//   キャッシュヒット時は待たずに画面を出すための最適化。
//   保存 shape: { userId, profile(14列 SELECT の生 data), savedAt }。
//   すべて try/catch で握りつぶし、localStorage 不可 (プライベートモード等) でも
//   起動フローを壊さない (キャッシュ無し扱いにフォールバック)。
// -----------------------------------------------------------------
const PROFILE_CACHE_KEY = 'pcfo_profile_cache_v1';

function readProfileCache() {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeProfileCache(userId, profile) {
  try {
    localStorage.setItem(
      PROFILE_CACHE_KEY,
      JSON.stringify({ userId, profile, savedAt: Date.now() }),
    );
  } catch {
    // quota / serialization 失敗は無視 (キャッシュはあくまで最適化)。
  }
}

function clearProfileCache() {
  // サインアウト時: profiles / categories / payment_methods の SWR キャッシュを一括破棄。
  //   本アプリの SWR キャッシュは全て 'pcfo_' プレフィックス (pcfo_profile_cache_v1 /
  //   pcfo_categories_cache_v1 / pcfo_payment_methods_cache_v1)。他の永続キーは
  //   'cfo_' / 'monthly_' プレフィックスのため衝突しない。プレフィックス一括削除に
  //   することで、将来キャッシュを追加しても取りこぼさない。
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf('pcfo_') === 0) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // 無視。
  }
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
  // A (2026-07-29): profiles の機能フラグが「確定済みか」を表す番兵。
  //   false = まだ権威データ (フェッチ成功 / キャッシュ採用) が一度も入っていない状態。
  //   機能フラグ系 6 つ (report/meeting/fixed_costs/utilization/category_add/asset_sheet) と
  //   customer_edit_enabled は未確定時の既定が false = ロックのため、そのまま描画すると
  //   ログイン直後の 1RTT だけ誤って 🔒 が出る。消費側 (App.jsx) はこのフラグが false の間
  //   「ロックにも解放にも倒さない」ニュートラル表示にする。
  //   AuthGate の分岐 (LOADING / 承認 / アプリ停止) はこのフラグを参照しない (挙動不変)。
  const [profileReady, setProfileReady] = useState(false);

  // #6 修正: profile を読み込み済みの userId。onAuthStateChange が同一ユーザーで
  // 再発火 (TOKEN_REFRESHED 等) したとき profile 再取得をスキップするための番兵。
  const loadedUserIdRef = useRef(null);
  // E (2026-07-29): visibilitychange 再検証の対象 userId。
  //   loadedUserIdRef は「取得成功済み」の番兵なので、取得に失敗して未確定のまま
  //   残っているケースを拾えない。復帰時のリトライを取りこぼさないよう別 ref で
  //   「現在のセッションの userId」を保持する。
  const sessionUserIdRef = useRef(null);

  // profiles の 14 列 (生 data) を state に反映する共通処理。
  //   キャッシュ採用時 (起動) / フェッチ成功時 / サインアウト時 (data=null) から呼ぶ。
  //   B: data=null を渡すと全列 undefined 経由で各 ?? 既定へ戻る (前ユーザーの残留を根絶)。
  //   profileReady はここでは触らない (確定/未確定の判断は呼び出し側の責務)。
  const applyProfile = useCallback((data) => {
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
    // B-2: profile.msd が non-null かつ localStorage と異なるとき localStorage を上書き。
    // NULL は no-op (既存 localStorage の値を破壊しない、B-1 未実施ユーザー保護)。
    // Supabase = source of truth、ただし NULL は「未充填」として扱う。
    // (data=null のサインアウト経路も no-op = localStorage の msd は保持)。
    if (data?.management_start_day != null) {
      const local = getManagementStartDay();
      if (local !== data.management_start_day) {
        setManagementStartDay(data.management_start_day);
      }
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log('[auth] useEffect start');
    let mounted = true;

    // profiles を SELECT して state / キャッシュを更新する。
    //   opts.background=true: stale-while-revalidate の裏更新。取得失敗時は role/approved を
    //     null に落とさず (キャッシュ採用済みの表示を壊さない)、成功時もキャッシュ済み値と
    //     差分がある時のみ setState する (無駄な再描画を避ける)。
    async function loadProfile(userId, opts) {
      const background = opts?.background === true;
      // eslint-disable-next-line no-console
      console.log('[auth] loadProfile start', userId, background ? '(bg)' : '');
      try {
        const q = supabase
          .from('profiles')
          .select(PROFILE_COLUMNS)
          .eq('id', userId)
          .maybeSingle();
        const { data, error } = await withTimeout(q, PROFILE_FETCH_TIMEOUT_MS, 'profiles fetch');
        // eslint-disable-next-line no-console
        console.log('[auth] loadProfile result', { data, error });
        if (!mounted) return;
        if (error) {
          console.error('[auth] loadProfile error', error);
          // 取得失敗時はキャッシュを消さない (オフライン耐性)。前景ロードのみ role/approved を
          // クリア (#6: 従来挙動)。背景更新では現在の表示を維持する。
          if (!background) {
            setRole(null);
            setApproved(null);
          }
          return;
        }
        // 成功: 背景更新はキャッシュ済み値と差分がある時のみ state 反映 (無駄な再描画回避)。
        if (background) {
          const prev = readProfileCache();
          const changed = !prev || prev.userId !== userId
            || JSON.stringify(prev.profile) !== JSON.stringify(data);
          if (changed) applyProfile(data);
        } else {
          applyProfile(data);
        }
        // A: フェッチが権威的に解決した時点で「確定」とする。data===null (profiles 行なし)
        //   も "確定した結果として全既定" なので true にする (ニュートラル表示のまま
        //   固まるのを避ける)。
        setProfileReady(true);
        // #6 修正: 「取得成功時のみ」ロード済み userId を記録する。
        //   こうすると失敗/タイムアウトしたロードは "未ロード" のまま残り、次の focus
        //   再発火で再試行され、customerEditEnabled の false 張り付きが自己回復する。
        loadedUserIdRef.current = userId;
        // loadProfile 成功時は常にキャッシュを上書き保存 (行なしユーザーの null は保存しない)。
        if (data) writeProfileCache(userId, data);
      } catch (e) {
        console.error('[auth] loadProfile exception', e);
        if (!mounted) return;
        // タイムアウト/例外時もキャッシュは消さない (オフライン耐性)。前景のみ role/approved を
        // クリア (#6: 誤ロック防止と両立)。
        if (!background) {
          setRole(null);
          setApproved(null);
        }
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
        const uid = s?.user?.id ?? null;
        sessionUserIdRef.current = uid;
        if (uid) {
          const cached = readProfileCache();
          if (cached && cached.userId === uid && cached.profile) {
            // キャッシュヒット: profiles 往復を待たず即採用して LOADING を解除。
            //   その後バックグラウンドで再検証する (stale-while-revalidate)。
            //   別ユーザーのキャッシュは userId 不一致で自然に無視される。
            applyProfile(cached.profile);
            // A: キャッシュも権威データ扱い (stale の可能性はあるが「未確定」ではない)。
            setProfileReady(true);
            loadedUserIdRef.current = uid;
            setLoading(false);
            // eslint-disable-next-line no-console
            console.log('[auth] profile cache hit → 背景で再検証');
            // await しない (LOADING を止めない)。失敗してもキャッシュ表示を維持。
            loadProfile(uid, { background: true });
          } else {
            // キャッシュ無し / 別ユーザー: 従来通り前景で取得してから LOADING 解除 (finally)。
            await loadProfile(uid);
          }
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
        sessionUserIdRef.current = nextId;
        if (nextId) {
          // #6 修正: 同一ユーザーの再発火 (TOKEN_REFRESHED / フォーカス復帰など) では
          //   profile を再取得しない。ログイン/ユーザー変更/初回ロード時のみ取得。
          //   これにより復帰のたびの再取得失敗で customerEditEnabled が揺れるのを防ぐ。
          if (nextId === loadedUserIdRef.current) return;
          await loadProfile(nextId);
        } else {
          // B (2026-07-29): サインアウト時のリセットを完全化。
          //   従来は role / approved / customerEditEnabled の 3 つしか戻しておらず、
          //   report/meeting/fixed_costs/utilization/category_add/asset_sheet /
          //   card_limit / app_enabled / include_fixed_expenses / initial_asset は
          //   前ユーザーの値が AuthProvider (root・再マウントされない) に残留していた。
          //   → 同一端末で別顧客が再ログインすると、profiles 取得完了までの 1RTT だけ
          //     前顧客のフラグで描画される (誤ロック・誤解放の双方向)。
          //   applyProfile(null) で全列を ?? 既定へ戻す (initial_asset も 0 に戻る)。
          applyProfile(null);
          // A: 次のユーザーの profiles が確定するまで再びニュートラルへ。
          setProfileReady(false);
          loadedUserIdRef.current = null;
          clearProfileCache();
        }
      } catch (e) {
        console.error('[auth] onAuthStateChange loadProfile exception', e);
      }
    });

    // E (2026-07-29): タブ復帰時に profiles を背景で再検証する。
    //   HQ がフラグを変更しても、開きっぱなしのアプリには反映されなかった:
    //     - onAuthStateChange の TOKEN_REFRESHED は loadedUserIdRef 番兵で早期 return
    //       (この return ロジック自体は #6 の意図どおりなので触らない)
    //     - refreshProfile は承認待ち画面の「再確認」ボタンからしか呼ばれない
    //   useClientBudgetRows.js:70-82 / useAnnualBudgets.js:73-83 と同型の DOM イベント
    //   listener を profiles 専用に足して補完する (realtime/subscribe は使わない)。
    //   background:true なので失敗しても現在の表示は壊れず、成功しても差分がある時だけ
    //   再描画される。連打・高速なタブ往復での多重発火は revalidating フラグで抑止。
    let revalidating = false;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const uid = sessionUserIdRef.current;
      if (!uid || revalidating) return;
      revalidating = true;
      loadProfile(uid, { background: true }).finally(() => { revalidating = false; });
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      // eslint-disable-next-line no-console
      console.log('[auth] cleanup');
      mounted = false;
      subscription.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [applyProfile]);

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
    // キャッシュを即時破棄 (onAuthStateChange(SIGNED_OUT) の else 分岐でも破棄されるが、
    //   ここでも消して確実性を上げる)。
    clearProfileCache();
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
        .select(PROFILE_COLUMNS)
        .eq('id', session.user.id)
        .maybeSingle();
      const { data, error } = await withTimeout(q, PROFILE_FETCH_TIMEOUT_MS, 'profiles refresh');
      if (error) {
        console.error('[auth] refreshProfile error', error);
        return;
      }
      // F: 13 行の手書き setter を applyProfile に集約 (msd sync も内包)。
      applyProfile(data);
      setProfileReady(true);
      // 再確認 (承認ポール等) で取得した最新値をキャッシュにも反映しておく。
      if (data) writeProfileCache(session.user.id, data);
    } catch (e) {
      console.error('[auth] refreshProfile exception', e);
    }
  }, [session, applyProfile]);

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
    // A: 機能フラグが確定済みか。App.jsx のロック UI (🔒 / requestFeature / requestEdit) が
    //    false の間はニュートラル表示に倒す。
    profileReady,
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
