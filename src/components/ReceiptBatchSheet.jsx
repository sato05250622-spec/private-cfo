import { useEffect, useMemo, useState } from "react";
import { NAVY2, BORDER, TEXT_SECONDARY, TEXT_MUTED } from "@shared/theme";
import { toDateStr } from "@shared/format";

// =============================================================
// ReceiptBatchSheet — レシート読取の確認画面 (ボトムシート)。
//   単発/一括どちらの読取もここを通し、ユーザーが確認・修正してから一括登録する。
//   カテゴリ・支払い方法は入力画面で選択中のものを使う (シート上部に明示)。
//
// props:
//   - reading: boolean            読取中 (progress を表示、行は出さない)
//   - progress: { done, total }   読取済み画像数 / 総数
//   - receipts: [{amount,date,memo}] | null   読取結果 (null = まだ無い)
//   - failedImages: number        読み取れなかった画像数
//   - fallbackDateStr: "YYYY-MM-DD"  日付が範囲外/null の行に入れる日付 (入力画面の inputDate)
//   - categoryLabel / categoryColor / paymentLabel: 登録先の表示用
//   - saving: boolean             登録処理中
//   - onConfirm(rows)             rows: [{ amount:number, date:"YYYY-MM-DD", memo:string }]
//   - onClose()
// =============================================================

const NAVY = "#0D1E36";
const GOLD = "#D4A843";
const TEXT_PRIMARY = "#F0EAD6";
const RED = "#FF5252";

// 読取日が「今日〜60 日前」の実在日なら "YYYY-MM-DD"、それ以外は null。
function dateInRange(v) {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const local = new Date(y, mo - 1, d);
  if (local.getFullYear() !== y || local.getMonth() !== mo - 1 || local.getDate() !== d) return null;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const minDate = new Date(todayStart); minDate.setDate(minDate.getDate() - 60);
  if (local < minDate || local > todayStart) return null;
  return toDateStr(local);
}

