import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GOLD, CARD_BG, BORDER, TEXT_PRIMARY, TEXT_MUTED,
  ORANGE, ORANGE_LIGHT, RED,
} from '@shared/theme';

// 支払い方法編集画面の 1 行。SortableCategoryRow と同じ iOS 長押しドラッグ方式。
// - 行全体に listeners/attributes を付与 → 長押しでドラッグ発動
// - touch-action:none + user-select 無効化で iOS の青い選択 UI / ブラウザ scroll 奪取を抑制
// - 編集/削除ボタンは onMouseDown + onTouchStart + onPointerDown の 3 系統で伝播停止
//   (App 側の sensor が MouseSensor + TouchSensor 構成のため 3 経路を塞ぐ必要あり)
export default function SortablePaymentRow({ pm, onEdit, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: pm.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    display: 'flex',
    alignItems: 'center',
    padding: '14px 18px',
    gap: 12,
    background: CARD_BG,
    borderBottom: `1px solid ${BORDER}`,
    outline: isDragging ? `1px solid ${GOLD}` : 'none',
    outlineOffset: -1,
    boxShadow: isDragging ? '0 6px 24px rgba(0,0,0,0.5)' : 'none',
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 2 : 0,
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    cursor: 'grab',
  };

  const stopPointer = (e) => e.stopPropagation();

  // 銀行 / 締日 / 引落日 を全角スペース区切りで結合(いずれも任意)。
  const subtext = [
    pm.bank && `🏦${pm.bank}`,
    pm.closingDay && `締日：${pm.closingDay}${pm.closingDay !== '末' ? '日' : ''}`,
    pm.withdrawalDay && `引落：${pm.withdrawalDay}${pm.withdrawalDay !== '末' ? '日' : ''}`,
  ].filter(Boolean).join('　');

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      <div style={{ width: 36, height: 36, borderRadius: 8, background: pm.color, flexShrink: 0 }}/>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 14, fontWeight: 400, color: TEXT_PRIMARY }}>{pm.label}</span>
        {subtext && <div style={{ fontSize: 10, color: TEXT_MUTED, marginTop: 2 }}>{subtext}</div>}
      </div>
      <button
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onTouchStart={stopPointer}
        onClick={() => onEdit(pm)}
        style={{
          padding: '6px 14px',
          background: ORANGE_LIGHT,
          border: `1px solid ${ORANGE}`,
          borderRadius: 16,
          color: ORANGE,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
          marginRight: 6,
        }}
      >編集</button>
      <button
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onTouchStart={stopPointer}
        onClick={() => onRemove(pm.id)}
        style={{
          padding: '6px 14px',
          background: '#FFEBEE',
          border: `1px solid ${RED}`,
          borderRadius: 16,
          color: RED,
          fontSize: 12,
          fontWeight: 700,
          cursor: 'pointer',
        }}
      >削除</button>
    </div>
  );
}
