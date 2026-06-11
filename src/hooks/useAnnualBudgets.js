import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from '../lib/api/annualBudgets';

// =============================================================
// 指定 client の最新年度の繰越票 (committed_*) を取得する read-only hook
// (Phase E 最終ゴール — 顧客アプリ)。
//
// 戻り値 shape: { data, loading, error, refetch }
//   - data: getCommittedByClient の返却 (オブジェクト or null)。
//           last_committed_at が null なら「準備中」、UI 側で判定する。
//
// admin 側 useAnnualBudgets.js は optimistic + ref-mirror の重量実装だが、
// 顧客アプリは閲覧のみのため useState + useEffect + refetch の軽量パターン。
// clientId 変化時に自動再取得 (StrictMode 下の二重実行も冪等)。
// =============================================================
// ③: fiscalYear 省略時は最新年度、指定時はその年度を取得 (年度ダイヤル用)。
export function useAnnualBudgets(clientId, fiscalYear) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(async () => {
    if (!clientId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const row = await api.getCommittedByClient(clientId, fiscalYear);
      // Phase 1: committed_settled_months / Phase 1c: committed_annual_total_target を
      // camelCase でも露出 (UI 側 isSettled 判定 / 全体バー budget 用)。
      // 既存の snake_case フィールドはそのまま温存し、camelCase を追加するのみ。
      setData(
        row
          ? {
              ...row,
              committedSettledMonths: row.committed_settled_months ?? [],
              committedAnnualTotalTarget: row.committed_annual_total_target ?? null,
              // Phase B-3 (2026-06-07): 資産残高繰越票用。admin commitIncomeSnapshot で焼かれた snapshot を露出。
              //   AssetSheetViewer が「準備中」判定 (incomeCommittedAt null) と本体描画 (committedIncomeLines) に使う。
              //   支出側 committedLines も読み出しが増えるため snake_case のままだが camelCase でも露出。
              committedLines: row.committed_lines ?? [],
              committedIncomeLines: row.committed_income_lines ?? [],
              incomeCommittedAt: row.income_committed_at ?? null,
              // Phase 2-2b (2026-06-11): live read 露出。
              //   api.withCamel が既に row へ incomeLines / lines / annualTotalTarget を
              //   camelCase で付与済 (snake_case も ...row 経由で保持)。ここでは hook の
              //   公開キーとして再露出するだけ。新規 API 配備前 (snake_case のみ) も
              //   フォールバックで動くよう ?? 連鎖。
              incomeLines: row.incomeLines ?? row.income_lines ?? [],
              lines: row.lines ?? [],
              annualTotalTarget: row.annualTotalTarget ?? row.annual_total_target ?? null,
              settledMonths: row.settled_months ?? [],
            }
          : null,
      );
      setError(null);
    } catch (e) {
      console.error('[useAnnualBudgets]', e);
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [clientId, fiscalYear]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // 修正2(a): アプリ/タブに復帰したとき (focus / visibility=visible) に最新化。
  //   本部が「反映」した後、顧客が画面を開いたまま (mount/clientId/fiscalYear 不変) でも
  //   復帰時に refetch して committed_* の更新を取り込む。clientId 無しは何もしない。
  useEffect(() => {
    if (!clientId) return undefined;
    const onFocus = () => { refetch(); };
    const onVisible = () => { if (document.visibilityState === "visible") refetch(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [clientId, refetch]);

  // =============================================================
  // Phase 2-2b (2026-06-11): 顧客直接編集 writer。
  //   admin リポ src/hooks/useAnnualBudgets.js の income_lines setter 群を
  //   single-data 形 (data + dataRef) に翻案して移植。
  //
  //   楽観 update + rollback パターン:
  //     1) dataRef.current から現 incomeLines 取得
  //     2) 純関数で next 配列を構築 (map / spread / filter のみ)
  //     3) setData で local 即時反映 (incomeLines / income_lines 両キーを更新)
  //     4) api.updateIncomeLines を await
  //     5) 失敗時 setData(prev) で rollback + refetch で DB 再同期 + re-throw
  //
  //   行 shape (admin と完全一致):
  //     { id, row_type:'income', category_name, target_value,
  //       monthly_actuals:number[0..11], monthly_targets:number[0..11] }
  //   ★ income line の月配列は fiscal idx 0..11 (暦月キー jsonb ではない)。
  //
  //   ※ Phase 2-3 の RLS (annual_budgets_client_update_own) 適用済 DB 前提。
  //      未適用 DB では updateIncomeLines / setInitialAsset は RLS 拒否される。
  // =============================================================

  // 最新 data の ref (setter 内から最新値を読むため)。
  const dataRef = useRef(null);
  useEffect(() => { dataRef.current = data; }, [data]);

  // dataRef から income_lines を取り出すヘルパ (配列保証)。
  // withCamel 後は incomeLines が正だが、snake_case フォールバックも残す。
  const _getIncomeLines = () => {
    const d = dataRef.current;
    if (Array.isArray(d?.incomeLines)) return d.incomeLines;
    if (Array.isArray(d?.income_lines)) return d.income_lines;
    return [];
  };

  // 共通: income_lines を api.updateIncomeLines で永続化 + data state を optimistic 更新 + 失敗 rollback。
  const _persistIncomeLines = useCallback(async (fy, nextLines) => {
    if (!clientId) throw new Error('clientId required');
    if (fy == null) throw new Error('fiscalYear required');
    const prev = dataRef.current;
    // optimistic: data の incomeLines / income_lines 両キーを同時に書き換え (新旧 reader 両対応)
    setData((d) => (d ? { ...d, incomeLines: nextLines, income_lines: nextLines } : d));
    try {
      await api.updateIncomeLines(clientId, fy, nextLines);
    } catch (e) {
      console.error('[_persistIncomeLines] failed', e);
      setData(prev); // rollback
      refetch().catch(() => {});
      throw e;
    }
  }, [clientId, refetch]);

  // 末尾に新規収入行を push (admin と shape 完全一致)。
  const addIncomeRow = useCallback(async (fy) => {
    const current = _getIncomeLines();
    const newRow = {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `inc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      row_type: 'income',
      category_name: '',
      target_value: 0,
      monthly_actuals: Array(12).fill(0),
      monthly_targets: Array(12).fill(0),
    };
    await _persistIncomeLines(fy, [...current, newRow]);
  }, [_persistIncomeLines]);

  // id で行削除 (filter で immutable)。
  const removeIncomeRow = useCallback(async (fy, lineId) => {
    const current = _getIncomeLines();
    const next = current.filter((l) => l?.id !== lineId);
    await _persistIncomeLines(fy, next);
  }, [_persistIncomeLines]);

  // 該当行の category_name 更新 (map + spread)。
  const setIncomeLineName = useCallback(async (fy, lineId, name) => {
    const current = _getIncomeLines();
    const next = current.map((l) => (
      l?.id === lineId ? { ...l, category_name: name ?? '' } : l
    ));
    await _persistIncomeLines(fy, next);
  }, [_persistIncomeLines]);

  // 該当行の monthly_actuals[monthIdx] を更新 (monthIdx は fiscal idx 0..11)。
  //   配列が短ければ末尾を 0 で埋めて長さ 12 を保証 (admin と同パターン)。
  const setIncomeMonthlyActual = useCallback(async (fy, lineId, monthIdx, value) => {
    const current = _getIncomeLines();
    const v = Number(value);
    const safe = Number.isFinite(v) ? v : 0;
    const idx = Number(monthIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 11) return;
    const next = current.map((l) => {
      if (l?.id !== lineId) return l;
      const arr = Array.isArray(l.monthly_actuals) ? [...l.monthly_actuals] : Array(12).fill(0);
      while (arr.length < 12) arr.push(0);
      arr[idx] = safe;
      return { ...l, monthly_actuals: arr };
    });
    await _persistIncomeLines(fy, next);
  }, [_persistIncomeLines]);

  // 該当行の monthly_targets[monthIdx] を更新 (setIncomeMonthlyActual のミラー)。
  const setIncomeMonthlyTarget = useCallback(async (fy, lineId, monthIdx, value) => {
    const current = _getIncomeLines();
    const v = Number(value);
    const safe = Number.isFinite(v) ? v : 0;
    const idx = Number(monthIdx);
    if (!Number.isInteger(idx) || idx < 0 || idx > 11) return;
    const next = current.map((l) => {
      if (l?.id !== lineId) return l;
      const arr = Array.isArray(l.monthly_targets) ? [...l.monthly_targets] : Array(12).fill(0);
      while (arr.length < 12) arr.push(0);
      arr[idx] = safe;
      return { ...l, monthly_targets: arr };
    });
    await _persistIncomeLines(fy, next);
  }, [_persistIncomeLines]);

  // profiles.initial_asset を更新。
  //   ※ UI 反映導線は要相談:
  //     - 顧客アプリでは initialAsset は useAuth() 由来 (login 時に profiles 読み込み)。
  //     - この setter は API を呼ぶだけで、useAuth の state は自動更新されない。
  //     - 後段 (Phase 2-4 UI) で以下のどれかを採用想定:
  //         (a) AssetSheetViewer 側で local mirror state (setLocalInitialAsset(v)) を持ち、
  //             書込成功時に local 反映 + 次回 reload 時に useAuth が DB から再取得
  //         (b) useAuth 側に refreshInitialAsset() を追加して呼び出す
  //         (c) 専用 useProfile 系 hook を新設
  //     どの方針を取るかは UI 着手時に決定。本 hook は副作用を持たず純粋に API を叩く。
  const setInitialAsset = useCallback(async (value) => {
    if (!clientId) throw new Error('clientId required');
    try {
      const row = await api.setInitialAsset(clientId, value);
      return row;
    } catch (e) {
      console.error('[setInitialAsset] failed', e);
      throw e;
    }
  }, [clientId]);

  return {
    data, loading, error, refetch,
    // Phase 2-2b: 資産残高繰越票 writer 群 (顧客直接編集用)。
    addIncomeRow, removeIncomeRow, setIncomeLineName,
    setIncomeMonthlyActual, setIncomeMonthlyTarget,
    setInitialAsset,
  };
}
