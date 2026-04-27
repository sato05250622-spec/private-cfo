import { useCallback, useState, useMemo, useRef } from "react";
import { PieChart, Pie, Cell, BarChart, Bar, LineChart, Line, AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import {
  GOLD, GOLD_LIGHT, GOLD_GRAD,
  NAVY, NAVY2, NAVY3, CREAM,
  RED, TEAL,
  CARD_BG, BORDER, SHADOW,
  TEXT_PRIMARY, TEXT_SECONDARY, TEXT_MUTED,
  ORANGE, ORANGE_LIGHT, BLUE,
} from "@shared/theme";
import { SVG_ICONS, ALL_SVG_KEYS } from "@shared/icons";
import { RECUR_OPTIONS, COLOR_OPTIONS, PAYMENT_COLORS } from "@shared/categories";
import { fmt, fmtMonth, toDateStr } from "@shared/format";
import {
  getManagementStartDay, setManagementStartDay,
  cycleStart, cycleEnd, findCycleOfDate, weeksInCycle, weekInCycle, cycleLabel, isInCycle,
  // Phase 2: 報酬日リスト(複数登録可、ただの記録、サイクル切替には無関係)
  getRewardDays, addRewardDay, removeRewardDay,
  // Phase 3: カード billing 期間をサイクル月基準で計算(closingDay 連動)
  cardBillingRange,
} from "./utils/cycle";
import { useExpenses } from "./hooks/useExpenses";
import { useCategories } from "./hooks/useCategories";
import { useBudgets } from "./hooks/useBudgets";
import { usePoints } from "./hooks/usePoints";
import LogoutButton from "./components/LogoutButton";
import AppointmentCard from "./components/AppointmentCard";
import SortableCategoryRow from "./components/SortableCategoryRow";
import SortablePaymentRow from "./components/SortablePaymentRow";
import { useLatestTelop } from "./hooks/useNotifications";
import { useInquiries } from "./hooks/useInquiries";
import { DndContext, closestCenter, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from "@dnd-kit/sortable";

// ---------------------------------------------------------------
// One-shot migration: kakeibo_* → cfo_* (module top-level, runs once per browser)
// ---------------------------------------------------------------
// Supabase 化対象外で localStorage 継続運用する 5 キーについて、
// 旧 kakeibo_* 実データを cfo_* 側にコピーする。
// - cfo_migratedFromKakeibo === "1" なら実行しない(冪等)
// - 旧 kakeibo_* は削除しない(ロールバック用に残す)
// - 値は JSON 未パースの生文字列でコピー(形状保全)
// - cfo_* に既に値があればスキップ(Phase 2-3 の検証中に発生した上書き防止)
if (typeof window !== "undefined" && window.localStorage.getItem("cfo_migratedFromKakeibo") !== "1") {
  const MIGRATE_KEYS = ["budgets", "weekBudgets", "weekCatBudgets", "paymentMethods", "loans"];
  for (const k of MIGRATE_KEYS) {
    const old = window.localStorage.getItem(`kakeibo_${k}`);
    const neu = window.localStorage.getItem(`cfo_${k}`);
    if (old !== null && neu === null) {
      window.localStorage.setItem(`cfo_${k}`, old);
    }
  }
  window.localStorage.setItem("cfo_migratedFromKakeibo", "1");
}

// 報酬日(rewardDay) → 管理スタート日(managementStartDay) へのワンタイム移行。
// Phase 1 で rewardDay からサイクル切替機能を剥がし、managementStartDay に移植したため、
// 既存ユーザー(localStorage に旧キー cfo_rewardDay = "25" 等を持つ人)のサイクル挙動を
// 維持するために値を新キー cfo_managementStartDay へコピーする。
// "末" や非数値は新仕様では受けないので silent drop。
// 旧キー cfo_rewardDay 自体は表示記録として残置(Phase 2 の複数登録UI設計時に再利用)。
// 冪等:cfo_migratedRewardToManagementStart フラグで二重実行防止。
if (typeof window !== "undefined" && window.localStorage.getItem("cfo_migratedRewardToManagementStart") !== "1") {
  const oldVal = window.localStorage.getItem("cfo_rewardDay");
  const newVal = window.localStorage.getItem("cfo_managementStartDay");
  if (oldVal != null && newVal == null) {
    const n = Number(oldVal);
    if (Number.isInteger(n) && n >= 1 && n <= 31) {
      window.localStorage.setItem("cfo_managementStartDay", String(n));
    }
    // 数値以外("末" 等)は新仕様非対応のため移行しない(silent drop)。
  }
  window.localStorage.setItem("cfo_migratedRewardToManagementStart", "1");
}

// 報酬日 (legacy 単一値) → 報酬日リスト(複数登録可)へのワンタイム移行(Phase 2)。
// Phase 1 で報酬日 input は cfo_rewardDay_legacy に controlled text として保存されていたが、
// Phase 2 で iOS 風カレンダー + 複数登録チップ UI に置き換えたため、既存値を配列形式の
// cfo_rewardDays へコピーする。数値 1-31 でない値(空、"末" 等)は silent drop。
// 旧キー cfo_rewardDay_legacy は残置(Phase 1 マイグレーション同様、削除しない)。
// 冪等:cfo_migratedRewardDayToList フラグで二重実行防止。
if (typeof window !== "undefined" && window.localStorage.getItem("cfo_migratedRewardDayToList") !== "1") {
  const existing = window.localStorage.getItem("cfo_rewardDays");
  if (existing == null) {
    const legacy = window.localStorage.getItem("cfo_rewardDay_legacy");
    if (legacy != null) {
      const n = Number(legacy);
      if (Number.isInteger(n) && n >= 1 && n <= 31) {
        window.localStorage.setItem("cfo_rewardDays", JSON.stringify([n]));
      }
      // 数値以外なら何もしない(空配列状態 = key 不在 を維持)
    }
  }
  window.localStorage.setItem("cfo_migratedRewardDayToList", "1");
}

// Supabase 取得失敗・未ログイン・0 件時に表示するフォールバック。
// admin が INSERT しないままでも画面が成立するための安全網。
const FALLBACK_TELOP = "【本部より】今月の経費精算は月末25日までにご提出ください　　　／　　　来月の研修は5月10日（土）を予定しております　　　／　　　ご不明点はお気軽に本部までお問い合わせください";

// ---------------------------------------------------------------
// 「支出を入力する」固定ゴールドボタン用のスタイルを module スコープに昇格。
// - App 内 `const S = {...}` は毎レンダで再生成 → S.fixedSubmit の参照も毎回新規
// - React は style prop の参照が変わるたびに DOM element.style の各プロパティを再適用
// - その際 iOS Safari は bottom:calc(env(safe-area-inset-bottom)...) を再評価し、
//   safe-area の測定ゆらぎで 1-2px の位置ズレ=「ピクッ」と跳ねる挙動が発生
// この定数を module レベルに置くことで参照を完全固定し、React の style 再適用を抑制。
// 加えて位置指定を bottom ではなく transform:translate3d に移行することで、
// 再適用が発生しても GPU コンポジット層のみで処理され、layout 再計算を完全回避できる。
// ---------------------------------------------------------------
const FIXED_SUBMIT_STYLE = {
  // サンドイッチ構造の footer:renderDaily 直下の flex column の最下段に配置。
  // 旧実装(position:fixed + bottom:calc(env())) は iOS Safari で env() 再評価が
  // 主因のジッタ原因だったため、flex child に移行。renderDaily が height:100% で
  // S.main 内容域いっぱいを占めるので、そこの末尾にぶら下げれば視覚的に「画面下固定」と同等。
  flexShrink: 0,
  width: "100%",
  padding: "10px 18px",
  background: NAVY2,
  borderTop: `1px solid ${BORDER}`,
  // GPU 合成レイヤー化は維持(他サブツリー再レンダによる paint 波及を分離)。
  transform: "translateZ(0)",
  willChange: "transform",
  WebkitBackfaceVisibility: "hidden",
};
const SUBMIT_BTN_STYLE = {
  display: "block",
  width: "100%",
  padding: "15px",
  background: GOLD_GRAD,
  color: "#0A1628",
  border: "none",
  borderRadius: 28,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: `0 4px 24px ${GOLD}44`,
};

const SvgIconBtn = ({ iconKey, size = 28, color = "#555", selected = false }) => {
  const icon = SVG_ICONS[iconKey];
  if (!icon) return null;
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", color: selected ? "#F5921E" : color }}>
      <div style={{ width: size, height: size }}>{icon.svg}</div>
    </div>
  );
};

const CatSvgIcon = ({ cat, size = 28 }) => {
  const iconKey = cat.iconKey || cat.icon || cat.id;
  const icon = SVG_ICONS[iconKey];
  const color = cat.color || "#D4A843";
  return (
    <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <div style={{ width: size * 0.85, height: size * 0.85, color: color }}>
        {icon ? icon.svg : SVG_ICONS.more.svg}
      </div>
    </div>
  );
};

const today = new Date();

function useLocalStorage(key, initialValue) {
  const [value, setValue] = useState(() => {
    try { const saved = localStorage.getItem(key); return saved !== null ? JSON.parse(saved) : initialValue; }
    catch { return initialValue; }
  });
  const setAndSave = (v) => {
    setValue(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      try { localStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  };
  return [value, setAndSave];
}

export default function App() {
  const [tab, setTab] = useState("daily");
  const {
    expenses: transactions,
    addExpense,
    updateExpense,
    softDeleteExpense,
  } = useExpenses();
  const [inputDate, setInputDate] = useState(new Date());
  const [inputAmount, setInputAmount] = useState("");
  const [inputMemo, setInputMemo] = useState("");
  const [inputCategory, setInputCategory] = useState("entertainment");
  const {
    categories: expenseCats,
    addCategory,
    updateCategory: updateCategoryDb,
    removeCategory,
    reorderCategories,
  } = useCategories();

  // dnd-kit: iOS 長押しドラッグ方式。
  // PointerSensor は iOS Safari 画面中央で Pointer Events が scroll gesture detection に奪われ、
  // 中央付近の行だけドラッグ発動しない問題があったため、MouseSensor + TouchSensor に分離。
  // TouchSensor はネイティブ touchstart を直接 listen するので iOS の gesture interception を回避できる。
  // - MouseSensor:PC 向け、5px ドラッグで発動(即時)
  // - TouchSensor:iOS/Android 向け、250ms 長押し + 5px 許容
  //   行側は touch-action:'pan-y' で縦スクロールを許可しているため、
  //   250ms 以内に 5px 以上動けば activation キャンセル → そのままブラウザスクロールに移行。
  //   250ms 指が動かなければ明示的な長押しとしてドラッグ発動。両立のための閾値設計。
  // - 編集/削除ボタンは行の listeners より先に onMouseDown/onTouchStart で伝播停止(下記 Row 参照)
  const dndSensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [calMonth, setCalMonth] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [reportMonth, setReportMonth] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [reportYear, setReportYear] = useState(today.getFullYear());
  const [reportType, setReportType] = useState("monthly");
  const [budgetMonth, setBudgetMonth] = useState({ y: today.getFullYear(), m: today.getMonth() });

  // === B-3a Step 4-3 phase 1: budgets / weekBudgets / weekCatBudgets を Supabase 経由に切替 ===
  // 旧 localStorage 行は rollback 用にコメントアウトで残置 (Phase 3 で削除予定):
  //   const [budgets, setBudgets] = useLocalStorage("cfo_budgets", {});
  //   const [weekBudgets, setWeekBudgets] = useLocalStorage("cfo_weekBudgets", {});  ← L243 元位置
  //   const [weekCatBudgets, setWeekCatBudgets] = useLocalStorage("cfo_weekCatBudgets", {});  ← L244 元位置
  const {
    budgets, weekBudgets, weekCatBudgets,
    setBudget, deleteBudget,
    setWeekBudget, deleteWeekBudget,
    setWeekCatBudget, deleteWeekCatBudget,
    refetch: refetchBudgets,
  } = useBudgets();

  // 旧 setter の互換 shim (Phase 2 で順次 hook 直呼びに置換、Phase 3 で削除予定)。
  // updater が関数なら現 Record で評価、そうでなければそのまま next とみなす。
  // 差分から set/delete を決定し、hook の action を fire-and-forget で呼ぶ。
  // 失敗時は console.error + alert (App.jsx の他 setter と同じ UX)。
  const setBudgets = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(budgets) : updater;
    const allKeys = new Set([...Object.keys(budgets), ...Object.keys(next)]);
    for (const key of allKeys) {
      const cur = budgets[key];
      const upd = next[key];
      if (upd === undefined && cur !== undefined) {
        deleteBudget(key).catch(e => { console.error('[budgets] delete failed', key, e); alert('予算の削除に失敗しました'); });
      } else if (upd !== cur) {
        setBudget(key, upd).catch(e => { console.error('[budgets] save failed', key, e); alert('予算の保存に失敗しました'); });
      }
    }
  }, [budgets, setBudget, deleteBudget]);

  const setWeekCatBudgets = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(weekCatBudgets) : updater;
    const allKeys = new Set([...Object.keys(weekCatBudgets), ...Object.keys(next)]);
    for (const key of allKeys) {
      const cur = weekCatBudgets[key];
      const upd = next[key];
      if (upd === undefined && cur !== undefined) {
        deleteWeekCatBudget(key).catch(e => { console.error('[weekCatBudgets] delete failed', key, e); alert('週予算の削除に失敗しました'); });
      } else if (upd !== cur) {
        setWeekCatBudget(key, upd).catch(e => { console.error('[weekCatBudgets] save failed', key, e); alert('週予算の保存に失敗しました'); });
      }
    }
  }, [weekCatBudgets, setWeekCatBudget, deleteWeekCatBudget]);
  // setWeekBudgets は callsite ゼロ (grep 確認済) のため shim 作成しない。
  // === B-3a Step 4-3 phase 1 end ===

  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState({});
  const [menuScreen, setMenuScreen] = useState("main");
  const [selectedPdfYear, setSelectedPdfYear] = useState(null);
  const [newCatName, setNewCatName] = useState("");
  const [newCatIcon, setNewCatIcon] = useState("restaurant");
  const [newCatColor, setNewCatColor] = useState("#F5921E");
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [menuReportYear, setMenuReportYear] = useState(today.getFullYear());
  const [showEditModal, setShowEditModal] = useState(false);
  const [editDraft, setEditDraft] = useState({});
  const [recurringList, setRecurringList] = useState([]);
  const [showRecurringModal, setShowRecurringModal] = useState(false);
  const [recurDraft, setRecurDraft] = useState({ category:"entertainment", amount:"", memo:"", freq:"monthly" });
  const [editingRecurId, setEditingRecurId] = useState(null);
  const [editingCat, setEditingCat] = useState(null);
  const [editName, setEditName] = useState("");
  const [editIcon, setEditIcon] = useState("restaurant");
  const [editColor, setEditColor] = useState("#FF6B35");
  const [selectedDay, setSelectedDay] = useState(toDateStr(today));
  const [expandedWeek, setExpandedWeek] = useState(weekInCycle(today, getManagementStartDay()));
  const [weekBudgetInput, setWeekBudgetInput] = useState("");
  // weekBudgets / weekCatBudgets は B-3a Step 4-3 phase 1 で useBudgets() に統合済 (L219 周辺参照)。
  // 旧 localStorage 行は L219 のコメント内に残置 (rollback 用)。
  const [showCatBudgetModal, setShowCatBudgetModal] = useState(false);
  const [catBudgetTarget, setCatBudgetTarget] = useState(null);
  const [catBudgetInput, setCatBudgetInput] = useState("");
  const [paymentMethods, setPaymentMethods] = useLocalStorage("cfo_paymentMethods", [{ id:"cash", label:"現金", color:"#4CAF50" }]);
  // 管理スタート日(サイクル切替の本体機能、旧 rewardDay の役割を引き継ぐ)。
  // localStorage 永続化、空 → 1 日起点フォールバック。数値 1-31 のみ受け付ける("末" 等は無効)。
  // 明日 Supabase profiles.management_start_day 列に β 移行予定 → そのときも getter/setter
  // ユーティリティの中身を差し替えるだけで済むよう、UI 側は draft state パターンを採用。
  const [managementStartDayDraft, setManagementStartDayDraft] = useState(() => {
    const v = getManagementStartDay();
    return v == null ? "" : String(v);
  });
  // 保存ボタン押下時にこのカウンタをインクリメント → useMemo を再評価して最新値を読み直す。
  // 保存タイミングが UI 上で明示される(「打鍵ごとに自動保存」より顧客への説明が明快)。
  const [managementStartDayCommitTick, setManagementStartDayCommitTick] = useState(0);
  const managementStartDay = useMemo(() => getManagementStartDay(), [managementStartDayCommitTick]);
  // 報酬日リスト(Phase 2、複数登録可、ただの記録)。
  // 1-31 の数値の配列。空配列でもアプリは動く(報酬日は記録なので無くても OK)。
  // サイクル切替には影響しない(Phase 1 で managementStartDay へ完全分離済み)。
  // 永続化は localStorage('cfo_rewardDays')、UI 操作(チップ追加/削除)で即書き込み。
  const [rewardDaysList, setRewardDaysList] = useState(() => getRewardDays());
  // iOS Safari のネイティブカレンダーピッカーを開くための hidden <input type="date">。
  // 「+ 追加」ボタンエリアの上に opacity:0 で重ねてタップで picker を開く。
  const rewardDayPickerRef = useRef(null);
  // 「保存しました」フラッシュ表示用(2 秒で自動的に消す)
  const [accountSavedFlash, setAccountSavedFlash] = useState(false);
  const [inputPayment, setInputPayment] = useState("cash");
  const [showCalc, setShowCalc] = useState(false);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [datePickerMonth, setDatePickerMonth] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [showMonthSummary, setShowMonthSummary] = useState(false);
  const [showTelop, setShowTelop] = useState(true);
  const [allWeekTarget, setAllWeekTarget] = useState(null);
  const [allWeekInput, setAllWeekInput] = useState("");
  const [weekBudgetMonth, setWeekBudgetMonth] = useState({y:today.getFullYear(),m:today.getMonth()});
  const [showCopyConfirm, setShowCopyConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [contactType, setContactType] = useState("inquiry");
  const [contactText, setContactText] = useState("");
  const [contactSent, setContactSent] = useState(false);
  const { submitting: contactSubmitting, sendInquiry } = useInquiries();
  const [summaryTab, setSummaryTab] = useState("summary");
  const [loans, setLoans] = useLocalStorage("cfo_loans", []);
  const [showLoanForm, setShowLoanForm] = useState(false);
  const [deleteLoanTarget, setDeleteLoanTarget] = useState(null);
  const [showLoanCalc, setShowLoanCalc] = useState(false);
  const [editingLoanId, setEditingLoanId] = useState(null);
  const [loanDraft, setLoanDraft] = useState({label:"",amount:"",bank:"",withdrawalDay:"",pmId:""});
  const [reportSearchQuery, setReportSearchQuery] = useState("");
  const { balance: userPoints, history: pointHistory } = usePoints();
  const { body: telopBody } = useLatestTelop();
  const telopText = telopBody ?? FALLBACK_TELOP;
  const [menuPaymentScreen, setMenuPaymentScreen] = useState("list");
  const [paymentDraft, setPaymentDraft] = useState({ label:"", color:"#4CAF50", closingDay:"", withdrawalDay:"", bank:"" });
  const [showDayCalc, setShowDayCalc] = useState(false);
  const [dayCalcInput, setDayCalcInput] = useState("");
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const longPressTimer = useRef(null);

  // today が属するサイクルの year/month と日付範囲。
  // 月予算キー / "今月" 判定 / 月別サマリ等、today を起点にした計算は全てここを通す。
  const todayCycle = useMemo(() => findCycleOfDate(today, managementStartDay), [managementStartDay]);
  const tmCycleStart = useMemo(() => toDateStr(cycleStart(todayCycle.year, todayCycle.month, managementStartDay)), [todayCycle, managementStartDay]);
  const tmCycleEnd = useMemo(() => toDateStr(cycleEnd(todayCycle.year, todayCycle.month, managementStartDay)), [todayCycle, managementStartDay]);
  // 月予算キーはサイクルベース(起点日が属する年月)。報酬日未設定時はカレンダー月と等価。
  const monthBudgetKey = (catId) => `${todayCycle.year}-${todayCycle.month + 1}-${catId}`;

  const getCatBudgetRemain = (catId) => {
    const bv = budgets[monthBudgetKey(catId)];
    if (!bv) return null;
    const spent = transactions.filter(t=>t.category===catId&&t.date>=tmCycleStart&&t.date<=tmCycleEnd).reduce((s,t)=>s+t.amount,0);
    return bv - spent;
  };

  const budgetAlerts = useMemo(() => {
    const result = [];
    expenseCats.forEach(cat => {
      const budget = budgets[monthBudgetKey(cat.id)];
      if (!budget) return;
      const spent = transactions.filter(t=>t.category===cat.id&&t.date>=tmCycleStart&&t.date<=tmCycleEnd).reduce((s,t)=>s+t.amount,0);
      const pct = spent / budget * 100;
      if (pct >= 100) result.push({ cat, pct, spent, budget, level:"over" });
      else if (pct >= 80) result.push({ cat, pct, spent, budget, level:"warn" });
    });
    return result;
  }, [transactions, budgets, expenseCats, tmCycleStart, tmCycleEnd, todayCycle]);

  const tmSummary = useMemo(() => {
    const spent = transactions.filter(t=>t.date>=tmCycleStart&&t.date<=tmCycleEnd).reduce((s,t)=>s+t.amount,0);
    const budget = expenseCats.reduce((s,c)=>s+(budgets[monthBudgetKey(c.id)]||0),0);
    return { spent, budget, remain: budget - spent };
  }, [transactions, budgets, expenseCats, tmCycleStart, tmCycleEnd, todayCycle]);

  // weekSummary:calMonth(現在表示中のサイクル年月)に対応する週リスト + 集計。
  // 報酬日サイクル準拠で weeksInCycle() を使用。常に 4 週(第 4 週がサイクル末日まで吸収)。
  const weekSummary = useMemo(() => {
    const {y, m} = calMonth;
    const cycWeeks = weeksInCycle(y, m, managementStartDay);
    const enriched = cycWeeks.map((w) => {
      const startStr = toDateStr(w.startDate);
      const endStr = toDateStr(w.endDate);
      const exp = transactions.filter(t => t.date >= startStr && t.date <= endStr).reduce((s,t) => s + t.amount, 0);
      const manualBudget = weekBudgets[w.weekKey] != null ? weekBudgets[w.weekKey] : null;
      const catBudgetTotal = expenseCats.reduce((s, cat) => s + (weekCatBudgets[`${w.weekKey}_${cat.id}`] || 0), 0);
      return {
        label: `第${w.weekNum}週`,
        startStr, endStr,
        expense: exp,
        weekKey: w.weekKey,
        weekNum: w.weekNum,
        manualBudget, catBudgetTotal,
      };
    });
    return enriched.map(w => {
      const weekBudget = w.manualBudget !== null ? w.manualBudget : w.catBudgetTotal > 0 ? w.catBudgetTotal : 0;
      const isOver = weekBudget > 0 && w.expense > weekBudget;
      const isManual = w.manualBudget !== null;
      return {...w, weekBudget, isOver, isManual};
    });
  }, [calMonth, transactions, budgets, expenseCats, weekBudgets, weekCatBudgets, managementStartDay]);

  // calDays:カレンダー画面の日付グリッド。サイクル(cycleStart..cycleEnd)を 7 列の Sun-Sat グリッドに展開。
  // 範囲外の日は current:false で薄く描画。報酬日未設定なら従来のカレンダー月そのまま。
  const calDays = useMemo(() => {
    const {y, m} = calMonth;
    const start = cycleStart(y, m, managementStartDay);
    const end = cycleEnd(y, m, managementStartDay);
    const days = [];
    // 先頭の空白セル(start の曜日まで前日埋め)
    for (let i = 0; i < start.getDay(); i++) {
      const d = new Date(start);
      d.setDate(d.getDate() - (start.getDay() - i));
      days.push({date: d, current: false});
    }
    // 本体:start 〜 end
    const cur = new Date(start);
    while (cur <= end) {
      days.push({date: new Date(cur), current: true});
      cur.setDate(cur.getDate() + 1);
    }
    // 末尾埋め(7 の倍数まで)
    while (days.length % 7 !== 0) {
      const last = days[days.length - 1].date;
      const d = new Date(last);
      d.setDate(d.getDate() + 1);
      days.push({date: d, current: false});
    }
    return days;
  }, [calMonth, managementStartDay]);

  const calTxMap=useMemo(()=>{const map={};transactions.forEach(t=>{map[t.date]=(map[t.date]||0)+t.amount;});return map;},[transactions]);

  // reportTxs:選択中サイクル(reportMonth)範囲内の取引のみ。
  // 旧:date.startsWith(YYYY-MM)/ 新:cycleStart..cycleEnd の文字列範囲比較
  const reportTxs = useMemo(() => {
    const {y, m} = reportMonth;
    const sStr = toDateStr(cycleStart(y, m, managementStartDay));
    const eStr = toDateStr(cycleEnd(y, m, managementStartDay));
    return transactions.filter(t => t.date >= sStr && t.date <= eStr);
  }, [transactions, reportMonth, managementStartDay]);
  const reportExpense=reportTxs.reduce((s,t)=>s+t.amount,0);
  const catBreakdown=useMemo(()=>{const map={};reportTxs.forEach(t=>{map[t.category]=(map[t.category]||0)+t.amount;});return expenseCats.filter(c=>map[c.id]).map(c=>({name:c.label,value:map[c.id],color:c.color}));},[reportTxs,expenseCats]);

  // yearlyData:12 サイクル(各カレンダー月起点)を独立に集計。
  // 報酬日 25 なら 5月分 = 5/25-6/24 のように、隣接サイクルが同じ取引を重複カウントしないよう
  // 各サイクル range で個別 filter する。
  const yearlyData = useMemo(() => Array.from({length: 12}, (_, m) => {
    const sStr = toDateStr(cycleStart(reportYear, m, managementStartDay));
    const eStr = toDateStr(cycleEnd(reportYear, m, managementStartDay));
    return {
      name: `${m + 1}月`,
      expense: transactions.filter(t => t.date >= sStr && t.date <= eStr).reduce((s, t) => s + t.amount, 0),
    };
  }), [transactions, reportYear, managementStartDay]);
  const yearlyTotal=yearlyData.reduce((s,d)=>s+d.expense,0);

  const budgetKey=(cat)=>`${budgetMonth.y}-${budgetMonth.m+1}-${cat}`;
  const getBudget=(cat)=>budgets[budgetKey(cat)];

  const getEffectiveMonthBudget = (y, m) => {
    const manualTotal = expenseCats.reduce((s,c)=>s+(budgets[`${y}-${m+1}-${c.id}`]||0),0);
    if(manualTotal>0) return manualTotal;
    const weekKeys = [`${y}-${m+1}-w1`,`${y}-${m+1}-w2`,`${y}-${m+1}-w3`,`${y}-${m+1}-w4`];
    return weekKeys.reduce((total,wKey)=>total+expenseCats.reduce((s,cat)=>s+(weekCatBudgets[`${wKey}_${cat.id}`]||0),0),0);
  };

  // 予算画面の集計範囲もサイクルベース(報酬日未設定時はカレンダー月と等価)
  const budgetCycleStartStr = toDateStr(cycleStart(budgetMonth.y, budgetMonth.m, managementStartDay));
  const budgetCycleEndStr = toDateStr(cycleEnd(budgetMonth.y, budgetMonth.m, managementStartDay));
  const catSpending=(catId)=>transactions.filter(t=>t.category===catId&&t.date>=budgetCycleStartStr&&t.date<=budgetCycleEndStr).reduce((s,t)=>s+t.amount,0);
  const totalBudget=getEffectiveMonthBudget(budgetMonth.y, budgetMonth.m);
  const totalSpending=transactions.filter(t=>t.date>=budgetCycleStartStr&&t.date<=budgetCycleEndStr).reduce((s,t)=>s+t.amount,0);
  const openBudgetModal=()=>{const draft={};expenseCats.forEach(c=>{const b=getBudget(c.id);if(b)draft[c.id]=String(b);});setBudgetDraft(draft);setShowBudgetModal(true);};
  const saveBudgets=()=>{const next={...budgets};expenseCats.forEach(c=>{const k=budgetKey(c.id);if(budgetDraft[c.id]&&!isNaN(Number(budgetDraft[c.id])))next[k]=Number(budgetDraft[c.id]);else delete next[k];});setBudgets(next);setShowBudgetModal(false);};
  const searchResults=useMemo(()=>{if(!searchQuery.trim())return transactions;const q=searchQuery.toLowerCase();return transactions.filter(t=>{const cat=expenseCats.find(c=>c.id===t.category);return t.memo.toLowerCase().includes(q)||(cat&&cat.label.toLowerCase().includes(q))||String(t.amount).includes(q);});},[searchQuery,transactions,expenseCats]);

  const addNewCategory = () => {
    if (!newCatName.trim()) return;
    addCategory({ label: newCatName, iconKey: newCatIcon, color: newCatColor })
      .then(() => {
        setNewCatName(""); setNewCatIcon("restaurant"); setNewCatColor("#F5921E");
        setMenuScreen("catEdit");
      })
      .catch((e) => { console.error(e); alert("カテゴリ追加に失敗しました。"); });
  };

  const changeDate = (delta) => { const d=new Date(inputDate); d.setDate(d.getDate()+delta); setInputDate(d); };
  const addTransaction = () => {
    if (!inputAmount || isNaN(Number(inputAmount)) || Number(inputAmount) <= 0) return;
    addExpense({
      date: toDateStr(inputDate),
      amount: Number(inputAmount),
      memo: inputMemo,
      category: inputCategory,
      payment: inputPayment,
    })
      .then(() => { setInputAmount(""); setInputMemo(""); })
      .catch((e) => { console.error(e); alert("支出の保存に失敗しました。"); });
  };
  // 固定ゴールドボタンの onClick を参照固定化する(jitter 対策)。
  // addTransaction は複数 state を閉包するため毎レンダ新規関数 → そのまま渡すと
  // React が毎回 event listener を付け替え、iOS Safari で DOM touch が発生する。
  // ref に最新を保持し、useMemo で作った単一クロージャから常に最新 addTransaction を呼ぶ。
  const addTransactionRef = useRef(addTransaction);
  addTransactionRef.current = addTransaction;
  const submitFixedClick = useMemo(() => () => addTransactionRef.current(), []);
  const deleteTransaction = (id) => {
    softDeleteExpense(id).catch((e) => { console.error(e); alert("削除に失敗しました。"); });
  };
  const startEditTx = (tx) => { setEditDraft({ ...tx, amount: String(tx.amount) }); setShowEditModal(true); };
  const saveEditTx = () => {
    if (!editDraft.amount || isNaN(Number(editDraft.amount)) || Number(editDraft.amount) <= 0) return;
    updateExpense(editDraft.id, {
      date: editDraft.date,
      amount: Number(editDraft.amount),
      memo: editDraft.memo,
      category: editDraft.category,
      payment: editDraft.payment,
    })
      .then(() => setShowEditModal(false))
      .catch((e) => { console.error(e); alert("編集の保存に失敗しました。"); });
  };
  // NOTE: 定期ルール id は local Date.now() / DB recur_id は uuid のため、
  // Day 3 では recurId / isRecurring を送信しない。結果として一括適用分には
  // 「定期」バッジが付かない(視覚的退行のみ)。ルール自体は recurringList
  // (in-memory) で従来通り動作。recurring_rules テーブル化は Phase 1 以降で。
  const applyRecurring = (list = recurringList) => {
    list.forEach((r) => {
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(r.day || 1).padStart(2, '0')}`;
      const exists = transactions.find(
        (t) => t.memo === r.memo && t.category === r.category && t.date >= tmCycleStart && t.date <= tmCycleEnd,
      );
      if (exists) return;
      addExpense({
        date: dateStr,
        amount: Number(r.amount),
        memo: r.memo,
        category: r.category,
      }).catch((e) => console.error(e));
    });
  };
  const saveRecurring=()=>{if(!recurDraft.amount||isNaN(Number(recurDraft.amount))||Number(recurDraft.amount)<=0)return;if(editingRecurId){setRecurringList(prev=>prev.map(r=>r.id===editingRecurId?{...recurDraft,id:editingRecurId}:r));}else{const newR={...recurDraft,id:Date.now(),amount:Number(recurDraft.amount)};const newList=[...recurringList,newR];setRecurringList(newList);applyRecurring(newList);}setShowRecurringModal(false);setEditingRecurId(null);setRecurDraft({category:"food",amount:"",memo:"",freq:"monthly"});};

  const handleCalc = (v) => {
    if(v==="AC"){ setInputAmount(""); return; }
    if(v==="Del"){ setInputAmount(p=>p.slice(0,-1)); return; }
    if(v==="OK"){ setShowCalc(false); return; }
    if(v==="＝"){
      setInputAmount(p=>{
        try{ const expr=p.replace(/÷/g,"/").replace(/×/g,"*").replace(/－/g,"-").replace(/＋/g,"+"); const result=Function('"use strict";return ('+expr+')')(); if(!isFinite(result)||isNaN(result))return p; return String(Math.round(result)); }catch{ return p; }
      }); return;
    }
    if(v==="÷"||v==="×"||v==="－"||v==="＋"){ setInputAmount(p=>p===""?"0":p+v); return; }
    if(v==="00"){ setInputAmount(p=>p===""?"0":p+"00"); return; }
    setInputAmount(p=>{ if(p===""&&v==="0")return "0"; if(p==="0")return String(v); return p+String(v); });
  };

  const handleCatCalc = (v) => {
    if(v==="AC"){ setCatBudgetInput(""); return; }
    if(v==="Del"){ setCatBudgetInput(p=>p.slice(0,-1)); return; }
    if(v==="＝"){
      setCatBudgetInput(p=>{
        try{ const expr=p.replace(/÷/g,"/").replace(/×/g,"*").replace(/－/g,"-").replace(/＋/g,"+"); const result=Function('"use strict";return ('+expr+')')(); if(!isFinite(result)||isNaN(result))return p; return String(Math.round(result)); }catch{ return p; }
      }); return;
    }
    if(v==="÷"||v==="×"||v==="－"||v==="＋"){ setCatBudgetInput(p=>p===""?"0":p+v); return; }
    if(v==="00"){ setCatBudgetInput(p=>p===""?"0":p+"00"); return; }
    if(v==="OK"){
      const val=catBudgetInput; const num=Number(val);
      // 未設定と 0 を明確に区別する:
      //  - 空欄(val==="") / NaN / 負数 → 「未設定」として key を削除(従来通り)
      //  - 0 以上の有効値     → 値として保存(0 も「明示的に 0 円」として保存される)
      const isInvalid = !val || isNaN(num) || num < 0;
      if(catBudgetTarget._isWeek){
        if(isInvalid){setWeekCatBudgets(p=>{const next={...p};delete next[`${catBudgetTarget._weekKey}_${catBudgetTarget.id}`];return next;});}
        else{setWeekCatBudgets(p=>({...p,[`${catBudgetTarget._weekKey}_${catBudgetTarget.id}`]:num}));}
      } else {
        if(isInvalid){setBudgets(prev=>{const next={...prev};delete next[monthBudgetKey(catBudgetTarget.id)];return next;});}
        else{setBudgets(prev=>({...prev,[monthBudgetKey(catBudgetTarget.id)]:num}));}
      }
      setShowCatBudgetModal(false);setCatBudgetInput(""); return;
    }
    setCatBudgetInput(p=>{ if(p===""&&v==="0")return "0"; if(p==="0")return String(v); return p+String(v); });
  };

  const handleAllWeekCalc = (v, weeks) => {
    if(v==="AC"){ setAllWeekInput(""); return; }
    if(v==="Del"){ setAllWeekInput(p=>p.slice(0,-1)); return; }
    if(v==="＝"){
      setAllWeekInput(p=>{
        try{ const expr=p.replace(/÷/g,"/").replace(/×/g,"*").replace(/－/g,"-").replace(/＋/g,"+"); const result=Function('"use strict";return ('+expr+')')(); if(!isFinite(result)||isNaN(result))return p; return String(Math.round(result)); }catch{ return p; }
      }); return;
    }
    if(v==="÷"||v==="×"||v==="－"||v==="＋"){ setAllWeekInput(p=>p===""?"0":p+v); return; }
    if(v==="00"){ setAllWeekInput(p=>p===""?"0":p+"00"); return; }
    if(v==="OK"){
      // 全週一括設定でも 0 入力を許可(全週を明示的に 0 円としてセットできる)。
      // 空欄 / NaN / 負数は「何もしない」= モーダルを閉じずに留まる動作を維持。
      const val=allWeekInput; const num=Number(val); if(!val||isNaN(num)||num<0) return;
      const next={...weekCatBudgets};
      weeks.forEach(w=>{next[`${w.weekKey}_${allWeekTarget.id}`]=num;});
      setWeekCatBudgets(next);setAllWeekTarget(null);setAllWeekInput(""); return;
    }
    setAllWeekInput(p=>{ if(p===""&&v==="0")return "0"; if(p==="0")return String(v); return p+String(v); });
  };

  const handleLoanCalc = (v) => {
    if(v==="AC"){ setLoanDraft(p=>({...p,amount:""})); return; }
    if(v==="Del"){ setLoanDraft(p=>({...p,amount:p.amount.slice(0,-1)})); return; }
    if(v==="OK"){ setShowLoanCalc(false); return; }
    if(v==="＝"){
      setLoanDraft(p=>{
        try{ const expr=p.amount.replace(/÷/g,"/").replace(/×/g,"*").replace(/－/g,"-").replace(/＋/g,"+"); const result=Function('"use strict";return ('+expr+')')(); if(!isFinite(result)||isNaN(result))return p; return {...p,amount:String(Math.round(result))}; }catch{ return p; }
      }); return;
    }
    if(v==="÷"||v==="×"||v==="－"||v==="＋"){ setLoanDraft(p=>({...p,amount:p.amount===""?"0":p.amount+v})); return; }
    if(v==="00"){ setLoanDraft(p=>({...p,amount:p.amount===""?"0":p.amount+"00"})); return; }
    setLoanDraft(p=>{ if(p.amount===""&&v==="0")return p; if(p.amount==="0")return {...p,amount:String(v)}; return {...p,amount:p.amount+String(v)}; });
  };

  const S = {
    // height:100%(#root の 100dvh に追従)+ minHeight:0 で flex 子が shrink 可能に。
    // 旧 minHeight:100vh だと iOS Safari で content-size 依存のレイアウト崩壊が起きていた。
    app:{fontFamily:"'Hiragino Sans','Noto Sans JP','Yu Gothic UI','sans-serif'",maxWidth:430,margin:"0 auto",height:"100%",minHeight:0,background:NAVY,display:"flex",flexDirection:"column",position:"relative",overflowX:"hidden"},
    // minHeight:0 が無いと flex item が overflow:auto を持っていても content-size に固着し
    // 内部スクロールが効かない(iOS Safari の典型バグ)。
    main:{flex:1,overflowY:"auto",overflowX:"hidden",minHeight:0,paddingBottom:140},
    bottomNav:{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:NAVY2,borderTop:`1px solid ${BORDER}`,display:"flex",zIndex:100,paddingBottom:"calc(env(safe-area-inset-bottom) + 8px)"},
    // 固定ゴールドボタン用:module-level 定数への参照で、毎レンダ同一参照を維持。
    // 実体は FIXED_SUBMIT_STYLE(GPU 合成レイヤー化済み)。
    fixedSubmit: FIXED_SUBMIT_STYLE,
    navBtn:(a)=>({flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"10px 0 8px",border:"none",background:"none",cursor:"pointer",color:a?GOLD:TEXT_MUTED,fontSize:10,gap:2,fontWeight:500}),
    typeBtn:(a)=>({flex:1,padding:"3px 16px",border:"none",borderRadius:20,fontWeight:a?600:400,fontSize:10,cursor:"pointer",background:a?GOLD_GRAD:"transparent",color:a?"#0A1628":TEXT_SECONDARY,whiteSpace:"nowrap"}),
    row:{display:"flex",alignItems:"center",padding:"13px 20px",background:CARD_BG,borderBottom:`1px solid ${BORDER}`,boxSizing:"border-box",width:"100%"},
    amountInput:{flex:1,border:"none",fontSize:32,fontWeight:400,background:"transparent",padding:"4px 10px",outline:"none",color:TEXT_PRIMARY,minWidth:0},
    memoInput:{flex:1,border:"none",fontSize:14,background:"transparent",outline:"none",color:TEXT_PRIMARY,fontWeight:400},
    // 固定ゴールドボタン本体:module-level 定数への参照。実体は SUBMIT_BTN_STYLE。
    submitBtn: SUBMIT_BTN_STYLE,
    monthNav:{display:"flex",alignItems:"center",justifyContent:"space-between",background:NAVY2,borderRadius:12,padding:"10px 16px",margin:"0 14px 12px",border:`1px solid ${BORDER}`,boxShadow:SHADOW},
    navArrow:{background:"none",border:"none",fontSize:18,cursor:"pointer",color:GOLD,padding:"0 8px"},
    calGrid:{display:"grid",gridTemplateColumns:"repeat(7,1fr)",background:CARD_BG},
    menuItem:{display:"flex",alignItems:"center",gap:12,padding:"15px 20px",borderBottom:`1px solid ${BORDER}`,cursor:"pointer",background:CARD_BG},
    listItem:{display:"flex",alignItems:"center",gap:12,padding:"13px 20px",borderBottom:`1px solid ${BORDER}`,background:CARD_BG,cursor:"pointer"},
    overlay:{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:NAVY,zIndex:200,display:"flex",flexDirection:"column",overflowY:"auto"},
    overlayHeader:{background:NAVY2,padding:"13px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`,position:"sticky",top:0,zIndex:10,boxShadow:SHADOW},
    summaryBar:{display:"flex",gap:0,background:CARD_BG,borderBottom:`1px solid rgba(212,168,67,0.1)`},
    summaryCell:(border)=>({flex:1,padding:"10px 0",textAlign:"center",borderRight:border?`1px solid ${BORDER}`:"none"}),
  };

  const SummaryBar = ({ spent, budget, remain, onBudgetTap, labelBudget="予算", labelSpent="支出", labelRemain="残予算" }) => (
    <div style={S.summaryBar}>
      <div style={{...S.summaryCell(true),cursor:onBudgetTap?"pointer":"default"}} onClick={onBudgetTap}>
        <div style={{fontSize:11,color:TEXT_PRIMARY,marginBottom:4,fontWeight:600}}>{labelBudget}</div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:1,flexWrap:"nowrap",overflow:"hidden"}}>
          {budget>0
            ? <><span style={{fontSize:budget>=1000000?15:budget>=100000?17:20,fontWeight:700,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{budget.toLocaleString()}</span><span style={{fontSize:10,color:TEXT_SECONDARY,fontWeight:500,flexShrink:0}}>円</span></>
            : <span style={{fontSize:20,fontWeight:700,color:GOLD}}>未設定</span>
          }
        </div>
        {!budget&&onBudgetTap&&<div style={{fontSize:9,color:GOLD,fontWeight:500}}>タップして設定</div>}
      </div>
      <div style={S.summaryCell(true)}>
        <div style={{fontSize:11,color:TEXT_PRIMARY,marginBottom:4,fontWeight:600}}>{labelSpent}</div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:1,flexWrap:"nowrap",overflow:"hidden"}}>
          <span style={{fontSize:spent>=1000000?15:spent>=100000?17:20,fontWeight:700,color:RED,whiteSpace:"nowrap"}}>{spent.toLocaleString()}</span>
          <span style={{fontSize:10,color:TEXT_SECONDARY,fontWeight:500,flexShrink:0}}>円</span>
        </div>
      </div>
      <div style={S.summaryCell(false)}>
        <div style={{fontSize:11,color:TEXT_PRIMARY,marginBottom:4,fontWeight:600}}>{labelRemain}</div>
        <div style={{display:"flex",alignItems:"baseline",justifyContent:"center",gap:1,flexWrap:"nowrap",overflow:"hidden"}}>
          {budget===0
            ? <span style={{fontSize:20,fontWeight:700,color:TEXT_MUTED}}>–</span>
            : <>
                <span style={{fontSize:Math.abs(remain)>=1000000?15:Math.abs(remain)>=100000?17:20,fontWeight:700,color:remain<0?RED:GOLD,whiteSpace:"nowrap"}}>
                  {remain<0?`-${Math.abs(remain).toLocaleString()}`:remain.toLocaleString()}
                </span>
                <span style={{fontSize:10,color:TEXT_SECONDARY,fontWeight:500,flexShrink:0}}>円</span>
              </>
          }
        </div>
      </div>
    </div>
  );

  const TxItem = ({ t }) => {
    const [open, setOpen] = useState(false);
    const cat = expenseCats.find(c=>c.id===t.category);
    const remain = getCatBudgetRemain(t.category);
    const isOver = remain !== null && remain < 0;
    return (
      <div style={{borderBottom:`1px solid ${BORDER}`}}>
        <div style={{display:"flex",alignItems:"center",padding:"10px 18px",gap:10,background:CARD_BG,cursor:"pointer"}} onClick={()=>setOpen(p=>!p)}>
          {cat&&<CatSvgIcon cat={cat} size={24}/>}
          <div style={{flex:1}}>
            <div style={{fontSize:14,fontWeight:600,display:"flex",alignItems:"center",gap:6,color:TEXT_PRIMARY,flexWrap:"wrap"}}>
              {cat?.label}
              {t.isRecurring && <span style={{fontSize:8,background:`${GOLD}18`,color:GOLD,borderRadius:3,padding:"1px 5px"}}>定期</span>}
              {t.isProxyEntry && <span style={{fontSize:8,background:GOLD_GRAD,color:NAVY,borderRadius:3,padding:"1px 5px",fontWeight:700}}>本部入力</span>}
            </div>
            <div style={{fontSize:11,color:TEXT_SECONDARY,display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
              <span>{t.date}{t.memo&&` · ${t.memo}`}</span>
              {t.payment&&(()=>{const pm=paymentMethods.find(p=>p.id===t.payment);return pm?(<span style={{display:"inline-flex",alignItems:"center",gap:3,background:pm.color,color:"#fff",borderRadius:4,padding:"1px 6px",fontSize:10,fontWeight:700}}>{pm.label}</span>):null;})()}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:15,fontWeight:700,color:RED}}>-{t.amount.toLocaleString()}円</div>
            {remain!==null&&<div style={{fontSize:10,fontWeight:400,color:isOver?RED:GOLD,marginTop:2}}>{isOver?`超 ${Math.abs(remain).toLocaleString()}円`:`残 ${remain.toLocaleString()}円`}</div>}
          </div>
          <span style={{fontSize:11,color:TEXT_MUTED,marginLeft:4}}>{open?"▲":"▼"}</span>
        </div>
        {open&&(<div style={{display:"flex",gap:8,padding:"6px 18px 10px",background:CREAM}}>
          <button onClick={()=>{setOpen(false);startEditTx(t);}} style={{flex:1,padding:"7px",border:`1px solid ${GOLD}`,borderRadius:8,background:CARD_BG,color:GOLD,fontSize:11,fontWeight:400,cursor:"pointer"}}>編集</button>
          <button onClick={()=>{deleteTransaction(t.id);}} style={{flex:1,padding:"7px",border:`1px solid ${RED}`,borderRadius:8,background:CARD_BG,color:RED,fontSize:11,fontWeight:400,cursor:"pointer"}}>削除</button>
        </div>)}
      </div>
    );
  };

  const IconPicker = ({ selected, onSelect }) => (
    <div style={{background:CARD_BG,padding:"16px 18px"}}>
      <div style={{fontWeight:600,fontSize:13,marginBottom:14,color:TEXT_PRIMARY}}>アイコンを選択</div>
      <div style={{height:280,overflowY:"auto",WebkitOverflowScrolling:"touch"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
          {ALL_SVG_KEYS.map((key) => {
            const icon = SVG_ICONS[key];
            const isSelected = selected === key;
            return (
              <button key={key} onClick={() => onSelect(key)} style={{border:isSelected?`2px solid ${GOLD}`:`1px solid ${BORDER}`,borderRadius:12,padding:"14px 6px 10px",cursor:"pointer",background:isSelected?`${GOLD}18`:NAVY2,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:6,boxShadow:isSelected?`0 0 10px ${GOLD}44`:"none"}}>
                <div style={{width:34,height:34,color:isSelected?GOLD:TEXT_SECONDARY,display:"flex",alignItems:"center",justifyContent:"center"}}>{icon.svg}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const ColorPicker = ({ selected, onSelect }) => (
    <div style={{background:CARD_BG,padding:"16px 18px"}}>
      <div style={{fontWeight:400,fontSize:13,marginBottom:14,color:TEXT_SECONDARY}}>カラー</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
        {COLOR_OPTIONS.map(color=>(
          <button key={color} onClick={()=>onSelect(color)} style={{width:"100%",aspectRatio:"1",borderRadius:8,border:selected===color?`3px solid #333`:"3px solid transparent",background:color,cursor:"pointer"}}/>
        ))}
      </div>
    </div>
  );

  // ============================================================
  // ★ 週ボックス（絶対配置フィル＋縦線でテキスト絶対切れない）
  // ============================================================
  const WeekTwoBox = ({ expense, budget, isOver, pct, pctRaw, remain, barColor }) => {
    if (budget <= 0) {
      return <div style={{fontSize:11,color:TEXT_SECONDARY,fontWeight:500}}>週予算を設定するとここに表示されます</div>;
    }
    // 〜79%: TEAL / 80〜99%: 黄 / 100%+: 赤
    const themeColor = pct >= 100 ? RED : pct >= 80 ? "#FFC107" : TEAL;
    const displayPct = pctRaw != null ? pctRaw : pct;
    return (
      <div>
        <div style={{display:"flex",justifyContent:"flex-end",marginBottom:6}}>
          <span style={{fontSize:11,color:TEXT_MUTED}}>
            予算 <span style={{color:TEXT_PRIMARY,fontWeight:700}}>{budget.toLocaleString()}</span>円（週）
          </span>
        </div>
        <div style={{
          display:"flex",
          borderRadius:8,
          overflow:"hidden",
          position:"relative",
        }}>
          {/* 進捗フィル背景(pct%分だけ色がつく)— pct===0 は DOM ごと描画しない */}
          {pct > 0 && (
            <div style={{
              position:"absolute", top:0, left:0, height:"100%",
              width:`${Math.min(100,pct)}%`,
              background:`${themeColor}22`,
              transition:"width 0.4s ease",
              pointerEvents:"none",
            }}/>
          )}
          {/* 縦の仕切り線(pct%の位置)— 0% 時は左端に半画素漏れするので同じく非描画 */}
          {pct > 0 && (
            <div style={{
              position:"absolute", top:0, left:`${Math.min(100,pct)}%`,
              width:1.5, height:"100%",
              background:"rgba(255,255,255,0.25)",
              transform:"translateX(-50%)",
              pointerEvents:"none",
            }}/>
          )}
          {/* 左テキスト */}
          <div style={{flex:1,padding:"5px 12px",position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:4,overflow:"hidden"}}>
            <span style={{fontSize:13,fontWeight:700,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{expense.toLocaleString()}円</span>
            <span style={{fontSize:12,fontWeight:700,color:themeColor,whiteSpace:"nowrap"}}>({displayPct}%)</span>
          </div>
          {/* 右テキスト（右寄せ） */}
          <div style={{flex:1,padding:"5px 12px",position:"relative",zIndex:1,display:"flex",alignItems:"center",justifyContent:"flex-end",gap:2}}>
            <span style={{fontSize:11,color:TEXT_MUTED,whiteSpace:"nowrap"}}>残</span>
            <span style={{fontSize:13,fontWeight:700,color:themeColor,whiteSpace:"nowrap"}}>
              {isOver?`-${Math.abs(remain).toLocaleString()}`:remain.toLocaleString()}円
            </span>
          </div>
        </div>
      </div>
    );
  };

  // ============================================================
  // ★ カテゴリボックス（絶対配置フィル＋縦線・テキスト絶対切れない）
  // ============================================================
  const CatTwoBox = ({ cat, spent, weekCatBudget, catPct, catPctRaw, hasBudget, isLast, periodLabel = '週' }) => {
    // hasBudget:明示的に予算が設定されているか(0 円も「立派な予算設定」として true)。
    // 旧呼び出し互換:hasBudget が未指定の場合は weekCatBudget>0 で代用。
    const hasBudgetSafe = hasBudget != null ? hasBudget : weekCatBudget > 0;
    // 予算 0 円 + 支出 0 円 = 残 0(超過なし)。予算 0 円 + 支出>0 = 即超過(spent > 0)。
    const isOver = hasBudgetSafe && spent > weekCatBudget;
    const isWarn = hasBudgetSafe && catPct >= 80 && !isOver;
    // 〜79%: TEAL / 80〜99%: 黄 / 100%+ または超過: 赤
    // 予算 0 円で支出ありの場合、catPct は 100 にクランプされるが isOver で確実に赤化される。
    const themeColor = (isOver || catPct >= 100) ? RED : catPct >= 80 ? "#FFC107" : TEAL;
    const cRemain = weekCatBudget - spent;
    const displayCatPct = catPctRaw != null ? catPctRaw : catPct;
    // 呼び出し側でフィルタリング済みなので、ここでは早期returnしない
    return (
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
          <div style={{display:"flex",alignItems:"center",gap:6}}>
            <CatSvgIcon cat={cat} size={15}/>
            <span style={{fontSize:12,fontWeight:700,color:TEXT_PRIMARY}}>{cat.label}</span>
          </div>
          {hasBudgetSafe && (
            <span style={{fontSize:10,color:TEXT_MUTED}}>
              予算 <span style={{color:TEXT_PRIMARY,fontWeight:700}}>{weekCatBudget.toLocaleString()}</span>円（{periodLabel}）
            </span>
          )}
        </div>
        <div style={{
          display:"flex",
          borderRadius:7,
          overflow:"hidden",
          position:"relative",
        }}>
          {/* 進捗フィル背景:予算 0 円のときも catPct(=spent クランプ)で赤フィル表示 */}
          {hasBudgetSafe && (
            <div style={{
              position:"absolute", top:0, left:0, height:"100%",
              width:`${Math.min(100,catPct)}%`,
              background:`${themeColor}20`,
              transition:"width 0.4s ease",
              pointerEvents:"none",
            }}/>
          )}
          {/* 縦の仕切り線:予算 0 円では分子分母比が無いので非表示(weekCatBudget>0 時のみ) */}
          {hasBudgetSafe && weekCatBudget > 0 && (
            <div style={{
              position:"absolute", top:0, left:`${Math.min(100,catPct)}%`,
              width:1.5, height:"100%",
              background:"rgba(255,255,255,0.2)",
              transform:"translateX(-50%)",
              pointerEvents:"none",
            }}/>
          )}
          {/* 左テキスト */}
          <div style={{flex:1,padding:"4px 12px",position:"relative",zIndex:1,display:"flex",alignItems:"center",gap:4,overflow:"hidden"}}>
            <span style={{fontSize:13,fontWeight:700,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{spent.toLocaleString()}円</span>
            {hasBudgetSafe && (
              <span style={{fontSize:11,fontWeight:700,color:themeColor,whiteSpace:"nowrap"}}>({displayCatPct}%)</span>
            )}
          </div>
          {/* 右テキスト（右寄せ） */}
          <div style={{flex:1,padding:"4px 12px",position:"relative",zIndex:1,display:"flex",alignItems:"center",justifyContent:"flex-end",gap:2}}>
            <span style={{fontSize:10,color:TEXT_MUTED,whiteSpace:"nowrap"}}>残</span>
            <span style={{fontSize:13,fontWeight:700,color:hasBudgetSafe?themeColor:TEXT_MUTED,whiteSpace:"nowrap"}}>
              {hasBudgetSafe?(isOver?`-${Math.abs(cRemain).toLocaleString()}`:cRemain.toLocaleString()):"−"}円
            </span>
          </div>
        </div>
        {!isLast && <div style={{borderTop:"1px solid rgba(255,255,255,0.07)",margin:"12px 0"}}/>}
      </div>
    );
  };

  const renderDaily = () => {
    // inputDate が属するサイクルの週情報を取得(報酬日基準)。
    // weekSummary は calMonth ベースなので、別サイクルにいるときは inputDate のサイクル週で再計算する。
    const inputCycle = findCycleOfDate(inputDate, managementStartDay);
    const inputCycWeeks = weeksInCycle(inputCycle.year, inputCycle.month, managementStartDay);
    const weekNum = weekInCycle(inputDate, managementStartDay);
    const thisWeek = inputCycWeeks[weekNum - 1] || inputCycWeeks[0];
    // weekSummary は calMonth(画面選択中の月)用、inputDate の月と同じなら使い、違うなら個別計算。
    const weekBudgetFromSummary = (calMonth.y === inputCycle.year && calMonth.m === inputCycle.month)
      ? (weekSummary[weekNum - 1]?.weekBudget || 0)
      : (() => {
          const manual = weekBudgets[thisWeek.weekKey];
          if (manual != null) return manual;
          return expenseCats.reduce((s, cat) => s + (weekCatBudgets[`${thisWeek.weekKey}_${cat.id}`] || 0), 0);
        })();
    const weekBudget = weekBudgetFromSummary;
    const weekStart = thisWeek.startDate;
    const weekEnd = thisWeek.endDate;
    const weekExp = transactions.filter(t=>t.date>=toDateStr(weekStart)&&t.date<=toDateStr(weekEnd)).reduce((s,t)=>s+t.amount,0);
    const weekRemain = weekBudget - weekExp;
    const weekRemainDays = Math.max(1, Math.ceil((weekEnd - inputDate) / (1000*60*60*24)) + 1);

    return (
      <div style={{display:"flex",flexDirection:"column",height:"100%"}}>
        <div style={{background:CARD_BG,borderBottom:`1px solid ${BORDER}`,padding:"6px 16px",display:"flex",alignItems:"center",gap:8}}>
          <button style={S.navArrow} onClick={()=>changeDate(-1)}>‹</button>
          <div
            onClick={()=>{setDatePickerMonth({y:inputDate.getFullYear(),m:inputDate.getMonth()});setShowDatePicker(true);}}
            style={{flex:1,background:NAVY3,borderRadius:8,padding:"6px 12px",textAlign:"center",fontSize:14,fontWeight:500,color:TEXT_PRIMARY,border:`1px solid ${GOLD}55`,cursor:"pointer"}}
          >{fmt(inputDate)}</div>
          <button style={S.navArrow} onClick={()=>changeDate(1)}>›</button>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",minWidth:52,marginLeft:4}}>
            <span style={{fontSize:9,color:TEXT_PRIMARY,fontWeight:600}}>第{weekNum}週</span>
            <div style={{display:"flex",alignItems:"baseline",gap:2}}>
              <span style={{fontSize:9,color:TEXT_SECONDARY,fontWeight:500}}>残</span>
              <span style={{fontSize:22,fontWeight:700,lineHeight:1.1,color:weekRemainDays<=2?"#2196F3":weekRemainDays<=4?"#FFC107":RED}}>{weekRemainDays}</span>
              <span style={{fontSize:9,color:TEXT_SECONDARY,fontWeight:500}}>日</span>
            </div>
          </div>
        </div>
        {/* 上部ブロック(flex-shrink:0):金額 / メモ / 支払い方法 — 常に最上段固定でスクロール非対象 */}
        <div style={{flexShrink:0,display:"flex",flexDirection:"column"}}>
        <div onClick={()=>setShowCalc(true)} style={{background:CARD_BG,borderBottom:`1px solid ${BORDER}`,padding:"5px 16px 8px",display:"flex",alignItems:"flex-end",justifyContent:"space-between",cursor:"pointer"}}>
          <span style={{fontSize:12,color:TEXT_MUTED,fontWeight:500,marginBottom:6}}>支出金額</span>
          <div style={{display:"flex",alignItems:"flex-end",gap:6}}>
            <span style={{fontSize:44,fontWeight:400,color:inputAmount?TEXT_PRIMARY:TEXT_MUTED,lineHeight:1}}>{inputAmount||"0"}</span>
            <span style={{fontSize:16,color:TEXT_MUTED,fontWeight:400,marginBottom:8}}>円</span>
          </div>
        </div>
        <div style={{...S.row,padding:"5px 16px"}}>
          <span style={{color:TEXT_SECONDARY,fontSize:10,marginRight:12,minWidth:36,fontWeight:300}}>メモ</span>
          <input style={{...S.memoInput,fontSize:13,textAlign:"right"}} placeholder="未入力" value={inputMemo} onChange={e=>setInputMemo(e.target.value)}/>
        </div>
        <div style={{display:"flex",background:NAVY2,borderBottom:`1px solid ${BORDER}`,padding:"5px 16px",gap:8,alignItems:"center",justifyContent:"flex-end",overflowX:"auto"}}>
          {paymentMethods.map(pm=>{
            const isSel = inputPayment===pm.id;
            return(
              <button key={pm.id} onClick={()=>setInputPayment(pm.id)} style={{flexShrink:0,padding:"5px 14px",border:`1px solid ${isSel?"rgba(255,255,255,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:20,background:isSel?"rgba(255,255,255,0.12)":"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:isSel?pm.color:"rgba(255,255,255,0.3)",flexShrink:0}}/>
                <span style={{fontSize:11,fontWeight:isSel?600:400,color:isSel?TEXT_PRIMARY:TEXT_SECONDARY,whiteSpace:"nowrap"}}>{pm.label}</span>
              </button>
            );
          })}
        </div>
        </div>
        {/* 中央ブロック(flex:1 overflow-y:auto):カテゴリグリッドと定期支出だけスクロール可。
            iOS 用に WebkitOverflowScrolling("touch") で慣性スクロール、
            overscrollBehavior:"contain" で親(S.main / body)への scroll chaining を遮断。 */}
        <div style={{flex:1,overflowY:"auto",minHeight:0,WebkitOverflowScrolling:"touch",overscrollBehavior:"contain"}}>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,padding:"8px 14px 0",background:NAVY}}>
          {expenseCats.map(cat=>{
            const isSelected=inputCategory===cat.id;
            // inputDate が属するサイクルの「現在週」のキーで予算/支出を引く。
            // 0 円明示も「予算あり」扱い:rawWeekCatBudget が null/undefined のときだけ未設定。
            const wKey = thisWeek.weekKey;
            const rawWeekCatBudget = weekCatBudgets[`${wKey}_${cat.id}`];
            const hasWeekCatBudget = rawWeekCatBudget != null;
            const weekCatBudget = hasWeekCatBudget ? rawWeekCatBudget : 0;
            const wStart = toDateStr(thisWeek.startDate);
            const wEnd = toDateStr(thisWeek.endDate);
            const weekCatSpent = transactions.filter(t=>t.category===cat.id&&t.date>=wStart&&t.date<=wEnd).reduce((s,t)=>s+t.amount,0);
            // 予算明示済みなら remainCat 計算(0 円 - 支出 N = -N で「超 N」表示に乗せる)。
            const weekRemainCat = hasWeekCatBudget ? (weekCatBudget - weekCatSpent) : null;
            const isOver = weekRemainCat!==null&&weekRemainCat<0;
            const alertItem=budgetAlerts.find(a=>a.cat.id===cat.id);
            return(
              <button key={cat.id} onClick={()=>setInputCategory(cat.id)} style={{border:`1.5px solid ${isSelected?GOLD:alertItem?alertItem.level==="over"?RED:`${GOLD}44`:BORDER}`,borderRadius:12,padding:"12px 6px 10px",cursor:"pointer",background:isSelected?`${GOLD}14`:CARD_BG,display:"flex",flexDirection:"column",alignItems:"center",gap:5,position:"relative",boxShadow:isSelected?`0 0 16px ${GOLD}44`:"0 1px 6px rgba(0,0,0,0.3)"}}>
                {alertItem&&<span style={{position:"absolute",top:4,right:4,fontSize:7,background:alertItem.level==="over"?RED:GOLD,color:"#0A1628",borderRadius:3,padding:"1px 4px",fontWeight:500}}>{alertItem.level==="over"?"超":"警"}</span>}
                <CatSvgIcon cat={cat} size={44}/>
                <span style={{fontSize:13,color:isSelected?GOLD:TEXT_PRIMARY,fontWeight:isSelected?700:600}}>{cat.label}</span>
                <span style={{fontSize:9,fontWeight:700,color:weekRemainCat===null?TEXT_MUTED:isOver?RED:GOLD,lineHeight:1.3,textAlign:"center"}}>
                  {weekRemainCat===null?"–":isOver?`超${Math.abs(weekRemainCat).toLocaleString()}`:`残${weekRemainCat.toLocaleString()}`}
                </span>
              </button>
            );
          })}
        </div>
        {recurringList.length>0&&(<div style={{margin:"6px 18px 0",background:`${TEAL}18`,borderRadius:12,padding:"10px 14px",display:"flex",alignItems:"center",justifyContent:"space-between",border:`1px solid ${TEAL}44`}}><span style={{fontSize:11,color:TEAL,fontWeight:300}}>🔁 定期支出: {recurringList.length}件</span><button onClick={()=>setShowRecurringModal(true)} style={{background:"none",border:"none",color:TEAL,fontSize:11,cursor:"pointer"}}>管理 ›</button></div>)}
        </div>
        {/* 下部ブロック(flex-shrink:0):ゴールドボタン — サンドイッチの footer 位置
            - FIXED_SUBMIT_STYLE は module-level 定数(参照安定 → style 再適用スキップ)
            - 旧 position:fixed + translate3d + env() 方式から flex child に移行。
              renderDaily の height:100% が S.main content area と一致し、その末尾の
              flex-shrink:0 要素として自然に「画面下」に収まる。env() 再評価ジッタなし。
            - translateZ(0)・willChange:transform は GPU 合成レイヤー化のため維持。
            - onClick は submitFixedClick(useMemo 参照固定) */}
        <div style={S.fixedSubmit}>
          <button style={S.submitBtn} onClick={submitFixedClick}>支出を入力する</button>
        </div>
      </div>
    );
  };

  const renderDayView = () => {
    const {y,m}=calMonth;
    // サイクル範囲(報酬日設定済み = 5/25-6/24 など、未設定 = 5/1-5/31)で取引フィルタ
    const cycSStr = toDateStr(cycleStart(y, m, managementStartDay));
    const cycEStr = toDateStr(cycleEnd(y, m, managementStartDay));
    const monthTxs=[...transactions].filter(t=>t.date>=cycSStr&&t.date<=cycEStr).reverse();
    const groupedByDate = {};
    monthTxs.forEach(t=>{if(!groupedByDate[t.date])groupedByDate[t.date]=[];groupedByDate[t.date].push(t);});
    return (
      <div>
        <div style={{...S.monthNav,justifyContent:"space-between",padding:"8px 12px"}}>
          <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};});setSelectedDay(null);}}>‹</button>
          <span style={{fontWeight:600,fontSize:13,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{cycleLabel(y,m,managementStartDay)}</span>
          <div style={{display:"flex",alignItems:"center",gap:4}}>
            <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};});setSelectedDay(null);}}>›</button>
            <button onClick={()=>setShowSearch(true)} style={{background:"none",border:"none",color:TEXT_MUTED,cursor:"pointer",fontSize:13,padding:"4px 6px"}}>🔍</button>
          </div>
        </div>
        <div style={S.calGrid}>
          {["日","月","火","水","木","金","土"].map((d,i)=>(<div key={d} style={{textAlign:"center",padding:"6px 0",fontSize:11,color:i===0?RED:i===6?TEAL:TEXT_SECONDARY,borderBottom:`1px solid ${BORDER}`}}>{d}</div>))}
          {calDays.map(({date,current},idx)=>{
            const ds=toDateStr(date);const isToday=ds===toDateStr(today);const isSelected=ds===selectedDay;const dow=date.getDay();const tx=calTxMap[ds];
            return(<div key={idx} onClick={()=>{if(current){setSelectedDay(isSelected?null:ds);}}} style={{minHeight:52,padding:"4px 2px",borderBottom:`1px solid ${BORDER}`,borderRight:`1px solid rgba(212,168,67,0.08)`,background:isSelected?NAVY3:isToday?`${GOLD}1A`:CARD_BG,opacity:current?1:0.25,cursor:current?"pointer":"default"}}>
              <div style={{fontSize:12,fontWeight:isToday?500:300,color:dow===0?RED:dow===6?TEAL:TEXT_PRIMARY,textAlign:"center"}}>{date.getDate()}</div>
              {tx&&tx>0&&<div style={{fontSize:9,color:RED,textAlign:"center",fontWeight:400}}>{tx.toLocaleString()}</div>}
            </div>);
          })}
        </div>
        <div style={{background:CARD_BG,margin:"8px 0 0",paddingBottom:4}}>
          <div style={{padding:"10px 18px 8px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
            <span style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>{selectedDay||toDateStr(today)}</span>
            {groupedByDate[selectedDay]
              ? <span style={{fontSize:10,color:RED,fontWeight:300}}>{groupedByDate[selectedDay].reduce((s,t)=>s+t.amount,0).toLocaleString()}円</span>
              : <span style={{fontSize:10,color:TEXT_MUTED,fontWeight:300}}>0円</span>
            }
          </div>
          {groupedByDate[selectedDay]
            ? groupedByDate[selectedDay].map(t=><TxItem key={t.id} t={t}/>)
            : <div style={{textAlign:"center",padding:"20px",color:TEXT_MUTED,fontSize:11}}>この日の取引はありません</div>
          }
        </div>
      </div>
    );
  };

  // ============================================================
  // ★★★ 週ビュー - 2ボックス形式に変更 ★★★
  // ============================================================
  const renderWeekly = () => {
    const {y,m}=calMonth;
    const currentWeekNum = weekInCycle(today, managementStartDay);

    return (
      <div>
        <div style={{padding:"12px 18px 8px",background:CARD_BG,display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:700,fontSize:17,color:TEXT_PRIMARY}}>週間サマリー</span>
          <span style={{width:40}}/>
        </div>
        <div style={S.monthNav}>
          <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m-1);const nm=d.getMonth(),ny=d.getFullYear();const isNowMonth=ny===today.getFullYear()&&nm===today.getMonth();setExpandedWeek(isNowMonth?weekInCycle(today,managementStartDay):null);return{y:ny,m:nm};});}}>‹</button>
          <span style={{fontWeight:600,fontSize:13,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{cycleLabel(y,m,managementStartDay)}</span>
          <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m+1);const nm=d.getMonth(),ny=d.getFullYear();const isNowMonth=ny===today.getFullYear()&&nm===today.getMonth();setExpandedWeek(isNowMonth?weekInCycle(today,managementStartDay):null);return{y:ny,m:nm};});}}>›</button>
        </div>

        <div style={{background:CARD_BG,margin:"8px 0 0",padding:"14px 18px"}}>
          <div style={{fontWeight:400,fontSize:11,marginBottom:12,color:TEXT_SECONDARY}}>週間サマリー（{m+1}月）</div>
          {[...weekSummary].sort((a,b)=>{
            // 今月表示中だけ今週を先頭に、それ以外は第1週から順番
            const isCurrentMonth = y===today.getFullYear() && m===today.getMonth();
            if(!isCurrentMonth) return a.weekNum-b.weekNum;
            const cur = weekInCycle(today, managementStartDay);
            if(a.weekNum===cur) return -1;
            if(b.weekNum===cur) return 1;
            return a.weekNum-b.weekNum;
          }).map((w,i)=>{
            const pctRaw = w.weekBudget>0 ? Math.round(w.expense/w.weekBudget*100) : 0;
            const pct = Math.min(100, pctRaw);
            const remain = w.weekBudget - w.expense;
            const barColor = pctRaw>=100 ? RED : pctRaw>=80 ? "#D4A017" : GOLD;
            const isExpanded = expandedWeek === w.weekNum;
            const isCurrentMonth = y===today.getFullYear() && m===today.getMonth();
            const isCurrentWeek = isCurrentMonth && w.weekNum === currentWeekNum;

            const catBreakdownData = expenseCats.map(cat=>{
              const spent = transactions.filter(t=>t.category===cat.id&&t.date>=w.startStr&&t.date<=w.endStr).reduce((s,t)=>s+t.amount,0);
              // 週予算キーが localStorage に存在するか(0 円明示も含む)で hasWeekCatBudget を判定。
              const rawWeekCatBudget = weekCatBudgets[`${w.weekKey}_${cat.id}`];
              const hasWeekCatBudget = rawWeekCatBudget != null;
              const weekCatBudget = hasWeekCatBudget ? rawWeekCatBudget : 0;
              // 月予算も同様に明示判定(0 円明示も含む)。
              const rawDirectBudget = budgets[`${y}-${m+1}-${cat.id}`];
              const hasDirectBudget = rawDirectBudget != null;
              const hasAnyBudget = hasWeekCatBudget || hasDirectBudget;
              // 予算 0 円: 1 円 = 1% 換算(spent 円 = spent %)。予算 > 0: 通常比率。予算なし: 0%。
              const catPctRaw = hasWeekCatBudget
                ? (weekCatBudget > 0 ? Math.round(spent/weekCatBudget*100) : spent)
                : 0;
              const catPct = Math.min(100, catPctRaw);
              return {cat, spent, weekCatBudget, hasWeekCatBudget, catPct, catPctRaw, hasAnyBudget};
            });

            return (
              <div key={i} style={{marginBottom:12,background:"#2A2F3E",borderRadius:14,border:`1px solid ${isExpanded?GOLD:BORDER}`,boxShadow:isExpanded?`0 0 12px ${GOLD}33`:SHADOW,overflow:"hidden"}}>
                {/* ── カードヘッダー ── */}
                <div onClick={()=>setExpandedWeek(isExpanded?null:w.weekNum)} style={{padding:"14px 16px",cursor:"pointer"}}>
                  {/* タイトル行 */}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:18,fontWeight:700,color:TEXT_PRIMARY}}>{w.label}</span>
                      {isCurrentWeek&&<span style={{fontSize:10,color:GOLD,background:`${GOLD}22`,borderRadius:6,padding:"2px 6px",fontWeight:600}}>今週</span>}
                      <span style={{fontSize:10,color:TEXT_MUTED}}>{w.startStr.slice(5)} 〜 {w.endStr.slice(5)}</span>
                      {w.isManual
                        ? <span style={{fontSize:9,background:NAVY,color:GOLD,borderRadius:4,padding:"1px 6px"}}>手動</span>
                        : w.weekBudget>0&&<span style={{fontSize:9,background:`${GOLD}22`,color:GOLD,borderRadius:4,padding:"1px 6px"}}>自動</span>
                      }
                    </div>
                    <span style={{fontSize:14,color:isExpanded?GOLD:TEXT_MUTED}}>{isExpanded?"▲":"▼"}</span>
                  </div>

                  {/* ★ 2ボックス(合計バー。カード地 #2A2F3E にフラットに溶ける) */}
                  <WeekTwoBox
                    expense={w.expense}
                    budget={w.weekBudget}
                    isOver={w.isOver}
                    pct={pct}
                    pctRaw={pctRaw}
                    remain={remain}
                    barColor={barColor}
                  />
                </div>

                {/* ── 展開：カテゴリ別内訳（2ボックス形式） ── */}
                {isExpanded&&(
                  <div style={{borderTop:`1px solid ${BORDER}`,padding:"14px 16px 14px",background:"#1E2330"}}>
                    {catBreakdownData.map(({cat,spent,weekCatBudget,hasWeekCatBudget,catPct,catPctRaw,hasAnyBudget},idx,arr)=>{
                      // 0 円明示も「予算あり」扱い。spent も hasAnyBudget も 0/false なら非表示。
                      const visible = arr.filter(x=>x.spent>0||x.hasAnyBudget);
                      const visIdx = visible.findIndex(x=>x.cat.id===cat.id);
                      if(spent===0&&!hasAnyBudget) return null;
                      return(
                        <CatTwoBox key={cat.id} cat={cat} spent={spent} weekCatBudget={weekCatBudget} catPct={catPct} catPctRaw={catPctRaw} hasBudget={hasWeekCatBudget} isLast={visIdx===visible.length-1}/>
                      );
                    })}
                    <div style={{borderTop:`1px solid rgba(255,255,255,0.1)`,marginTop:16,paddingTop:14}}>
                      <button onClick={e=>{e.stopPropagation();setExpandedWeek(null);}} style={{width:"100%",padding:"12px",background:"rgba(255,255,255,0.05)",border:`1px solid ${BORDER}`,borderRadius:8,color:TEXT_MUTED,fontSize:12,cursor:"pointer",fontWeight:500}}>▲ 閉じる</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ============================================================
  // 月間ビュー（円グラフはそのまま）
  // ============================================================
  const renderMonthly = () => {
    const {y,m}=reportMonth;
    const rBudget=getEffectiveMonthBudget(y,m);
    return (
      <div>
        <div style={{display:"flex",alignItems:"center",padding:"8px 14px",background:CARD_BG}}>
          <div style={{flex:1,display:"flex"}}>
            <div style={{display:"flex",background:NAVY3,borderRadius:24,padding:2,border:`1px solid ${BORDER}`,width:"100%"}}>
              <button style={S.typeBtn(reportType==="monthly")} onClick={()=>setReportType("monthly")}>月間進捗</button>
              <button style={S.typeBtn(reportType==="yearly")} onClick={()=>setReportType("yearly")}>年間レポート</button>
            </div>
          </div>
          {(()=>{
            const sStr=toDateStr(cycleStart(y,m,managementStartDay));
            const eStr=toDateStr(cycleEnd(y,m,managementStartDay));
            const monthTotal=transactions.filter(t=>t.date>=sStr&&t.date<=eStr).reduce((s,t)=>s+t.amount,0);
            return(
              <button onClick={()=>setShowMonthSummary(true)} style={{background:NAVY3,border:`1px solid ${GOLD}66`,borderRadius:16,padding:"4px 10px",cursor:"pointer",display:"flex",alignItems:"center",gap:3,flexShrink:0}}>
                <span style={{fontSize:10,fontWeight:700,color:GOLD}}>現金支出</span>
              </button>
            );
          })()}
        </div>
        {reportType==="monthly"?(
          <>
            <div style={S.monthNav}>
              <button style={S.navArrow} onClick={()=>setReportMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}>‹</button>
              <span style={{fontWeight:600,fontSize:13,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{cycleLabel(y,m,managementStartDay)}</span>
              <button style={S.navArrow} onClick={()=>setReportMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}>›</button>
            </div>
            <SummaryBar spent={reportExpense} budget={rBudget} remain={rBudget-reportExpense} labelBudget="月の予算" labelSpent="月の支出" labelRemain="月の残予算"/>

            {/* ★ 円グラフはそのまま維持 */}
            {catBreakdown.length>0&&(
              <div style={{background:CARD_BG,padding:"16px 18px 8px",marginBottom:1}}>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={catBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={90} dataKey="value" labelLine={false}
                      label={({cx,cy,midAngle,innerRadius,outerRadius,name,percent,fill})=>{
                        const RADIAN=Math.PI/180;
                        const pctInt=Math.round(percent*100);
                        // 中サイズ以上: リング内側に従来どおり重ね描画
                        if(percent>=0.08){
                          const r=innerRadius+(outerRadius-innerRadius)*0.5;
                          const x=cx+r*Math.cos(-midAngle*RADIAN);
                          const yy=cy+r*Math.sin(-midAngle*RADIAN);
                          return(
                            <g>
                              <text x={x} y={yy-7} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700}>{name.length>4?name.slice(0,4):name}</text>
                              <text x={x} y={yy+9} fill="#fff" textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={700}>{pctInt}%</text>
                            </g>
                          );
                        }
                        // 小サイズ: スライス外縁からリーダーライン → 外側ラベル
                        const cos=Math.cos(-midAngle*RADIAN);
                        const sin=Math.sin(-midAngle*RADIAN);
                        const sx=cx+outerRadius*cos;
                        const sy=cy+outerRadius*sin;
                        const mx=cx+(outerRadius+8)*cos;
                        const my=cy+(outerRadius+8)*sin;
                        const ex=mx+(cos>=0?1:-1)*10;
                        const ey=my;
                        const textAnchor=cos>=0?'start':'end';
                        const tx=ex+(cos>=0?3:-3);
                        const lineColor=fill||TEXT_MUTED;
                        return(
                          <g>
                            <path d={`M${sx},${sy}L${mx},${my}L${ex},${ey}`} stroke={lineColor} strokeWidth={1} fill="none" opacity={0.7}/>
                            <circle cx={ex} cy={ey} r={1.5} fill={lineColor}/>
                            <text x={tx} y={ey} fill={TEXT_PRIMARY} textAnchor={textAnchor} dominantBaseline="central" fontSize={10} fontWeight={600}>{(name.length>4?name.slice(0,4):name)} {pctInt}%</text>
                          </g>
                        );
                      }}
                    >
                      {catBreakdown.map((e,i)=><Cell key={i} fill={e.color}/>)}
                    </Pie>
                    <Tooltip formatter={v=>`${v.toLocaleString()}円`}/>
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            <div style={{background:CARD_BG,marginBottom:1}}>
              <div style={{fontWeight:400,fontSize:13,padding:"16px 18px 10px",color:TEXT_SECONDARY}}>カテゴリー別支出</div>
              <div style={{padding:"0 18px 16px"}}>
                {(()=>{
                  // 月予算:直接設定 → なければ週予算×4週の合計。0 円明示も「予算あり」扱い。
                  const items = expenseCats.map(cat=>{
                    const spent = reportTxs.filter(t=>t.category===cat.id).reduce((s,t)=>s+t.amount,0);
                    const rawDirect = budgets[`${y}-${m+1}-${cat.id}`];
                    const hasDirectBudget = rawDirect != null;
                    const directBudget = hasDirectBudget ? rawDirect : 0;
                    // 週予算の sum と「いずれか 1 週でも明示設定があるか」の両方を取る。
                    let weeklyBudgetSum = 0;
                    let hasAnyWeekBudget = false;
                    for (const wn of [1,2,3,4]) {
                      const v = weekCatBudgets[`${y}-${m+1}-w${wn}_${cat.id}`];
                      if (v != null) { hasAnyWeekBudget = true; weeklyBudgetSum += v; }
                    }
                    // 表示する予算値:直接設定があればそれ(0 含む)、無ければ週予算合計。
                    const catBudget = hasDirectBudget ? directBudget : weeklyBudgetSum;
                    const hasBudget = hasDirectBudget || hasAnyWeekBudget;
                    return { cat, spent, catBudget, hasBudget };
                  }).filter(x => x.spent>0 || x.hasBudget);
                  return items.map((item, idx)=>{
                    const { cat, spent, catBudget, hasBudget } = item;
                    // 予算 0 円: 1 円 = 1% 換算。予算 > 0: 通常比率。予算なし: 0%。
                    const catPctRaw = hasBudget
                      ? (catBudget > 0 ? Math.round(spent/catBudget*100) : spent)
                      : 0;
                    const catPct = Math.min(100, catPctRaw);
                    return (
                      <CatTwoBox
                        key={cat.id}
                        cat={cat}
                        spent={spent}
                        weekCatBudget={catBudget}
                        catPct={catPct}
                        catPctRaw={catPctRaw}
                        hasBudget={hasBudget}
                        isLast={idx === items.length - 1}
                        periodLabel="月"
                      />
                    );
                  });
                })()}
              </div>
            </div>
          </>
        ):(
          <>
            <div style={S.monthNav}>
              <button style={S.navArrow} onClick={()=>setReportYear(y=>y-1)}>‹</button>
              <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{reportYear}年</span>
              <button style={S.navArrow} onClick={()=>setReportYear(y=>y+1)}>›</button>
            </div>
            <div style={{background:CARD_BG,padding:"20px 20px 16px",marginBottom:1}}>
              <div style={{fontSize:11,color:TEXT_SECONDARY,fontWeight:500,marginBottom:6}}>年間合計支出</div>
              <div style={{fontSize:34,fontWeight:700,color:RED}}>{yearlyTotal.toLocaleString()}<span style={{fontSize:15,color:TEXT_SECONDARY,fontWeight:400}}>円</span></div>
              <div style={{marginTop:16,height:200}}>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={yearlyData} margin={{top:16,right:8,left:8,bottom:0}}>
                    <defs>
                      <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={GOLD} stopOpacity={0.45}/>
                        <stop offset="100%" stopColor={GOLD} stopOpacity={0.02}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false}/>
                    {/* 基準ライン */}
                    <ReferenceLine y={500000} stroke="rgba(46,216,180,0.35)" strokeDasharray="4 3"
                      label={{value:"50万",position:"insideTopRight",fontSize:9,fill:"rgba(46,216,180,0.7)",fontWeight:700}}/>
                    <ReferenceLine y={1000000} stroke="rgba(255,71,87,0.35)" strokeDasharray="4 3"
                      label={{value:"100万",position:"insideTopRight",fontSize:9,fill:"rgba(255,71,87,0.7)",fontWeight:700}}/>
                    <XAxis
                      dataKey="name"
                      tick={{fontSize:10,fill:"rgba(240,234,214,0.4)"}}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{fontSize:9,fill:"rgba(240,234,214,0.3)"}}
                      axisLine={false}
                      tickLine={false}
                      tickFormatter={v=>v===0?"":v>=10000?`${Math.round(v/10000)}万`:`${v}`}
                      width={34}
                    />
                    <Tooltip
                      formatter={v=>[`${v.toLocaleString()}円`,"支出"]}
                      contentStyle={{background:NAVY2,border:`1px solid ${GOLD}44`,borderRadius:10,fontSize:12,color:TEXT_PRIMARY}}
                      labelStyle={{color:GOLD,fontWeight:700,marginBottom:4}}
                      cursor={{stroke:`${GOLD}33`,strokeWidth:1}}
                    />
                    <Area
                      type="monotone"
                      dataKey="expense"
                      stroke={GOLD}
                      strokeWidth={2.5}
                      fill="url(#goldGrad)"
                      dot={(props)=>{
                        const {cx,cy,payload,index}=props;
                        const isCurrentMonth = index===today.getMonth()&&reportYear===today.getFullYear();
                        const hasData = payload.expense > 0;
                        if(!hasData) return <circle key={index} cx={cx} cy={cy} r={2} fill="rgba(212,168,67,0.2)" stroke="none"/>;
                        return(
                          <g key={index}>
                            <circle cx={cx} cy={cy}
                              r={isCurrentMonth?7:4}
                              fill={isCurrentMonth?GOLD:NAVY2}
                              stroke={GOLD}
                              strokeWidth={2}
                            />
                            {/* 金額ラベル */}
                            <text x={cx} y={cy-12} textAnchor="middle" fontSize={8} fill={isCurrentMonth?GOLD:"rgba(212,168,67,0.7)"} fontWeight={700}>
                              {payload.expense>=1000000
                                ? `${(payload.expense/10000).toFixed(0)}万`
                                : payload.expense>=10000
                                ? `${Math.round(payload.expense/10000)}万`
                                : `${payload.expense.toLocaleString()}`
                              }
                            </text>
                          </g>
                        );
                      }}
                      activeDot={{r:8,fill:GOLD,stroke:NAVY2,strokeWidth:2}}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div style={{background:CARD_BG,padding:"14px 0"}}>
              <div style={{padding:"0 20px 10px",fontSize:12,fontWeight:700,color:TEXT_PRIMARY}}>月別支出</div>
              {yearlyData.map((d,i)=>{
                const isCurrentMonth = i===today.getMonth()&&reportYear===today.getFullYear();
                // その月の総予算を計算
                const monthBudget = expenseCats.reduce((total,cat)=>{
                  const directBudget = budgets[`${reportYear}-${i+1}-${cat.id}`] || 0;
                  const weeklyBudgetSum = [1,2,3,4].reduce((s,wn)=>s+(weekCatBudgets[`${reportYear}-${i+1}-w${wn}_${cat.id}`]||0),0);
                  return total + (directBudget>0 ? directBudget : weeklyBudgetSum);
                }, 0);
                const isOver = monthBudget>0 && d.expense>monthBudget;
                const hasExpense = d.expense>0;
                const amountColor = !hasExpense ? TEXT_MUTED : isOver ? RED : "#2196F3";
                const barColor = isCurrentMonth ? GOLD : isOver ? RED : "#2196F3";
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",padding:"10px 20px",borderBottom:`1px solid ${BORDER}`,background:isCurrentMonth?`${GOLD}0A`:CARD_BG}}>
                    <span style={{fontSize:13,fontWeight:isCurrentMonth?700:400,color:isCurrentMonth?GOLD:TEXT_PRIMARY,minWidth:40}}>{i+1}月</span>
                    <div style={{flex:1,height:3,background:"rgba(255,255,255,0.07)",borderRadius:2,overflow:"hidden",margin:"0 12px"}}>
                      {d.expense>0&&<div style={{height:"100%",width:`${Math.round(d.expense/Math.max(...yearlyData.map(x=>x.expense),1)*100)}%`,background:barColor,borderRadius:2}}/>}
                    </div>
                    <span style={{fontSize:13,fontWeight:700,color:amountColor,minWidth:80,textAlign:"right"}}>{d.expense>0?`${d.expense.toLocaleString()}円`:"—"}</span>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );
  };

  const renderBudget = () => {
    const {y,m}=budgetMonth;
    return (
      <div>
        <div style={{padding:"14px 18px 8px",background:CARD_BG,display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{width:32}}></span><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>予算</span><button onClick={openBudgetModal} style={{background:"none",border:"none",fontSize:20,color:ORANGE,cursor:"pointer"}}>⚙️</button></div>
        {budgetAlerts.length>0&&(<div style={{margin:"0 18px 12px",background:budgetAlerts.some(a=>a.level==="over")?`${RED}15`:`${GOLD}15`,borderRadius:12,padding:"12px 14px"}}><div style={{fontWeight:700,fontSize:13,marginBottom:8,color:budgetAlerts.some(a=>a.level==="over")?RED:GOLD}}>{budgetAlerts.some(a=>a.level==="over")?"🚨 予算オーバー":"⚠️ 予算80%超え"}</div>{budgetAlerts.map((a,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><CatSvgIcon cat={a.cat} size={18}/><span style={{flex:1,fontSize:12,fontWeight:600}}>{a.cat.label}</span><span style={{fontSize:11,color:"#888"}}>{a.spent.toLocaleString()} / {a.budget.toLocaleString()}円</span><span style={{fontSize:11,fontWeight:700,color:a.level==="over"?RED:"#E65100",background:a.level==="over"?"#FFCDD2":"#FFE0B2",borderRadius:8,padding:"2px 6px"}}>{Math.round(a.pct)}%</span></div>))}</div>)}
        <div style={S.monthNav}><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}>‹</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{fmtMonth(y,m)}</span><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}>›</button></div>
        <SummaryBar spent={totalSpending} budget={totalBudget} remain={totalBudget-totalSpending} onBudgetTap={openBudgetModal}/>
        {totalBudget>0&&<div style={{padding:"0 18px 12px",background:CARD_BG}}><div style={{height:6,background:"rgba(255,255,255,0.08)",borderRadius:4,overflow:"hidden",marginTop:8}}><div style={{height:"100%",width:`${Math.min(100,totalSpending/totalBudget*100)}%`,background:totalSpending>totalBudget?RED:GOLD,borderRadius:4}}/></div></div>}
        <div style={{background:CARD_BG}}>
          {expenseCats.map(cat=>{
            const budget=getBudget(cat.id);const spent=catSpending(cat.id);const pctRaw=budget?Math.round(spent/budget*100):0;const pct=Math.min(100,pctRaw);const isOver=budget&&spent>budget;const isWarn=budget&&pct>=80&&!isOver;
            return(
              <div key={cat.id} onClick={()=>{setCatBudgetTarget({...cat,_isWeek:false});setCatBudgetInput(budget?String(budget):"");setShowCatBudgetModal(true);}} style={{borderBottom:`1px solid ${BORDER}`,background:isOver?`${RED}11`:isWarn?`${GOLD}11`:CARD_BG,cursor:"pointer"}}>
                <div style={{display:"flex",alignItems:"center",padding:"14px 18px 6px",gap:10}}>
                  <CatSvgIcon cat={cat} size={24}/>
                  <span style={{flex:1,fontWeight:400,fontSize:13,color:TEXT_PRIMARY}}>{cat.label}</span>
                  {isOver&&<span style={{fontSize:10,background:RED,color:"#fff",borderRadius:6,padding:"2px 6px",fontWeight:700}}>超過</span>}
                  {isWarn&&<span style={{fontSize:10,background:"#FF9800",color:"#fff",borderRadius:6,padding:"2px 6px",fontWeight:700}}>警告</span>}
                  <span style={{color:budget?TEXT_PRIMARY:TEXT_MUTED,fontSize:12}}>{budget?`${budget.toLocaleString()}円`:"未設定"}</span>
                  <span style={{color:"#ccc",fontSize:14}}>›</span>
                </div>
                <div style={{padding:"0 18px 12px"}}>
                  <div style={{height:4,background:"rgba(255,255,255,0.08)",borderRadius:4,overflow:"hidden"}}>{budget>0&&<div style={{height:"100%",width:`${pct}%`,background:pct>=100?RED:pct>=80?GOLD:TEAL,borderRadius:4}}/>}</div>
                  {budget>0&&<div style={{fontSize:10,color:isOver?RED:isWarn?GOLD:TEXT_MUTED,marginTop:2,textAlign:"right",fontWeight:isOver||isWarn?700:400}}>{spent.toLocaleString()} / {budget.toLocaleString()}円 ({pctRaw}%)</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const renderMenu = () => {
    if(menuScreen==="catNew") return (
      <div style={{display:"flex",flexDirection:"column",minHeight:"100dvh",background:CREAM}}>
        <div style={{...S.overlayHeader,position:"sticky",top:0,zIndex:10}}>
          <button onClick={()=>setMenuScreen("catEdit")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
          <span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>新規制作</span>
          <span style={{width:32}}></span>
        </div>
        <div style={{flex:1,overflowY:"auto",paddingBottom:140,background:NAVY}}>
          <div style={{height:12,background:CREAM}}/>
          <div style={{background:CARD_BG,borderBottom:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",padding:"16px 18px",gap:12}}>
              <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:36}}>名前</span>
              <input value={newCatName} onChange={e=>setNewCatName(e.target.value)} placeholder="項目名を入力してください" style={{flex:1,border:"none",fontSize:15,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
            </div>
          </div>
          <div style={{height:12,background:CREAM}}/>
          <IconPicker selected={newCatIcon} onSelect={setNewCatIcon}/>
          <div style={{height:12,background:CREAM}}/>
          <ColorPicker selected={newCatColor} onSelect={setNewCatColor}/>
          <div style={{height:12,background:CREAM}}/>
        </div>
        <div style={{position:"fixed",bottom:"calc(60px + env(safe-area-inset-bottom) + 8px)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:CARD_BG,padding:"12px 18px 12px",borderTop:"1px solid #f0f0f0",zIndex:150}}>
          <button onClick={addNewCategory} style={{display:"block",width:"100%",padding:"16px",background:newCatName.trim()?ORANGE:"#eee",color:newCatName.trim()?"#fff":"#aaa",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}>保存</button>
        </div>
      </div>
    );

    if(menuScreen==="catEdit") return(
      <div>
        <div style={S.overlayHeader}><button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>カテゴリ編集</span><span style={{width:40}}></span></div>
        <div style={{height:12,background:CREAM}}/>
        <div style={{background:CARD_BG}}>
          <div onClick={()=>setMenuScreen("catNew")} style={{...S.listItem,color:ORANGE,fontWeight:600}}><span>＋</span><span style={{flex:1}}>新規カテゴリーの追加</span><span style={{color:"#bbb"}}>›</span></div>
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              const oldIndex = expenseCats.findIndex((c) => c.id === active.id);
              const newIndex = expenseCats.findIndex((c) => c.id === over.id);
              if (oldIndex < 0 || newIndex < 0) return;
              const sorted = arrayMove(expenseCats, oldIndex, newIndex);
              reorderCategories(sorted.map((c) => c.id));
            }}
          >
            <SortableContext items={expenseCats.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              {expenseCats.map((cat) => (
                <SortableCategoryRow
                  key={cat.id}
                  cat={cat}
                  icon={<CatSvgIcon cat={cat} size={32}/>}
                  onEdit={(c) => {
                    setEditingCat(c);
                    setEditName(c.label);
                    setEditIcon(c.iconKey || c.icon || "restaurant");
                    setEditColor(c.color || "#FF6B35");
                    setMenuScreen("catEditDetail");
                  }}
                  onRemove={(id) => removeCategory(id).catch((e) => { console.error(e); alert("削除に失敗しました。"); })}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    );

    if(menuScreen==="catEditDetail"&&editingCat) return(
      <div style={{display:"flex",flexDirection:"column",minHeight:"100dvh",background:CREAM}}>
        <div style={{...S.overlayHeader,position:"sticky",top:0,zIndex:10}}>
          <button onClick={()=>setMenuScreen("catEdit")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
          <span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>{editingCat.label}を編集</span>
          <span style={{width:32}}></span>
        </div>
        <div style={{flex:1,overflowY:"auto",paddingBottom:140,background:NAVY}}>
          <div style={{height:12,background:CREAM}}/>
          <div style={{background:CARD_BG,borderBottom:`1px solid ${BORDER}`}}>
            <div style={{display:"flex",alignItems:"center",padding:"16px 18px",gap:12}}>
              <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:36}}>名前</span>
              <input value={editName} onChange={e=>setEditName(e.target.value)} style={{flex:1,border:"none",fontSize:15,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
            </div>
          </div>
          <div style={{height:12,background:CREAM}}/>
          <IconPicker selected={editIcon} onSelect={setEditIcon}/>
          <div style={{height:12,background:CREAM}}/>
          <ColorPicker selected={editColor} onSelect={setEditColor}/>
          <div style={{height:12,background:CREAM}}/>
        </div>
        <div style={{position:"fixed",bottom:"calc(60px + env(safe-area-inset-bottom) + 8px)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:CARD_BG,padding:"12px 18px 12px",borderTop:"1px solid #f0f0f0",zIndex:150}}>
          <button
            onClick={() => {
              updateCategoryDb(editingCat.id, { label: editName, iconKey: editIcon, color: editColor })
                .then(() => setMenuScreen("catEdit"))
                .catch((e) => { console.error(e); alert("保存に失敗しました。"); });
            }}
            style={{display:"block",width:"100%",padding:"16px",background:ORANGE,color:"#fff",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}
          >保存</button>
        </div>
      </div>
    );

    if(menuScreen==="paymentEdit") return(
      <div>
        <div style={S.overlayHeader}><button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>支払い方法</span><span style={{width:40}}></span></div>
        <div style={{height:12,background:CREAM}}/>
        <div style={{background:CARD_BG}}>
          <div onClick={()=>{setPaymentDraft({label:"",color:"#4CAF50",closingDay:"",withdrawalDay:""});setEditingPaymentId(null);setMenuScreen("paymentNew");}} style={{...S.listItem,color:ORANGE,fontWeight:600}}>
            <span>＋</span><span style={{flex:1}}>新しい支払い方法を追加</span><span style={{color:"#bbb"}}>›</span>
          </div>
          {/* カテゴリ編集と同じ iOS 長押しドラッグ機構。
              sensors は App 直下で定義済みの dndSensors を流用(MouseSensor + TouchSensor + KeyboardSensor)。
              永続化は useLocalStorage("cfo_paymentMethods") 経由で自動 → アプリ再起動後も順序保持。 */}
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={({ active, over }) => {
              if (!over || active.id === over.id) return;
              const oldIndex = paymentMethods.findIndex((pm) => pm.id === active.id);
              const newIndex = paymentMethods.findIndex((pm) => pm.id === over.id);
              if (oldIndex < 0 || newIndex < 0) return;
              setPaymentMethods(arrayMove(paymentMethods, oldIndex, newIndex));
            }}
          >
            <SortableContext items={paymentMethods.map((pm) => pm.id)} strategy={verticalListSortingStrategy}>
              {paymentMethods.map((pm) => (
                <SortablePaymentRow
                  key={pm.id}
                  pm={pm}
                  onEdit={(p) => {
                    setPaymentDraft({ label: p.label, color: p.color, closingDay: p.closingDay || "", withdrawalDay: p.withdrawalDay || "", bank: p.bank || "" });
                    setEditingPaymentId(p.id);
                    setMenuScreen("paymentNew");
                  }}
                  onRemove={(id) => setPaymentMethods((prev) => prev.filter((x) => x.id !== id))}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </div>
    );

    if(menuScreen==="paymentNew"){
      const isEdit = !!editingPaymentId;
      return(
        <div style={{display:"flex",flexDirection:"column",minHeight:"100dvh",background:CREAM}}>
          <div style={{...S.overlayHeader,position:"sticky",top:0,zIndex:10}}>
            <button onClick={()=>setMenuScreen("paymentEdit")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:700,fontSize:16}}>{isEdit?"支払い方法を編集":"新規支払い方法"}</span>
            <span style={{width:32}}></span>
          </div>
          <div style={{flex:1,overflowY:"auto",paddingBottom:140}}>
            <div style={{height:12,background:CREAM}}/>
            <div style={{background:CARD_BG,padding:"20px 18px",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:1}}>
              <div style={{padding:"10px 28px",background:paymentDraft.color,borderRadius:10,display:"flex",flexDirection:"column",alignItems:"center",gap:6,minWidth:100}}>
                <div style={{width:32,height:32,borderRadius:6,background:"rgba(255,255,255,0.35)"}}/>
                <span style={{fontSize:13,fontWeight:700,color:"#fff"}}>{paymentDraft.label||"名前未入力"}</span>
              </div>
            </div>
            <div style={{background:CARD_BG,borderBottom:`1px solid ${BORDER}`}}>
              <div style={{display:"flex",alignItems:"center",padding:"16px 18px",gap:12}}>
                <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:36}}>名前</span>
                <input value={paymentDraft.label} onChange={e=>setPaymentDraft(p=>({...p,label:e.target.value}))} placeholder="例：楽天カード" style={{flex:1,border:"none",fontSize:15,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
              </div>
            </div>
            <div style={{height:12,background:CREAM}}/>
            <div style={{background:CARD_BG,padding:"16px 18px"}}>
              <div style={{fontWeight:400,fontSize:13,marginBottom:14,color:TEXT_SECONDARY}}>カラー</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                {PAYMENT_COLORS.map(color=>(
                  <button key={color} onClick={()=>setPaymentDraft(p=>({...p,color}))} style={{width:"100%",aspectRatio:"1",borderRadius:10,border:paymentDraft.color===color?`2px solid ${NAVY}`:"2px solid transparent",background:color,cursor:"pointer"}}/>
                ))}
              </div>
            </div>
            <div style={{height:12,background:CREAM}}/>
            <div style={{background:CARD_BG}}>
              <div style={{padding:"14px 18px 6px",fontSize:12,fontWeight:700,color:TEXT_SECONDARY}}>カード設定（任意）</div>
              <div style={{display:"flex",alignItems:"center",padding:"14px 18px",borderBottom:`1px solid ${BORDER}`,gap:12}}>
                <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:80}}>引き落とし銀行</span>
                <input value={paymentDraft.bank||""} onChange={e=>setPaymentDraft(p=>({...p,bank:e.target.value}))} placeholder="例：三菱UFJ銀行" style={{flex:1,border:"none",background:"transparent",fontSize:14,outline:"none",color:TEXT_PRIMARY,textAlign:"right"}}/>
              </div>
              <div onClick={()=>{setDayCalcInput(paymentDraft.closingDay==="末"?"":paymentDraft.closingDay);setShowDayCalc("closing");}} style={{display:"flex",alignItems:"center",padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,cursor:"pointer",gap:12}}>
                <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:60}}>締日</span>
                <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                  {paymentDraft.closingDay?<span style={{fontSize:20,fontWeight:700,color:GOLD}}>{paymentDraft.closingDay}{paymentDraft.closingDay!=="末"&&"日"}</span>:<span style={{fontSize:14,color:TEXT_MUTED}}>タップして入力</span>}
                  <span style={{fontSize:16,color:TEXT_MUTED}}>›</span>
                </div>
              </div>
              <div onClick={()=>{setDayCalcInput(paymentDraft.withdrawalDay==="末"?"":paymentDraft.withdrawalDay);setShowDayCalc("withdrawal");}} style={{display:"flex",alignItems:"center",padding:"16px 18px",cursor:"pointer",gap:12}}>
                <span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:60}}>引き落とし日</span>
                <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"flex-end",gap:8}}>
                  {paymentDraft.withdrawalDay?<span style={{fontSize:20,fontWeight:700,color:GOLD}}>{paymentDraft.withdrawalDay}{paymentDraft.withdrawalDay!=="末"&&"日"}</span>:<span style={{fontSize:14,color:TEXT_MUTED}}>タップして入力</span>}
                  <span style={{fontSize:16,color:TEXT_MUTED}}>›</span>
                </div>
              </div>
            </div>
            <div style={{height:12,background:CREAM}}/>
          </div>
          {showDayCalc&&(
            <div onClick={()=>setShowDayCalc(false)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}}>
              <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(30px + env(safe-area-inset-bottom))"}}>
                <div style={{padding:"14px 20px 10px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                  <span style={{fontSize:13,color:TEXT_SECONDARY}}>{showDayCalc==="closing"?"締日":"引き落とし日"}</span>
                  <div style={{display:"flex",alignItems:"baseline",gap:4}}>
                    <span style={{fontSize:32,fontWeight:700,color:dayCalcInput?TEXT_PRIMARY:TEXT_MUTED}}>{dayCalcInput||"—"}</span>
                    {dayCalcInput&&<span style={{fontSize:14,color:TEXT_SECONDARY}}>日</span>}
                  </div>
                </div>
                <div style={{padding:"10px 16px 0",display:"flex",gap:8}}>
                  <button onClick={()=>{if(showDayCalc==="closing")setPaymentDraft(p=>({...p,closingDay:"末"}));else setPaymentDraft(p=>({...p,withdrawalDay:"末"}));setShowDayCalc(false);}} style={{flex:1,padding:"10px",background:`${GOLD}22`,border:`1px solid ${GOLD}66`,borderRadius:10,color:GOLD,fontSize:14,fontWeight:700,cursor:"pointer"}}>月末</button>
                  <button onClick={()=>{if(showDayCalc==="closing")setPaymentDraft(p=>({...p,closingDay:""}));else setPaymentDraft(p=>({...p,withdrawalDay:""}));setDayCalcInput("");setShowDayCalc(false);}} style={{flex:1,padding:"10px",background:`${RED}18`,border:`1px solid ${RED}44`,borderRadius:10,color:RED,fontSize:14,fontWeight:700,cursor:"pointer"}}>クリア</button>
                </div>
                <div style={{padding:"10px 16px 0",display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                  {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((k,i)=>(
                    k===""?<div key={i}/>:
                    <button key={k+i} onClick={()=>{if(k==="⌫"){setDayCalcInput(p=>p.slice(0,-1));return;}setDayCalcInput(p=>{if(p.length>=2)return p;const next=p+k;const num=Number(next);if(num<1||num>31)return p;return next;});}} style={{padding:"16px 0",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:12,color:k==="⌫"?TEXT_SECONDARY:TEXT_PRIMARY,fontSize:22,fontWeight:400,cursor:"pointer"}}>{k}</button>
                  ))}
                </div>
                <div style={{padding:"10px 16px 0"}}>
                  <button onClick={()=>{const val=dayCalcInput;if(val&&Number(val)>=1&&Number(val)<=31){if(showDayCalc==="closing")setPaymentDraft(p=>({...p,closingDay:val}));else setPaymentDraft(p=>({...p,withdrawalDay:val}));}setShowDayCalc(false);}} style={{width:"100%",padding:"16px",background:dayCalcInput?GOLD_GRAD:"rgba(255,255,255,0.1)",border:"none",borderRadius:14,fontSize:16,fontWeight:700,color:dayCalcInput?"#0A1628":TEXT_MUTED,cursor:"pointer"}}>OK</button>
                </div>
              </div>
            </div>
          )}
          <div style={{position:"fixed",bottom:"calc(60px + env(safe-area-inset-bottom) + 8px)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:CARD_BG,padding:"12px 18px 12px",borderTop:"1px solid #f0f0f0",zIndex:150}}>
            <button onClick={()=>{if(!paymentDraft.label.trim())return;if(isEdit){setPaymentMethods(p=>p.map(x=>x.id===editingPaymentId?{...x,label:paymentDraft.label,color:paymentDraft.color,closingDay:paymentDraft.closingDay,withdrawalDay:paymentDraft.withdrawalDay,bank:paymentDraft.bank}:x));}else{setPaymentMethods(p=>[...p,{id:`pm_${Date.now()}`,label:paymentDraft.label,color:paymentDraft.color,closingDay:paymentDraft.closingDay,withdrawalDay:paymentDraft.withdrawalDay,bank:paymentDraft.bank}]);}setMenuScreen("paymentEdit");}} style={{display:"block",width:"100%",padding:"16px",background:paymentDraft.label.trim()?ORANGE:"#eee",color:paymentDraft.label.trim()?"#fff":"#aaa",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}>保存</button>
          </div>
        </div>
      );
    }

    if(menuScreen==="weekBudgetSetting"){
      const y=weekBudgetMonth.y,m=weekBudgetMonth.m;
      // weeks 配列はサイクルベース。常に 4 週(週 1〜3 は 7 日固定、第 4 週は cycleEnd まで)。
      // {weekNum, weekKey, startStr, endStr} の形は従来互換、UI 側のグリッドはこれに合わせ
      // 4 列固定(repeat(weeks.length,1fr) = repeat(4,1fr))で表示される。
      const weeks = weeksInCycle(y, m, managementStartDay);
      const prevM=m===0?11:m-1;const prevY=m===0?y-1:y;
      // 先月コピーも 0 を尊重:truthy チェックだと prev が 0 のときにコピーされないので null 判定に変更。
      const copyLastMonth=()=>{const next={...weekCatBudgets};weeks.forEach(w=>{expenseCats.forEach(cat=>{const prevKey=`${prevY}-${prevM+1}-w${w.weekNum}_${cat.id}`;const thisKey=`${w.weekKey}_${cat.id}`;if(weekCatBudgets[prevKey]!=null)next[thisKey]=weekCatBudgets[prevKey];});});setWeekCatBudgets(next);};
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>週予算設定</span>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>setShowCopyConfirm(true)} style={{background:"none",border:`1px solid ${GOLD}44`,color:GOLD,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",borderRadius:8}}>先月と同一</button>
              <button onClick={()=>setShowClearConfirm(true)} style={{background:"none",border:`1px solid ${RED}44`,color:RED,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",borderRadius:8}}>全消去</button>
            </div>
          </div>
          <div style={{padding:"8px 12px",fontSize:10,color:TEXT_MUTED}}>カテゴリ名 → 全週統一　／　金額タップ → その週のみ</div>
          <div style={S.monthNav}>
            <button style={S.navArrow} onClick={()=>setWeekBudgetMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}>‹</button>
            <span style={{fontWeight:600,fontSize:13,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{cycleLabel(y,m,managementStartDay)}</span>
            <button style={S.navArrow} onClick={()=>setWeekBudgetMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}>›</button>
          </div>
          <div style={{margin:"0 12px",overflowX:"auto"}}>
            {/* minWidth は週数に応じて動的(常に 4 週なので実質固定):
                90(cat) + 4×68(week cells) + 56(合計) + 6×4(gap) = 442px。 */}
            <div style={{minWidth:90 + weeks.length * 68 + 56 + (weeks.length + 2) * 4}}>
              <div style={{display:"grid",gridTemplateColumns:`90px repeat(${weeks.length},1fr) 56px`,gap:4,marginBottom:4}}>
                <div/>
                {weeks.map(w=>(<div key={w.weekKey} style={{textAlign:"center",padding:"6px 2px",background:NAVY2,borderRadius:8,border:`1px solid ${BORDER}`}}><div style={{fontSize:10,fontWeight:700,color:TEXT_PRIMARY}}>第{w.weekNum}週</div><div style={{fontSize:8,color:TEXT_MUTED}}>{w.startStr}〜{w.endStr}</div></div>))}
                {/* 合計列ヘッダ:週ヘッダと同構造・2行(日付行は visibility:hidden で高さ揃え)。NAVY3 + 破線 border で読み取り専用を示唆。 */}
                <div style={{textAlign:"center",padding:"6px 2px",background:NAVY3,borderRadius:8,border:`1px dashed ${BORDER}`}}><div style={{fontSize:10,fontWeight:700,color:TEXT_MUTED}}>合計額</div><div style={{fontSize:8,visibility:"hidden"}}>-</div></div>
              </div>
              {expenseCats.map(cat=>{
                // 「1週でも明示的に値(0含む)がセットされているか」で合計表示の有無を決める。
                // 合計値は null/undefined を 0 扱いで加算、0 は実質寄与ゼロで安全。
                const hasAnyBudget=weeks.some(w=>weekCatBudgets[`${w.weekKey}_${cat.id}`]!=null);
                const catTotal=weeks.reduce((s,w)=>s+(weekCatBudgets[`${w.weekKey}_${cat.id}`]??0),0);
                return(
                <div key={cat.id} style={{display:"grid",gridTemplateColumns:`90px repeat(${weeks.length},1fr) 56px`,gap:4,marginBottom:4}}>
                  <button onClick={()=>{setAllWeekTarget(cat);setAllWeekInput("");}} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 8px",background:CARD_BG,border:`1px solid ${BORDER}`,borderRadius:8,cursor:"pointer",textAlign:"left"}}>
                    <CatSvgIcon cat={cat} size={16}/><span style={{fontSize:10,color:TEXT_PRIMARY,fontWeight:500,lineHeight:1.2}}>{cat.label}</span>
                  </button>
                  {weeks.map(w=>{
                    const key=`${w.weekKey}_${cat.id}`;
                    const val=weekCatBudgets[key];
                    // hasVal:明示設定があるか(0 も含む)= 表示・スタイル・削除可否の真の判定。
                    // 従来の `val ?` だと 0 が falsy になり「未設定扱い」になってしまう不具合があった。
                    const hasVal=val!=null;
                    return(
                    <button key={w.weekKey}
                      onClick={()=>{setCatBudgetTarget({...cat,_weekKey:w.weekKey,_isWeek:true});setCatBudgetInput(hasVal?String(val):"");setShowCatBudgetModal(true);}}
                      onContextMenu={e=>{e.preventDefault();if(hasVal){const next={...weekCatBudgets};delete next[key];setWeekCatBudgets(next);}}}
                      onTouchStart={()=>{if(hasVal){longPressTimer.current=setTimeout(()=>{const next={...weekCatBudgets};delete next[key];setWeekCatBudgets(next);},700);}}}
                      onTouchEnd={()=>{clearTimeout(longPressTimer.current);}}
                      onTouchMove={()=>{clearTimeout(longPressTimer.current);}}
                      style={{padding:"8px 4px",textAlign:"center",background:hasVal?`${GOLD}15`:NAVY2,border:`1px solid ${hasVal?`${GOLD}44`:BORDER}`,borderRadius:8,cursor:"pointer"}}>
                      <div style={{fontSize:10,fontWeight:700,color:hasVal?GOLD:TEXT_MUTED}}>{hasVal?`${val.toLocaleString()}`:"-"}</div>
                      {hasVal&&<div style={{fontSize:8,color:TEXT_MUTED}}>円</div>}
                    </button>
                    );
                  })}
                  {/* 合計列:1週でも明示設定があれば合計を表示(0 円合計も含む)、全週未設定なら "-"。 */}
                  <div style={{padding:"8px 4px",textAlign:"center",background:NAVY3,border:`1px dashed ${BORDER}`,borderRadius:8}}>
                    <div style={{fontSize:10,fontWeight:700,color:hasAnyBudget?GOLD:TEXT_MUTED}}>{hasAnyBudget?catTotal.toLocaleString():"-"}</div>
                    {hasAnyBudget&&<div style={{fontSize:8,color:TEXT_MUTED}}>円</div>}
                  </div>
                </div>
                );
              })}
            </div>
          </div>
          {allWeekTarget&&(
            <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"flex-end"}}>
              <div style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(24px + env(safe-area-inset-bottom))"}}>
                <div style={{display:"flex",alignItems:"center",gap:12,padding:"16px 20px 12px",borderBottom:`1px solid ${BORDER}`}}>
                  <CatSvgIcon cat={allWeekTarget} size={28}/>
                  <div style={{flex:1}}><div style={{fontWeight:700,fontSize:15,color:TEXT_PRIMARY}}>{allWeekTarget.label}</div><div style={{fontSize:11,color:TEXT_MUTED}}>全週統一で設定</div></div>
                  <button onClick={()=>setAllWeekTarget(null)} style={{background:"none",border:"none",fontSize:22,color:TEXT_MUTED,cursor:"pointer"}}>✕</button>
                </div>
                <div style={{padding:"14px 20px 10px",display:"flex",alignItems:"baseline",justifyContent:"flex-end",gap:6}}>
                  <span style={{fontSize:42,fontWeight:700,color:allWeekInput?TEXT_PRIMARY:TEXT_MUTED}}>{allWeekInput||"0"}</span>
                  <span style={{fontSize:16,color:TEXT_SECONDARY}}>円</span>
                </div>
                <div style={{padding:"0 14px"}}>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gridTemplateRows:"repeat(4,62px)",gap:8}}>
                    {[{k:"7",col:1,row:1},{k:"8",col:2,row:1},{k:"9",col:3,row:1},{k:"÷",col:4,row:1},{k:"AC",col:5,row:1},{k:"4",col:1,row:2},{k:"5",col:2,row:2},{k:"6",col:3,row:2},{k:"×",col:4,row:2},{k:"Del",col:5,row:2},{k:"1",col:1,row:3},{k:"2",col:2,row:3},{k:"3",col:3,row:3},{k:"－",col:4,row:3},{k:"0",col:1,row:4},{k:"00",col:2,row:4},{k:"＝",col:3,row:4},{k:"＋",col:4,row:4},{k:"OK",col:5,row:3,rowSpan:2}].map(({k,col,row,rowSpan})=>{
                      const isOK=k==="OK",isAC=k==="AC",isDel=k==="Del",isOp=["÷","×","－","＋"].includes(k),isEq=k==="＝";
                      return(<button key={k} onClick={()=>handleAllWeekCalc(k,weeks)} style={{gridColumn:`${col}`,gridRow:rowSpan?`${row}/span ${rowSpan}`:String(row),background:isOK?GOLD_GRAD:isAC?`${RED}22`:isEq?`${TEAL}22`:isOp?`${GOLD}18`:NAVY3,border:`1px solid ${isOK?`${GOLD}66`:isAC?`${RED}44`:isEq?`${TEAL}44`:isOp?`${GOLD}33`:BORDER}`,borderRadius:12,color:isOK?"#0A1628":isAC?RED:isDel?TEXT_SECONDARY:isEq?TEAL:isOp?GOLD:TEXT_PRIMARY,fontSize:isOK?20:24,fontWeight:isOK?700:300,cursor:"pointer"}}>{k}</button>);
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}
          {showClearConfirm&&(<div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{background:NAVY2,borderRadius:20,padding:"28px 24px",margin:"0 24px",border:`1px solid ${BORDER}`,width:"100%"}}><div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:24,marginBottom:10}}>🗑️</div><div style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY,marginBottom:8}}>予算を全て削除</div></div><div style={{display:"flex",gap:10}}><button onClick={()=>{const next={...weekCatBudgets};weeks.forEach(w=>{expenseCats.forEach(cat=>{delete next[`${w.weekKey}_${cat.id}`];});});setWeekCatBudgets(next);setShowClearConfirm(false);}} style={{flex:1,padding:"14px",background:`${RED}22`,border:`1px solid ${RED}44`,borderRadius:14,fontSize:15,fontWeight:700,color:RED,cursor:"pointer"}}>はい</button><button onClick={()=>setShowClearConfirm(false)} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${BORDER}`,borderRadius:14,fontSize:15,fontWeight:600,color:TEXT_SECONDARY,cursor:"pointer"}}>いいえ</button></div></div></div>)}
          {showCopyConfirm&&(<div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{background:NAVY2,borderRadius:20,padding:"28px 24px",margin:"0 24px",border:`1px solid ${BORDER}`,width:"100%"}}><div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:24,marginBottom:10}}>📋</div><div style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY,marginBottom:8}}>先月と同じ予算を設定</div></div><div style={{display:"flex",gap:10}}><button onClick={()=>{copyLastMonth();setShowCopyConfirm(false);}} style={{flex:1,padding:"14px",background:GOLD_GRAD,border:"none",borderRadius:14,fontSize:15,fontWeight:700,color:"#0A1628",cursor:"pointer"}}>はい</button><button onClick={()=>setShowCopyConfirm(false)} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${BORDER}`,borderRadius:14,fontSize:15,fontWeight:600,color:TEXT_SECONDARY,cursor:"pointer"}}>いいえ</button></div></div></div>)}
          <div style={{height:20}}/>
        </div>
      );
    }

    if (menuScreen === "appointment") {
      return <AppointmentCard onBack={() => setMenuScreen("main")} />;
    }

    if(menuScreen==="contact"){
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>お問い合わせ</span>
            <span style={{width:40}}/>
          </div>
          {contactSent?(
            <div style={{margin:"60px 16px 0",textAlign:"center"}}>
              <div style={{fontSize:48,marginBottom:16}}>✅</div>
              <div style={{fontSize:18,fontWeight:700,color:TEXT_PRIMARY,marginBottom:8}}>送信完了！</div>
              <div style={{fontSize:13,color:TEXT_SECONDARY,lineHeight:1.7}}>お問い合わせありがとうございます。<br/>内容を確認次第ご連絡いたします。</div>
              <button onClick={()=>{setContactSent(false);setContactText("");setMenuScreen("main");}} style={{marginTop:24,padding:"12px 32px",background:GOLD_GRAD,border:"none",borderRadius:24,fontSize:14,fontWeight:700,color:"#0A1628",cursor:"pointer"}}>メニューに戻る</button>
            </div>
          ):(
            <div style={{padding:"16px"}}>
              <div style={{background:CARD_BG,borderRadius:14,overflow:"hidden",border:`1px solid ${BORDER}`,marginBottom:14}}>
                <div style={{padding:"12px 16px 8px",fontSize:11,fontWeight:700,color:TEXT_SECONDARY}}>お問い合わせ種別</div>
                {[{id:"inquiry",label:"💬 一般的なお問い合わせ"},{id:"bug",label:"🐛 不具合・バグ報告"},{id:"request",label:"✨ 機能のご要望"},{id:"other",label:"📋 その他"}].map((t,i,arr)=>(
                  <div key={t.id} onClick={()=>setContactType(t.id)} style={{display:"flex",alignItems:"center",padding:"14px 16px",borderTop:`1px solid ${BORDER}`,cursor:"pointer",background:contactType===t.id?`${GOLD}15`:"transparent"}}>
                    <span style={{flex:1,fontSize:13,color:contactType===t.id?GOLD:TEXT_PRIMARY,fontWeight:contactType===t.id?700:400}}>{t.label}</span>
                    {contactType===t.id&&<span style={{color:GOLD,fontSize:16}}>✓</span>}
                  </div>
                ))}
              </div>
              <div style={{background:CARD_BG,borderRadius:14,border:`1px solid ${BORDER}`,overflow:"hidden",marginBottom:14}}>
                <div style={{padding:"12px 16px 8px",fontSize:11,fontWeight:700,color:TEXT_SECONDARY}}>お問い合わせ内容</div>
                <textarea value={contactText} onChange={e=>setContactText(e.target.value)} placeholder="詳細をご記入ください..." style={{width:"100%",minHeight:140,background:"transparent",border:"none",borderTop:`1px solid ${BORDER}`,padding:"12px 16px",fontSize:13,color:TEXT_PRIMARY,outline:"none",resize:"none",boxSizing:"border-box"}}/>
                <div style={{padding:"6px 16px 10px",textAlign:"right"}}><span style={{fontSize:10,color:TEXT_MUTED}}>{contactText.length} 文字</span></div>
              </div>
              <div style={{padding:"10px 14px",background:`${GOLD}10`,borderRadius:10,border:`1px solid ${GOLD}22`,marginBottom:16}}>
                <div style={{fontSize:11,color:TEXT_SECONDARY,lineHeight:1.7}}>💡 送信内容はプライベートCFO担当が確認します。</div>
              </div>
              <button
                onClick={async () => {
                  if (!contactText.trim()) return;
                  if (contactSubmitting) return;
                  const ok = await sendInquiry(contactType, contactText);
                  if (ok) {
                    setContactSent(true);
                  } else {
                    alert("送信に失敗しました。通信状況を確認し、もう一度お試しください。");
                  }
                }}
                disabled={contactSubmitting || !contactText.trim()}
                style={{
                  width: "100%",
                  padding: "16px",
                  background: contactText.trim() && !contactSubmitting ? GOLD_GRAD : "rgba(255,255,255,0.1)",
                  border: "none",
                  borderRadius: 28,
                  fontSize: 16,
                  fontWeight: 700,
                  color: contactText.trim() && !contactSubmitting ? "#0A1628" : TEXT_MUTED,
                  cursor: contactSubmitting ? "wait" : (contactText.trim() ? "pointer" : "default"),
                }}
              >
                {contactSubmitting ? "送信中…" : "送信する"}
              </button>
            </div>
          )}
        </div>
      );
    }

    if(menuScreen==="loanSetting"){
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>🔁 定期支出</span>
            <button onClick={()=>{setLoanDraft({label:"",amount:"",bank:"",withdrawalDay:"",pmId:""});setEditingLoanId(null);setShowLoanForm(true);}} style={{background:"none",border:`1px solid ${GOLD}`,borderRadius:20,padding:"4px 12px",color:GOLD,fontSize:12,fontWeight:700,cursor:"pointer"}}>＋追加</button>
          </div>
          <div style={{padding:"12px 16px",fontSize:10,color:TEXT_MUTED,lineHeight:1.6}}>💡 住宅ローン・車ローン・奨学金など定期的な引き落としを登録しておくと、月次サマリーで合算して表示できます。</div>
          <div style={{padding:"0 16px"}}>
            {loans.length===0?(
              <div style={{textAlign:"center",padding:"40px 20px",color:TEXT_MUTED}}>
                <div style={{fontSize:32,marginBottom:8}}>🏠</div>
                <div style={{fontSize:13}}>登録されたローンがありません</div>
                <div style={{fontSize:10,marginTop:4}}>右上の「＋追加」から登録してください</div>
              </div>
            ):(
              <div>
                {loans.map(loan=>(
                  <div key={loan.id} style={{background:CARD_BG,borderRadius:12,padding:"14px",marginBottom:8,border:`1px solid ${BORDER}`,display:"flex",alignItems:"center"}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>{loan.label}</div>
                      <div style={{fontSize:11,color:TEXT_MUTED,marginTop:2}}>🏦 {loan.bank||"銀行未設定"} ／ 毎月{loan.withdrawalDay||"－"}日</div>
                      <div style={{fontSize:16,fontWeight:700,color:GOLD,marginTop:4}}>{Number(loan.amount||0).toLocaleString()}円／月</div>
                    </div>
                    <button onClick={()=>{setLoanDraft({label:loan.label,amount:String(loan.amount),bank:loan.bank||"",withdrawalDay:loan.withdrawalDay||"",pmId:loan.pmId||""});setEditingLoanId(loan.id);setShowLoanForm(true);}} style={{padding:"6px 12px",background:ORANGE_LIGHT,border:`1px solid ${ORANGE}`,borderRadius:12,color:ORANGE,fontSize:11,fontWeight:700,cursor:"pointer",marginRight:6}}>編集</button>
                    <button onClick={()=>setDeleteLoanTarget(loan)} style={{padding:"6px 10px",background:"transparent",border:`1px solid ${RED}44`,borderRadius:12,color:RED,fontSize:11,fontWeight:700,cursor:"pointer"}}>削除</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    if(menuScreen==="pointHistory") return(
      <div style={{minHeight:"100dvh",background:NAVY}}>
        <div style={S.overlayHeader}><button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>ポイント履歴</span><span style={{width:40}}/></div>
        <div style={{margin:"12px 16px 0",background:`linear-gradient(135deg,${NAVY2},#1A2C42)`,borderRadius:16,padding:"20px",border:`1px solid ${GOLD}55`,textAlign:"center"}}>
          <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6}}>保有ポイント</div>
          <div style={{fontSize:48,fontWeight:700,color:GOLD}}>{userPoints.toLocaleString()}<span style={{fontSize:16,color:TEXT_SECONDARY,fontWeight:400}}> pt</span></div>
        </div>
        <div style={{margin:"12px 16px 0"}}>
          {pointHistory.length===0
            ? <div style={{background:CARD_BG,borderRadius:12,padding:"32px",textAlign:"center",border:`1px solid ${BORDER}`}}><div style={{fontSize:12,color:TEXT_MUTED}}>まだポイントの付与はありません</div></div>
            : <div style={{background:CARD_BG,borderRadius:12,overflow:"hidden",border:`1px solid ${BORDER}`}}>{[...pointHistory].reverse().map((h,i)=>(<div key={h.id} style={{display:"flex",alignItems:"center",padding:"14px 16px",borderBottom:i<pointHistory.length-1?`1px solid ${BORDER}`:"none",gap:12}}><div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>{h.label}</div><div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{h.date}</div></div><div style={{fontSize:16,fontWeight:700,color:GOLD}}>+{h.points.toLocaleString()} pt</div></div>))}</div>
          }
        </div>
        <div style={{height:20}}/>
      </div>
    );

    if(menuScreen==="currentMonthReport"){
      // 今日が属するサイクルの y / 1-indexed month を表示用に取得。
      const y=todayCycle.year, m=todayCycle.month+1;
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer",fontWeight:300}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{y}年{m}月　レポート</span>
            <span style={{width:40}}/>
          </div>
          <div style={{margin:"16px 16px 0",display:"flex",flexDirection:"column",gap:12}}>
            <div style={{background:CARD_BG,borderRadius:16,border:`1px solid ${BORDER}`,overflow:"hidden"}}>
              <div style={{padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:44,height:44,borderRadius:12,background:`${GOLD}22`,border:`1px solid ${GOLD}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>📄</div>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>管理繰越票</div>
                  <div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{y}年{m}月分</div>
                </div>
              </div>
              <div style={{padding:"14px 18px",background:NAVY2,textAlign:"center"}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6}}>Supabase連携後に本部から送付されます</div>
                <div style={{fontSize:10,color:`${GOLD}88`,background:`${GOLD}11`,borderRadius:8,padding:"6px 12px",display:"inline-block"}}>準備中</div>
              </div>
            </div>
            <div style={{background:CARD_BG,borderRadius:16,border:`1px solid ${BORDER}`,overflow:"hidden"}}>
              <div style={{padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:44,height:44,borderRadius:12,background:`${TEAL}22`,border:`1px solid ${TEAL}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>📝</div>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>月次レビューシート</div>
                  <div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{y}年{m}月分</div>
                </div>
              </div>
              <div style={{padding:"14px 18px",background:NAVY2,textAlign:"center"}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6}}>Supabase連携後に本部から送付されます</div>
                <div style={{fontSize:10,color:`${TEAL}88`,background:`${TEAL}11`,borderRadius:8,padding:"6px 12px",display:"inline-block"}}>準備中</div>
              </div>
            </div>
          </div>
          <div style={{height:20}}/>
        </div>
      );
    }

    if(menuScreen==="accountSetting"){
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>アカウント設定</span>
            <span style={{width:40}}/>
          </div>
          <div style={{margin:"12px 16px 0",background:CARD_BG,borderRadius:12,overflow:"hidden",border:`1px solid ${BORDER}`}}>
            {[
              {label:"名前",placeholder:"例：山田 太郎",type:"text"},
              {label:"メールアドレス",placeholder:"例：example@mail.com",type:"email"},
              {label:"電話番号",placeholder:"例：090-1234-5678",type:"tel"},
              // 報酬日:Phase 2 で複数登録チップ UI(iOS ネイティブカレンダーピッカー併用)。
              {label:"報酬日"},
              // 管理スタート日:cycle 切替の本体機能(旧 rewardDay の役割)。
              // Phase 2 追加修正で iOS ネイティブカレンダー + chip UI 化。空欄 → 1 日始まり(従来動作)。
              {label:"管理スタート日"},
            ].map((field,i,arr)=>(
              <div key={i} style={{display:"flex",alignItems:"center",padding:"14px 16px",borderBottom:i<arr.length-1?`1px solid ${BORDER}`:"none",gap:12}}>
                <span style={{fontSize:12,color:TEXT_SECONDARY,minWidth:80,fontWeight:500,alignSelf:field.label==="報酬日"&&rewardDaysList.length>0?"flex-start":"center",paddingTop:field.label==="報酬日"&&rewardDaysList.length>0?6:0}}>{field.label}</span>
                {field.label === "報酬日" ? (
                  // 報酬日チップリスト + 「+ 追加」ボタン(=隠した <input type="date"> を覆い被せて
                  // タップで iOS ネイティブピッカー起動)。各チップは X ボタン付きで個別削除可。
                  // 値の永続化は addRewardDay/removeRewardDay 経由で即時 localStorage 反映。
                  <div style={{flex:1,display:"flex",flexWrap:"wrap",gap:6,justifyContent:"flex-end",alignItems:"center"}}>
                    {rewardDaysList.map(d => (
                      <span key={d} style={{display:"inline-flex",alignItems:"center",gap:4,padding:"4px 4px 4px 10px",background:NAVY3,border:`1px solid ${GOLD}55`,borderRadius:14,fontSize:12,fontWeight:600,color:GOLD,whiteSpace:"nowrap"}}>
                        {d}日
                        <button
                          type="button"
                          onClick={() => setRewardDaysList(removeRewardDay(d))}
                          aria-label={`${d}日を削除`}
                          style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:18,height:18,padding:0,background:"transparent",border:"none",borderRadius:9,color:TEXT_MUTED,cursor:"pointer",fontSize:12,lineHeight:1}}
                        >✕</button>
                      </span>
                    ))}
                    <span style={{position:"relative",display:"inline-block"}}>
                      <span style={{display:"inline-flex",alignItems:"center",padding:"4px 10px",background:"transparent",border:`1px dashed ${GOLD}88`,borderRadius:14,fontSize:12,fontWeight:600,color:GOLD,whiteSpace:"nowrap",cursor:"pointer"}}>＋ 追加</span>
                      {/* 透明な date input を上に重ねてタップ領域にする(iOS Safari でネイティブピッカー起動)。 */}
                      <input
                        ref={rewardDayPickerRef}
                        type="date"
                        onChange={(e) => {
                          const dateStr = e.target.value;
                          if (!dateStr) return;
                          const d = new Date(dateStr);
                          if (Number.isNaN(d.getTime())) return;
                          setRewardDaysList(addRewardDay(d.getDate()));
                          // 次の追加に備えて値をクリア(同じ日を再選択しても onChange が再発火するように)
                          e.target.value = "";
                        }}
                        style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0,cursor:"pointer",border:"none",padding:0,margin:0,background:"transparent"}}
                      />
                    </span>
                  </div>
                ) : field.label === "管理スタート日" ? (
                  // 管理スタート日:単一値の置き換え式。報酬日と同じく iOS ネイティブカレンダー
                  // ピッカー(<input type="date"> 上に透明 overlay)で「日」だけ抽出して draft に格納。
                  // 永続化(localStorage 書込み)は下の保存ボタン onClick で commit する Phase 1 の流れを維持。
                  // ✕ で空欄に戻せる(空 → 1 日始まりにフォールバック)。
                  <div style={{flex:1,display:"flex",justifyContent:"flex-end",alignItems:"center",gap:6}}>
                    {managementStartDayDraft && (
                      <button
                        type="button"
                        onClick={() => setManagementStartDayDraft("")}
                        aria-label="管理スタート日を空欄に戻す"
                        style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:18,height:18,padding:0,background:"transparent",border:"none",borderRadius:9,color:TEXT_MUTED,cursor:"pointer",fontSize:12,lineHeight:1}}
                      >✕</button>
                    )}
                    <span style={{position:"relative",display:"inline-block"}}>
                      <span style={{
                        display:"inline-flex",alignItems:"center",
                        padding:"4px 10px",
                        background: managementStartDayDraft ? NAVY3 : "transparent",
                        border: `1px ${managementStartDayDraft ? "solid" : "dashed"} ${GOLD}${managementStartDayDraft ? "55" : "88"}`,
                        borderRadius:14,fontSize:12,fontWeight:600,color:GOLD,whiteSpace:"nowrap",cursor:"pointer",
                      }}>{managementStartDayDraft ? `${managementStartDayDraft}日` : "＋ 設定"}</span>
                      {/* 透明な date input を上に重ねてタップ領域にする(iOS Safari でネイティブピッカー起動)。
                          選択 → date.getDate() を draft state にセット(年月は無視、「日」のみ意味あり)。
                          値クリア(e.target.value = "")で同じ日を再選択しても onChange を再発火させる。 */}
                      <input
                        type="date"
                        onChange={(e) => {
                          const dateStr = e.target.value;
                          if (!dateStr) return;
                          const d = new Date(dateStr);
                          if (Number.isNaN(d.getTime())) return;
                          setManagementStartDayDraft(String(d.getDate()));
                          e.target.value = "";
                        }}
                        style={{position:"absolute",inset:0,width:"100%",height:"100%",opacity:0,cursor:"pointer",border:"none",padding:0,margin:0,background:"transparent"}}
                      />
                    </span>
                  </div>
                ) : (
                  <input type={field.type} placeholder={field.placeholder} style={{flex:1,border:"none",background:"transparent",fontSize:14,outline:"none",color:TEXT_PRIMARY,textAlign:"right"}}/>
                )}
              </div>
            ))}
          </div>
          <div style={{margin:"16px 16px 0"}}>
            {/* 保存ボタン:管理スタート日のみを永続化(報酬日は Phase 2 でチップ追加/削除ごとに即時書込みに変更済み)。
                  - 管理スタート日 → setManagementStartDay() 経由で cfo_managementStartDay 書き込み
                                  + commit tick インクリメントで全画面のサイクル派生 memo を再評価
                他 3 項目(名前/メール/電話)は依然 uncontrolled stub。 */}
            <button
              onClick={() => {
                setManagementStartDay(managementStartDayDraft);
                setManagementStartDayCommitTick(t => t + 1);
                setAccountSavedFlash(true);
                setTimeout(() => setAccountSavedFlash(false), 2000);
              }}
              style={{width:"100%",padding:"14px",background:GOLD_GRAD,border:"none",borderRadius:12,fontSize:14,fontWeight:700,color:"#0A1628",cursor:"pointer"}}
            >{accountSavedFlash ? "保存しました" : "保存"}</button>
          </div>
          <LogoutButton />
          <div style={{height:20}}/>
        </div>
      );
    }

    if(menuScreen==="monthlyReport") return(
      <div style={{minHeight:"100dvh",background:NAVY,display:"flex",flexDirection:"column"}}>
        <div style={S.overlayHeader}><button onClick={()=>{setMenuScreen("main");setReportSearchQuery("");}} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>月別レポート</span><span style={{width:40}}/></div>
        <div style={{padding:"10px 16px",background:NAVY2,borderBottom:`1px solid ${BORDER}`}}>
          <div style={{display:"flex",alignItems:"center",background:NAVY3,borderRadius:10,padding:"8px 14px",gap:8,border:`1px solid ${BORDER}`}}>
            <span style={{fontSize:13,color:TEXT_MUTED}}>🔍</span>
            <input value={reportSearchQuery} onChange={e=>setReportSearchQuery(e.target.value)} placeholder="例：2026年4月" style={{flex:1,border:"none",background:"transparent",fontSize:14,outline:"none",color:TEXT_PRIMARY}}/>
            {reportSearchQuery&&<button onClick={()=>setReportSearchQuery("")} style={{background:"none",border:"none",color:TEXT_MUTED,cursor:"pointer",fontSize:14}}>✕</button>}
          </div>
        </div>
        <div style={{flex:1,overflowY:"auto"}}>
          <div style={{margin:"8px 16px",background:CARD_BG,borderRadius:12,overflow:"hidden",border:`1px solid ${BORDER}`}}>
            {(()=>{
              const currentY=today.getFullYear();
              const allMonths=[];
              for(let y=2026;y<=currentY+1;y++){for(let m=(y===2026?7:1);m<=12;m++){allMonths.push({y,m,label:`${y}年${m}月`});}}
              const filtered=reportSearchQuery?allMonths.filter(({label})=>label.includes(reportSearchQuery)):allMonths;
              return filtered.length===0
                ? <div style={{padding:"24px",textAlign:"center",fontSize:12,color:TEXT_MUTED}}>該当する月がありません</div>
                : filtered.map(({y,m,label},i)=>(
                  <div key={label} onClick={()=>setMenuScreen(`report_${y}_${m}`)} style={{display:"flex",alignItems:"center",padding:"10px 16px",borderBottom:i<filtered.length-1?`1px solid ${BORDER}`:"none",cursor:"pointer",gap:10}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:y===todayCycle.year&&m===todayCycle.month+1?GOLD:BORDER,flexShrink:0}}/>
                    <span style={{flex:1,fontSize:13,fontWeight:y===todayCycle.year&&m===todayCycle.month+1?600:400,color:y===todayCycle.year&&m===todayCycle.month+1?TEXT_PRIMARY:TEXT_SECONDARY}}>{label}</span>
                    {y===todayCycle.year&&m===todayCycle.month+1&&<span style={{fontSize:9,color:GOLD,background:`${GOLD}18`,borderRadius:6,padding:"2px 6px",fontWeight:600}}>今月</span>}
                    <span style={{color:TEXT_MUTED,fontSize:12}}>›</span>
                  </div>
                ));
            })()}
          </div>
          <div style={{height:20}}/>
        </div>
      </div>
    );

    if(menuScreen&&menuScreen.startsWith("report_")){
      const parts=menuScreen.split("_");const ry=Number(parts[1]);const rm=Number(parts[2]);
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}><button onClick={()=>setMenuScreen("monthlyReport")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{ry}年{rm}月　レポート</span><span style={{width:40}}/></div>
          <div style={{margin:"16px 16px 0",display:"flex",flexDirection:"column",gap:12}}>
            <div style={{background:CARD_BG,borderRadius:16,border:`1px solid ${BORDER}`,overflow:"hidden"}}><div style={{padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:12}}><div style={{width:44,height:44,borderRadius:12,background:`${GOLD}22`,border:`1px solid ${GOLD}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>📄</div><div><div style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>管理繰越票</div><div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{ry}年{rm}月分</div></div></div><div style={{padding:"14px 18px",background:NAVY2,textAlign:"center"}}><div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6}}>Supabase連携後に本部から送付されます</div><div style={{fontSize:10,color:`${GOLD}88`,background:`${GOLD}11`,borderRadius:8,padding:"6px 12px",display:"inline-block"}}>準備中</div></div></div>
            <div style={{background:CARD_BG,borderRadius:16,border:`1px solid ${BORDER}`,overflow:"hidden"}}><div style={{padding:"16px 18px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",gap:12}}><div style={{width:44,height:44,borderRadius:12,background:`${TEAL}22`,border:`1px solid ${TEAL}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:24}}>📝</div><div><div style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>月次レビューシート</div><div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{ry}年{rm}月分</div></div></div><div style={{padding:"14px 18px",background:NAVY2,textAlign:"center"}}><div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6}}>Supabase連携後に本部から送付されます</div><div style={{fontSize:10,color:`${TEAL}88`,background:`${TEAL}11`,borderRadius:8,padding:"6px 12px",display:"inline-block"}}>準備中</div></div></div>
          </div>
          <div style={{height:20}}/>
        </div>
      );
    }

    const menuGroups=[[
      {icon:"📊",label:"当月レポート",action:()=>setMenuScreen("currentMonthReport")},
      {icon:"📋",label:"月別レポート",action:()=>setMenuScreen("monthlyReport")},
      {icon:"🤝",label:"面談予定",action:()=>setMenuScreen("appointment")},
    ]];
    const settingsGroups=[[{icon:"📅",label:"週予算設定",action:()=>setMenuScreen("weekBudgetSetting")},{icon:"🎨",label:"カテゴリーアイコン設定",action:()=>setMenuScreen("catEdit")},{icon:"💳",label:"支払い方法 追加編集",action:()=>setMenuScreen("paymentEdit")},{icon:"🔁",label:"定期支出",action:()=>setMenuScreen("loanSetting")}],[{icon:"👤",label:"アカウント設定",action:()=>setMenuScreen("accountSetting")},{icon:"✉️",label:"お問い合わせ",action:()=>setMenuScreen("contact")}]];

    return(
      <div>
        <div style={{padding:"14px 18px",background:NAVY2,display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>メニュー</span></div>
        {menuGroups.map((group,gi)=>(
          <div key={gi} style={{background:CARD_BG,borderRadius:12,margin:"12px 16px 0",overflow:"hidden"}}>
            {group.map((item,i)=>(<div key={i} onClick={item.action} style={{...S.menuItem,borderBottom:i<group.length-1?`1px solid ${BORDER}`:"none"}}><span style={{fontSize:18,color:GOLD}}>{item.icon}</span><span style={{flex:1,fontSize:13,fontWeight:500,color:TEXT_PRIMARY}}>{item.label}</span><span style={{color:TEXT_MUTED}}>›</span></div>))}
          </div>
        ))}
        <div style={{padding:"20px 16px 8px"}}><span style={{fontSize:12,fontWeight:700,color:TEXT_MUTED,letterSpacing:"0.08em"}}>設定</span></div>
        {settingsGroups.map((group,gi)=>(
          <div key={gi} style={{background:CARD_BG,borderRadius:12,margin:"0 16px 12px",overflow:"hidden",border:`1px solid ${BORDER}`}}>
            {group.map((item,i)=>(<div key={i} onClick={item.action} style={{...S.menuItem,borderBottom:i<group.length-1?`1px solid ${BORDER}`:"none"}}><span style={{fontSize:18,color:GOLD}}>{item.icon}</span><span style={{flex:1,fontSize:13,fontWeight:500,color:TEXT_PRIMARY}}>{item.label}</span><span style={{color:TEXT_MUTED}}>›</span></div>))}
          </div>
        ))}
        <div onClick={()=>setMenuScreen("pointHistory")} style={{margin:"4px 16px 12px",background:`linear-gradient(135deg,${NAVY2},#1A2C42)`,borderRadius:16,padding:"14px 18px",border:`1px solid ${GOLD}55`,boxShadow:`0 4px 20px ${GOLD}22`,cursor:"pointer",display:"flex",alignItems:"center",gap:12}}>
          <div style={{flex:1}}><div style={{fontSize:10,color:TEXT_MUTED}}>保有ポイント</div><div style={{fontSize:18,fontWeight:700,color:GOLD}}>{userPoints.toLocaleString()}<span style={{fontSize:11,color:TEXT_SECONDARY,fontWeight:400}}> pt</span></div></div>
          <span style={{fontSize:12,color:TEXT_MUTED}}>履歴 ›</span>
        </div>
        <div style={{margin:"0 16px 20px",background:CARD_BG,borderRadius:12,overflow:"hidden",border:`1px solid ${BORDER}`}}>
          <div onClick={()=>window.open("https://forms.gle/example","_blank")} style={{display:"flex",alignItems:"center",gap:10,padding:"13px 16px",borderBottom:`1px solid ${BORDER}`,cursor:"pointer"}}>
            <div style={{width:26,height:26,borderRadius:7,background:"rgba(123,108,246,0.2)",border:"1px solid rgba(123,108,246,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📋</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>会社フォームページ</div>
              <div style={{fontSize:9,color:TEXT_MUTED}}>各種申請・届出フォーム</div>
            </div>
            <span style={{fontSize:13,color:TEXT_MUTED}}>›</span>
          </div>
          <div onClick={()=>window.open("https://example.com/company.pdf","_blank")} style={{display:"flex",alignItems:"center",gap:10,padding:"13px 16px",cursor:"pointer"}}>
            <div style={{width:26,height:26,borderRadius:7,background:`${RED}22`,border:`1px solid ${RED}44`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📄</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>会社案内（PDF）</div>
              <div style={{fontSize:9,color:TEXT_MUTED}}>会社概要・サービス紹介</div>
            </div>
            <span style={{fontSize:13,color:TEXT_MUTED}}>›</span>
          </div>
        </div>
      </div>
    );
  };

  const tabs=[{id:"daily",label:"入力",icon:"✏️"},{id:"day",label:"日",icon:"📅"},{id:"weekly",label:"週",icon:"📊"},{id:"monthly",label:"月",icon:"📈"},{id:"menu",label:"メニュー",icon:"···"}];

  return (
    <div style={S.app}>
      <div style={{position:"fixed",top:0,left:"50%",transform:`translateX(-50%) translateY(${showTelop?0:"-100%"})`,width:"100%",maxWidth:430,zIndex:200,background:`linear-gradient(90deg,${NAVY},#0D1E36,${NAVY})`,borderBottom:`1px solid ${GOLD}44`,height:24,paddingTop:"env(safe-area-inset-top)",boxSizing:"content-box",overflow:"hidden",display:"flex",alignItems:"center",transition:"transform 0.3s ease",cursor:"pointer"}} onTouchStart={e=>{e._startY=e.touches[0].clientY;}} onTouchEnd={e=>{if(e._startY-e.changedTouches[0].clientY>20)setShowTelop(false);}}>
        <style>{`@keyframes telop{0%{transform:translateX(100%);}100%{transform:translateX(-100%);}} .telop-text{animation:telop 28s linear infinite;white-space:nowrap;display:inline-block;}`}</style>
        <span className="telop-text" style={{fontSize:10,fontWeight:500,color:GOLD,letterSpacing:"0.05em",paddingLeft:"100%"}}>{telopText}</span>
      </div>
      {!showTelop&&<div onClick={()=>setShowTelop(true)} style={{position:"fixed",top:"env(safe-area-inset-top)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,zIndex:200,height:8,background:`${GOLD}33`,cursor:"pointer",borderBottom:`1px solid ${GOLD}22`}}/>}

      {/* paddingBottom = 62 + safe + 8 = ナビバー実高(button~54 + paddingBottom safe+8)+ 8px 呼吸。
          以前は 60(ナビ button 高さの初期見積もり)+ safe + 8 = 約 6px gap だったが、
          実測ではナビ button 内部の line-height で ~54px、加えてユーザー要望の 8px 呼吸を
          確実に確保するために 62 へ調整。サンドイッチ構造の footer はこの paddingBottom 分だけ
          ナビバー上端から離れて固定される。 */}
      <div style={{...S.main,paddingTop:showTelop?24:8,paddingBottom:"calc(62px + env(safe-area-inset-bottom) + 8px)"}}>
        {tab==="daily"&&renderDaily()}
        {tab==="day"&&renderDayView()}
        {tab==="weekly"&&renderWeekly()}
        {tab==="monthly"&&renderMonthly()}
        {tab==="menu"&&renderMenu()}
      </div>

      <div style={S.bottomNav}>{tabs.map(t=>(<button key={t.id} style={S.navBtn(tab===t.id)} onClick={()=>{setTab(t.id);if(t.id!=="menu")setMenuScreen("main");}}><span style={{fontSize:18}}>{t.icon}</span><span>{t.label}</span></button>))}</div>

      {/* 今月サマリーモーダル */}
      {showMonthSummary&&(()=>{
        // y は カレンダー年、m は 1-indexed 月(ヘッダ「{y}年{m}月 支出サマリー」表示で使用)。
        // サイクル範囲は cycSStr-cycEStr。
        // cardBreakdown は cardBillingRange ヘルパ経由でサイクル月対応(Phase 3)。
        // 末締(closingDay="末") も full cycle 扱いに統一(Phase 2 までの 2 ヶ月範囲バグも併せて解消)。
        const y=reportMonth.y;const m=reportMonth.m+1;
        const cycSStr=toDateStr(cycleStart(reportMonth.y,reportMonth.m,managementStartDay));
        const cycEStr=toDateStr(cycleEnd(reportMonth.y,reportMonth.m,managementStartDay));
        const cashId="cash";const cardPms=paymentMethods.filter(p=>p.id!==cashId);
        const cashTxs=transactions.filter(t=>t.date>=cycSStr&&t.date<=cycEStr&&t.payment===cashId);const cashTotal=cashTxs.reduce((s,t)=>s+t.amount,0);
        const cardBreakdown=cardPms.map(pm=>{
          const { fromStr, toStr } = cardBillingRange(pm.closingDay, reportMonth.y, reportMonth.m, managementStartDay);
          const pmTxs=transactions.filter(t=>t.payment===pm.id&&t.date>=fromStr&&t.date<=toStr);
          const total=pmTxs.reduce((s,t)=>s+t.amount,0);
          return{pm,total,pmTxs};
        });
        const cardTotal=cardBreakdown.reduce((s,c)=>s+c.total,0);const grandTotal=cashTotal+cardTotal;
        return(
          <div onClick={()=>setShowMonthSummary(false)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:400,display:"flex",alignItems:"flex-end"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:CARD_BG,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,maxHeight:"85vh",display:"flex",flexDirection:"column"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px 8px",flexShrink:0}}>
                <span style={{fontSize:15,fontWeight:700,color:TEXT_PRIMARY}}>{y}年{m}月 支出サマリー</span>
                <button onClick={()=>setShowMonthSummary(false)} style={{background:"none",border:"none",fontSize:20,color:TEXT_MUTED,cursor:"pointer"}}>✕</button>
              </div>
              <div style={{display:"flex",padding:"0 16px 10px",gap:8,flexShrink:0}}>
                {[{id:"summary",label:"支出サマリー"},{id:"schedule",label:"📅 引き落とし予定"}].map(t=>(
                  <button key={t.id} onClick={()=>setSummaryTab(t.id)} style={{flex:1,padding:"8px",borderRadius:20,border:`1px solid ${summaryTab===t.id?GOLD:BORDER}`,background:summaryTab===t.id?`${GOLD}22`:"transparent",color:summaryTab===t.id?GOLD:TEXT_MUTED,fontSize:12,fontWeight:summaryTab===t.id?700:400,cursor:"pointer"}}>{t.label}</button>
                ))}
              </div>
              {/* paddingBottom = max(28px, env(safe-area-inset-bottom)):
                  iPhone のホームインジケーター領域(safe-area-inset-bottom = ~34px)に
                  最下部の「当月現金支出」ブロックが被って見切れる問題を解消。
                  Phase 2 の電卓モーダル safe-area 対応と同じ手法。 */}
              <div style={{overflowY:"auto",flex:1,padding:"0 16px max(28px, env(safe-area-inset-bottom))"}}>
                {summaryTab==="summary"?(
                  <>
                    <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",marginBottom:10,border:`1px solid ${BORDER}`}}>
                      <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>実質支出</div>
                      <div style={{fontSize:30,fontWeight:700,color:grandTotal>0?RED:TEXT_MUTED}}>{grandTotal.toLocaleString()}<span style={{fontSize:14,color:TEXT_SECONDARY,fontWeight:400}}>円</span></div>
                    </div>
                    {cardBreakdown.length>0&&(
                      <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",marginBottom:8,border:`1px solid ${BORDER}`}}>
                        <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>当月カード引き落とし額</div>
                        <div style={{fontSize:22,fontWeight:700,color:cardTotal>0?TEXT_PRIMARY:TEXT_MUTED}}>{cardTotal.toLocaleString()}<span style={{fontSize:12,color:TEXT_SECONDARY,fontWeight:400}}>円</span></div>
                        {cardBreakdown.map(({pm,total})=>(
                          <div key={pm.id} style={{display:"flex",alignItems:"center",gap:8,marginTop:10,paddingTop:8,borderTop:`1px solid ${BORDER}`}}>
                            <div style={{width:8,height:8,borderRadius:"50%",background:pm.color,flexShrink:0}}/>
                            <span style={{flex:1,fontSize:11,color:TEXT_SECONDARY}}>{pm.label}</span>
                            {pm.bank&&<span style={{fontSize:9,color:TEXT_MUTED}}>🏦{pm.bank}</span>}
                            {pm.withdrawalDay&&<span style={{fontSize:9,color:GOLD}}>引落{pm.withdrawalDay}{pm.withdrawalDay!=="末"?"日":""}</span>}
                            <span style={{fontSize:14,fontWeight:700,color:total>0?TEXT_PRIMARY:TEXT_MUTED}}>{total.toLocaleString()}円</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",border:`1px solid ${BORDER}`}}>
                      <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>当月現金支出</div>
                      <div style={{fontSize:22,fontWeight:700,color:cashTotal>0?TEXT_PRIMARY:TEXT_MUTED}}>{cashTotal.toLocaleString()}<span style={{fontSize:12,color:TEXT_SECONDARY,fontWeight:400}}>円</span></div>
                    </div>
                  </>
                ):(
                  (()=>{
                    const items=[];
                    cardBreakdown.forEach(({pm,total})=>{
                      if(total>0||pm.withdrawalDay){items.push({day:pm.withdrawalDay||"－",label:pm.label,bank:pm.bank||"",amount:total,color:pm.color,type:"card"});}
                    });
                    loans.forEach(loan=>{items.push({day:loan.withdrawalDay||"－",label:loan.label,bank:loan.bank||"",amount:Number(loan.amount)||0,color:TEAL,type:"loan"});});
                    const dayNum=d=>d==="末"?31:d==="－"?99:Number(d)||99;
                    items.sort((a,b)=>dayNum(a.day)-dayNum(b.day));
                    const byBank={};
                    items.forEach(item=>{const key=item.bank||"銀行未設定";if(!byBank[key])byBank[key]={bank:key,items:[],total:0};byBank[key].items.push(item);byBank[key].total+=item.amount;});
                    const bankGroups=Object.values(byBank);
                    const totalDeduction=items.reduce((s,i)=>s+i.amount,0);
                    if(items.length===0)return(
                      <div style={{textAlign:"center",padding:"40px 20px"}}>
                        <div style={{fontSize:24,marginBottom:8}}>🏦</div>
                        <div style={{fontSize:12,color:TEXT_MUTED}}>引き落とし予定がありません</div>
                        <div style={{fontSize:10,color:TEXT_MUTED,marginTop:4}}>カードの引き落とし日・銀行を設定するか<br/>定期支出を追加してください</div>
                      </div>
                    );
                    return(
                      <>
                        <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",marginBottom:12,border:`1px solid ${BORDER}`}}>
                          <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>{y}年{m}月 引き落とし合計</div>
                          <div style={{fontSize:28,fontWeight:700,color:RED}}>{totalDeduction.toLocaleString()}<span style={{fontSize:13,color:TEXT_SECONDARY,fontWeight:400}}>円</span></div>
                        </div>
                        {bankGroups.map((group,gi)=>(
                          <div key={gi} style={{background:NAVY2,borderRadius:14,marginBottom:10,border:`1px solid ${BORDER}`,overflow:"hidden"}}>
                            <div style={{padding:"12px 16px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"space-between",background:NAVY3}}>
                              <div style={{display:"flex",alignItems:"center",gap:8}}>
                                <span style={{fontSize:16}}>🏦</span>
                                <span style={{fontSize:14,fontWeight:700,color:TEXT_PRIMARY}}>{group.bank}</span>
                              </div>
                              <span style={{fontSize:13,fontWeight:700,color:RED}}>{group.total.toLocaleString()}円</span>
                            </div>
                            {group.items.map((item,ii)=>(
                              <div key={ii} style={{display:"flex",alignItems:"center",padding:"12px 16px",borderBottom:ii<group.items.length-1?`1px solid ${BORDER}`:"none",gap:10}}>
                                <div style={{width:8,height:8,borderRadius:"50%",background:item.color,flexShrink:0}}/>
                                <div style={{flex:1}}>
                                  <div style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>{item.label}</div>
                                  <div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{item.type==="loan"?"🔁 定期支出":"💳 カード"} ／ {item.day==="－"?"引落日未設定":`毎月${item.day}${item.day!=="末"?"日":""}引き落とし`}</div>
                                </div>
                                <span style={{fontSize:15,fontWeight:700,color:RED}}>{item.amount.toLocaleString()}円</span>
                              </div>
                            ))}
                          </div>
                        ))}
                      </>
                    );
                  })()
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* 検索モーダル */}
      {showSearch&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>{setShowSearch(false);setSearchQuery("");}} style={{background:"none",border:"none",color:ORANGE,fontSize:14,cursor:"pointer"}}>‹</button><span style={{fontWeight:700,fontSize:15}}>検索（全期間）</span><span style={{width:60}}></span></div><div style={{padding:"12px 18px",background:CARD_BG}}><div style={{display:"flex",alignItems:"center",background:NAVY3,borderRadius:10,padding:"8px 14px",gap:8}}><span>🔍</span><input autoFocus value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="検索" style={{flex:1,border:"none",background:"transparent",fontSize:15,outline:"none",color:TEXT_PRIMARY}}/></div></div><div style={{textAlign:"center",padding:"12px 18px",background:CARD_BG,borderBottom:`1px solid ${BORDER}`}}><div style={{fontSize:11,color:TEXT_SECONDARY}}>支出合計</div><div style={{fontSize:18,fontWeight:400,color:RED}}>{searchResults.reduce((s,t)=>s+t.amount,0).toLocaleString()}円</div></div><div style={{flex:1,overflowY:"auto"}}>{[...searchResults].reverse().map(t=><TxItem key={t.id} t={t}/>)}{searchResults.length===0&&<div style={{textAlign:"center",padding:"40px",color:"#aaa"}}>取引が見つかりません</div>}</div></div>)}

      {/* 編集モーダル */}
      {showEditModal&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>setShowEditModal(false)} style={{background:"none",border:"none",fontSize:20,color:TEXT_SECONDARY,cursor:"pointer"}}>✕</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>取引を編集</span><button onClick={saveEditTx} style={{background:"none",border:"none",color:ORANGE,fontSize:16,fontWeight:700,cursor:"pointer"}}>保存</button></div><div style={{flex:1,overflowY:"auto"}}><div style={S.row}><span style={{color:TEXT_SECONDARY,fontSize:11,marginRight:12,minWidth:40}}>日付</span><input type="date" value={editDraft.date} onChange={e=>setEditDraft(p=>({...p,date:e.target.value}))} style={{flex:1,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 12px",fontSize:14,outline:"none",background:NAVY3,color:TEXT_PRIMARY}}/></div><div style={S.row}><span style={{color:"#888",fontSize:13,marginRight:12,minWidth:40}}>金額</span><input type="number" value={editDraft.amount} onChange={e=>setEditDraft(p=>({...p,amount:e.target.value}))} style={S.amountInput}/><span style={{marginLeft:6,fontSize:13,color:TEXT_SECONDARY}}>円</span></div><div style={S.row}><span style={{color:TEXT_SECONDARY,fontSize:11,marginRight:12,minWidth:40}}>メモ</span><input value={editDraft.memo||""} onChange={e=>setEditDraft(p=>({...p,memo:e.target.value}))} placeholder="未入力" style={S.memoInput}/></div><div style={{padding:"14px 18px 6px",background:CARD_BG,marginTop:1}}><div style={{fontWeight:700,fontSize:15,marginBottom:12,color:TEXT_PRIMARY}}>カテゴリー</div></div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,padding:"12px 14px",background:NAVY}}>{expenseCats.map(cat=>(<button key={cat.id} onClick={()=>setEditDraft(p=>({...p,category:cat.id}))} style={{border:`2px solid ${editDraft.category===cat.id?ORANGE:"#333"}`,borderRadius:10,padding:"10px 6px 8px",cursor:"pointer",background:editDraft.category===cat.id?ORANGE_LIGHT:CARD_BG,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}><CatSvgIcon cat={cat} size={26}/><span style={{fontSize:11,color:TEXT_PRIMARY}}>{cat.label}</span></button>))}</div></div></div>)}

      {/* 定期モーダル */}
      {/* 定期支出削除確認モーダル */}
      {deleteLoanTarget&&(
        <div onClick={()=>setDeleteLoanTarget(null)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:600,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,borderRadius:20,padding:"28px 24px",margin:"0 24px",border:`1px solid ${BORDER}`,width:"100%"}}>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontSize:32,marginBottom:10}}>🗑️</div>
              <div style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY,marginBottom:6}}>削除しますか？</div>
              <div style={{fontSize:13,color:TEXT_SECONDARY}}>「{deleteLoanTarget.label}」</div>
            </div>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{setLoans(p=>p.filter(x=>x.id!==deleteLoanTarget.id));setDeleteLoanTarget(null);}} style={{flex:1,padding:"14px",background:`${RED}22`,border:`1px solid ${RED}44`,borderRadius:14,fontSize:15,fontWeight:700,color:RED,cursor:"pointer"}}>削除する</button>
              <button onClick={()=>setDeleteLoanTarget(null)} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${BORDER}`,borderRadius:14,fontSize:15,fontWeight:600,color:TEXT_SECONDARY,cursor:"pointer"}}>キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* ローンフォームモーダル */}
      {showLoanForm&&(
        <div onClick={()=>setShowLoanForm(false)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:500,display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(24px + env(safe-area-inset-bottom))",maxHeight:"85dvh",overflowY:"auto"}}>
            <div style={{padding:"16px 20px 10px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
              <span style={{fontSize:15,fontWeight:700,color:TEXT_PRIMARY}}>🔁 {editingLoanId?"定期支出編集":"定期支出追加"}</span>
              <button onClick={()=>setShowLoanForm(false)} style={{background:"none",border:"none",fontSize:22,color:TEXT_MUTED,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{padding:"16px 20px"}}>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6,fontWeight:600}}>名称</div>
                <input value={loanDraft.label} onChange={e=>setLoanDraft(p=>({...p,label:e.target.value}))} placeholder="例：家賃・サブスク・保険など" style={{width:"100%",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",color:TEXT_PRIMARY,fontSize:14,outline:"none",boxSizing:"border-box"}}/>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6,fontWeight:600}}>月額</div>
                <div onClick={()=>setShowLoanCalc(true)} style={{display:"flex",alignItems:"center",gap:6,background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",cursor:"pointer"}}>
                  <span style={{flex:1,textAlign:"right",fontSize:18,fontWeight:700,color:loanDraft.amount?TEXT_PRIMARY:TEXT_MUTED}}>{loanDraft.amount?Number(loanDraft.amount).toLocaleString():"0"}</span>
                  <span style={{fontSize:14,color:TEXT_SECONDARY}}>円</span>
                </div>
              </div>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6,fontWeight:600}}>引き落とし銀行</div>
                <input value={loanDraft.bank} onChange={e=>setLoanDraft(p=>({...p,bank:e.target.value}))} placeholder="例：三菱UFJ銀行" style={{width:"100%",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",color:TEXT_PRIMARY,fontSize:14,outline:"none",boxSizing:"border-box"}}/>
              </div>
              <div style={{marginBottom:20}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6,fontWeight:600}}>引き落とし日</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {["1","5","10","15","20","25","27","末"].map(d=>(
                    <button key={d} onClick={()=>setLoanDraft(p=>({...p,withdrawalDay:d}))} style={{padding:"8px 14px",borderRadius:16,border:`1px solid ${loanDraft.withdrawalDay===d?GOLD:BORDER}`,background:loanDraft.withdrawalDay===d?`${GOLD}22`:"transparent",color:loanDraft.withdrawalDay===d?GOLD:TEXT_SECONDARY,fontSize:13,fontWeight:loanDraft.withdrawalDay===d?700:400,cursor:"pointer"}}>{d}{d!=="末"?"日":""}</button>
                  ))}
                </div>
              </div>
              <button onClick={()=>{
                if(!loanDraft.label.trim()||!loanDraft.amount||Number(loanDraft.amount)<=0)return;
                if(editingLoanId){
                  setLoans(p=>p.map(x=>x.id===editingLoanId?{...loanDraft,id:editingLoanId,amount:Number(loanDraft.amount)}:x));
                } else {
                  setLoans(p=>[...p,{...loanDraft,id:`loan_${Date.now()}`,amount:Number(loanDraft.amount)}]);
                }
                setShowLoanForm(false);setEditingLoanId(null);setLoanDraft({label:"",amount:"",bank:"",withdrawalDay:"",pmId:""});
              }} style={{width:"100%",padding:"14px",background:loanDraft.label.trim()&&loanDraft.amount?GOLD_GRAD:"rgba(255,255,255,0.1)",border:"none",borderRadius:24,fontSize:15,fontWeight:700,color:loanDraft.label.trim()&&loanDraft.amount?"#0A1628":TEXT_MUTED,cursor:"pointer"}}>{editingLoanId?"変更を保存":"登録する"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 定期支出月額電卓モーダル */}
      {showLoanCalc&&(
        <div onClick={()=>setShowLoanCalc(false)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:700,display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(24px + env(safe-area-inset-bottom))"}}>
            <div style={{padding:"14px 20px 10px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"baseline",justifyContent:"flex-end",gap:6}}>
              <span style={{fontSize:42,fontWeight:700,color:loanDraft.amount?TEXT_PRIMARY:TEXT_MUTED}}>{loanDraft.amount||"0"}</span>
              <span style={{fontSize:16,color:TEXT_SECONDARY}}>円</span>
            </div>
            <div style={{padding:"14px"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gridTemplateRows:"repeat(4,62px)",gap:8}}>
                {[{k:"7",col:1,row:1},{k:"8",col:2,row:1},{k:"9",col:3,row:1},{k:"÷",col:4,row:1},{k:"AC",col:5,row:1},{k:"4",col:1,row:2},{k:"5",col:2,row:2},{k:"6",col:3,row:2},{k:"×",col:4,row:2},{k:"Del",col:5,row:2},{k:"1",col:1,row:3},{k:"2",col:2,row:3},{k:"3",col:3,row:3},{k:"－",col:4,row:3},{k:"0",col:1,row:4},{k:"00",col:2,row:4},{k:"＝",col:3,row:4},{k:"＋",col:4,row:4},{k:"OK",col:5,row:3,rowSpan:2}].map(({k,col,row,rowSpan})=>{
                  const isOK=k==="OK",isAC=k==="AC",isDel=k==="Del",isOp=["÷","×","－","＋"].includes(k),isEq=k==="＝";
                  return(<button key={k} onClick={()=>handleLoanCalc(k)} style={{gridColumn:`${col}`,gridRow:rowSpan?`${row}/span ${rowSpan}`:String(row),background:isOK?GOLD_GRAD:isAC?`${RED}22`:isEq?`${TEAL}22`:isOp?`${GOLD}18`:NAVY3,border:`1px solid ${isOK?`${GOLD}66`:isAC?`${RED}44`:isEq?`${TEAL}44`:isOp?`${GOLD}33`:BORDER}`,borderRadius:12,color:isOK?"#0A1628":isAC?RED:isDel?TEXT_SECONDARY:isEq?TEAL:isOp?GOLD:TEXT_PRIMARY,fontSize:isOK?20:24,fontWeight:isOK?700:300,cursor:"pointer"}}>{k}</button>);
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {showRecurringModal&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>{setShowRecurringModal(false);setEditingRecurId(null);setRecurDraft({category:"food",amount:"",memo:"",freq:"monthly"});}} style={{background:"none",border:"none",fontSize:20,color:TEXT_SECONDARY,cursor:"pointer"}}>✕</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>🔁 定期支出</span><span style={{width:40}}></span></div><div style={{flex:1,overflowY:"auto"}}><div style={{background:CARD_BG,margin:"12px 16px",borderRadius:14,padding:"16px",boxShadow:SHADOW}}><div style={{fontWeight:400,fontSize:13,marginBottom:12,color:TEXT_PRIMARY}}>{editingRecurId?"編集":"＋ 新規登録"}</div><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:CREAM,borderRadius:8}}><span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:40}}>金額</span><input type="number" value={recurDraft.amount} onChange={e=>setRecurDraft(p=>({...p,amount:e.target.value}))} placeholder="0" style={{flex:1,border:"none",background:"transparent",fontSize:18,fontWeight:700,outline:"none",color:TEXT_PRIMARY}}/><span style={{color:"#888"}}>円</span></div><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:CREAM,borderRadius:8}}><span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:40}}>メモ</span><input value={recurDraft.memo} onChange={e=>setRecurDraft(p=>({...p,memo:e.target.value}))} placeholder="家賃・Netflixなど" style={{flex:1,border:"none",background:"transparent",fontSize:14,outline:"none",color:TEXT_PRIMARY}}/></div><div style={{marginBottom:12}}><div style={{fontSize:13,color:"#666",marginBottom:8}}>頻度</div><div style={{display:"flex",gap:8}}>{RECUR_OPTIONS.map(o=>(<button key={o.value} onClick={()=>setRecurDraft(p=>({...p,freq:o.value}))} style={{flex:1,padding:"8px",border:`2px solid ${recurDraft.freq===o.value?ORANGE:BORDER}`,borderRadius:8,background:recurDraft.freq===o.value?ORANGE_LIGHT:CARD_BG,fontSize:13,cursor:"pointer",color:recurDraft.freq===o.value?ORANGE:TEXT_PRIMARY,fontWeight:recurDraft.freq===o.value?700:400}}>{o.label}</button>))}</div></div><div style={{marginBottom:14}}><div style={{fontSize:13,color:"#666",marginBottom:8}}>カテゴリー</div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>{expenseCats.map(cat=>(<button key={cat.id} onClick={()=>setRecurDraft(p=>({...p,category:cat.id}))} style={{border:`2px solid ${recurDraft.category===cat.id?ORANGE:BORDER}`,borderRadius:8,padding:"8px 4px",cursor:"pointer",background:recurDraft.category===cat.id?ORANGE_LIGHT:CARD_BG,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}><CatSvgIcon cat={cat} size={20}/><span style={{fontSize:9,color:TEXT_PRIMARY}}>{cat.label}</span></button>))}</div></div><button onClick={saveRecurring} style={{display:"block",width:"100%",padding:"16px",background:recurDraft.amount&&Number(recurDraft.amount)>0?ORANGE:"#333",color:recurDraft.amount&&Number(recurDraft.amount)>0?"#fff":"#888",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}>{editingRecurId?"変更を保存":"登録して今月分を追加"}</button></div></div></div>)}

      {/* ── 日付カレンダーモーダル ── */}
      {showDatePicker&&(
        <div onClick={()=>setShowDatePicker(false)} style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.65)",zIndex:400,display:"flex",alignItems:"flex-end"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(28px + env(safe-area-inset-bottom))"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px 12px",borderBottom:`1px solid ${BORDER}`}}>
              <button onClick={()=>setDatePickerMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})} style={{background:"none",border:"none",color:GOLD,fontSize:22,cursor:"pointer",padding:"0 8px"}}>‹</button>
              <span style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY}}>{datePickerMonth.y}年{datePickerMonth.m+1}月</span>
              <button onClick={()=>setDatePickerMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})} style={{background:"none",border:"none",color:GOLD,fontSize:22,cursor:"pointer",padding:"0 8px"}}>›</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",padding:"8px 12px 4px"}}>
              {["日","月","火","水","木","金","土"].map((d,i)=>(
                <div key={d} style={{textAlign:"center",fontSize:11,fontWeight:600,color:i===0?RED:i===6?TEAL:TEXT_SECONDARY,padding:"4px 0"}}>{d}</div>
              ))}
            </div>
            <div style={{padding:"0 12px 8px"}}>
              {(()=>{
                const {y,m}=datePickerMonth;
                const first=new Date(y,m,1);
                const last=new Date(y,m+1,0);
                const days=[];
                for(let i=0;i<first.getDay();i++) days.push(null);
                for(let i=1;i<=last.getDate();i++) days.push(i);
                while(days.length%7!==0) days.push(null);
                return(
                  <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:3}}>
                    {days.map((day,idx)=>{
                      if(!day) return <div key={idx}/>;
                      const d=new Date(y,m,day);
                      const ds=toDateStr(d);
                      const isSelected=ds===toDateStr(inputDate);
                      const isToday=ds===toDateStr(today);
                      const dow=d.getDay();
                      const hasTx=calTxMap[ds]>0;
                      return(
                        <button key={idx} onClick={()=>{setInputDate(new Date(y,m,day));setShowDatePicker(false);}} style={{padding:"8px 2px",border:"none",borderRadius:10,cursor:"pointer",background:isSelected?GOLD_GRAD:isToday?`${GOLD}22`:"transparent",display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                          <span style={{fontSize:15,fontWeight:isSelected||isToday?700:400,color:isSelected?"#0A1628":dow===0?RED:dow===6?TEAL:TEXT_PRIMARY}}>{day}</span>
                          {hasTx&&!isSelected&&<div style={{width:4,height:4,borderRadius:"50%",background:RED}}/>}
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
            <div style={{padding:"4px 16px 0"}}>
              <button onClick={()=>{setInputDate(new Date());setShowDatePicker(false);}} style={{width:"100%",padding:"12px",background:`${GOLD}18`,border:`1px solid ${GOLD}44`,borderRadius:12,color:GOLD,fontSize:14,fontWeight:700,cursor:"pointer"}}>今日</button>
            </div>
          </div>
        </div>
      )}

      {/* 電卓モーダル */}
      {showCalc&&(
        <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:400,display:"flex",flexDirection:"column",justifyContent:"flex-end"}} onClick={()=>setShowCalc(false)}>
          <div onClick={e=>e.stopPropagation()} style={{background:NAVY2,borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(30px + env(safe-area-inset-bottom))"}}>
            <div style={{padding:"16px 20px 10px",borderBottom:`1px solid ${BORDER}`,display:"flex",alignItems:"flex-end",justifyContent:"flex-end",gap:8}}>
              <span style={{fontSize:46,fontWeight:400,color:inputAmount?TEXT_PRIMARY:TEXT_MUTED,lineHeight:1}}>{inputAmount||"0"}</span>
              <span style={{fontSize:18,color:TEXT_MUTED,fontWeight:400,marginBottom:8}}>円</span>
            </div>
            <div style={{padding:"12px 16px 0"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gridTemplateRows:"repeat(4,68px)",gap:10}}>
                {[{k:"7",col:1,row:1},{k:"8",col:2,row:1},{k:"9",col:3,row:1},{k:"÷",col:4,row:1},{k:"AC",col:5,row:1},{k:"4",col:1,row:2},{k:"5",col:2,row:2},{k:"6",col:3,row:2},{k:"×",col:4,row:2},{k:"Del",col:5,row:2},{k:"1",col:1,row:3},{k:"2",col:2,row:3},{k:"3",col:3,row:3},{k:"－",col:4,row:3},{k:"0",col:1,row:4},{k:"00",col:2,row:4},{k:"＝",col:3,row:4},{k:"＋",col:4,row:4},{k:"OK",col:5,row:3,rowSpan:2}].map(({k,col,row,rowSpan})=>{
                  const isOK=k==="OK",isAC=k==="AC",isDel=k==="Del",isOp=["÷","×","－","＋"].includes(k),isEq=k==="＝";
                  return(<button key={k} onClick={()=>handleCalc(k)} style={{gridColumn:`${col}`,gridRow:rowSpan?`${row}/span ${rowSpan}`:String(row),background:isOK?GOLD_GRAD:isAC?`${RED}22`:isEq?`${TEAL}22`:isOp?`${GOLD}18`:NAVY3,border:`1px solid ${isOK?`${GOLD}66`:isAC?`${RED}44`:isEq?`${TEAL}44`:isOp?`${GOLD}33`:BORDER}`,borderRadius:12,color:isOK?"#0A1628":isAC?RED:isDel?TEXT_SECONDARY:isEq?TEAL:isOp?GOLD:TEXT_PRIMARY,fontSize:isOK?20:24,fontWeight:isOK?500:300,cursor:"pointer",boxShadow:isOK?`0 4px 16px ${GOLD}44`:"none"}}>{k}</button>);
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* カテゴリ予算モーダル */}
      {showCatBudgetModal&&catBudgetTarget&&(
        <div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.6)",zIndex:300,display:"flex",alignItems:"flex-end"}}>
          <div style={{background:NAVY2,width:"100%",borderRadius:"20px 20px 0 0",border:`1px solid ${BORDER}`,paddingBottom:"calc(24px + env(safe-area-inset-bottom))"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,padding:"16px 20px 12px",borderBottom:`1px solid ${BORDER}`}}>
              <CatSvgIcon cat={catBudgetTarget} size={28}/>
              <div style={{flex:1}}><div style={{fontWeight:700,fontSize:15,color:TEXT_PRIMARY}}>{catBudgetTarget.label}</div><div style={{fontSize:11,color:TEXT_MUTED}}>{catBudgetTarget._isWeek?"今週の予算を設定":`${todayCycle.month+1}月の予算を設定`}</div></div>
              <button onClick={()=>setShowCatBudgetModal(false)} style={{background:"none",border:"none",fontSize:22,color:TEXT_MUTED,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{padding:"14px 20px 10px",display:"flex",alignItems:"baseline",justifyContent:"flex-end",gap:6}}>
              <span style={{fontSize:42,fontWeight:700,color:catBudgetInput?TEXT_PRIMARY:TEXT_MUTED}}>{catBudgetInput||"0"}</span>
              <span style={{fontSize:16,color:TEXT_SECONDARY}}>円</span>
            </div>
            <div style={{padding:"0 14px"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gridTemplateRows:"repeat(4,62px)",gap:8}}>
                {[{k:"7",col:1,row:1},{k:"8",col:2,row:1},{k:"9",col:3,row:1},{k:"÷",col:4,row:1},{k:"AC",col:5,row:1},{k:"4",col:1,row:2},{k:"5",col:2,row:2},{k:"6",col:3,row:2},{k:"×",col:4,row:2},{k:"Del",col:5,row:2},{k:"1",col:1,row:3},{k:"2",col:2,row:3},{k:"3",col:3,row:3},{k:"－",col:4,row:3},{k:"0",col:1,row:4},{k:"00",col:2,row:4},{k:"＝",col:3,row:4},{k:"＋",col:4,row:4},{k:"OK",col:5,row:3,rowSpan:2}].map(({k,col,row,rowSpan})=>{
                  const isOK=k==="OK",isAC=k==="AC",isDel=k==="Del",isOp=["÷","×","－","＋"].includes(k),isEq=k==="＝";
                  return(<button key={k} onClick={()=>handleCatCalc(k)} style={{gridColumn:`${col}`,gridRow:rowSpan?`${row}/span ${rowSpan}`:String(row),background:isOK?GOLD_GRAD:isAC?`${RED}22`:isEq?`${TEAL}22`:isOp?`${GOLD}18`:NAVY3,border:`1px solid ${isOK?`${GOLD}66`:isAC?`${RED}44`:isEq?`${TEAL}44`:isOp?`${GOLD}33`:BORDER}`,borderRadius:12,color:isOK?"#0A1628":isAC?RED:isDel?TEXT_SECONDARY:isEq?TEAL:isOp?GOLD:TEXT_PRIMARY,fontSize:isOK?20:24,fontWeight:isOK?700:300,cursor:"pointer"}}>{k}</button>);
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 予算設定モーダル */}
      {showBudgetModal&&(
        <div style={S.overlay}>
          <div style={S.overlayHeader}><button onClick={()=>setShowBudgetModal(false)} style={{background:"none",border:"none",fontSize:20,color:TEXT_SECONDARY,cursor:"pointer"}}>✕</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>予算設定</span><button onClick={saveBudgets} style={{background:"none",border:"none",color:GOLD,fontSize:15,fontWeight:700,cursor:"pointer"}}>保存</button></div>
          <div style={{flex:1,overflowY:"auto"}}>
            <div style={S.monthNav}><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}>‹</button><span style={{fontWeight:600,fontSize:14,color:TEXT_PRIMARY}}>{fmtMonth(budgetMonth.y,budgetMonth.m)}</span><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}>›</button></div>
            <div style={{background:CARD_BG}}>
              {expenseCats.map(cat=>(
                <div key={cat.id} onClick={()=>{setCatBudgetTarget({...cat,_isWeek:false});setCatBudgetInput(budgetDraft[cat.id]||"");setShowCatBudgetModal(true);}} style={{display:"flex",alignItems:"center",padding:"14px 18px",borderBottom:`1px solid ${BORDER}`,cursor:"pointer",gap:12}}>
                  <CatSvgIcon cat={cat} size={26}/>
                  <span style={{flex:1,fontSize:14,fontWeight:500,color:TEXT_PRIMARY}}>{cat.label}</span>
                  <span style={{fontSize:14,fontWeight:600,color:budgetDraft[cat.id]?TEXT_PRIMARY:TEXT_MUTED}}>{budgetDraft[cat.id]?`${Number(budgetDraft[cat.id]).toLocaleString()}円`:"未設定"}</span>
                  <span style={{color:TEXT_MUTED,fontSize:14}}>›</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}