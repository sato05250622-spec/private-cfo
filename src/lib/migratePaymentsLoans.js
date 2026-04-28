// =============================================================
// B-3b Step 5: payment_methods / loans の localStorage → Supabase 移行。
//
// AuthGate ログイン後、App.jsx の useEffect から 1 回だけ呼ぶ。
// 冪等: cfo_paymentsLoansMigrated === "1" フラグで二重実行防止 + idempotent upsert。
// 失敗は throw せず console.warn で続行 (B-3a と同方針、UX 阻害しない)。
// =============================================================
import * as paymentMethodsApi from './api/paymentMethods';
import * as loansApi from './api/loans';

const FLAG_KEY = 'cfo_paymentsLoansMigrated';
const PM_KEY = 'cfo_paymentMethods';
const LOANS_KEY = 'cfo_loans';

// useLocalStorage 旧 default と互換 (App.jsx L262 の元 default 値)
const DEFAULT_CASH = { id: 'cash', label: '現金', color: '#4CAF50' };

function readLocalArray(key) {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[migrate] localStorage parse failed for ${key}, treating as empty`, e);
    return [];
  }
}

// 戻り値: { skipped, reason?, pmWritten, loanWritten, pmFailed, loanFailed }
export async function migratePaymentsLoans(userId) {
  if (!userId) return { skipped: true, reason: 'no-userId' };
  if (typeof window === 'undefined') return { skipped: true, reason: 'no-window' };
  if (window.localStorage.getItem(FLAG_KEY) === '1') {
    return { skipped: true, reason: 'already-migrated' };
  }

  const localPMs = readLocalArray(PM_KEY);
  const localLoans = readLocalArray(LOANS_KEY);

  // PM seeding strategy (user 仕様):
  //   - localStorage にデータあり → 全部 upsert
  //   - localStorage 空 かつ DB 空 → DEFAULT_CASH を 1 件 seed
  //   - localStorage 空 かつ DB データあり → 何もしない (PM_KEY 不在の客は触らない)
  let pmsToWrite;
  if (localPMs.length > 0) {
    pmsToWrite = localPMs;
  } else {
    let dbEmpty = false;
    try {
      const dbRows = await paymentMethodsApi.listPaymentMethods(userId);
      dbEmpty = dbRows.length === 0;
    } catch (e) {
      console.warn('[migrate] PM list failed (default seed skip, safe fallback)', e);
      dbEmpty = false;
    }
    pmsToWrite = dbEmpty ? [DEFAULT_CASH] : [];
  }

  let pmWritten = 0, pmFailed = 0;
  for (let i = 0; i < pmsToWrite.length; i++) {
    const pm = pmsToWrite[i];
    try {
      await paymentMethodsApi.upsertPaymentMethod(userId, {
        id: pm.id,
        label: pm.label,
        color: pm.color,
        closingDay: pm.closingDay,
        withdrawalDay: pm.withdrawalDay,
        bank: pm.bank,
        sortOrder: i,
        legacyKey: pm.id,
      });
      pmWritten++;
    } catch (e) {
      console.warn('[migrate] PM upsert failed', pm.id, e);
      pmFailed++;
    }
  }

  // loans: default seed 不要 (空配列が valid な初期状態)
  let loanWritten = 0, loanFailed = 0;
  for (const loan of localLoans) {
    try {
      await loansApi.upsertLoan(userId, {
        id: loan.id,
        label: loan.label,
        amount: loan.amount,
        bank: loan.bank,
        withdrawalDay: loan.withdrawalDay,
        pmId: loan.pmId,
        legacyKey: loan.id,
      });
      loanWritten++;
    } catch (e) {
      console.warn('[migrate] loan upsert failed', loan.id, e);
      loanFailed++;
    }
  }

  // 全ループ完了でフラグセット (途中失敗は console.warn で記録済、UX 阻害しない)
  window.localStorage.setItem(FLAG_KEY, '1');
  console.log('[migrate] payments/loans migration done', {
    localPMs: localPMs.length, localLoans: localLoans.length,
    pmWritten, pmFailed, loanWritten, loanFailed,
  });

  return { skipped: false, pmWritten, pmFailed, loanWritten, loanFailed };
}
