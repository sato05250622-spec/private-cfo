// レシート読取 (Edge Function receipt-ocr) の薄ラッパ。
// 撮影画像をブラウザ側で縮小 → JPEG base64 化してから送る (通信量と Claude の入力サイズを抑える)。
// 画像は Function 側でもメモリ上のみで扱い、どこにも保存されない。
//
// 戻り値は throw せず { data, error, status } で返す。
//   成功: { data: { amount, date, category_id: null, memo }, error: null, status: 200 }
//   失敗: { data: null, error: Error, status }  (status: HTTP ステータス、ネットワーク失敗等は 0)
//   403 + code 'feature_locked' = 有料フラグ OFF (呼び出し側でプラン案内トーストに分岐)。
import { supabase } from '../supabaseClient';

// 2400px: Sonnet 系の高解像度入力 (長辺 2576px まで) を活かしつつ、レシートの小さい文字を潰さない。
const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.85;

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
        // iOS Safari はキャンバスのメモリ解放が遅いので、変換後すぐ 0x0 にして手放す (複数枚読取時の対策)。
        canvas.width = 0;
        canvas.height = 0;
        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
      } catch (e) {
        reject(e);
      } finally {
        URL.revokeObjectURL(url);
        img.src = '';
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

// 複数レシート読取 (確認画面フロー用)。
//   - 1 画像 = 1 リクエスト (mode:"multi" → { receipts:[{amount,date,memo}] })。1 枚に複数レシートが写っていてもよい。
//   - 画像の縮小は 1 枚ずつ直列 (iOS のメモリ対策)。ネットワーク呼び出しは最大 2 本まで並行。
//   - 結果は画像の選択順に結合する。onProgress(完了数, 総数) を 1 画像完了ごとに呼ぶ。
// 戻り値: { receipts: [...], failedImages: 失敗した画像数, locked: 403 feature_locked が 1 つでもあれば true }
// throw しない。
const MULTI_CONCURRENCY = 2;

export async function readReceiptsMulti(files, onProgress) {
  const list = Array.prototype.slice.call(files || []);
  const total = list.length;
  const perImage = new Array(total);
  let failedImages = 0;
  let locked = false;
  let done = 0;
  let next = 0;
  // 縮小処理を直列化するためのロック (前の変換が終わってから次を始める)。
  let convertChain = Promise.resolve();

  const convertSerial = (file) => {
    const p = convertChain.then(() => fileToJpegBase64(file));
    convertChain = p.catch(() => {});
    return p;
  };

  const processOne = async (idx) => {
    try {
      const imageBase64 = await convertSerial(list[idx]);
      const { data, error } = await supabase.functions.invoke('receipt-ocr', {
        body: { image_base64: imageBase64, mime_type: 'image/jpeg', mode: 'multi' },
      });
      if (error) {
        const res = error.context;
        if (res && res.status === 403) locked = true;
        failedImages += 1;
        perImage[idx] = [];
        return;
      }
      if (data?.error) {
        failedImages += 1;
        perImage[idx] = [];
        return;
      }
      perImage[idx] = Array.isArray(data?.receipts) ? data.receipts : [];
    } catch (e) {
      console.error('[receipt-ocr multi]', e);
      failedImages += 1;
      perImage[idx] = [];
    } finally {
      done += 1;
      if (typeof onProgress === 'function') onProgress(done, total);
    }
  };

  const worker = async () => {
    while (next < total) {
      const idx = next;
      next += 1;
      await processOne(idx);
    }
  };

  const workers = [];
  for (let i = 0; i < Math.min(MULTI_CONCURRENCY, total); i++) workers.push(worker());
  await Promise.all(workers);

  const receipts = [];
  for (let i = 0; i < total; i++) {
    const arr = perImage[i] || [];
    for (let j = 0; j < arr.length; j++) receipts.push(arr[j]);
  }
  return { receipts, failedImages, locked };
}
