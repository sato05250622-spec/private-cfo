-- =============================================================
-- B-3b 段階 1: payment_methods + loans (FK 制約は段階 2 = 008)
-- =============================================================

-- ---- payment_methods ---------------------------------------------
create table public.payment_methods (
  client_id      uuid not null references public.profiles(id) on delete cascade,
  id             text not null,                        -- 'cash' or 'pm_<timestamp>'
  label          text not null,
  color          text,
  closing_day    smallint check (closing_day between 1 and 31),
  withdrawal_day smallint check (withdrawal_day between 1 and 31),
  bank           text,
  sort_order     int not null default 0,               -- drag-drop 順序
  legacy_key     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (client_id, id)
);
create index payment_methods_client_sort_idx
  on public.payment_methods (client_id, sort_order);
create trigger trg_payment_methods_updated_at
  before update on public.payment_methods
  for each row execute procedure public.set_updated_at();
comment on column public.payment_methods.sort_order is
  'drag-drop による表示順。新規は max(sort_order)+1';
comment on column public.payment_methods.legacy_key is
  'localStorage 移行時の元 id 控え (debug / rollback 用)';

-- ---- loans ----------------------------------------------------------
create table public.loans (
  client_id      uuid not null references public.profiles(id) on delete cascade,
  id             text not null,                        -- 'loan_<timestamp>'
  label          text not null,
  amount         bigint not null check (amount >= 0),
  bank           text,
  withdrawal_day smallint check (withdrawal_day between 1 and 31),
  pm_id          text,                                  -- payment_methods への論理参照 (現実装は未使用、FK 貼らない)
  legacy_key     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (client_id, id)
);
create index loans_client_idx on public.loans (client_id);
create trigger trg_loans_updated_at
  before update on public.loans
  for each row execute procedure public.set_updated_at();
comment on column public.loans.pm_id is
  'payment_methods への論理参照。B-3b 段階1 では FK 貼らない (App.jsx 内で未使用のため)。将来連動拡張時に FK 化を検討';
comment on column public.loans.legacy_key is
  'localStorage 移行時の元 id 控え';

-- ---- RLS ------------------------------------------------------------
alter table public.payment_methods enable row level security;
alter table public.loans           enable row level security;

create policy "payment_methods_client_rw_own" on public.payment_methods
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "payment_methods_admin_all" on public.payment_methods
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "loans_client_rw_own" on public.loans
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "loans_admin_all" on public.loans
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- Realtime publication -------------------------------------------
alter publication supabase_realtime add table public.payment_methods;
alter publication supabase_realtime add table public.loans;
