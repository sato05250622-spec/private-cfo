import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  GOLD, CARD_BG, BORDER, TEXT_PRIMARY,
  ORANGE, ORANGE_LIGHT, RED,
} from '@shared/theme';

// カテゴリ編集画面の 1 行。iOS 長押しドラッグ方式。
// - ≡ ハンドルは廃止(iOS でテキスト選択 UI が出る問題のため)
// - 行全体に listeners/attributes を付与 → 長押しでドラッグ発動
// - userSelect/WebkitUserSelect/WebkitTouchCallout を無効化 → 青いコピー/選択 UI を抑止
// - 編集/削除ボタンは onPointerDown で伝播停止 → ボタンタップで誤ドラッグしない
// CatSvgIcon は呼び出し側から描画済み JSX を `icon` プロパティで受け取る。
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
    outline: isDragging ? `1px solid ${GOLD}` : 'none',
    outlineOffset: -1,
    boxShadow: isDragging ? '0 6px 24px rgba(0,0,0,0.5)' : 'none',
    opacity: isDragging ? 0.9 : 1,
    zIndex: isDragging ? 2 : 0,
    // iOS touch 競合対策:
    // - touch-action:'pan-y' で縦スクロールはブラウザに残し、pinch / 長押しコンテキストメニューだけ抑止。
    //   'none' にすると親スクロールまで奪い「中央行で縦スワイプしてもスクロールしない」バグが出る。
    //   ドラッグ活性化は App 側 TouchSensor の delay(250ms)+ tolerance(5px)で差別化する。
    // - user-select / TouchCallout は iOS の青いテキスト選択 UI・コピーメニューを抑止するため残す。
    touchAction: 'pan-y',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    WebkitTouchCallout: 'none',
    cursor: 'grab',
  };

  // 編集/削除ボタンのタップが行のドラッグセンサーに伝播するのを止める。
  // App 側が MouseSensor + TouchSensor を使うようになったため、pointer だけでなく
  // mousedown / touchstart も捕まえる必要がある(pointer 系とは別系統のイベントなので)。
  const stopPointer = (e) => e.stopPropagation();

  return (
    <div ref={setNodeRef} style={style} {...listeners} {...attributes}>
      {icon}
      <span style={{ flex: 1, fontSize: 14, fontWeight: 400, color: TEXT_PRIMARY }}>{cat.label}</span>
      <button
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onTouchStart={stopPointer}
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
        onPointerDown={stopPointer}
        onMouseDown={stopPointer}
        onTouchStart={stopPointer}
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
