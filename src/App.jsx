import { useState, useMemo, useRef, useEffect } from "react";
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
import { usePaymentMethods } from "./hooks/usePaymentMethods";
import { useLoans } from "./hooks/useLoans";
import { usePoints } from "./hooks/usePoints";
import LogoutButton from "./components/LogoutButton";
import AppointmentCard, { fmtDateTime } from "./components/AppointmentCard";
import { useNextAppointment } from "./hooks/useAppointments";
import SortableCategoryRow from "./components/SortableCategoryRow";
import SortablePaymentRow from "./components/SortablePaymentRow";
import AnnualBudgetViewer from "./components/AnnualBudgetViewer";
import AssetSheetViewer from "./components/AssetSheetViewer";
import MonthlyReviewViewer from "./components/MonthlyReviewViewer";
import InvestmentRecoveryViewer from "./pages/InvestmentRecoveryViewer";
import { MonthPopoverDial } from "./components/MonthDialPicker";
import ReportTabs from "./components/ReportTabs";
import { listPublishedByClient } from "./lib/api/monthlyReviews";
import { useLatestTelop } from "./hooks/useNotifications";
import { useInquiries } from "./hooks/useInquiries";
import { useAnnualBudgets } from "./hooks/useAnnualBudgets";
import { useAuth } from "./context/AuthContext";
import { migratePaymentsLoans } from "./lib/migratePaymentsLoans";
import { migrateBudgets } from "./lib/migrateBudgets";
import { supabase } from "./lib/supabaseClient";
import { DndContext, closestCenter, MouseSensor, TouchSensor, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, sortableKeyboardCoordinates, arrayMove } from "@dnd-kit/sortable";

// Phase E ⑦-2: 顧客自身による編集許可フラグは Supabase
// profiles.customer_edit_enabled へ移行済 (migration 010)。
// AuthContext.customerEditEnabled として App 内 useAuth() で取得し、
// requestEdit() が true なら action 実行 / false ならトースト案内。
// 本部側 (private-cfo-admin) からの UPDATE で per-customer 切替が可能。

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

// 顧客メニュー下部の外部リンクカード用 URL (renderMenu 内 L2588 / L2595 で参照)。
// 空文字の間は onClick のガード分岐でタップ無効化、確定 URL を貼るだけで即有効化される。
const COMPANY_HP_URL = "";   // ← 会社HPのURL確定後ここに貼るだけで即反映。空の間はタップ無効
const COMPANY_PDF_URL = "";  // ← 会社案内PDFのURL確定後ここに貼るだけで即反映。空の間はタップ無効

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