// 金額文字列 → 正の整数 or null。
function parseAmount(s) {
  const cleaned = String(s ?? "").replace(/[^\d]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

let rowSeq = 0;

export default function ReceiptBatchSheet({
  reading,
  progress,
  receipts,
  failedImages,
  fallbackDateStr,
  categoryLabel,
  categoryColor,
  paymentLabel,
  saving,
  onConfirm,
  onClose,
}) {
  const [rows, setRows] = useState([]);

  // 読取結果が届いたら編集用の行に変換 (日付ルールを適用)。
  useEffect(() => {
    if (!Array.isArray(receipts)) { setRows([]); return; }
    setRows(receipts.map((r) => {
      const okDate = dateInRange(r?.date);
      const amt = typeof r?.amount === "number" && r.amount > 0 ? String(Math.round(r.amount)) : "";
      rowSeq += 1;
      return {
        key: rowSeq,
        amount: amt,
        date: okDate || fallbackDateStr,
        dateWarn: !okDate,
        memo: typeof r?.memo === "string" ? r.memo : "",
      };
    }));
    // fallbackDateStr は読取開始時点の値で固定したいので依存に入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipts]);

  const updateRow = (key, patch) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key) => setRows((prev) => prev.filter((r) => r.key !== key));

  const total = useMemo(() => rows.reduce((s, r) => s + (parseAmount(r.amount) || 0), 0), [rows]);
  const hasInvalid = rows.some((r) => parseAmount(r.amount) == null || !r.date);
  const canSubmit = !reading && !saving && rows.length > 0 && !hasInvalid;

  const submit = () => {
    if (!canSubmit) return;
    onConfirm(rows.map((r) => ({ amount: parseAmount(r.amount), date: r.date, memo: r.memo.trim() })));
  };

  const inputBase = {
    background: NAVY,
    border: `1px solid ${BORDER}`,
    borderRadius: 8,
    color: TEXT_PRIMARY,
    fontSize: 16, // iOS のフォーカス時ズーム防止
    padding: "6px 8px",
    outline: "none",
    minWidth: 0,
    boxSizing: "border-box",
  };

  return (
    <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:400,display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
      <div style={{background:NAVY2,borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,maxHeight:"85dvh",display:"flex",flexDirection:"column"}}>
        {/* 上部: 登録先 */}
        <div style={{padding:"16px 20px 12px",borderBottom:`1px solid ${BORDER}`,flexShrink:0}}>
          <div style={{fontSize:12,color:TEXT_SECONDARY,marginBottom:6}}>レシート読取の確認</div>
          <div style={{display:"flex",alignItems:"center",flexWrap:"wrap",gap:6,fontSize:15,fontWeight:700,color:TEXT_PRIMARY}}>
            <span style={{display:"inline-flex",alignItems:"center",gap:6}}>
              <span style={{width:10,height:10,borderRadius:"50%",background:categoryColor || GOLD,flexShrink:0}}/>
              <span style={{color:categoryColor || GOLD}}>{categoryLabel}</span>
            </span>
            <span style={{color:TEXT_MUTED}}>/</span>
            <span>{paymentLabel}</span>
            <span style={{fontWeight:400,fontSize:13,color:TEXT_SECONDARY}}>に登録</span>
          </div>
          {!reading && failedImages > 0 && (
            <div style={{marginTop:8,fontSize:12,color:RED}}>{failedImages}枚の写真が読み取れませんでした</div>
          )}
        </div>

        {/* 一覧 (ここだけスクロール) */}
        <div style={{flex:1,minHeight:0,overflowY:"auto",WebkitOverflowScrolling:"touch",overscrollBehavior:"contain",padding:"10px 14px"}}>
          {reading ? (
            <div style={{padding:"28px 0",textAlign:"center",color:GOLD,fontSize:14}}>
              読み取り中…{progress && progress.total > 0 ? `(${progress.done}/${progress.total}枚)` : ""}
            </div>
          ) : rows.length === 0 ? (
            <div style={{padding:"28px 0",textAlign:"center",color:TEXT_SECONDARY,fontSize:13}}>登録する行がありません</div>
          ) : rows.map((r, i) => {
            const amountMissing = parseAmount(r.amount) == null;
            return (
              <div key={r.key} style={{background:NAVY,border:`1px solid ${amountMissing ? RED : BORDER}`,borderRadius:12,padding:"10px 10px 8px",marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontSize:11,color:TEXT_MUTED,width:16,flexShrink:0}}>{i + 1}</span>
                  <input
                    inputMode="numeric"
                    placeholder="金額"
                    value={r.amount}
                    onChange={(e) => updateRow(r.key, { amount: e.target.value.replace(/[^\d]/g, "") })}
                    style={{...inputBase,width:96,textAlign:"right",border:`1px solid ${amountMissing ? RED : BORDER}`}}
                  />
                  <span style={{fontSize:12,color:TEXT_SECONDARY}}>円</span>
                  <input
                    type="date"
                    value={r.date}
                    onChange={(e) => updateRow(r.key, { date: e.target.value, dateWarn: false })}
                    style={{...inputBase,flex:1,border:`1px solid ${r.dateWarn ? RED : BORDER}`}}
                  />
                  <button
                    aria-label="この行を削除"
                    onClick={() => removeRow(r.key)}
                    style={{flexShrink:0,width:32,height:32,border:"none",background:"transparent",color:TEXT_SECONDARY,fontSize:18,cursor:"pointer"}}
                  >✕</button>
                </div>
                <input
                  placeholder="メモ"
                  value={r.memo}
                  onChange={(e) => updateRow(r.key, { memo: e.target.value })}
                  style={{...inputBase,width:"100%",marginTop:6}}
                />
                {(amountMissing || r.dateWarn) && (
                  <div style={{display:"flex",gap:10,marginTop:5,fontSize:11,color:RED}}>
                    {amountMissing && <span>金額を入力</span>}
                    {r.dateWarn && <span>日付要確認</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 下部固定: 合計 + ボタン */}
        <div style={{flexShrink:0,borderTop:`1px solid ${BORDER}`,padding:"12px 16px",paddingBottom:"calc(16px + env(safe-area-inset-bottom))"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
            <span style={{fontSize:12,color:TEXT_SECONDARY}}>合計{rows.length > 0 ? `(${rows.length}件)` : ""}</span>
            <span style={{fontSize:22,fontWeight:700,color:TEXT_PRIMARY}}>{total.toLocaleString()}<span style={{fontSize:13,fontWeight:400,color:TEXT_SECONDARY,marginLeft:2}}>円</span></span>
          </div>
          <div style={{display:"flex",gap:10}}>
            <button
              onClick={onClose}
              disabled={saving}
              style={{flex:1,height:46,borderRadius:12,border:`1px solid ${BORDER}`,background:"transparent",color:TEXT_SECONDARY,fontSize:15,cursor:saving?"default":"pointer"}}
            >キャンセル</button>
            <button
              onClick={submit}
              disabled={!canSubmit}
              style={{flex:2,height:46,borderRadius:12,border:"none",background:GOLD,color:NAVY,fontSize:15,fontWeight:700,cursor:canSubmit?"pointer":"default",opacity:canSubmit?1:0.4}}
            >{saving ? "登録中…" : `${rows.length}件を登録する`}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
