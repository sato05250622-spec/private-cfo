import {
  NAVY, NAVY2, GOLD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
  TEAL,
} from '@shared/theme';
import { useNextAppointment } from '../hooks/useAppointments';

const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ISO → "YYYY/MM/DD(曜) HH:mm" 表示
// タスク (2026-06-08): App.jsx メニュー「面談予定」行のサブ日時表示でも再利用するため export。
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${dd}(${JA_WEEKDAYS[d.getDay()]}) ${hh}:${mm}`;
}

export default function AppointmentCard({ onBack }) {
  // #4-D (2026-06-03): リスケ機能を顧客アプリから撤去。LINE 経由に一本化。
  //   ボタン/モーダル/送信 handler を削除し、useNextAppointment の {submitting, requestReschedule}
  //   は destructure しない (未使用警告回避)。useAppointments.js 側のラッパ実装は残置 (legacy互換)。
  //   ステータスバッジは既存通り表示 (legacy reschedule_requested 行があれば「変更希望中」を表示)。
  const { appointment, loading } = useNextAppointment();

  const status = appointment?.status ?? null;
  const isPending = status === 'reschedule_requested';

  return (
    <div style={{ minHeight: '100dvh', background: NAVY }}>
      <div style={{ background: NAVY2, padding: '13px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: `1px solid ${BORDER}`, position: 'sticky', top: 0, zIndex: 10, boxShadow: SHADOW }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', color: GOLD, fontSize: 20, cursor: 'pointer' }}>‹</button>
        <span style={{ fontWeight: 600, fontSize: 15, color: TEXT_PRIMARY }}>面談予定</span>
        <span style={{ width: 40 }} />
      </div>

      <div style={{ padding: 16 }}>
        {loading && (
          <div style={{ textAlign: 'center', color: TEXT_MUTED, fontSize: 12, padding: 40 }}>LOADING…</div>
        )}

        {!loading && !appointment && (
          <div style={{ background: CARD_BG, borderRadius: 14, border: `1px solid ${BORDER}`, padding: '32px 20px', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🤝</div>
            <div style={{ fontSize: 14, color: TEXT_PRIMARY, fontWeight: 600, marginBottom: 8 }}>次回の面談はまだ設定されていません</div>
            <div style={{ fontSize: 11, color: TEXT_MUTED, lineHeight: 1.7 }}>本部からの連絡をお待ちください。</div>
          </div>
        )}

        {!loading && appointment && (
          <div style={{ background: CARD_BG, borderRadius: 14, border: `1px solid ${BORDER}`, overflow: 'hidden' }}>
            <div style={{ padding: '16px 18px', borderBottom: `1px solid ${BORDER}` }}>
              <div style={{ fontSize: 10, color: TEXT_MUTED, marginBottom: 6, letterSpacing: '0.1em' }}>次回の面談</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: TEXT_PRIMARY }}>{fmtDateTime(appointment.scheduledAt)}</div>
              <div style={{ fontSize: 11, color: TEXT_SECONDARY, marginTop: 4 }}>所要時間: 約 {appointment.durationMin} 分</div>
            </div>

            <div style={{ padding: '12px 18px' }}>
              {status === 'scheduled' && (
                <span style={{ fontSize: 10, background: `${GOLD}22`, color: GOLD, borderRadius: 4, padding: '3px 8px', fontWeight: 600 }}>通常予定</span>
              )}
              {status === 'confirmed' && (
                <span style={{ fontSize: 10, background: `${TEAL}22`, color: TEAL, borderRadius: 4, padding: '3px 8px', fontWeight: 600 }}>確定済</span>
              )}
              {isPending && (
                <div>
                  <span style={{ fontSize: 10, background: '#F59E0B22', color: '#F59E0B', borderRadius: 4, padding: '3px 8px', fontWeight: 600 }}>🟡 変更希望中(本部対応待ち)</span>
                  <div style={{ marginTop: 10, padding: '10px 12px', background: NAVY2, borderRadius: 8, fontSize: 12, color: TEXT_SECONDARY, lineHeight: 1.6 }}>
                    <div>希望日時: <span style={{ color: TEXT_PRIMARY, fontWeight: 600 }}>{fmtDateTime(appointment.requestedAt)}</span></div>
                    {appointment.requestReason && <div style={{ marginTop: 4 }}>理由: {appointment.requestReason}</div>}
                  </div>
                </div>
              )}
            </div>

            {/* #4-D: 旧「日程を変更したい」ボタン & モーダルを削除。
                LINE 経由で本部にご連絡いただく運用に一本化。注記スタイルで控えめに表示。 */}
            <div style={{ padding: '12px 18px 18px', textAlign: 'center' }}>
              <span style={{ fontSize: 11, color: TEXT_MUTED, lineHeight: 1.6 }}>
                日程変更はLINEにてご連絡ください
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
