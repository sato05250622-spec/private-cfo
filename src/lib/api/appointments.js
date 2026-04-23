// appointments テーブルの薄い CRUD(client 側用途に限定)。
// client は SELECT と変更希望の UPDATE しかしない。INSERT / DELETE は admin のみ。
import { supabase } from '../supabaseClient';

const TABLE = 'appointments';

// 次回の予定 1 件を取得。
// - scheduled_at が「現在以降」
// - status が scheduled / confirmed / reschedule_requested のいずれか
//   (cancelled / completed は除外 = 「次回」と呼ばない)
// - scheduled_at 昇順で先頭 1 件のみ
// 0 件なら null を返す。
export async function getNextAppointment(clientId) {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('client_id', clientId)
    .gte('scheduled_at', nowIso)
    .in('status', ['scheduled', 'confirmed', 'reschedule_requested'])
    .order('scheduled_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

// 変更希望 UPDATE。
// 呼び出し側は status / requested_at / request_reason の 3 カラムだけを含む
// patch を渡す(他カラムは送らない = RLS 安定化 + 意図しない書き換え防止)。
export async function requestReschedule(id, patch) {
  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}
