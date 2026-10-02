// レシート読取 (Edge Function receipt-ocr) の薄ラッパ。
// 撮影画像をブラウザ側で縮小 → JPEG base64 化してから送る (通信量と Claude の入力サイズを抑える)。
// 画像は Function 側でもメモリ上のみで扱い、どこにも保存されない。
//
// 戻り値は throw せず { data, error, status } で返す。
//   成功: { data: { amount, date, category_id: null, memo }, error: null, status: 200 }
//   失敗: { data: null, error: Error, status }  (status: HTTP ステータス、ネットワーク失敗等は 0)
//   403 + code 'feature_locked' = 有料フラグ OFF (呼び出し側でプラン案内トーストに分岐)。
import { supabase } from '../supabaseClient';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.8;

// File → 長辺 MAX_EDGE 以下の JPEG base64 (data URL 接頭辞なし)。
function fileToJpegBase64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('画像を読み込めませんでした'));
    };
    img.src = url;
  });
}

// supabase.functions.invoke のエラーは 2 系統 (credentialRequests.js と同じ扱い):
//   - error       : network / HTTP レベルの失敗。HTTP 失敗 (FunctionsHttpError) は
//                   error.context に Response が載るので、status と本文 {error} をそこから拾う。
//   - data.error  : Function が 200 で返した論理エラー (現仕様では無いが念のため)。
export async function readReceipt(file) {
  let imageBase64;
  try {
    imageBase64 = await fileToJpegBase64(file);
  } catch (e) {
    return { data: null, error: e, status: 0 };
  }

  const { data, error } = await supabase.functions.invoke('receipt-ocr', {
    body: { image_base64: imageBase64, mime_type: 'image/jpeg' },
  });

  if (error) {
    const res = error.context;
    const status = typeof res?.status === 'number' ? res.status : 0;
    let body = data ?? null;
    if (!body && res && typeof res.json === 'function') {
      body = await res.json().catch(() => null);
    }
    const err = new Error(body?.error || error.message || 'レシートの読み取りに失敗しました');
    if (body?.error) err.code = body.error; // 'feature_locked' 等
    return { data: null, error: err, status };
  }
  if (data?.error) {
    const err = new Error(data.error);
    err.code = data.error;
    return { data: null, error: err, status: 200 };
  }
  return { data, error: null, status: 200 };
}
