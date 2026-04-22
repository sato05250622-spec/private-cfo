import { useCallback, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import * as api from '../lib/api/inquiries';

// 有効な種別(App.jsx の contactType と同じ集合)。
// 未知の値が来た場合は 'other' にフォールバックする。
const VALID_TYPES = new Set(['inquiry', 'bug', 'request', 'other']);

// 問い合わせ送信フック。
// - Day 4 Phase 2 は送信のみ実装。履歴表示は Phase 1 以降で追加。
// - submitting: 送信中フラグ(UI の disabled + 文言切替用)
// - error: 直近の送信エラー(UI は alert で表示)
// - sendInquiry(contactType, contactText): Promise<boolean>
//     true  = 送信成功(UI が setContactSent(true) に遷移)
//     false = 失敗(UI は alert を出し、入力はそのまま残す)
//
// body 整形ルール:
//   "[inquiry] <本文>"  ← 半角大括弧 + 末尾スペース 1 つ + 本文
//   admin 側は `where body like '[bug]%'` 等で種別抽出する前提。
export function useInquiries() {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const sendInquiry = useCallback(
    async (contactType, contactText) => {
      if (!userId) return false;
      const text = (contactText || '').trim();
      if (!text) return false;

      const type = VALID_TYPES.has(contactType) ? contactType : 'other';
      const body = `[${type}] ${text}`;

      setSubmitting(true);
      setError(null);
      try {
        await api.insertInquiry({ client_id: userId, body });
        return true;
      } catch (e) {
        console.error(e);
        setError(e);
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [userId],
  );

  return { submitting, error, sendInquiry };
}
