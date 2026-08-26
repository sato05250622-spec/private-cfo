import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/credentialRequests';

// 認証情報 (メール / パスワード) 変更申請フック。
// useInquiries と同じ流儀:
//   - submitting: 送信中フラグ (UI の disabled + 文言切替用)
//   - error:      直近のエラー (UI 側で表示)
//   - submit():   Promise<boolean> — true=成功 / false=失敗
//     (useAppointments.requestReschedule と同じ boolean 戻り値)
//
// 加えて、承認待ち申請の事前チェックを持つ:
//   - pending:        承認待ちの申請行 or null
//   - pendingLoading: 初回取得中フラグ (フォームを出す前のちらつき防止)
//   顧客は自分の申請を取り消せない (RLS に UPDATE/DELETE ポリシーが無い) ため、
//   pending がある間はフォームを出さず「確認中」を表示する運用にする。
//   409 (pending_exists) は二重防護として submit 側でも受ける。
//
// 現在のメールアドレスは session から取れるので profiles を引き直さない。
// opts.enabled: false の間は pending の取得を行わない。
//   このフックは App 直下で呼ばれるため、常時取得にするとアプリ起動のたびに
//   1 クエリ増える。アカウント設定 / 申請画面を開いている間だけ true にする。
export function useCredentialRequest({ enabled = true } = {}) {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const currentEmail = user?.email ?? '';

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const [pendingLoading, setPendingLoading] = useState(true);

  // 承認待ち申請の取得。画面表示時と申請成功後に呼ぶ。
  const refetchPending = useCallback(async () => {
    if (!userId) {
      setPending(null);
      setPendingLoading(false);
      return;
    }
    setPendingLoading(true);
    try {
      setPending(await api.getPendingRequest(userId));
    } catch (e) {
      // 取得失敗でフォームを塞ぐと申請できなくなるので、pending は null 扱いにして
      // フォームは出す。二重申請は submit 側の 409 で弾かれる。
      console.error('[credentialRequest] pending fetch failed', e);
      setPending(null);
    } finally {
      setPendingLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (!enabled) return;
    refetchPending();
  }, [enabled, refetchPending]);

  // 申請送信。email / password はどちらか一方だけでもよい。
  // 入力検証は Edge Function 側にもあるが、往復を減らすため手前でも同条件で弾く。
  const submit = useCallback(
    async ({ email, password, passwordConfirm }) => {
      if (!userId) return false;

      const nextEmail = (email || '').trim();
      const nextPassword = password || '';

      if (!nextEmail && !nextPassword) {
        setError(new Error('変更したい項目を入力してください'));
        return false;
      }
      if (nextEmail) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail.length > 254) {
          setError(new Error('メールアドレスの形式が正しくありません'));
          return false;
        }
        if (nextEmail.toLowerCase() === currentEmail.toLowerCase()) {
          setError(new Error('現在のメールアドレスと同じです'));
          return false;
        }
      }
      if (nextPassword) {
        if (nextPassword.length < 8) {
          setError(new Error('パスワードは8文字以上にしてください'));
          return false;
        }
        // Supabase Auth は bcrypt。72 バイト超は切り捨てられ、承認後に
        // 「申請したパスワードで入れない」事故になるため手前で弾く。
        if (new TextEncoder().encode(nextPassword).length > 72) {
          setError(new Error('パスワードが長すぎます'));
          return false;
        }
        // 確認用の一致チェックはフロント側のみ (Function は 1 つしか受け取らない)。
        // 承認されると顧客はこのパスワードでしかログインできなくなるため必須。
        if (nextPassword !== passwordConfirm) {
          setError(new Error('パスワードが一致しません'));
          return false;
        }
      }

      setSubmitting(true);
      setError(null);
      try {
        await api.submitCredentialRequest({ email: nextEmail, password: nextPassword });
        await refetchPending(); // 申請直後に pending を反映 → 画面が「確認中」に切り替わる
        return true;
      } catch (e) {
        console.error('[credentialRequest] submit failed', e);
        if (e?.code === 'pending_exists') {
          // 事前チェックをすり抜けた二重申請 (別端末からの申請など)。
          // pending を取り直して画面を「確認中」に寄せる。
          await refetchPending();
        }
        setError(e);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [userId, currentEmail, refetchPending],
  );

  return { currentEmail, submitting, error, setError, pending, pendingLoading, submit, refetchPending };
}
