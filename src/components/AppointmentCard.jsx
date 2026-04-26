import { useState } from 'react';
import {
  NAVY, NAVY2, GOLD, GOLD_GRAD,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
  TEAL,
} from '@shared/theme';
import { useNextAppointment } from '../hooks/useAppointments';

const JA_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

// ISO → "YYYY/MM/DD(曜) HH:mm" 表示
function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}/${m}/${dd}(${JA_WEEKDAYS[d.getDay()]}) ${hh}:${mm}`;
}

// datetime-local の value 初期値 / min 用。ローカル TZ の "YYYY-MM-DDTHH:mm"
function nowLocalStr() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d - tz).toISOString().slice(0, 16);
}

export default function AppointmentCard({ onBack }) {
  const { appointment, loading, submitting, requestReschedule } = useNextAppointment();
  const [showModal, setShowModal] = useState(false);
  const [newDateTime, setNewDateTime] = useState('');
  const [reason, setReason] = useState('');

  const status = appointment?.status ?? null;
  const canRequest = status === 'scheduled' || status === 'confirmed';
  const isPending = status === 'reschedule_requested';

  const openModal = () => {
    setNewDateTime(nowLocalStr());
    setReason('');
    setShowModal(true);
  };

  const onSubmit = async () => {
    if (submitting || !newDateTime || !reason.trim()) return;
    const ok = await requestReschedule(newDateTime, reason);
    if (ok) {
      setShowModal(false);
    } else {
      alert('変更希望の送信に失敗しました。通信状況を確認し、もう一度お試しください。');
    }
  };

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

            {canRequest && (
              <div style={{ padding: '12px 18px 18px' }}>
                <button
                  onClick={openModal}
                  style={{ width: '100%', padding: 14, background: GOLD_GRAD, color: '#0A1628', border: 'none', borderRadius: 24, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
                >
                  日程を変更したい
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: 430, background: NAVY, borderTopLeftRadius: 20, borderTopRightRadius: 20, border: `1px solid ${BORDER}`, padding: '20px 18px 24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: TEXT_PRIMARY }}>日程変更希望</span>
              <button onClick={() => setShowModal(false)} style={{ background: 'none', border: 'none', color: TEXT_SECONDARY, fontSize: 18, cursor: 'pointer' }}>✕</button>
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: TEXT_SECONDARY, marginBottom: 14 }}>
              新しい希望日時
              <input
                type="datetime-local"
                value={newDateTime}
                onChange={(e) => setNewDateTime(e.target.value)}
                min={nowLocalStr()}
                style={{ padding: '10px 12px', background: NAVY2, color: TEXT_PRIMARY, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', colorScheme: 'dark' }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11, color: TEXT_SECONDARY, marginBottom: 18 }}>
              変更理由(必須)
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="例:当日出張が入りました"
                rows={4}
                style={{ padding: '10px 12px', background: NAVY2, color: TEXT_PRIMARY, border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, outline: 'none', resize: 'none', fontFamily: 'inherit' }}
              />
            </label>

            <button
              onClick={onSubmit}
              disabled={submitting || !newDateTime || !reason.trim()}
              style={{
                width: '100%',
                padding: 14,
                background: !submitting && newDateTime && reason.trim() ? GOLD_GRAD : 'rgba(255,255,255,0.1)',
                color: !submitting && newDateTime && reason.trim() ? '#0A1628' : TEXT_MUTED,
                border: 'none',
                borderRadius: 24,
                fontSize: 14,
                fontWeight: 700,
                cursor: submitting ? 'wait' : ((newDateTime && reason.trim()) ? 'pointer' : 'default'),
              }}
            >
              {submitting ? '送信中…' : '送信する'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