// Step A ②: 予算超過/警告の集約サマリー。renderDaily 上部に配置 (alerts === budgetAlerts)。
// over>0 と warn>0 の両方を扱い、件数だけのコンパクト表示。アラート 0 件なら null を返す。
function BudgetAlertSummary({ alerts }) {
  const overCount = alerts.filter(a => a.level === "over").length;
  const warnCount = alerts.filter(a => a.level === "warn").length;
  if (overCount === 0 && warnCount === 0) return null;
  const hasOver = overCount > 0;
  const accent = hasOver ? RED : GOLD;
  return (
    <div style={{
      flexShrink: 0,
      margin: "8px 14px 0",
      padding: "10px 14px",
      borderRadius: 10,
      border: `1.5px solid ${accent}`,
      background: hasOver ? `${RED}14` : `${GOLD}14`,
      display: "flex",
      alignItems: "center",
      gap: 8,
      fontSize: 13,
      fontWeight: 600,
      color: accent,
    }}>
      <span style={{fontSize: 14}}>{hasOver ? "🚨" : "⚠️"}</span>
      {hasOver && <span>予算超過 {overCount} 件</span>}
      {hasOver && warnCount > 0 && <span style={{color: TEXT_MUTED, fontWeight: 400}}>・</span>}
      {warnCount > 0 && <span style={{color: hasOver ? GOLD : accent}}>警告 {warnCount} 件</span>}
    </div>
  );
}

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
  // B-2: 月次レビュー overlay を横画面で局所拡幅するため orientation を購読 (他 overlay は触らない)。
  //   App shell (S.app maxWidth:430) はそのまま、currentMonthReport 配下 wrapper だけ広げる。
  const [isLandscape, setIsLandscape] = useState(
    () => typeof window !== "undefined"
      && window.matchMedia("(orientation: landscape)").matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const mq = window.matchMedia("(orientation: landscape)");
    const handler = (e) => setIsLandscape(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const [tab, setTab] = useState("daily");
  // #11: 月間サマリーで固定費(loans)を合算するか。'split'(分ける=既定/カテゴリのみ) / 'incl'(込み)。
  //   localStorage 'monthly_fixedCostMode' で永続 (本部アプリとは別キー)。
  const [fixedCostMode, setFixedCostMode] = useLocalStorage("monthly_fixedCostMode", "split");
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
  // calMonth / reportMonth / budgetMonth / weekBudgetMonth は「サイクル月」を表す state。
  // today.getMonth() (calendar 月) ではなく、today が属するサイクルの month を初期値に使う。
  // 例) msd=25, today=2026-05-06 → cycle は 4/25-5/24 → m=3 (4月サイクル) で初期化。
  // msd=null (未設定) のときは findCycleOfDate が cycleStart=1日 を返すので calendar 月と等価。
  const initialCycle = findCycleOfDate(today, getManagementStartDay());
  const [calMonth, setCalMonth] = useState({ y: initialCycle.year, m: initialCycle.month });
  const [reportMonth, setReportMonth] = useState({ y: initialCycle.year, m: initialCycle.month });
  const [reportYear, setReportYear] = useState(today.getFullYear());
  const [reportType, setReportType] = useState("monthly");
  // ③ 稼働進捗タブ (renderMonthly 内、月ナビ直下のチップタブ切替):
  // - progressTab: 'budget' (既存 UI = SummaryBar + PieChart + CatTwoBox 一覧) / 'operation' (新規 = 既使用額 + 週チップ + 予測合計)
  // - selectedWeeks: 「稼働進捗」タブで multi-select される週番号 (1-4) の Set。
  //   未来支出予定金額 = 既使用額 + Σ(選択週の予算)。default 空 Set (= 既使用額のみ表示)。
  const [progressTab, setProgressTab] = useState("budget");
  const [selectedWeeks, setSelectedWeeks] = useState(() => new Set());
  const [budgetMonth, setBudgetMonth] = useState({ y: initialCycle.year, m: initialCycle.month });

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

  const [showBudgetModal, setShowBudgetModal] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState({});
  const [menuScreen, setMenuScreen] = useState("main");
  // Phase E: 顧客側編集ロック中のトースト表示制御。requestEdit() で発火、3.5s 自動消滅。
  // 連打されたら setTimeout を都度張り直し、最後のタップから 3.5s 後に閉じる。
  const [editLockedToast, setEditLockedToast] = useState(false);
  const editLockedToastTimer = useRef(null);
  const showEditLockedToast = () => {
    setEditLockedToast(true);
    if (editLockedToastTimer.current) clearTimeout(editLockedToastTimer.current);
    editLockedToastTimer.current = setTimeout(() => setEditLockedToast(false), 3500);
  };
  // 2026-06-05: 機能ゲート用トースト + ラッパ
  const PLAN_GATE_MSG = '本機能は、Monthlyプラン以上をご契約のお客様よりご利用いただけます。';
  const [featureLockedToast, setFeatureLockedToast] = useState(null);
  const featureLockedToastTimer = useRef(null);
  const showFeatureLockedToast = (msg = PLAN_GATE_MSG) => {
    setFeatureLockedToast(msg);
    if (featureLockedToastTimer.current) clearTimeout(featureLockedToastTimer.current);
    featureLockedToastTimer.current = setTimeout(() => setFeatureLockedToast(null), 3500);
  };
  const requestFeature = (flag, action, lockedMsg = PLAN_GATE_MSG) => {
    if (flag) action();
    else showFeatureLockedToast(lockedMsg);
  };
  // Step B ④: 予算オーバートースト。addTransaction 成功後、当該カテゴリが
  // 「ちょうど over に乗った」瞬間 (spentOld < budget && spentNew >= budget) だけ発火。
  // null=非表示 / string=表示メッセージ。3.5s 自動消滅 (editLockedToast と同方針)。
  const [budgetOverToast, setBudgetOverToast] = useState(null);
  const budgetOverToastTimer = useRef(null);
  // 編集導線の入口で呼ぶラッパ。フラグ ON なら action 実行、OFF ならトースト案内。
  // フラグは AuthContext.customerEditEnabled = profiles.customer_edit_enabled。
  const requestEdit = (action) => {
    if (customerEditEnabled) action();
    else showEditLockedToast();
  };
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
  // === B-3b Step 4-2 phase 1: payment_methods を Supabase 経由に切替 ===
  // 旧 localStorage 行は rollback 用にコメントアウトで残置 (Phase 3 で削除予定):
  //   const [paymentMethods, setPaymentMethods] = useLocalStorage("cfo_paymentMethods", [{ id:"cash", label:"現金", color:"#4CAF50" }]);
  const {
    paymentMethods,
    createPaymentMethod, updatePaymentMethod, deletePaymentMethod, reorderPaymentMethods,
    refetch: refetchPaymentMethods,
  } = usePaymentMethods();

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
  // iOS Safari / macOS Chrome / Safari でネイティブカレンダーピッカーを起動するための ref。
  // 当初は <input type="date" opacity:0> を上に重ねるだけの方式 (iOS Safari の click→picker 自動起動を期待)
  // で実装していたが、macOS Chrome/Safari では opacity:0 の input への click が showPicker を発火しない
  // ことが判明 (2026-05-04)。そのため親 span 側の onClick から `inputRef.current?.showPicker?.()` を
  // 明示呼び出しする方式に切替。これにより iOS / macOS の双方で確実に picker が開く。
  // 旧 overlay <input> 自体も残置 (showPicker 未対応の古いブラウザ互換 + change ハンドラの届け先)。
  const rewardDayPickerRef = useRef(null);
  const msdPickerRef = useRef(null);
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
  const [weekBudgetMonth, setWeekBudgetMonth] = useState({ y: initialCycle.year, m: initialCycle.month });
  const [showCopyConfirm, setShowCopyConfirm] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [contactType, setContactType] = useState("inquiry");
  const [contactText, setContactText] = useState("");
  const [contactSent, setContactSent] = useState(false);
  const { submitting: contactSubmitting, sendInquiry } = useInquiries();
  const [summaryTab, setSummaryTab] = useState("summary");
  // === B-3b Step 4-2 phase 1: loans を Supabase 経由に切替 ===
  // 旧 localStorage 行は rollback 用にコメントアウトで残置 (Phase 3 で削除予定):
  //   const [loans, setLoans] = useLocalStorage("cfo_loans", []);
  const {
    loans,
    createLoan, updateLoan, deleteLoan,
    refetch: refetchLoans,
  } = useLoans();

  // === B-3b Step 5: payment_methods / loans の localStorage → Supabase 移行 ===
  // ログイン直後に 1 回だけ実行。冪等 (cfo_paymentsLoansMigrated フラグ + idempotent upsert)。
  // ref ガードで StrictMode 二重起動を抑止。失敗は console.warn のみで UI 阻害しない。
  // 完了後に refetchPaymentMethods / refetchLoans で UI を最新 DB 状態へ同期。
  const { user: authUser, customerEditEnabled, reportEnabled, meetingEnabled, fixedCostsEnabled, utilizationEnabled, categoryAddEnabled, cardLimit, assetSheetEnabled } = useAuth();
  const authUserId = authUser?.id ?? null;
  // タスク (2026-06-08): メニュー「面談予定」行に次回面談日時を read-only 表示するため、
  //   詳細画面 AppointmentCard と同じ useNextAppointment を top-level で 1 回購読する。
  //   loading/エラーは UI 上「日時 or 空」で吸収 (subLabel 空表示)。
  const { appointment: nextAppointment } = useNextAppointment();
  // 繰越票 (annual_budgets) の committed snapshot を購読。月間サマリーの「月の予算」を
  // HQ が決めた monthly_budget と連動させる (getCarryoverMonthBudget 経由)。
  // AnnualBudgetViewer も別途同フックを使うが、ここは消費者を増やすだけ (Viewer 側は不変)。
  const { data: carryoverBudget } = useAnnualBudgets(authUserId);
  // 2026-06-08 ②: 初回のみ reportYear を「今いる年度の起点暦年」へ合わせる。
  //   例) startMonth=4・today=2026-02 → 年度起点は 2025 (2025年4月〜2026年3月)。
  //   ユーザーが年ナビを動かした後は上書きしない (didInitReportYear で guard)。
  const didInitReportYear = useRef(false);
  useEffect(() => {
    if (didInitReportYear.current) return;
    if (carryoverBudget?.fiscal_year_start_month == null) return;
    const sm = Number(carryoverBudget.fiscal_year_start_month) || 1;
    const now = new Date();
    setReportYear((now.getMonth() + 1) >= sm ? now.getFullYear() : now.getFullYear() - 1);
    didInitReportYear.current = true;
  }, [carryoverBudget]);
  const paymentsLoansMigrationStartedRef = useRef(false);
  useEffect(() => {
    if (!authUserId) return;
    if (paymentsLoansMigrationStartedRef.current) return;
    paymentsLoansMigrationStartedRef.current = true;
    (async () => {
      try {
        const result = await migratePaymentsLoans(authUserId);
        if (!result.skipped && (result.pmWritten > 0 || result.loanWritten > 0)) {
          await Promise.all([refetchPaymentMethods(), refetchLoans()]);
        }
      } catch (e) {
        console.error('[migrate] payments/loans migration crashed', e);
      }
    })();
  }, [authUserId, refetchPaymentMethods, refetchLoans]);
  // === B-3b Step 5 end ===

  // === B-3a Step 5: budgets localStorage → Supabase ワンタイム移行 ===
  // B-3a で useLocalStorage("cfo_budgets" 等) → useBudgets() に置換した結果、
  // 既存ユーザーの localStorage に残った予算データが UI から不可視になっていた問題への対処。
  // migratePaymentsLoans とは独立したフラグ + 独立 ref で並行起動 (片方失敗の巻き添え防止)。
  // 完了後 refetchBudgets() で UI を最新 DB 状態に同期。
  const budgetsMigrationStartedRef = useRef(false);
  useEffect(() => {
    if (!authUserId) return;
    if (budgetsMigrationStartedRef.current) return;
    budgetsMigrationStartedRef.current = true;
    (async () => {
      try {
        const result = await migrateBudgets(authUserId);
        // 何か実書き込みが発生したら refetch して UI を最新化。
        // skip / no-localstorage-data ケースは refetch 不要 (DB 状態は変わってない)。
        if (!result.skipped && (result.bWritten > 0 || result.wWritten > 0 || result.wcWritten > 0)) {
          await refetchBudgets();
        }
      } catch (e) {
        console.error('[migrate] budgets migration crashed', e);
      }
    })();
  }, [authUserId, refetchBudgets]);
  // === B-3a Step 5 end ===

  const [showLoanForm, setShowLoanForm] = useState(false);
  const [deleteLoanTarget, setDeleteLoanTarget] = useState(null);
  const [showLoanCalc, setShowLoanCalc] = useState(false);
  const [editingLoanId, setEditingLoanId] = useState(null);
  const [loanDraft, setLoanDraft] = useState({label:"",amount:"",bank:"",withdrawalDay:"",pmId:""});
  const [reportSearchQuery, setReportSearchQuery] = useState("");
  // #2+#3/④: 月次レポートの表示月 (暦年月)。ダイヤルピッカーで切替。
  //   初期は「先月」(当月の1ヶ月前、1月は前年12月)。候補レンジ外なら effect でクランプ。
  const [mrMonth, setMrMonth] = useState(() => {
    let y = today.getFullYear(), m = today.getMonth(); // getMonth()=当月0-indexed → そのまま先月の1-indexed候補
    if (m < 1) { m = 12; y -= 1; }
    return { y, m };
  });
  // ④: 初期選択 (先月クランプ) を1度だけ適用するための番兵。
  const mrInitRef = useRef(false);
  // #2+#3: ダイヤルの月候補 (昇順 [{y,m,label}])。最古の公開済みレビュー月〜当月。0件なら当月のみ。
  const [mrMonths, setMrMonths] = useState(() => {
    const y = today.getFullYear(), m = today.getMonth() + 1;
    return [{ y, m, label: `${y}年${m}月` }];
  });
  const { balance: userPoints, history: pointHistory } = usePoints();
  const { body: telopBody } = useLatestTelop();
  const telopText = telopBody ?? FALLBACK_TELOP;
  const [menuPaymentScreen, setMenuPaymentScreen] = useState("list");
  const [paymentDraft, setPaymentDraft] = useState({ label:"", color:"#4CAF50", closingDay:"", withdrawalDay:"", bank:"" });
  const [showDayCalc, setShowDayCalc] = useState(false);
  const [dayCalcInput, setDayCalcInput] = useState("");
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const longPressTimer = useRef(null);

  // #2+#3: 公開済み月次レビューを取得し、ダイヤルの月候補 [最古公開月 〜 当月] を構築。
  //   listPublishedByClient は year/month DESC で全件 → 末尾が最古。0件なら当月のみ。
  useEffect(() => {
    if (!authUserId) return;
    let alive = true;
    listPublishedByClient(authUserId)
      .then((rows) => {
        if (!alive) return;
        const curY = today.getFullYear(), curM = today.getMonth() + 1;
        let oy = curY, om = curM;
        if (Array.isArray(rows) && rows.length > 0) {
          const oldest = rows[rows.length - 1]; // DESC のため末尾が最古
          const ry = Number(oldest?.year), rm = Number(oldest?.month);
          // 最古が当月より過去のときだけ下限に採用 (未来月は無視)。
          if (Number.isFinite(ry) && Number.isFinite(rm) && (ry < curY || (ry === curY && rm < curM))) {
            oy = ry; om = rm;
          }
        }
        // 最古 → 当月 の連続月配列 (昇順)。
        const out = [];
        let y = oy, m = om;
        while (y < curY || (y === curY && m <= curM)) {
          out.push({ y, m, label: `${y}年${m}月` });
          m += 1; if (m > 12) { m = 1; y += 1; }
          if (out.length > 240) break; // 安全弁
        }
        const list = out.length > 0 ? out : [{ y: curY, m: curM, label: `${curY}年${curM}月` }];
        setMrMonths(list);
        // 修正A: 初回のみ、初期選択を「公開済みレビューが実在する月」にする。
        //   - 先月 (当月の1ヶ月前) に公開済みレビューが実在 → 先月 (従来の意図を尊重)。
        //   - 無ければ → 最新の公開済み月 (rows は year/month DESC のため rows[0])。
        //   - 公開が1件も無ければ → 当月のまま (準備中表示で正当)。
        //   ※「レンジ内か」ではなく「その月に公開が実在するか」で判定 (準備中初期表示を防ぐ)。
        if (!mrInitRef.current) {
          mrInitRef.current = true;
          let py = curY, pm = curM - 1;
          if (pm < 1) { pm = 12; py -= 1; }
          const isPublished = (yy, mm) =>
            Array.isArray(rows) && rows.some((r) => Number(r?.year) === yy && Number(r?.month) === mm);
          if (isPublished(py, pm)) {
            setMrMonth({ y: py, m: pm });
          } else if (Array.isArray(rows) && rows.length > 0) {
            const latest = rows[0]; // DESC 先頭 = 最新の公開済み月
            setMrMonth({ y: Number(latest.year), m: Number(latest.month) });
          }
          // 公開0件のときは初期 (当月) のまま = 準備中表示で正当。
        }
      })
      .catch((e) => { console.error("[mrMonths]", e); });
    return () => { alive = false; };
  }, [authUserId]);

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

  // Step A/B 共通: 真ソース (week_cat_budgets) を参照する月予算取得ヘルパー。
  // directBudget (旧 budgets テーブル, 直接月予算) > 0 ならそれを採用、
  // なければ週カテ予算 ×4週 合算で月予算を算出 (L1568 月別グラフと同方針)。
  // budgetAlerts (集約) と addTransaction (入力直後トースト判定) の両方から利用。
  const getCatBudget = (catId) => {
    const m1 = todayCycle.month + 1;
    const directBudget = budgets[`${todayCycle.year}-${m1}-${catId}`] || 0;
    const weeklyBudgetSum = [1,2,3,4].reduce(
      (s, wn) => s + (weekCatBudgets[`${todayCycle.year}-${m1}-w${wn}_${catId}`] || 0),
      0
    );
    return directBudget > 0 ? directBudget : weeklyBudgetSum;
  };

  const budgetAlerts = useMemo(() => {
    // ★予算オーバーアラート機能 一時非表示中 (2026-05-18)
    // 通知過多で精神的負荷が大きいため全機能停止。
    // 復活時:下の return []; 行を削除 + 続く /* */ を解除
    return [];
    /*
    const result = [];
    expenseCats.forEach(cat => {
      const budget = getCatBudget(cat.id);
      if (budget <= 0) return;
      const spent = transactions.filter(t=>t.category===cat.id&&t.date>=tmCycleStart&&t.date<=tmCycleEnd).reduce((s,t)=>s+t.amount,0);
      const pct = spent / budget * 100;
      if (pct >= 100) result.push({ cat, pct, spent, budget, level:"over" });
      else if (pct >= 80) result.push({ cat, pct, spent, budget, level:"warn" });
    });
    return result;
    */
  }, [transactions, budgets, weekCatBudgets, expenseCats, tmCycleStart, tmCycleEnd, todayCycle]);

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
  // タスクB (2026-06-07): 月タブ円グラフの小スライス (percent<0.08) ラベル衝突回避。
  //   事前に全スライスの midAngle と naturalY を recharts と同式で算出、cos 符号で左右に振り分け、
  //   各側で naturalY 昇順ソート → minGap=18px を強制して下方向に押し下げ。
  //   index → { side, finalYOffset } のマップを返す。label 関数は引数 index で参照。
  //   ※ 内側ラベル (percent>=0.08) は補正対象外。Pie の cx/cy/outerRadius は JSX 側のリテラル
  //      (cx="50%"/cy="50%"/outerRadius=90) と整合させる。
  const PIE_OUTER_RADIUS = 90;
  const PIE_LABEL_GAP = 18;       // 小スライスラベルの最小行間 (px)
  const PIE_LABEL_THRESHOLD = 0.08; // 内側/外側分岐の percent 閾値
  // タスクB追補2 (2026-06-07): チャート領域 (高さ 240、cy=120) からはみ出るのを防ぐ。
  //   offset は cy 相対値。上端 = -(120 - PIE_LABEL_TOP_PAD)、下端 = 120 - PIE_LABEL_BOT_PAD。
  //   テキスト fontSize=10 の上下分 (~5px) と外周余裕 (7px) で計 12px をパッドに。
  const PIE_CHART_HEIGHT = 240;
  const PIE_CY = PIE_CHART_HEIGHT / 2;
  const PIE_LABEL_TOP_PAD = 12;
  const PIE_LABEL_BOT_PAD = 12;
  const PIE_CY_MIN_OFFSET = -(PIE_CY - PIE_LABEL_TOP_PAD); // 例: -108
  const PIE_CY_MAX_OFFSET =  (PIE_CY - PIE_LABEL_BOT_PAD); // 例: +108
  const catLabelLayout = useMemo(() => {
    if (!Array.isArray(catBreakdown) || catBreakdown.length === 0) return {};
    const total = catBreakdown.reduce((s, e) => s + (Number(e?.value) || 0), 0);
    if (total <= 0) return {};
    const START_ANGLE = 0; // recharts Pie default
    const SWEEP = 360;
    const RADIAN = Math.PI / 180;
    let cum = 0;
    const items = catBreakdown.map((e, i) => {
      const p = (Number(e?.value) || 0) / total;
      const midAngle = START_ANGLE + (cum + p / 2) * SWEEP;
      cum += p;
      // 既存 label 関数と同じ -midAngle 反転 (SVG y 軸下向き整合)。
      const sin = Math.sin(-midAngle * RADIAN);
      const cos = Math.cos(-midAngle * RADIAN);
      return {
        index: i,
        percent: p,
        naturalYOffset: (PIE_OUTER_RADIUS + 8) * sin,
        side: cos >= 0 ? "right" : "left",
        isSmall: p < PIE_LABEL_THRESHOLD,
      };
    });
    // 同じ側に集まる小スライスを 3 段で配置調整:
    //   Step 1: naturalY 昇順 + minGap=18px で下方向にカスケード押し下げ
    //   Step 2: 末尾が下端 (PIE_CY_MAX_OFFSET) を超えたらグループ全体を上にシフト
    //   Step 3: 先頭が上端 (PIE_CY_MIN_OFFSET) を下回ったら、
    //           総高さが利用可能高さ以下なら下にシフト、超えるなら均等分散 (compress)
    //   → 日用品など最末尾の極小スライスも必ずチャート領域内 (TOP_PAD..BOT_PAD) に収まる
    const adjustSide = (sideItems) => {
      if (sideItems.length === 0) return;
      sideItems.sort((a, b) => a.naturalYOffset - b.naturalYOffset);
      // Step 1: 下方向カスケード押し下げ (既存)
      for (let i = 0; i < sideItems.length; i++) {
        if (i === 0) {
          sideItems[i].finalYOffset = sideItems[i].naturalYOffset;
        } else {
          const minAllowed = sideItems[i - 1].finalYOffset + PIE_LABEL_GAP;
          sideItems[i].finalYOffset = Math.max(sideItems[i].naturalYOffset, minAllowed);
        }
      }
      // Step 2: 下端超過 → グループ全体を上にシフト
      const lastOffset = sideItems[sideItems.length - 1].finalYOffset;
      if (lastOffset > PIE_CY_MAX_OFFSET) {
        const shift = lastOffset - PIE_CY_MAX_OFFSET;
        for (let i = 0; i < sideItems.length; i++) {
          sideItems[i].finalYOffset -= shift;
        }
      }
      // Step 3: 上端不足 → シフト or 均等分散 (compress)
      const firstOffset = sideItems[0].finalYOffset;
      if (firstOffset < PIE_CY_MIN_OFFSET) {
        const groupHeight = sideItems[sideItems.length - 1].finalYOffset - firstOffset;
        const availableHeight = PIE_CY_MAX_OFFSET - PIE_CY_MIN_OFFSET;
        if (groupHeight <= availableHeight) {
          // 単に下方向シフト
          const shift = PIE_CY_MIN_OFFSET - firstOffset;
          for (let i = 0; i < sideItems.length; i++) {
            sideItems[i].finalYOffset += shift;
          }
        } else {
          // 均等分散で fit (minGap を縮める)
          const newGap = sideItems.length > 1 ? availableHeight / (sideItems.length - 1) : 0;
          for (let i = 0; i < sideItems.length; i++) {
            sideItems[i].finalYOffset = PIE_CY_MIN_OFFSET + i * newGap;
          }
        }
      }
    };
    const rightSmall = items.filter((it) => it.isSmall && it.side === "right");
    const leftSmall  = items.filter((it) => it.isSmall && it.side === "left");
    adjustSide(rightSmall);
    adjustSide(leftSmall);
    const map = {};
    for (const it of [...rightSmall, ...leftSmall]) {
      map[it.index] = { side: it.side, finalYOffset: it.finalYOffset };
    }
    return map;
  }, [catBreakdown]);

  // yearlyData:12 サイクル(各カレンダー月起点)を独立に集計。
  // 報酬日 25 なら 5月分 = 5/25-6/24 のように、隣接サイクルが同じ取引を重複カウントしないよう
  // 各サイクル range で個別 filter する。
  // 2026-06-08 ②: 会計年度開始月 (carryoverBudget.fiscal_year_start_month) で並び替え、
  //   開始月より前の月 (例 startMonth=4 のとき 1〜3 月) は翌暦年 (reportYear+1) で集計。
  //   各要素に month/year を保持し、現在月ハイライト・予算キーの組立に再利用する。
  const startMonth = Number(carryoverBudget?.fiscal_year_start_month) || 1;
  const yearlyData = useMemo(() => {
    const monthOrder = Array.from({length:12}, (_, i) => ((startMonth - 1 + i) % 12) + 1);
    return monthOrder.map((m) => {
      const yr = m >= startMonth ? reportYear : reportYear + 1;
      const sStr = toDateStr(cycleStart(yr, m - 1, managementStartDay));
      const eStr = toDateStr(cycleEnd(yr, m - 1, managementStartDay));
      return {
        name: `${m}月`, month: m, year: yr,
        expense: transactions.filter(t => t.date >= sStr && t.date <= eStr).reduce((s, t) => s + t.amount, 0),
      };
    });
  }, [transactions, reportYear, managementStartDay, startMonth]);
  // #4 数字ずれ修正: 年間合計支出 standalone 表示を削除したため yearlyTotal も廃止。
  // 残った yearlyData は AreaChart / 月別バー (L1717,L1788,L1804) で引き続き使用。

  const budgetKey=(cat)=>`${budgetMonth.y}-${budgetMonth.m+1}-${cat}`;
  const getBudget=(cat)=>budgets[budgetKey(cat)];

  // 繰越票 (annual_budgets committed) の月予算を、サイクル月 (暦月 m+1) で合算して返す。
  //   - monthly_budget の jsonb キーはサイクル月番号 1..12 (admin 側 setMonthlyBudget /
  //     commit 焼き込みが String(月番号) で保存。暦月 m+1 と同じ番号体系)。
  //   - 通常カテゴリ行のみ対象 (特殊行: 納税/その他精算/調整額 = category_id null /
  //     row_type 'special_*' は除外。archived も除外)。
  //   - reportMonth が committed の年度範囲外、または monthly_budget 未保存なら 0。
  //     (fiscal_year_start_month を跨ぐ年度のため、サイクル月→暦年を逆算して年一致を確認)
  const getCarryoverMonthBudget = (y, m) => {
    const d = carryoverBudget;
    const lines = Array.isArray(d?.committed_lines) ? d.committed_lines : [];
    if (lines.length === 0) return 0;
    const mm = m + 1; // サイクル月番号 1..12
    const fy = Number(d.fiscal_year);
    const startM = Number(d.fiscal_year_start_month) || 1;
    // サイクル月 mm の暦年: 年度開始月以降は fy、開始月より前は翌年 (fy+1)。
    const expectedYear = mm >= startM ? fy : fy + 1;
    if (!Number.isFinite(fy) || y !== expectedYear) return 0;
    let sum = 0;
    for (const line of lines) {
      if (!line) continue;
      if (line.category_id == null) continue;                       // 特殊行 (category_id null)
      if (String(line.row_type || '').startsWith('special_')) continue; // 特殊行 (row_type)
      if (line.archived) continue;                                  // 削除済みカテゴリ
      const mb = line.monthly_budget;
      if (!mb) continue;
      const v = mb[mm] ?? mb[String(mm)];
      if (v != null) sum += Number(v) || 0;
    }
    return sum;
  };

  const getEffectiveMonthBudget = (y, m) => {
    // 繰越票 (HQ が決めた月予算) を最優先。週予算/手動月予算より上位。
    const carryover = getCarryoverMonthBudget(y, m);
    if (carryover > 0) return carryover;
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
  // Phase E ⑦-2: 顧客側編集導線は AuthContext.customerEditEnabled
  // (= profiles.customer_edit_enabled, migration 010) でガード。
  // ロック時は requestEdit() 経由で「本部管理中」トースト表示。
  // 本部側 (private-cfo-admin) からの UPDATE で per-customer 切替済。
  // 既知の別件 (本 commit のスコープ外): catBudget OK 押下で親モーダルの
  // budgetDraft が更新されない sync 漏れがコード上存在するが、ロック時は
  // showBudgetModal が requestEdit で開かれないため発火しない。
  // フラグ true 化 (編集解放) 時に併せて修正が必要。
  const saveBudgets=()=>{
    expenseCats.forEach(c=>{
      const k=budgetKey(c.id);
      const draft=budgetDraft[c.id];
      const valid=draft&&!isNaN(Number(draft));
      const cur=budgets[k];
      if(valid){
        const num=Number(draft);
        if(num!==cur){setBudget(k,num).catch(e=>{console.error('[budgets] save failed',k,e);alert('予算の保存に失敗しました');});}
      }else if(cur!==undefined){
        deleteBudget(k).catch(e=>{console.error('[budgets] delete failed',k,e);alert('予算の削除に失敗しました');});
      }
    });
    setShowBudgetModal(false);
  };
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
    // Step B ④: 予算オーバー判定に使うため、書き込み payload を変数に固定。
    // .then 内では setInputAmount("") で state が空になるが、ここでキャプチャしておけば
    // クロージャ経由で確定値として参照できる。transactions も closure 経由で「追加前の値」を使う。
    const txAmount = Number(inputAmount);
    const txDateStr = toDateStr(inputDate);
    const txCatId = inputCategory;
    addExpense({
      date: txDateStr,
      amount: txAmount,
      memo: inputMemo,
      category: txCatId,
      categoryLabel: expenseCats.find(c => c.id === txCatId)?.label ?? null,
      payment: inputPayment,
    })
      .then(() => {
        setInputAmount("");
        setInputMemo("");
        // ★予算オーバートースト 一時非表示中 (2026-05-18) — 復活時は /* */ 解除
        /*
        // 予算オーバートースト判定: 現サイクル内・該当カテゴリに月予算あり・
        // 「ちょうど over に乗る」瞬間 (spentOld < budget && spentNew >= budget) だけ発火。
        // 過去サイクルや無予算カテへの入力ではトースト出さない。
        if (txDateStr < tmCycleStart || txDateStr > tmCycleEnd) return;
        const cat = expenseCats.find(c => c.id === txCatId);
        if (!cat) return;
        const budget = getCatBudget(txCatId);
        if (budget <= 0) return;
        const spentOld = transactions
          .filter(t => t.category === txCatId && t.date >= tmCycleStart && t.date <= tmCycleEnd)
          .reduce((s, t) => s + t.amount, 0);
        const spentNew = spentOld + txAmount;
        if (spentOld < budget && spentNew >= budget) {
          const overAmount = spentNew - budget;
          setBudgetOverToast(`⚠️ ${cat.label} が予算超過\n(¥${overAmount.toLocaleString()} オーバー)`);
          if (budgetOverToastTimer.current) clearTimeout(budgetOverToastTimer.current);
          budgetOverToastTimer.current = setTimeout(() => setBudgetOverToast(null), 3500);
        }
        */
      })
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
      categoryLabel: expenseCats.find(c => c.id === editDraft.category)?.label ?? null,
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
        categoryLabel: expenseCats.find(c => c.id === r.category)?.label ?? null,
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
        const wkKey = `${catBudgetTarget._weekKey}_${catBudgetTarget.id}`;
        if(isInvalid){deleteWeekCatBudget(wkKey).catch(e=>{console.error('[weekCatBudgets] delete failed',wkKey,e);alert('週予算の削除に失敗しました');});}
        else{setWeekCatBudget(wkKey,num).catch(e=>{console.error('[weekCatBudgets] save failed',wkKey,e);alert('週予算の保存に失敗しました');});}
      } else {
        const mKey = monthBudgetKey(catBudgetTarget.id);
        if(isInvalid){deleteBudget(mKey).catch(e=>{console.error('[budgets] delete failed',mKey,e);alert('予算の削除に失敗しました');});}
        else{setBudget(mKey,num).catch(e=>{console.error('[budgets] save failed',mKey,e);alert('予算の保存に失敗しました');});}
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
      weeks.forEach(w=>{
        const key=`${w.weekKey}_${allWeekTarget.id}`;
        const cur=weekCatBudgets[key];
        if(num!==cur){
          setWeekCatBudget(key,num).catch(e=>{console.error('[weekCatBudgets] save failed',key,e);alert('週予算の保存に失敗しました');});
        }
      });
      setAllWeekTarget(null);setAllWeekInput(""); return;
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
    bottomNav:{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,background:NAVY2,borderTop:`1px solid ${BORDER}`,display:"flex",zIndex:100,paddingBottom:"max(8px, calc(env(safe-area-inset-bottom) - 12px))"},
    // 固定ゴールドボタン用:module-level 定数への参照で、毎レンダ同一参照を維持。
    // 実体は FIXED_SUBMIT_STYLE(GPU 合成レイヤー化済み)。
    fixedSubmit: FIXED_SUBMIT_STYLE,
    navBtn:(a)=>({flex:1,display:"flex",flexDirection:"column",alignItems:"center",padding:"10px 0 8px",border:"none",background:"none",cursor:"pointer",color:a?GOLD:TEXT_MUTED,fontSize:10,gap:2,fontWeight:500}),
    typeBtn:(a)=>({flex:1,padding:"3px 16px",border:"none",borderRadius:20,fontWeight:a?600:400,fontSize:10,cursor:"pointer",background:a?GOLD_GRAD:"transparent",color:a?"#0A1628":TEXT_SECONDARY,whiteSpace:"nowrap"}),
    row:{display:"flex",alignItems:"center",padding:"13px 20px",background:CARD_BG,borderBottom:`1px solid ${BORDER}`,boxSizing:"border-box",width:"100%"},
    amountInput:{flex:1,border:"none",fontSize:32,fontWeight:400,background:"transparent",padding:"4px 10px",outline:"none",color:TEXT_PRIMARY,minWidth:0},
    memoInput:{flex:1,border:"none",fontSize:16,background:"transparent",outline:"none",color:TEXT_PRIMARY,fontWeight:400},
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
        {/* Step A ②: 予算オーバーアラート集約サマリー (アラート 0 件なら自動で非表示) */}
        <BudgetAlertSummary alerts={budgetAlerts} />
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
          <input style={{...S.memoInput,fontSize:16,textAlign:"right"}} placeholder="未入力" value={inputMemo} onChange={e=>setInputMemo(e.target.value)}/>
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
    // calMonth は cycle 月 (例: msd=25 で {y:2026,m:4} = 「5月サイクル」=5/25-6/24) を表す。
    // 一方 today.getMonth() は calendar 月。両者の整合判定はカレンダー比較ではなく
    // cycle 比較 (today が属するサイクルと calMonth が指すサイクルの一致) で行う必要がある。
    // 旧コードは today.getMonth() を直接比較していたため、msd≠1 のとき「今週」バッジが
    // 未来サイクルに付くなどの週ズレ表示を起こしていた (renderDaily 側は L962-975 で
    // 既に findCycleOfDate ベースに移行済、こちら側がリファクタを免れていた)。
    const todayCycle = findCycleOfDate(today, managementStartDay);
    const isShowingTodayCycle = (y === todayCycle.year && m === todayCycle.month);
    const currentWeekNum = weekInCycle(today, managementStartDay);

    return (
      <div>
        <div style={{padding:"12px 18px 8px",background:CARD_BG,display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}>
          <span style={{fontWeight:700,fontSize:17,color:TEXT_PRIMARY}}>週間サマリー</span>
          <span style={{width:40}}/>
        </div>
        <div style={S.monthNav}>
          <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m-1);const nm=d.getMonth(),ny=d.getFullYear();const isNowMonth=ny===todayCycle.year&&nm===todayCycle.month;setExpandedWeek(isNowMonth?currentWeekNum:null);return{y:ny,m:nm};});}}>‹</button>
          <span style={{fontWeight:600,fontSize:13,color:TEXT_PRIMARY,whiteSpace:"nowrap"}}>{cycleLabel(y,m,managementStartDay)}</span>
          <button style={S.navArrow} onClick={()=>{setCalMonth(p=>{const d=new Date(p.y,p.m+1);const nm=d.getMonth(),ny=d.getFullYear();const isNowMonth=ny===todayCycle.year&&nm===todayCycle.month;setExpandedWeek(isNowMonth?currentWeekNum:null);return{y:ny,m:nm};});}}>›</button>
        </div>

        <div style={{background:CARD_BG,margin:"8px 0 0",padding:"14px 18px"}}>
          <div style={{fontWeight:400,fontSize:11,marginBottom:12,color:TEXT_SECONDARY}}>週間サマリー（{m+1}月）</div>
          {[...weekSummary].sort((a,b)=>{
            // 今月表示中だけ今週を先頭に、それ以外は第1週から順番
            const isCurrentMonth = isShowingTodayCycle;
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
            const isCurrentMonth = isShowingTodayCycle;
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
    // #11: 当月の固定費合計 = Σ loans ( monthlyAmounts[cycleMonth(m+1)] ?? amount )。
    //   「込み」のとき予算・実績の両方に同額加算 (固定費=確定債務)。残=budget−spent で「分ける」と同値。
    const inclFixed = fixedCostMode === 'incl';
    const fixedCostMonthTotal = loans.reduce((s, l) => {
      const ma = l?.monthlyAmounts;
      const mv = ma ? (ma[m + 1] ?? ma[String(m + 1)]) : null;
      const amt = mv != null ? Number(mv) : (Number(l?.amount) || 0);
      return s + (Number(amt) || 0);
    }, 0);
    const dispBudget = inclFixed ? rBudget + fixedCostMonthTotal : rBudget;
    const dispSpent  = inclFixed ? reportExpense + fixedCostMonthTotal : reportExpense;
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
            {/* ③ progressTab チップタブ (月ナビ↓ ここ ↓SummaryBar):
                予算進捗 (既存 UI 完全維持) / 稼働進捗 (新規、既使用額+週チップ+予測合計) */}
            <div style={{padding:"8px 14px",background:CARD_BG}}>
              <div style={{display:"flex",background:NAVY3,borderRadius:24,padding:2,border:`1px solid ${BORDER}`,width:"100%"}}>
                <button style={S.typeBtn(progressTab==="budget")} onClick={()=>setProgressTab("budget")}>予算進捗</button>
                <button style={S.typeBtn(progressTab==="operation")} onClick={()=>requestFeature(utilizationEnabled, ()=>setProgressTab("operation"))}>稼働進捗{utilizationEnabled?"":" 🔒"}</button>
              </div>
            </div>
            {/* #11: 固定費 込み/分ける トグル (pill型・子タブ枠直下、両タブ共通)。'split'=既定(カテゴリのみ)。
                2026-06-05: fixedCostsEnabled OFF のときは丸ごと非表示 (メニューの「固定費」と整合)。
                2026-06-14: 予算進捗タブ内から両タブ共通スコープへ昇格 (稼働進捗タブにも反映するため)。 */}
            {fixedCostsEnabled && (
            <div style={{padding:"0 14px 8px",background:CARD_BG}}>
              <div style={{display:"inline-flex",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:999,padding:2}}>
                {[["split","固定費分ける"],["incl","固定費込み"]].map(([mode,label])=>{
                  const active=fixedCostMode===mode;
                  return (
                    <button key={mode} onClick={()=>setFixedCostMode(mode)}
                      style={{border:"none",cursor:"pointer",borderRadius:999,padding:"4px 12px",fontSize:11,fontWeight:700,whiteSpace:"nowrap",background:active?GOLD:"transparent",color:active?NAVY:TEXT_SECONDARY}}>{label}</button>
                  );
                })}
              </div>
            </div>
            )}
            {progressTab === "budget" ? (<>
            <SummaryBar spent={dispSpent} budget={dispBudget} remain={dispBudget-dispSpent} labelBudget={inclFixed?"月の予算 (固定費込)":"月の予算"} labelSpent={inclFixed?"月の支出 (固定費込)":"月の支出"} labelRemain="月の残予算"/>

            {/* ★ 円グラフはそのまま維持 */}
            {catBreakdown.length>0&&(
              <div style={{background:CARD_BG,padding:"16px 18px 8px",marginBottom:1}}>
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie
                      data={catBreakdown} cx="50%" cy="50%" innerRadius={50} outerRadius={90} dataKey="value" labelLine={false}
                      label={({cx,cy,midAngle,innerRadius,outerRadius,name,percent,fill,index})=>{
                        const RADIAN=Math.PI/180;
                        const pctInt=Math.round(percent*100);
                        // 中サイズ以上: リング内側に従来どおり重ね描画 (補正対象外)
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
                        // 小サイズ: スライス外縁からリーダーライン → 外側ラベル。
                        // タスクB (2026-06-07): catLabelLayout から事前計算済の finalYOffset / side を取得し、
                        //   小スライス同士の y 衝突を minGap=18px で押し下げて回避する。引き出し線は
                        //   sx,sy (スライス外周) → bx,finalY (押し下げ後の屈曲点) → ex,finalY (水平延長) の
                        //   2 線分で構成。屈曲点 x は元の (outerRadius+8)*cos に合わせ、押し下げで生じた
                        //   オフセットは最初の線分の斜めで吸収。textAnchor は side で振り分け。
                        const cos=Math.cos(-midAngle*RADIAN);
                        const sin=Math.sin(-midAngle*RADIAN);
                        const sx=cx+outerRadius*cos;
                        const sy=cy+outerRadius*sin;
                        const layout=catLabelLayout?.[index];
                        const side=layout?layout.side:(cos>=0?'right':'left');
                        const finalY=layout?(cy+layout.finalYOffset):(cy+(outerRadius+8)*sin);
                        const dirSign=side==='right'?1:-1;
                        const bx=cx+(outerRadius+8)*cos;   // 屈曲点 x (元の natural x、押し下げで y のみ動く)
                        const ex=bx+dirSign*10;             // ラベルアンカー x (さらに水平に 10px 延長)
                        const ey=finalY;
                        const textAnchor=side==='right'?'start':'end';
                        const tx=ex+dirSign*3;
                        const lineColor=fill||TEXT_MUTED;
                        return(
                          <g>
                            <path d={`M${sx},${sy}L${bx},${finalY}L${ex},${ey}`} stroke={lineColor} strokeWidth={1} fill="none" opacity={0.7}/>
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
            </>) : (() => {
              // 「稼働進捗」タブ: 既使用額 + 第1〜4週チップ (multi-select) + 未来支出予定金額。
              // weekBudgets[N-1] = 第N週の全カテゴリ予算 sum (reportMonth ベースで weekCatBudgets を集計)。
              // selectedWeeks (Set<number>) は週番号 1-4 を持つ。空 Set なら futureTotal = reportExpense のみ。
              const weekBudgets = [1,2,3,4].map(N =>
                expenseCats.reduce((s, cat) => s + (weekCatBudgets[`${y}-${m+1}-w${N}_${cat.id}`] || 0), 0)
              );
              const selectedSum = [...selectedWeeks].reduce((s, N) => s + (weekBudgets[N-1] || 0), 0);
              // 2026-06-14: 固定費トグル ON のときは「既使用額」「未来支出予定金額」両方に loans 月額合計を加算。
              // 週別チップ (weekBudgets) は loans の週按分が無いため無改修 (admin MonthSummary 稼働進捗と同方針)。
              const opFixedAdd = inclFixed ? fixedCostMonthTotal : 0;
              const opUsed = reportExpense + opFixedAdd;
              const futureTotal = opUsed + selectedSum;
              const toggleWeek = (N) => {
                setSelectedWeeks(prev => {
                  const next = new Set(prev);
                  if (next.has(N)) next.delete(N); else next.add(N);
                  return next;
                });
              };
              return (
                <div style={{display:"flex",flexDirection:"column",gap:10,padding:"14px 18px",background:CARD_BG}}>
                  {/* ブロック 1: 既使用額 (cycle 範囲の reportExpense + 固定費込みなら loans 月額合計)。 */}
                  <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",border:`1px solid ${BORDER}`}}>
                    <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>既使用額{inclFixed?" (固定費込)":""}</div>
                    <div style={{fontSize:28,fontWeight:700,color:RED}}>
                      ¥{opUsed.toLocaleString()}
                    </div>
                  </div>
                  {/* ブロック 2: 第1〜4週チップ (multi-select、選択時 GOLD 強調、週予算金額併記) */}
                  <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                    {[1,2,3,4].map(N => {
                      const sel = selectedWeeks.has(N);
                      return (
                        <button key={N} onClick={()=>toggleWeek(N)}
                          style={{
                            flex:"1 1 calc(50% - 4px)", minWidth:"calc(50% - 4px)",
                            padding:"10px 12px", borderRadius:12,
                            background: sel ? `${GOLD}33` : NAVY3,
                            border: `1px solid ${sel ? GOLD : BORDER}`,
                            color: sel ? GOLD : TEXT_SECONDARY,
                            cursor:"pointer", textAlign:"left",
                            display:"flex", flexDirection:"column", gap:2,
                          }}>
                          <span style={{fontSize:12,fontWeight:700}}>第{N}週</span>
                          <span style={{fontSize:11,fontWeight:400}}>¥{weekBudgets[N-1].toLocaleString()}</span>
                        </button>
                      );
                    })}
                  </div>
                  {/* ブロック 3: 未来支出予定金額 (= 既使用額 + 選択週予算合計、固定費込みなら既使用額側に加算済) */}
                  <div style={{background:NAVY2,borderRadius:14,padding:"14px 18px",border:`1px solid ${BORDER}`}}>
                    <div style={{fontSize:11,color:TEXT_SECONDARY,marginBottom:4}}>未来支出予定金額{inclFixed?" (固定費込)":""}</div>
                    <div style={{fontSize:28,fontWeight:700,color:GOLD}}>
                      ¥{futureTotal.toLocaleString()}
                    </div>
                    {selectedWeeks.size > 0 && (
                      <div style={{fontSize:10,color:TEXT_MUTED,marginTop:4}}>
                        既使用額{inclFixed?" (固定費込)":""} ¥{opUsed.toLocaleString()} + 選択週予算 ¥{selectedSum.toLocaleString()}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
          </>
        ):(
          <>
            <div style={S.monthNav}>
              <button style={S.navArrow} onClick={()=>setReportYear(y=>y-1)}>‹</button>
              <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{reportYear}年</span>
              <button style={S.navArrow} onClick={()=>setReportYear(y=>y+1)}>›</button>
            </div>
            <div style={{background:CARD_BG,padding:"20px 20px 16px",marginBottom:1}}>
              {/* #4 数字ずれ修正: 「年間合計支出 ¥X 円」standalone 表示を削除。
                  繰越票 (AnnualBudgetViewer) の支出合計 grand cell (snapshot 由来) と
                  ここでの transactions live 合計 (異なる集計) が並んで誤誘導していたため、
                  代表値表示は繰越票側に一本化。AreaChart / 月別バーは温存。 */}
              <div style={{height:200}}>
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
                      type="linear"
                      dataKey="expense"
                      stroke={GOLD}
                      strokeWidth={2.5}
                      fill="url(#goldGrad)"
                      dot={(props)=>{
                        const {cx,cy,payload,index}=props;
                        const isCurrentMonth = payload.month===(today.getMonth()+1)&&payload.year===today.getFullYear();
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
                const isCurrentMonth = d.month===(today.getMonth()+1)&&d.year===today.getFullYear();
                // その月の総予算を計算
                const monthBudget = expenseCats.reduce((total,cat)=>{
                  const directBudget = budgets[`${d.year}-${d.month}-${cat.id}`] || 0;
                  const weeklyBudgetSum = [1,2,3,4].reduce((s,wn)=>s+(weekCatBudgets[`${d.year}-${d.month}-w${wn}_${cat.id}`]||0),0);
                  return total + (directBudget>0 ? directBudget : weeklyBudgetSum);
                }, 0);
                const isOver = monthBudget>0 && d.expense>monthBudget;
                const hasExpense = d.expense>0;
                const amountColor = !hasExpense ? TEXT_MUTED : isOver ? RED : "#2196F3";
                const barColor = isCurrentMonth ? GOLD : isOver ? RED : "#2196F3";
                return(
                  <div key={i} style={{display:"flex",alignItems:"center",padding:"10px 20px",borderBottom:`1px solid ${BORDER}`,background:isCurrentMonth?`${GOLD}0A`:CARD_BG}}>
                    <span style={{fontSize:13,fontWeight:isCurrentMonth?700:400,color:isCurrentMonth?GOLD:TEXT_PRIMARY,minWidth:40}}>{d.name}</span>
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
        <div style={{padding:"14px 18px 8px",background:CARD_BG,display:"flex",alignItems:"center",justifyContent:"space-between"}}><span style={{width:32}}></span><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>予算</span><button onClick={()=>requestEdit(openBudgetModal)} style={{background:"none",border:"none",fontSize:20,color:ORANGE,cursor:"pointer"}}>⚙️</button></div>
        {budgetAlerts.length>0&&(<div style={{margin:"0 18px 12px",background:budgetAlerts.some(a=>a.level==="over")?`${RED}15`:`${GOLD}15`,borderRadius:12,padding:"12px 14px"}}><div style={{fontWeight:700,fontSize:13,marginBottom:8,color:budgetAlerts.some(a=>a.level==="over")?RED:GOLD}}>{budgetAlerts.some(a=>a.level==="over")?"🚨 予算オーバー":"⚠️ 予算80%超え"}</div>{budgetAlerts.map((a,i)=>(<div key={i} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}><CatSvgIcon cat={a.cat} size={18}/><span style={{flex:1,fontSize:12,fontWeight:600}}>{a.cat.label}</span><span style={{fontSize:11,color:"#888"}}>{a.spent.toLocaleString()} / {a.budget.toLocaleString()}円</span><span style={{fontSize:11,fontWeight:700,color:a.level==="over"?RED:"#E65100",background:a.level==="over"?"#FFCDD2":"#FFE0B2",borderRadius:8,padding:"2px 6px"}}>{Math.round(a.pct)}%</span></div>))}</div>)}
        <div style={S.monthNav}><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m-1);return{y:d.getFullYear(),m:d.getMonth()};})}>‹</button><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>{fmtMonth(y,m)}</span><button style={S.navArrow} onClick={()=>setBudgetMonth(p=>{const d=new Date(p.y,p.m+1);return{y:d.getFullYear(),m:d.getMonth()};})}>›</button></div>
        <SummaryBar spent={totalSpending} budget={totalBudget} remain={totalBudget-totalSpending} onBudgetTap={()=>requestEdit(openBudgetModal)}/>
        {totalBudget>0&&<div style={{padding:"0 18px 12px",background:CARD_BG}}><div style={{height:6,background:"rgba(255,255,255,0.08)",borderRadius:4,overflow:"hidden",marginTop:8}}><div style={{height:"100%",width:`${Math.min(100,totalSpending/totalBudget*100)}%`,background:totalSpending>totalBudget?RED:GOLD,borderRadius:4}}/></div></div>}
        <div style={{background:CARD_BG}}>
          {expenseCats.map(cat=>{
            const budget=getBudget(cat.id);const spent=catSpending(cat.id);const pctRaw=budget?Math.round(spent/budget*100):0;const pct=Math.min(100,pctRaw);const isOver=budget&&spent>budget;const isWarn=budget&&pct>=80&&!isOver;
            return(
              <div key={cat.id} onClick={()=>requestEdit(()=>{setCatBudgetTarget({...cat,_isWeek:false});setCatBudgetInput(budget?String(budget):"");setShowCatBudgetModal(true);})} style={{borderBottom:`1px solid ${BORDER}`,background:isOver?`${RED}11`:isWarn?`${GOLD}11`:CARD_BG,cursor:"pointer"}}>
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
              <input value={newCatName} onChange={e=>setNewCatName(e.target.value)} placeholder="項目名を入力してください" style={{flex:1,border:"none",fontSize:16,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
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
          <div onClick={()=>{ if(expenseCats.length>=9 && !categoryAddEnabled){ showFeatureLockedToast(); return; } setMenuScreen("catNew"); }} style={{...S.listItem,color:ORANGE,fontWeight:600}}><span>＋</span><span style={{flex:1}}>新規カテゴリーの追加</span><span style={{color:"#bbb"}}>›</span></div>
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
              <input value={editName} onChange={e=>setEditName(e.target.value)} style={{flex:1,border:"none",fontSize:16,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
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
          <div onClick={()=>requestEdit(()=>{const cardPms=paymentMethods.filter(p=>p.id!=="cash");if(cardLimit!=null && cardPms.length>=cardLimit){showFeatureLockedToast();return;}setPaymentDraft({label:"",color:"#4CAF50",closingDay:"",withdrawalDay:""});setEditingPaymentId(null);setMenuScreen("paymentNew");})} style={{...S.listItem,color:ORANGE,fontWeight:600}}>
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
              reorderPaymentMethods(arrayMove(paymentMethods, oldIndex, newIndex)).catch(e => { console.error('[paymentMethods] reorder failed', e); alert('並び替えに失敗しました'); });
            }}
          >
            <SortableContext items={paymentMethods.map((pm) => pm.id)} strategy={verticalListSortingStrategy}>
              {paymentMethods.map((pm) => (
                <SortablePaymentRow
                  key={pm.id}
                  pm={pm}
                  onEdit={(p) => requestEdit(() => {
                    setPaymentDraft({ label: p.label, color: p.color, closingDay: p.closingDay || "", withdrawalDay: p.withdrawalDay || "", bank: p.bank || "" });
                    setEditingPaymentId(p.id);
                    setMenuScreen("paymentNew");
                  })}
                  onRemove={(id) => requestEdit(() => { deletePaymentMethod(id).catch(e => { console.error('[paymentMethods] delete failed', id, e); alert('決済手段の削除に失敗しました'); }); })}
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
                <input value={paymentDraft.label} onChange={e=>setPaymentDraft(p=>({...p,label:e.target.value}))} placeholder="例：楽天カード" style={{flex:1,border:"none",fontSize:16,outline:"none",color:TEXT_PRIMARY,background:"transparent"}}/>
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
                <input value={paymentDraft.bank||""} onChange={e=>setPaymentDraft(p=>({...p,bank:e.target.value}))} placeholder="例：三菱UFJ銀行" style={{flex:1,border:"none",background:"transparent",fontSize:16,outline:"none",color:TEXT_PRIMARY,textAlign:"right"}}/>
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
            <button onClick={()=>{if(!paymentDraft.label.trim())return;const patch={label:paymentDraft.label,color:paymentDraft.color,closingDay:paymentDraft.closingDay,withdrawalDay:paymentDraft.withdrawalDay,bank:paymentDraft.bank};if(isEdit){updatePaymentMethod(editingPaymentId,patch).catch(e=>{console.error('[paymentMethods] update failed',editingPaymentId,e);alert('決済手段の更新に失敗しました');});}else{createPaymentMethod({id:`pm_${Date.now()}`,...patch}).catch(e=>{console.error('[paymentMethods] create failed',e);alert('決済手段の追加に失敗しました');});}setMenuScreen("paymentEdit");}} style={{display:"block",width:"100%",padding:"16px",background:paymentDraft.label.trim()?ORANGE:"#eee",color:paymentDraft.label.trim()?"#fff":"#aaa",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}>保存</button>
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
      const copyLastMonth=()=>{
        weeks.forEach(w=>{
          expenseCats.forEach(cat=>{
            const prevKey=`${prevY}-${prevM+1}-w${w.weekNum}_${cat.id}`;
            const thisKey=`${w.weekKey}_${cat.id}`;
            const prevVal=weekCatBudgets[prevKey];
            if(prevVal==null) return;
            const cur=weekCatBudgets[thisKey];
            if(prevVal!==cur){
              setWeekCatBudget(thisKey,prevVal).catch(e=>{console.error('[weekCatBudgets] save failed',thisKey,e);alert('週予算の保存に失敗しました');});
            }
          });
        });
      };
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>週予算設定</span>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>requestEdit(()=>setShowCopyConfirm(true))} style={{background:"none",border:`1px solid ${GOLD}44`,color:GOLD,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",borderRadius:8}}>先月と同一</button>
              <button onClick={()=>requestEdit(()=>setShowClearConfirm(true))} style={{background:"none",border:`1px solid ${RED}44`,color:RED,fontSize:11,fontWeight:600,cursor:"pointer",padding:"4px 8px",borderRadius:8}}>全消去</button>
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
                  <button onClick={()=>requestEdit(()=>{setAllWeekTarget(cat);setAllWeekInput("");})} style={{display:"flex",alignItems:"center",gap:6,padding:"8px 8px",background:CARD_BG,border:`1px solid ${BORDER}`,borderRadius:8,cursor:"pointer",textAlign:"left"}}>
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
                      onClick={()=>requestEdit(()=>{setCatBudgetTarget({...cat,_weekKey:w.weekKey,_isWeek:true});setCatBudgetInput(hasVal?String(val):"");setShowCatBudgetModal(true);})}
                      onContextMenu={e=>{e.preventDefault();if(hasVal)requestEdit(()=>{deleteWeekCatBudget(key).catch(err=>{console.error('[weekCatBudgets] delete failed',key,err);alert('週予算の削除に失敗しました');});});}}
                      onTouchStart={()=>{if(hasVal){longPressTimer.current=setTimeout(()=>requestEdit(()=>{deleteWeekCatBudget(key).catch(err=>{console.error('[weekCatBudgets] delete failed',key,err);alert('週予算の削除に失敗しました');});}),700);}}}
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
              {/* 週合計フッター行:各週の縦列合計 (= その週の全カテゴリ予算合計)。
                  既存の月合計列 (右端) と対称な位置づけで、本部スタッフが
                  「この週の予算枠は何円か」を一目で把握できるようにする。
                  NAVY3 背景 + GOLD66 border + GOLD 文字で合計行であることを強調。
                  右端セルは grand total (= 月予算総額)、左の月合計列の総和と同値。 */}
              {(() => {
                const weekTotals = weeks.map(w =>
                  expenseCats.reduce((s, cat) => s + (weekCatBudgets[`${w.weekKey}_${cat.id}`] ?? 0), 0)
                );
                const grandTotal = weekTotals.reduce((s, v) => s + v, 0);
                const anyWeekHasBudget = expenseCats.some(cat =>
                  weeks.some(w => weekCatBudgets[`${w.weekKey}_${cat.id}`] != null)
                );
                return (
                  <div style={{display:"grid",gridTemplateColumns:`90px repeat(${weeks.length},1fr) 56px`,gap:4,marginBottom:4}}>
                    {/* 左端:"週合計" ラベル */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"center",padding:"8px 4px",background:NAVY3,border:`1px solid ${GOLD}66`,borderRadius:8}}>
                      <span style={{fontSize:10,fontWeight:700,color:GOLD}}>週合計</span>
                    </div>
                    {/* 各週の縦合計 */}
                    {weeks.map((w, i) => {
                      const total = weekTotals[i];
                      const hasAny = expenseCats.some(cat => weekCatBudgets[`${w.weekKey}_${cat.id}`] != null);
                      return (
                        <div key={w.weekKey} style={{padding:"8px 4px",textAlign:"center",background:NAVY3,border:`1px solid ${GOLD}66`,borderRadius:8}}>
                          <div style={{fontSize:10,fontWeight:700,color:hasAny?GOLD:TEXT_MUTED}}>{hasAny?total.toLocaleString():"-"}</div>
                          {hasAny&&<div style={{fontSize:8,color:TEXT_MUTED}}>円</div>}
                        </div>
                      );
                    })}
                    {/* 右端:grand total (月予算総額の参考表示、左の月合計列の総和と同値) */}
                    <div style={{padding:"8px 4px",textAlign:"center",background:NAVY3,border:`1px solid ${GOLD}66`,borderRadius:8}}>
                      <div style={{fontSize:10,fontWeight:700,color:anyWeekHasBudget?GOLD:TEXT_MUTED}}>{anyWeekHasBudget?grandTotal.toLocaleString():"-"}</div>
                      {anyWeekHasBudget&&<div style={{fontSize:8,color:TEXT_MUTED}}>円</div>}
                    </div>
                  </div>
                );
              })()}
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
          {showClearConfirm&&(<div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{background:NAVY2,borderRadius:20,padding:"28px 24px",margin:"0 24px",border:`1px solid ${BORDER}`,width:"100%"}}><div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:24,marginBottom:10}}>🗑️</div><div style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY,marginBottom:8}}>予算を全て削除</div></div><div style={{display:"flex",gap:10}}><button onClick={()=>{weeks.forEach(w=>{expenseCats.forEach(cat=>{const key=`${w.weekKey}_${cat.id}`;if(weekCatBudgets[key]!==undefined){deleteWeekCatBudget(key).catch(e=>{console.error('[weekCatBudgets] delete failed',key,e);alert('週予算の削除に失敗しました');});}});});setShowClearConfirm(false);}} style={{flex:1,padding:"14px",background:`${RED}22`,border:`1px solid ${RED}44`,borderRadius:14,fontSize:15,fontWeight:700,color:RED,cursor:"pointer"}}>はい</button><button onClick={()=>setShowClearConfirm(false)} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${BORDER}`,borderRadius:14,fontSize:15,fontWeight:600,color:TEXT_SECONDARY,cursor:"pointer"}}>いいえ</button></div></div></div>)}
          {showCopyConfirm&&(<div style={{position:"fixed",top:0,left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,height:"100dvh",background:"rgba(0,0,0,0.7)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}><div style={{background:NAVY2,borderRadius:20,padding:"28px 24px",margin:"0 24px",border:`1px solid ${BORDER}`,width:"100%"}}><div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:24,marginBottom:10}}>📋</div><div style={{fontSize:16,fontWeight:700,color:TEXT_PRIMARY,marginBottom:8}}>先月と同じ予算を設定</div></div><div style={{display:"flex",gap:10}}><button onClick={()=>{copyLastMonth();setShowCopyConfirm(false);}} style={{flex:1,padding:"14px",background:GOLD_GRAD,border:"none",borderRadius:14,fontSize:15,fontWeight:700,color:"#0A1628",cursor:"pointer"}}>はい</button><button onClick={()=>setShowCopyConfirm(false)} style={{flex:1,padding:"14px",background:"none",border:`1px solid ${BORDER}`,borderRadius:14,fontSize:15,fontWeight:600,color:TEXT_SECONDARY,cursor:"pointer"}}>いいえ</button></div></div></div>)}
          <div style={{height:20}}/>
        </div>
      );
    }

    if (menuScreen === "appointment") {
      return <AppointmentCard onBack={() => setMenuScreen("main")} />;
    }

    // Phase B-3 (2026-06-07): 資産残高繰越票 — AssetSheetViewer に差替。
    //   旧 placeholder ブロックは Viewer 内 StatusCard に統合 (準備中ゲートは Viewer 側で判定)。
    //   外側のヘッダ (戻るボタン + タイトル) は維持し、本文に Viewer を差し込む。
    if (menuScreen === "assetSheet") {
      return (
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer"}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>資産残高繰越票</span>
            <span style={{width:40}}/>
          </div>
          <div style={{padding:"12px 12px"}}>
            <AssetSheetViewer clientId={authUserId} />
          </div>
        </div>
      );
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
                <textarea value={contactText} onChange={e=>setContactText(e.target.value)} placeholder="詳細をご記入ください..." style={{width:"100%",minHeight:140,background:"transparent",border:"none",borderTop:`1px solid ${BORDER}`,padding:"12px 16px",fontSize:16,color:TEXT_PRIMARY,outline:"none",resize:"none",boxSizing:"border-box"}}/>
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
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>🔁 固定費</span>
            <button onClick={()=>{setLoanDraft({label:"",amount:"",bank:"",withdrawalDay:"",pmId:""});setEditingLoanId(null);setShowLoanForm(true);}} style={{background:"none",border:`1px solid ${GOLD}`,borderRadius:20,padding:"4px 12px",color:GOLD,fontSize:12,fontWeight:700,cursor:"pointer"}}>＋追加</button>
          </div>
          <div style={{padding:"12px 16px",fontSize:10,color:TEXT_MUTED,lineHeight:1.6}}>💡 家賃・ローン・保険など毎月の固定費を登録しておくと、月次サマリーで合算して表示できます。</div>
          <div style={{padding:"0 16px"}}>
            {loans.length===0?(
              <div style={{textAlign:"center",padding:"40px 20px",color:TEXT_MUTED}}>
                <div style={{fontSize:32,marginBottom:8}}>🏠</div>
                <div style={{fontSize:13}}>登録された固定費がありません</div>
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
      // #2+#3: 月次レポートを「ダイヤル付き1画面」に統合。表示月は mrMonth (state)。
      //   予算タブは年度ビューで月非依存のため、画面ヘッダは月を出さず「レポート」固定。
      //   月見出し/選択は月次レビュー側 (ダイヤル) に持たせる。
      return(
        <div style={{minHeight:"100dvh",background:NAVY}}>
          <div style={S.overlayHeader}>
            <button onClick={()=>setMenuScreen("main")} style={{background:"none",border:"none",color:GOLD,fontSize:20,cursor:"pointer",fontWeight:300}}>‹</button>
            <span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>レポート</span>
            <span style={{width:40}}/>
          </div>
          {/* B-2: landscape では月次レビューを 430px 枠の外へ拡幅 (maxWidth:"none")。
              他 overlay (S.overlay) は触らず、この wrapper だけ広げて月次レビュー本体に余白を渡す。 */}
          <div style={isLandscape
            ? {margin:"8px 16px 0", maxWidth:"none"}
            : {margin:"16px 16px 0"}}>
            <ReportTabs
              viewer={<AnnualBudgetViewer clientId={authUserId} />}
              review={(
                <div>
                  {/* A/B: コンパクトなチップ + タップでダイヤル展開 (月次レビュー本体をメインに) */}
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                    <span style={{fontSize:10,color:TEXT_MUTED,fontWeight:700}}>表示月</span>
                    <MonthPopoverDial months={mrMonths} value={mrMonth} onChange={setMrMonth} />
                  </div>
                  <MonthlyReviewViewer clientId={authUserId} year={mrMonth.y} month={mrMonth.m} />
                </div>
              )}
              recovery={<InvestmentRecoveryViewer clientId={authUserId} />}
            />
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
              // タスクG (2026-06-08): 名前/メール/電話 は uncontrolled stub で保存処理もないため削除。
              //   報酬日・管理スタート日のみ残す。else 分岐の素 <input> (L2664付近) は dead code 化するが今回は無改修。
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
                    <span
                      style={{position:"relative",display:"inline-block"}}
                      onClick={() => rewardDayPickerRef.current?.showPicker?.()}
                    >
                      <span style={{display:"inline-flex",alignItems:"center",padding:"4px 10px",background:"transparent",border:`1px dashed ${GOLD}88`,borderRadius:14,fontSize:12,fontWeight:600,color:GOLD,whiteSpace:"nowrap",cursor:"pointer"}}>＋ 追加</span>
                      {/* 透明な date input。macOS Chrome/Safari では opacity:0 overlay への click が
                          picker を発火しないため、親 span の onClick から showPicker() を明示呼出する。 */}
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
                    <span
                      style={{position:"relative",display:"inline-block"}}
                      onClick={() => msdPickerRef.current?.showPicker?.()}
                    >
                      <span style={{
                        display:"inline-flex",alignItems:"center",
                        padding:"4px 10px",
                        background: managementStartDayDraft ? NAVY3 : "transparent",
                        border: `1px ${managementStartDayDraft ? "solid" : "dashed"} ${GOLD}${managementStartDayDraft ? "55" : "88"}`,
                        borderRadius:14,fontSize:12,fontWeight:600,color:GOLD,whiteSpace:"nowrap",cursor:"pointer",
                      }}>{managementStartDayDraft ? `${managementStartDayDraft}日` : "＋ 設定"}</span>
                      {/* 透明な date input。macOS Chrome/Safari では opacity:0 overlay への click が
                          picker を発火しないため、親 span の onClick から showPicker() を明示呼出する。
                          選択 → date.getDate() を draft state にセット(年月は無視、「日」のみ意味あり)。
                          値クリア(e.target.value = "")で同じ日を再選択しても onChange を再発火させる。 */}
                      <input
                        ref={msdPickerRef}
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
                  <input type={field.type} placeholder={field.placeholder} style={{flex:1,border:"none",background:"transparent",fontSize:16,outline:"none",color:TEXT_PRIMARY,textAlign:"right"}}/>
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
              onClick={async () => {
                setManagementStartDay(managementStartDayDraft);
                setManagementStartDayCommitTick(t => t + 1);
                setAccountSavedFlash(true);
                setTimeout(() => setAccountSavedFlash(false), 2000);
                // B-1: profiles.management_start_day を Supabase にも upsert。
                // localStorage の即時反映は維持しつつ、admin 側からも各顧客の msd を
                // 読めるようにする (RLS profiles_self_update policy 経由)。
                // ネットワーク失敗は console.error のみで UX 阻害しない (eventually consistent)。
                if (authUserId) {
                  try {
                    const v = getManagementStartDay();  // 正規化済 (1-31 or null)
                    const { error } = await supabase
                      .from('profiles')
                      .update({ management_start_day: v })
                      .eq('id', authUserId);
                    if (error) console.error('[msd-sync] profile update failed', error);
                  } catch (e) {
                    console.error('[msd-sync] profile update exception', e);
                  }
                }
              }}
              style={{width:"100%",padding:"14px",background:GOLD_GRAD,border:"none",borderRadius:12,fontSize:14,fontWeight:700,color:"#0A1628",cursor:"pointer"}}
            >{accountSavedFlash ? "保存しました" : "保存"}</button>
          </div>
          <LogoutButton />
          <div style={{height:20}}/>
        </div>
      );
    }

    // #2+#3: monthlyReport (月リスト) / report_{y}_{m} (個別月) は currentMonthReport の
    //   ダイヤル統合により廃止。導線は currentMonthReport に向け直し済 (下の menuGroups)。

    const menuGroups=[[
      {icon:"📊",label:"レポート"+(reportEnabled?"":" 🔒"),action:()=>requestFeature(reportEnabled, ()=>setMenuScreen("currentMonthReport"))},
      {icon:"📈",label:"資産残高繰越票"+(assetSheetEnabled?"":" 🔒"),action:()=>requestFeature(assetSheetEnabled, ()=>setMenuScreen("assetSheet"), '本機能は、追加プランをご契約いただくことでご利用いただけます。')},
      {icon:"🤝",label:"面談予定"+(meetingEnabled?"":" 🔒"),subLabel:(meetingEnabled && nextAppointment) ? fmtDateTime(nextAppointment.scheduledAt) : '',action:()=>requestFeature(meetingEnabled, ()=>setMenuScreen("appointment"))},
    ]];
    const settingsGroups=[[{icon:"📅",label:"週予算設定",action:()=>setMenuScreen("weekBudgetSetting")},{icon:"🎨",label:"カテゴリーアイコン設定",action:()=>setMenuScreen("catEdit")},{icon:"💳",label:"支払い方法 追加編集",action:()=>setMenuScreen("paymentEdit")},{icon:"🔁",label:"固定費"+(fixedCostsEnabled?"":" 🔒"),action:()=>requestFeature(fixedCostsEnabled, ()=>setMenuScreen("loanSetting"))}],[{icon:"👤",label:"アカウント設定",action:()=>setMenuScreen("accountSetting")},{icon:"✉️",label:"お問い合わせ",action:()=>setMenuScreen("contact")}]];

    return(
      <div>
        <div style={{padding:"14px 18px",background:NAVY2,display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:`1px solid ${BORDER}`}}><span style={{fontWeight:600,fontSize:15,color:TEXT_PRIMARY}}>メニュー</span></div>
        {menuGroups.map((group,gi)=>(
          <div key={gi} style={{background:CARD_BG,borderRadius:12,margin:"12px 16px 0",overflow:"hidden"}}>
            {group.map((item,i)=>(<div key={i} onClick={item.action} style={{...S.menuItem,borderBottom:i<group.length-1?`1px solid ${BORDER}`:"none"}}><span style={{fontSize:18,color:GOLD}}>{item.icon}</span><span style={{flex:1,fontSize:13,fontWeight:500,color:TEXT_PRIMARY}}>{item.label}</span>{item.subLabel?<span style={{fontSize:12,color:TEXT_MUTED,marginRight:8,whiteSpace:"nowrap"}}>{item.subLabel}</span>:null}<span style={{color:TEXT_MUTED}}>›</span></div>))}
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
          <div onClick={()=>{ if(COMPANY_HP_URL) window.open(COMPANY_HP_URL,"_blank"); }} style={{display:"flex",alignItems:"center",gap:10,padding:"13px 16px",borderBottom:`1px solid ${BORDER}`,cursor:"pointer"}}>
            <div style={{width:26,height:26,borderRadius:7,background:"rgba(123,108,246,0.2)",border:"1px solid rgba(123,108,246,0.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>📋</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:600,color:TEXT_PRIMARY}}>会社HP</div>
            </div>
            <span style={{fontSize:13,color:TEXT_MUTED}}>›</span>
          </div>
          <div onClick={()=>{ if(COMPANY_PDF_URL) window.open(COMPANY_PDF_URL,"_blank"); }} style={{display:"flex",alignItems:"center",gap:10,padding:"13px 16px",cursor:"pointer"}}>
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
    // タスク㉕ (2026-06-03): 横画面 × レポート画面 (tab="menu" && menuScreen="currentMonthReport")
    //   のときだけ .app の maxWidth を 430→1100 に上書き。レビュー/投資回収の本文が親 430 で
    //   頭打ちになる真因を、.app 自体を局所拡大することで解消。
    //   - S.app の他プロパティ (margin:"0 auto", overflowX:"hidden", display/flex/height/background)
    //     は spread で完全維持。maxWidth だけ条件付き上書き。
    //   - bottomNav は L957 で独自に position:"fixed" + maxWidth:430 を持つため .app 拡大の影響なし
    //     (引き続き 430 中央維持)。
    //   - 縦画面・他画面 (入力/カレンダー/他メニュー) は else 側で従来どおり S.app (430)。
    //   - 繰越票は AnnualBudgetViewer L1391 の position:fixed 全画面化で .app 幅と無関係、不変。
    <div style={(isLandscape && tab === "menu" && menuScreen === "currentMonthReport")
      ? { ...S.app, maxWidth: 1100 }
      : S.app}>
      {/* Phase E: 顧客側編集ロック中トースト。requestEdit() ロック分岐で発火、3.5s 自動消滅。
          telop / その他 fixed 要素より大きい z-index (10000) で前面に表示。 */}
      {editLockedToast && (
        <div style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "rgba(13,30,54,0.96)",
          color: "#D4A843",
          padding: "20px 28px",
          borderRadius: 14,
          border: "1px solid rgba(212,168,67,0.4)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          zIndex: 10000,
          fontSize: 14,
          lineHeight: 1.7,
          maxWidth: "min(360px, 86vw)",
          textAlign: "center",
          pointerEvents: "none",
        }}>
          💼 予算・カテゴリ・お支払い方法の<br/>
          管理は本部で承っております
        </div>
      )}
      {/* 2026-06-05: 機能ゲート用トースト。editLockedToast と同形 (中央 fixed・z-index 10000・3.5s)。
          driven は featureLockedToast (string)、文言は PLAN_GATE_MSG を表示。 */}
      {featureLockedToast && (
        <div style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "rgba(13,30,54,0.96)",
          color: "#D4A843",
          padding: "20px 28px",
          borderRadius: 14,
          border: "1px solid rgba(212,168,67,0.4)",
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          zIndex: 10000,
          fontSize: 14,
          lineHeight: 1.7,
          maxWidth: "min(360px, 86vw)",
          textAlign: "center",
          pointerEvents: "none",
        }}>
          {featureLockedToast}
        </div>
      )}
      {/* Step B ④: 予算オーバートースト。addTransaction 成功時、当該カテゴリが
          ちょうど予算超過に乗った瞬間だけ発火。editLockedToast と同じ中央 fixed・
          z-index 10000・pointer-events:none・3.5s 自動消滅。配色のみ RED 系。 */}
      {budgetOverToast && (
        <div style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          background: "rgba(13,30,54,0.96)",
          color: RED,
          padding: "20px 28px",
          borderRadius: 14,
          border: `1px solid ${RED}66`,
          boxShadow: "0 12px 40px rgba(0,0,0,0.6)",
          zIndex: 10000,
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1.7,
          maxWidth: "min(360px, 86vw)",
          textAlign: "center",
          pointerEvents: "none",
          whiteSpace: "pre-line",
        }}>
          {budgetOverToast}
        </div>
      )}
      <div style={{position:"fixed",top:0,left:"50%",transform:`translateX(-50%) translateY(${showTelop?0:"-100%"})`,width:"100%",maxWidth:430,zIndex:200,background:`linear-gradient(90deg,${NAVY},#0D1E36,${NAVY})`,borderBottom:`1px solid ${GOLD}44`,height:24,paddingTop:"env(safe-area-inset-top)",boxSizing:"content-box",overflow:"hidden",display:"flex",alignItems:"center",transition:"transform 0.3s ease",cursor:"pointer"}} onTouchStart={e=>{e._startY=e.touches[0].clientY;}} onTouchEnd={e=>{if(e._startY-e.changedTouches[0].clientY>20)setShowTelop(false);}}>
        <style>{`@keyframes telop{0%{transform:translateX(100%);}100%{transform:translateX(-100%);}} .telop-text{animation:telop 28s linear infinite;white-space:nowrap;display:inline-block;}`}</style>
        <span className="telop-text" style={{fontSize:10,fontWeight:500,color:GOLD,letterSpacing:"0.05em",paddingLeft:"100%"}}>{telopText}</span>
      </div>
      {!showTelop&&<div onClick={()=>setShowTelop(true)} style={{position:"fixed",top:"env(safe-area-inset-top)",left:"50%",transform:"translateX(-50%)",width:"100%",maxWidth:430,zIndex:200,height:8,background:`${GOLD}33`,cursor:"pointer",borderBottom:`1px solid ${GOLD}22`}}/>}

      {/* タスク#3 (2026-06-03): 入力タブ「支出を入力する」NAVY2 footer 帯とナビバー上端の隙間を
          ~10px に詰める。
          - 旧式 "62 + safe + 8" は safe を生で加算するため、nav 側 (paddingBottom: max(8, safe-12))
            と safe 消費が乖離し、iPhone (safe=34px) で実隙間 ~27px に開いていた。
          - 新式 "65 + max(8, safe-12)" は nav 構造をそのままミラー (54 button + 1 borderTop + 10 呼吸)
            に合わせ、safe 値によらず実隙間が常に ~10px に揃う (iPhone=10、Desktop=10)。
          - iOS Safari ジッタ回避方針 (L120-144 のコメント参照) は維持: position:fixed/env() 上書き
            は使わず、CSS max() で safe 消費のみ揃える。FIXED_SUBMIT_STYLE は無改変。
          - tab !== "daily" の時は旧式を残す: 他タブには「支出を入力する」帯が無く、隙間詰めは
            不要 + ユーザー指示「他タブに影響させない」順守。 */}
      <div style={{...S.main,paddingTop:showTelop?24:8,paddingBottom: tab === "daily" ? "calc(57px + max(8px, env(safe-area-inset-bottom) - 12px))" : "calc(62px + env(safe-area-inset-bottom) + 8px)"}}>
        {tab==="daily"&&renderDaily()}
        {tab==="day"&&renderDayView()}
        {tab==="weekly"&&renderWeekly()}
        {tab==="monthly"&&renderMonthly()}
        {tab==="menu"&&renderMenu()}
      </div>

      {/* Step A ③: メニュータブの icon 右上に over 連動の赤dot。over なしなら表示なし。 */}
      <div style={S.bottomNav}>{tabs.map(t=>{const showOverDot=t.id==="menu"&&budgetAlerts.some(a=>a.level==="over");return(<button key={t.id} style={S.navBtn(tab===t.id)} onClick={()=>{setTab(t.id);if(t.id!=="menu")setMenuScreen("main");}}><span style={{fontSize:18,position:"relative",display:"inline-block",lineHeight:1}}>{t.icon}{showOverDot&&<span style={{position:"absolute",top:-2,right:-4,width:8,height:8,borderRadius:"50%",background:RED,boxShadow:`0 0 0 1.5px ${NAVY2}`}}/>}</span><span>{t.label}</span></button>);})}</div>

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
                        <div style={{fontSize:10,color:TEXT_MUTED,marginTop:4}}>カードの引き落とし日・銀行を設定するか<br/>固定費を追加してください</div>
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
                                  <div style={{fontSize:10,color:TEXT_MUTED,marginTop:2}}>{item.type==="loan"?"🔁 固定費":"💳 カード"} ／ {item.day==="－"?"引落日未設定":`毎月${item.day}${item.day!=="末"?"日":""}引き落とし`}</div>
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
      {showSearch&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>{setShowSearch(false);setSearchQuery("");}} style={{background:"none",border:"none",color:ORANGE,fontSize:14,cursor:"pointer"}}>‹</button><span style={{fontWeight:700,fontSize:15}}>検索（全期間）</span><span style={{width:60}}></span></div><div style={{padding:"12px 18px",background:CARD_BG}}><div style={{display:"flex",alignItems:"center",background:NAVY3,borderRadius:10,padding:"8px 14px",gap:8}}><span>🔍</span><input autoFocus value={searchQuery} onChange={e=>setSearchQuery(e.target.value)} placeholder="検索" style={{flex:1,border:"none",background:"transparent",fontSize:16,outline:"none",color:TEXT_PRIMARY}}/></div></div><div style={{textAlign:"center",padding:"12px 18px",background:CARD_BG,borderBottom:`1px solid ${BORDER}`}}><div style={{fontSize:11,color:TEXT_SECONDARY}}>支出合計</div><div style={{fontSize:18,fontWeight:400,color:RED}}>{searchResults.reduce((s,t)=>s+t.amount,0).toLocaleString()}円</div></div><div style={{flex:1,overflowY:"auto"}}>{[...searchResults].reverse().map(t=><TxItem key={t.id} t={t}/>)}{searchResults.length===0&&<div style={{textAlign:"center",padding:"40px",color:"#aaa"}}>取引が見つかりません</div>}</div></div>)}

      {/* 編集モーダル */}
      {showEditModal&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>setShowEditModal(false)} style={{background:"none",border:"none",fontSize:20,color:TEXT_SECONDARY,cursor:"pointer"}}>✕</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>取引を編集</span><button onClick={saveEditTx} style={{background:"none",border:"none",color:ORANGE,fontSize:16,fontWeight:700,cursor:"pointer"}}>保存</button></div><div style={{flex:1,overflowY:"auto"}}><div style={S.row}><span style={{color:TEXT_SECONDARY,fontSize:11,marginRight:12,minWidth:40}}>日付</span><input type="date" value={editDraft.date} onChange={e=>setEditDraft(p=>({...p,date:e.target.value}))} style={{flex:1,border:`1px solid ${BORDER}`,borderRadius:8,padding:"8px 12px",fontSize:16,outline:"none",background:NAVY3,color:TEXT_PRIMARY}}/></div><div style={S.row}><span style={{color:"#888",fontSize:13,marginRight:12,minWidth:40}}>金額</span><input type="number" value={editDraft.amount} onChange={e=>setEditDraft(p=>({...p,amount:e.target.value}))} style={S.amountInput}/><span style={{marginLeft:6,fontSize:13,color:TEXT_SECONDARY}}>円</span></div><div style={S.row}><span style={{color:TEXT_SECONDARY,fontSize:11,marginRight:12,minWidth:40}}>メモ</span><input value={editDraft.memo||""} onChange={e=>setEditDraft(p=>({...p,memo:e.target.value}))} placeholder="未入力" style={S.memoInput}/></div><div style={{padding:"14px 18px 6px",background:CARD_BG,marginTop:1}}><div style={{fontWeight:700,fontSize:15,marginBottom:12,color:TEXT_PRIMARY}}>支払い方法</div></div><div style={{display:"flex",flexWrap:"wrap",gap:8,padding:"12px 14px",background:NAVY}}>{paymentMethods.map(pm=>{const isSel=editDraft.payment===pm.id;return(<button key={pm.id} onClick={()=>setEditDraft(p=>({...p,payment:pm.id}))} style={{flexShrink:0,padding:"7px 14px",border:`1px solid ${isSel?"rgba(255,255,255,0.35)":"rgba(255,255,255,0.1)"}`,borderRadius:20,background:isSel?"rgba(255,255,255,0.12)":"transparent",cursor:"pointer",display:"flex",alignItems:"center",gap:5}}><div style={{width:7,height:7,borderRadius:"50%",background:isSel?pm.color:"rgba(255,255,255,0.3)",flexShrink:0}}/><span style={{fontSize:12,fontWeight:isSel?600:400,color:isSel?TEXT_PRIMARY:TEXT_SECONDARY,whiteSpace:"nowrap"}}>{pm.label}</span></button>);})}</div><div style={{padding:"14px 18px 6px",background:CARD_BG,marginTop:1}}><div style={{fontWeight:700,fontSize:15,marginBottom:12,color:TEXT_PRIMARY}}>カテゴリー</div></div><div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8,padding:"12px 14px",background:NAVY}}>{expenseCats.map(cat=>(<button key={cat.id} onClick={()=>setEditDraft(p=>({...p,category:cat.id}))} style={{border:`2px solid ${editDraft.category===cat.id?ORANGE:"#333"}`,borderRadius:10,padding:"10px 6px 8px",cursor:"pointer",background:editDraft.category===cat.id?ORANGE_LIGHT:CARD_BG,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}><CatSvgIcon cat={cat} size={26}/><span style={{fontSize:11,color:TEXT_PRIMARY}}>{cat.label}</span></button>))}</div></div></div>)}

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
              <button onClick={()=>{const id=deleteLoanTarget.id;deleteLoan(id).catch(e=>{console.error('[loans] delete failed',id,e);alert('固定費の削除に失敗しました');});setDeleteLoanTarget(null);}} style={{flex:1,padding:"14px",background:`${RED}22`,border:`1px solid ${RED}44`,borderRadius:14,fontSize:15,fontWeight:700,color:RED,cursor:"pointer"}}>削除する</button>
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
              <span style={{fontSize:15,fontWeight:700,color:TEXT_PRIMARY}}>🔁 {editingLoanId?"固定費編集":"固定費追加"}</span>
              <button onClick={()=>setShowLoanForm(false)} style={{background:"none",border:"none",fontSize:22,color:TEXT_MUTED,cursor:"pointer"}}>✕</button>
            </div>
            <div style={{padding:"16px 20px"}}>
              <div style={{marginBottom:14}}>
                <div style={{fontSize:11,color:TEXT_MUTED,marginBottom:6,fontWeight:600}}>名称</div>
                <input value={loanDraft.label} onChange={e=>setLoanDraft(p=>({...p,label:e.target.value}))} placeholder="例：家賃・サブスク・保険など" style={{width:"100%",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",color:TEXT_PRIMARY,fontSize:16,outline:"none",boxSizing:"border-box"}}/>
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
                <input value={loanDraft.bank} onChange={e=>setLoanDraft(p=>({...p,bank:e.target.value}))} placeholder="例：三菱UFJ銀行" style={{width:"100%",background:NAVY3,border:`1px solid ${BORDER}`,borderRadius:10,padding:"10px 12px",color:TEXT_PRIMARY,fontSize:16,outline:"none",boxSizing:"border-box"}}/>
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
                const patch={...loanDraft,amount:Number(loanDraft.amount)};
                if(editingLoanId){
                  updateLoan(editingLoanId,patch).catch(e=>{console.error('[loans] update failed',editingLoanId,e);alert('固定費の更新に失敗しました');});
                } else {
                  createLoan({...patch,id:`loan_${Date.now()}`}).catch(e=>{console.error('[loans] create failed',e);alert('固定費の追加に失敗しました');});
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

      {showRecurringModal&&(<div style={S.overlay}><div style={S.overlayHeader}><button onClick={()=>{setShowRecurringModal(false);setEditingRecurId(null);setRecurDraft({category:"food",amount:"",memo:"",freq:"monthly"});}} style={{background:"none",border:"none",fontSize:20,color:TEXT_SECONDARY,cursor:"pointer"}}>✕</button><span style={{fontWeight:400,fontSize:15,color:TEXT_PRIMARY}}>🔁 定期支出</span><span style={{width:40}}></span></div><div style={{flex:1,overflowY:"auto"}}><div style={{background:CARD_BG,margin:"12px 16px",borderRadius:14,padding:"16px",boxShadow:SHADOW}}><div style={{fontWeight:400,fontSize:13,marginBottom:12,color:TEXT_PRIMARY}}>{editingRecurId?"編集":"＋ 新規登録"}</div><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:CREAM,borderRadius:8}}><span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:40}}>金額</span><input type="number" value={recurDraft.amount} onChange={e=>setRecurDraft(p=>({...p,amount:e.target.value}))} placeholder="0" style={{flex:1,border:"none",background:"transparent",fontSize:18,fontWeight:700,outline:"none",color:TEXT_PRIMARY}}/><span style={{color:"#888"}}>円</span></div><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,padding:"8px 12px",background:CREAM,borderRadius:8}}><span style={{fontSize:13,color:TEXT_SECONDARY,minWidth:40}}>メモ</span><input value={recurDraft.memo} onChange={e=>setRecurDraft(p=>({...p,memo:e.target.value}))} placeholder="家賃・Netflixなど" style={{flex:1,border:"none",background:"transparent",fontSize:16,outline:"none",color:TEXT_PRIMARY}}/></div><div style={{marginBottom:12}}><div style={{fontSize:13,color:"#666",marginBottom:8}}>頻度</div><div style={{display:"flex",gap:8}}>{RECUR_OPTIONS.map(o=>(<button key={o.value} onClick={()=>setRecurDraft(p=>({...p,freq:o.value}))} style={{flex:1,padding:"8px",border:`2px solid ${recurDraft.freq===o.value?ORANGE:BORDER}`,borderRadius:8,background:recurDraft.freq===o.value?ORANGE_LIGHT:CARD_BG,fontSize:13,cursor:"pointer",color:recurDraft.freq===o.value?ORANGE:TEXT_PRIMARY,fontWeight:recurDraft.freq===o.value?700:400}}>{o.label}</button>))}</div></div><div style={{marginBottom:14}}><div style={{fontSize:13,color:"#666",marginBottom:8}}>カテゴリー</div><div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:6}}>{expenseCats.map(cat=>(<button key={cat.id} onClick={()=>setRecurDraft(p=>({...p,category:cat.id}))} style={{border:`2px solid ${recurDraft.category===cat.id?ORANGE:BORDER}`,borderRadius:8,padding:"8px 4px",cursor:"pointer",background:recurDraft.category===cat.id?ORANGE_LIGHT:CARD_BG,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}><CatSvgIcon cat={cat} size={20}/><span style={{fontSize:9,color:TEXT_PRIMARY}}>{cat.label}</span></button>))}</div></div><button onClick={saveRecurring} style={{display:"block",width:"100%",padding:"16px",background:recurDraft.amount&&Number(recurDraft.amount)>0?ORANGE:"#333",color:recurDraft.amount&&Number(recurDraft.amount)>0?"#fff":"#888",border:"none",borderRadius:28,fontSize:16,fontWeight:700,cursor:"pointer"}}>{editingRecurId?"変更を保存":"登録して今月分を追加"}</button></div></div></div>)}

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