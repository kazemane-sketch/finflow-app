-- ============================================================
-- Scadenzario v2: invoice installments + payment defaults
-- ============================================================

alter table public.companies
  add column if not exists default_dso_days int;

alter table public.companies
  add column if not exists default_pso_days int;

update public.companies
set
  default_dso_days = coalesce(default_dso_days, 30),
  default_pso_days = coalesce(default_pso_days, 30)
where default_dso_days is null or default_pso_days is null;

alter table public.companies
  alter column default_dso_days set default 30;

alter table public.companies
  alter column default_pso_days set default 30;

alter table public.companies
  alter column default_dso_days set not null;

alter table public.companies
  alter column default_pso_days set not null;

alter table public.counterparties
  add column if not exists dso_days_override int;

alter table public.counterparties
  add column if not exists pso_days_override int;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'companies_default_dso_days_non_negative'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
      add constraint companies_default_dso_days_non_negative
      check (default_dso_days >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'companies_default_pso_days_non_negative'
      and conrelid = 'public.companies'::regclass
  ) then
    alter table public.companies
      add constraint companies_default_pso_days_non_negative
      check (default_pso_days >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'counterparties_dso_days_override_non_negative'
      and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties
      add constraint counterparties_dso_days_override_non_negative
      check (dso_days_override is null or dso_days_override >= 0);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'counterparties_pso_days_override_non_negative'
      and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties
      add constraint counterparties_pso_days_override_non_negative
      check (pso_days_override is null or pso_days_override >= 0);
  end if;
end $$;

create table if not exists public.invoice_installments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  counterparty_id uuid references public.counterparties(id) on delete set null,
  direction text not null check (direction in ('in', 'out')),
  installment_no int not null,
  installment_total int not null default 1,
  due_date date not null,
  amount_due numeric(15,2) not null,
  paid_amount numeric(15,2) not null default 0,
  last_payment_date date,
  status text not null default 'pending' check (status in ('pending', 'overdue', 'partial', 'paid')),
  is_estimated boolean not null default false,
  estimate_source text check (estimate_source in ('xml', 'legacy_due_date', 'counterparty_override', 'company_default', 'fallback_30')),
  estimate_days int,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(invoice_id, installment_no)
);

create index if not exists idx_invoice_installments_company_due_status_direction
  on public.invoice_installments(company_id, due_date, status, direction);

create index if not exists idx_invoice_installments_company_counterparty_due
  on public.invoice_installments(company_id, counterparty_id, due_date);

create index if not exists idx_invoice_installments_invoice
  on public.invoice_installments(invoice_id);

alter table public.invoice_installments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installments'
      and policyname = 'ii_select'
  ) then
    create policy "ii_select"
      on public.invoice_installments
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installments'
      and policyname = 'ii_insert'
  ) then
    create policy "ii_insert"
      on public.invoice_installments
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installments'
      and policyname = 'ii_update'
  ) then
    create policy "ii_update"
      on public.invoice_installments
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installments'
      and policyname = 'ii_delete'
  ) then
    create policy "ii_delete"
      on public.invoice_installments
      for delete
      using (is_company_member(company_id));
  end if;
end $$;
