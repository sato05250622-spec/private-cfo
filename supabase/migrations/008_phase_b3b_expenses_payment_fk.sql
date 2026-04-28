-- =============================================================
-- B-3b 段階 2: expenses.payment_method に FK 制約追加
-- 前提:
--   - 全 client が payment_methods 移行完了済 (cfo_paymentsLoansMigrated == "1")
--   - 事前チェック (orphan_count = 0) を Run 済
--   - PostgreSQL 15+ (`ON DELETE SET NULL (column)` partial syntax 必須)
--
-- ON DELETE 戦略: payment_method 列のみ SET NULL (PG 15+ feature)
--   - 参照中 PM 削除時、expenses 行は残し、payment_method のみ NULL 化
--   - client_id は維持 (NOT NULL 制約に違反しない)
--   - useExpenses の `?? 'cash'` フォールバックで UI 表示は「現金」に
--   - soft delete 設計と整合 (expenses 行を物理削除しない)
--
-- ON UPDATE CASCADE: 万一 PM id が rename された時に expenses 側を追従
--   - 通常運用では PM id rename は発生しないが、debug / migrate 用の保険
-- =============================================================

alter table public.expenses
  add constraint expenses_payment_method_fk
    foreign key (client_id, payment_method)
    references public.payment_methods(client_id, id)
    on delete set null (payment_method)
    on update cascade;

-- 部分インデックス: payment_method = NULL の行と soft-deleted 行を除外し、
-- アクティブな PM 参照クエリ (例: 集計 / バッジ表示) を高速化。
create index expenses_payment_method_idx
  on public.expenses (client_id, payment_method)
  where deleted_at is null and payment_method is not null;

comment on constraint expenses_payment_method_fk on public.expenses is
  'B-3b 段階2 で追加。PM 削除時は payment_method 列のみ NULL flip (PG 15+ partial SET NULL)。client_id は維持。useExpenses で ?? "cash" フォールバック。';
