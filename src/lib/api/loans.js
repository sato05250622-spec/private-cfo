// loans の CRUD 薄ラッパ。
// アプリ形状 (camelCase) → DB 形状 (snake_case) への変換はこの層で実施。
// pm_id は payment_methods への論理参照 (B-3b 段階1 では FK なし)。
import { supabase } from '../supabaseClient';

const TABLE = 'loans';

// created_at 昇順で取得 (作成順 = 表示順、reorder 機能なし)。
export async function listLoans(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// (client_id, id) 複合 PK で upsert。
// loanDraft の withdrawalDay は <input> 由来の文字列なので空文字列 → null に
// 正規化 (paymentMethods.js と同じ理由、smallint cast 防止)。
// pm_id / bank も空文字列 → null に統一。
export async function upsertLoan(clientId, {
  id, label, amount, bank, withdrawalDay, pmId, legacyKey,
}) {
  const { error } = await supabase
    .from(TABLE)
    .upsert({
      client_id: clientId,
      id,
      label,
      amount: Number(amount) || 0,
      bank: bank || null,
      withdrawal_day: withdrawalDay === '' || withdrawalDay == null ? null : Number(withdrawalDay),
      pm_id: pmId || null,
      legacy_key: legacyKey ?? null,
    });
  if (error) throw error;
}

export async function deleteLoan(clientId, id) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('client_id', clientId)
    .eq('id', id);
  if (error) throw error;
}
