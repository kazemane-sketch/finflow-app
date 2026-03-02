-- ============================================================
-- VAT module v1
-- - company fiscal VAT profile
-- - invoice VAT entries (normalized extraction)
-- - VAT period computations + payment matching (F24 suggestions)
-- ============================================================

-- ------------------------------------------------------------
-- invoices compatibility: paid_date for deferred VAT eligibility
-- ------------------------------------------------------------
alter table public.invoices
  add column if not exists paid_date date;

create index if not exists idx_invoices_paid_date
  on public.invoices(company_id, paid_date);

-- ------------------------------------------------------------
-- company VAT profile (one per company)
-- ------------------------------------------------------------
create table if not exists public.company_vat_profiles (
  company_id uuid primary key references public.companies(id) on delete cascade,
  liquidation_regime text not null check (liquidation_regime in ('monthly', 'quarterly')),
  activity_type text not null check (activity_type in ('services', 'other')),
  start_date date not null,
  opening_vat_credit numeric(15,2) not null default 0,
  opening_vat_debit numeric(15,2) not null default 0,
  deferred_mode text not null default 'on_verified_payment' check (deferred_mode in ('on_verified_payment')),
  acconto_method text not null default 'historical' check (acconto_method in ('historical')),
  acconto_override_amount numeric(15,2),
  commercialista_confirmed boolean not null default false,
  backfill_confirmed boolean not null default false,
  backfill_preview_json jsonb,
  backfill_confirmed_at timestamptz,
  configured_by uuid references auth.users(id),
  configured_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- per-invoice normalized VAT movements
-- ------------------------------------------------------------
create table if not exists public.invoice_vat_entries (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete cascade,
  source_invoice_line_id uuid references public.invoice_lines(id) on delete set null,
  rc_pair_id uuid,
  invoice_date date not null,
  effective_date date,
  direction text not null check (direction in ('in', 'out')),
  doc_type text not null,
  vat_rate numeric(6,3) not null default 0,
  vat_nature text,
  esigibilita text not null check (esigibilita in ('I', 'D', 'S')),
  taxable_amount numeric(15,2) not null default 0,
  vat_amount numeric(15,2) not null default 0,
  vat_debit_amount numeric(15,2) not null default 0,
  vat_credit_amount numeric(15,2) not null default 0,
  is_credit_note boolean not null default false,
  is_reverse_charge boolean not null default false,
  is_split_payment boolean not null default false,
  is_manual boolean not null default false,
  manual_note text,
  status text not null check (status in ('pending_effective', 'effective')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_invoice_vat_entries_company_effective
  on public.invoice_vat_entries(company_id, status, effective_date);

create index if not exists idx_invoice_vat_entries_invoice
  on public.invoice_vat_entries(invoice_id);

create index if not exists idx_invoice_vat_entries_line
  on public.invoice_vat_entries(source_invoice_line_id);

create index if not exists idx_invoice_vat_entries_rc_pair
  on public.invoice_vat_entries(rc_pair_id);

create index if not exists idx_invoice_vat_entries_breakdown
  on public.invoice_vat_entries(company_id, vat_rate, vat_nature, esigibilita);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'invoice_vat_entries_manual_invoice_check'
      and conrelid = 'public.invoice_vat_entries'::regclass
  ) then
    alter table public.invoice_vat_entries
      add constraint invoice_vat_entries_manual_invoice_check
      check (
        (is_manual = true and invoice_id is null)
        or
        (is_manual = false and invoice_id is not null)
      );
  end if;
end $$;

-- ------------------------------------------------------------
-- VAT liquidation periods
-- ------------------------------------------------------------
create table if not exists public.vat_periods (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  regime text not null check (regime in ('monthly', 'quarterly')),
  period_type text not null check (period_type in ('regular', 'acconto', 'annual')),
  year int not null,
  period_index int not null,
  period_start date not null,
  period_end date not null,
  due_date date not null,
  vat_debit numeric(15,2) not null default 0,
  vat_credit numeric(15,2) not null default 0,
  prev_credit_used numeric(15,2) not null default 0,
  prev_debit_under_threshold numeric(15,2) not null default 0,
  quarterly_interest numeric(15,2) not null default 0,
  acconto_amount numeric(15,2),
  amount_due numeric(15,2) not null default 0,
  amount_credit_carry numeric(15,2) not null default 0,
  status text not null check (status in ('draft', 'to_pay', 'paid', 'credit', 'under_threshold', 'overdue')),
  snapshot_json jsonb,
  paid_amount numeric(15,2),
  paid_at timestamptz,
  payment_method text,
  payment_note text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(company_id, period_type, year, period_index)
);

create index if not exists idx_vat_periods_company_due
  on public.vat_periods(company_id, due_date);

create index if not exists idx_vat_periods_company_status
  on public.vat_periods(company_id, status, period_type);

-- ------------------------------------------------------------
-- payment matching suggestions (F24)
-- ------------------------------------------------------------
create table if not exists public.vat_period_payment_matches (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vat_period_id uuid not null references public.vat_periods(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  score numeric(5,4) not null default 0,
  reason text,
  suggested_amount numeric(15,2),
  status text not null default 'suggested' check (status in ('suggested', 'accepted', 'rejected')),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(vat_period_id, bank_transaction_id)
);

create index if not exists idx_vat_payment_matches_period
  on public.vat_period_payment_matches(vat_period_id, status, score desc);

create index if not exists idx_vat_payment_matches_company
  on public.vat_period_payment_matches(company_id, status);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.company_vat_profiles enable row level security;
alter table public.invoice_vat_entries enable row level security;
alter table public.vat_periods enable row level security;
alter table public.vat_period_payment_matches enable row level security;

-- company_vat_profiles: read for members, write owner/admin only

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'company_vat_profiles'
      and policyname = 'cvp_select'
  ) then
    create policy "cvp_select"
      on public.company_vat_profiles
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'company_vat_profiles'
      and policyname = 'cvp_insert'
  ) then
    create policy "cvp_insert"
      on public.company_vat_profiles
      for insert
      with check (
        exists (
          select 1 from public.company_members cm
          where cm.company_id = company_vat_profiles.company_id
            and cm.user_id = auth.uid()
            and cm.role in ('owner', 'admin')
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'company_vat_profiles'
      and policyname = 'cvp_update'
  ) then
    create policy "cvp_update"
      on public.company_vat_profiles
      for update
      using (
        exists (
          select 1 from public.company_members cm
          where cm.company_id = company_vat_profiles.company_id
            and cm.user_id = auth.uid()
            and cm.role in ('owner', 'admin')
        )
      )
      with check (
        exists (
          select 1 from public.company_members cm
          where cm.company_id = company_vat_profiles.company_id
            and cm.user_id = auth.uid()
            and cm.role in ('owner', 'admin')
        )
      );
  end if;
end $$;

-- invoice_vat_entries: company members full access

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_vat_entries'
      and policyname = 'ive_select'
  ) then
    create policy "ive_select"
      on public.invoice_vat_entries
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_vat_entries'
      and policyname = 'ive_insert'
  ) then
    create policy "ive_insert"
      on public.invoice_vat_entries
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_vat_entries'
      and policyname = 'ive_update'
  ) then
    create policy "ive_update"
      on public.invoice_vat_entries
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_vat_entries'
      and policyname = 'ive_delete'
  ) then
    create policy "ive_delete"
      on public.invoice_vat_entries
      for delete
      using (is_company_member(company_id));
  end if;
end $$;

-- vat_periods: company members full access

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_periods'
      and policyname = 'vp_select'
  ) then
    create policy "vp_select"
      on public.vat_periods
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_periods'
      and policyname = 'vp_insert'
  ) then
    create policy "vp_insert"
      on public.vat_periods
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_periods'
      and policyname = 'vp_update'
  ) then
    create policy "vp_update"
      on public.vat_periods
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_periods'
      and policyname = 'vp_delete'
  ) then
    create policy "vp_delete"
      on public.vat_periods
      for delete
      using (is_company_member(company_id));
  end if;
end $$;

-- vat_period_payment_matches: company members full access

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_payment_matches'
      and policyname = 'vppm_select'
  ) then
    create policy "vppm_select"
      on public.vat_period_payment_matches
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_payment_matches'
      and policyname = 'vppm_insert'
  ) then
    create policy "vppm_insert"
      on public.vat_period_payment_matches
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_payment_matches'
      and policyname = 'vppm_update'
  ) then
    create policy "vppm_update"
      on public.vat_period_payment_matches
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_payment_matches'
      and policyname = 'vppm_delete'
  ) then
    create policy "vppm_delete"
      on public.vat_period_payment_matches
      for delete
      using (is_company_member(company_id));
  end if;
end $$;
