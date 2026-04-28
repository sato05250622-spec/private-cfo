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
      bank: bank ?? null,
      withdrawal_day: withdrawalDay ?? null,
      pm_id: pmId ?? null,
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
