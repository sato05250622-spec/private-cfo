import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/appointments';

// DB 行 → App 側で使いやすい形。
function toApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    scheduledAt: row.scheduled_at,     // ISO string (UTC)
    durationMin: row.duration_min,
    status: row.status,                // 'scheduled'|'confirmed'|'reschedule_requested'|'cancelled'|'completed'
    requestedAt: row.requested_at,     // 変更希望中の新日時(nullable)
    requestReason: row.request_reason, // 変更理由(nullable)
  };
}

// 次回予定 1 件 + 変更希望送信 を提供するフック。
// - appointment: { id, scheduledAt, ..., status } または null
// - loading: 初回取得中
// - submitting: 変更希望送信中(連打防止)
// - error: 直近のエラー(UI は alert 表示)
// - refetch(): 明示再取得
// - requestReschedule(newLocalDateTime, reason): Promise<boolean>
//     true  = 成功(refetch 済、UI は status='reschedule_requested' に更新)
//     false = 失敗(UI は alert、入力保持)
export function useNextAppointment() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [appointment, setAppointment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!userId) {
      setAppointment(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const row = await api.getNextAppointment(userId);
      setAppointment(toApp(row));
      setError(null);
    } catch (e) {
      setError(e);
      setAppointment(null);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const requestReschedule = useCallback(
    async (newLocalDateTime, reason) => {
      if (!userId || !appointment?.id) return false;
      const text = (reason || '').trim();
      if (!text) return false;
      if (!newLocalDateTime) return false;

      // datetime-local は "YYYY-MM-DDTHH:mm"(TZ なし)。
      // new Date() はブラウザのローカル TZ で解釈 → toISOString() で UTC に。
      const requestedIso = new Date(newLocalDateTime).toISOString();

      setSubmitting(true);
      setError(null);
      try {
        // 意図した 3 カラムだけを送る(RLS 安定化・誤送防止)。
        await api.requestReschedule(appointment.id, {
          status: 'reschedule_requested',
          requested_at: requestedIso,
          request_reason: text,
        });
        await refetch(); // サーバ確定状態を UI に反映
        return true;
      } catch (e) {
        console.error(e);
        setError(e);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [userId, appointment, refetch],
  );

  return { appointment, loading, submitting, error, refetch, requestReschedule };
}
