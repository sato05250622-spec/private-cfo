// payment_methods の CRUD 薄ラッパ。
// アプリ形状 (camelCase) → DB 形状 (snake_case) への変換はこの層で実施。
// admin ロールは RLS `is_admin()` で全行を触れるため、いずれの操作も
// `client_id` フィルタを必ず先頭に含める (categories.js / budgets.js と同じ運用)。
import { supabase } from '../supabaseClient';

const TABLE = 'payment_methods';

// sort_order 昇順で取得。アプリ側は配列順 = 並び順として扱う。
export async function listPaymentMethods(clientId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// (client_id, id) 複合 PK で upsert。
export async function upsertPaymentMethod(clientId, {
  id, label, color, closingDay, withdrawalDay, bank, sortOrder, legacyKey,
}) {
  const { error } = await supabase
    .from(TABLE)
    .upsert({
      client_id: clientId,
      id,
      label,
      color: color ?? null,
      closing_day: closingDay ?? null,
      withdrawal_day: withdrawalDay ?? null,
      bank: bank ?? null,
      sort_order: sortOrder ?? 0,
      legacy_key: legacyKey ?? null,
    });
  if (error) throw error;
}

export async function deletePaymentMethod(clientId, id) {
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('client_id', clientId)
    .eq('id', id);
  if (error) throw error;
}

// drag-drop 完了時に呼ぶ。orderedIds の index を sort_order として
// 1 行ずつ並列 UPDATE。件数は通常 <10 のため Promise.all で十分。
export async function reorderPaymentMethods(clientId, orderedIds) {
  await Promise.all(orderedIds.map((id, i) =>
    supabase
      .from(TABLE)
      .update({ sort_order: i })
      .eq('client_id', clientId)
      .eq('id', id)
      .then(({ error }) => { if (error) throw error; })
  ));
}
