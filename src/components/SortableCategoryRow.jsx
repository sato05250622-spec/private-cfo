import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GOLD, CARD_BG, BORDER, TEXT_PRIMARY, TEXT_MUTED,
  ORANGE, ORANGE_LIGHT, RED,
} from '@shared/theme';

// カテゴリ編集画面の 1 行。ドラッグハンドル ☰ を左端に持ち、
// 行全体を useSortable の setNodeRef にバインドする。
// CatSvgIcon は App.jsx 内のみで定義されているため、
// 呼び出し側から描画済み JSX を `icon` プロパティで受け取る。
export default function SortableCategoryRow({ cat, icon, onEdit, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cat.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    display: 'flex',
    alignItems: 'center',
    padding: '12px 18px',
    gap: 12,
    background: CARD_BG,
    borderBottom: `1px solid ${BORDER}`,
    // 既存の borderBottom を潰さないよう、ドラッグ中の強調は outline で行う
    outline: isDragging ? `1px solid ${GOLD}` : 'none',
    outlineOffset: -1,
    boxShadow: isDragging ? '0 6px 24px rgba(0,0,0,0.5)' : 'none',
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 2 : 0,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <span
        {...listeners}
        {...attributes}
        // touchAction: 'none' は dnd-kit 必須 (iOS スクロールとの競合回避)
        style={{
          cursor: 'grab',
          color: TEXT_MUTED,
          fontSize: 18,
          touchAction: 'none',
          padding: '4px 2px',
          userSelect: 'none',
          lineHeight: 1,
        }}
        aria-label="並び替え"
      >☰</span>
      {icon}
      <span style={{ flex: 1, fontSize: 14, fontWeight: 400, color: TEXT_PRIMARY }}>{cat.label}</span>
      <button
        onClick={() => onEdit(cat)}
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
        onClick={() => onRemove(cat.id)}
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
