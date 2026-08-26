// credential_change_requests (認証情報変更申請) の薄ラッパ。
// 顧客アプリでは「申請の送信」と「自分の承認待ち申請の確認」の 2 つだけ使う。
//
// 申請の送信は Edge Function 経由。テーブルへ直接 INSERT しないのは、
// パスワードを AES-GCM で暗号化する処理が Function 内にあるため
// (鍵はブラウザに配らない)。
//
// 承認待ちの確認は RLS ccr_client_select_own (client_id = auth.uid()) が
// あるので通常の SELECT で読める。Function を経由する必要はない。
import { supabase } from '../supabaseClient';

const TABLE = 'credential_change_requests';

// 自分の承認待ち申請を 1 件取得 (無ければ null)。
// 顧客は同時に 1 件しか申請できない (submit 側が 409 で弾く) ため limit 1 で足りる。
export async function getPendingRequest(clientId) {
  if (!clientId) return null;
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, requested_email, created_at')
    .eq('client_id', clientId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// 認証情報変更を申請する。
// email / password は片方だけでもよい (空文字は送信対象から除外)。
//
// supabase.functions.invoke のエラーは 2 系統に分かれるので両方を見る:
//   - error       : network / HTTP レベルの失敗
//   - data.error  : Function が返した論理エラー ({error, code?, detail?})
// 呼び出し側が 409 を判別できるよう、throw する Error に code を載せる
// (code === 'pending_exists' が「すでに申請中」)。
export async function submitCredentialRequest({ email, password }) {
  const body = {};
  if (email) body.email = email;
  if (password) body.password = password;
  if (Object.keys(body).length === 0) {
    throw new Error('変更したい項目を入力してください');
  }

  const { data, error } = await supabase.functions.invoke(
    'submit-credential-request',
    { body },
  );

  if (error) {
    // FunctionsHttpError の場合、本文の {error, code} は data 側に載ることがある。
    // message を優先しつつ、data から code を拾えるなら拾う。
    const err = new Error(data?.error || error.message || '申請の送信に失敗しました');
    if (data?.code) err.code = data.code;
    throw err;
  }
  if (data?.error) {
    const err = new Error(data.detail ? `${data.error}: ${data.detail}` : data.error);
    if (data.code) err.code = data.code;
    throw err;
  }
  return data; // { ok: true, requestId, createdAt }
}
