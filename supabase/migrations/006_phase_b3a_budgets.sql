-- =============================================================
-- B-3a: 予算系 3 表 + Realtime publication 追加
-- =============================================================

-- ---- budgets -----------------------------------------------------
create table public.budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  category_id  text not null,
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, category_id),
  foreign key (client_id, category_id)
    references public.categories(client_id, id) on delete cascade
);
create index budgets_client_period_idx
  on public.budgets (client_id, year, cycle_month);
create trigger trg_budgets_updated_at
  before update on public.budgets
  for each row execute procedure public.set_updated_at();
comment on column public.budgets.cycle_month is
  '1-12 のサイクル月。managementStartDay 未設定ならカレンダー月と等価';
comment on column public.budgets.legacy_key is
  '旧 cfo_budgets のキー文字列 (例 "2026-4-entertainment")';

-- ---- week_budgets ------------------------------------------------
create table public.week_budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  week_num     smallint not null check (week_num between 1 and 4),
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, week_num)
);
create index week_budgets_client_period_idx
  on public.week_budgets (client_id, year, cycle_month);
create trigger trg_week_budgets_updated_at
  before update on public.week_budgets
  for each row execute procedure public.set_updated_at();

-- ---- week_cat_budgets --------------------------------------------
create table public.week_cat_budgets (
  client_id    uuid not null references public.profiles(id) on delete cascade,
  year         smallint not null check (year between 2000 and 2100),
  cycle_month  smallint not null check (cycle_month between 1 and 12),
  week_num     smallint not null check (week_num between 1 and 4),
  category_id  text not null,
  amount       bigint not null check (amount >= 0),
  legacy_key   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (client_id, year, cycle_month, week_num, category_id),
  foreign key (client_id, category_id)
    references public.categories(client_id, id) on delete cascade
);
create index week_cat_budgets_client_period_idx
  on public.week_cat_budgets (client_id, year, cycle_month, week_num);
create trigger trg_week_cat_budgets_updated_at
  before update on public.week_cat_budgets
  for each row execute procedure public.set_updated_at();

-- ---- RLS ---------------------------------------------------------
alter table public.budgets          enable row level security;
alter table public.week_budgets     enable row level security;
alter table public.week_cat_budgets enable row level security;

create policy "budgets_client_rw_own" on public.budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "budgets_admin_all" on public.budgets
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "week_budgets_client_rw_own" on public.week_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_budgets_admin_all" on public.week_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

create policy "week_cat_budgets_client_rw_own" on public.week_cat_budgets
  for all using (client_id = auth.uid())
  with check (client_id = auth.uid());
create policy "week_cat_budgets_admin_all" on public.week_cat_budgets
  for all using (public.is_admin())
  with check (public.is_admin());

-- ---- Realtime publication ----------------------------------------
alter publication supabase_realtime add table public.budgets;
alter publication supabase_realtime add table public.week_budgets;
alter publication supabase_realtime add table public.week_cat_budgets;
