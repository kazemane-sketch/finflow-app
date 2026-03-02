-- ============================================================
-- VAT performance hardening + scalable audit snapshots
-- ============================================================

-- ------------------------------------------------------------
-- detailed per-period audit rows (separate from vat_periods)
-- ------------------------------------------------------------
create table if not exists public.vat_period_entry_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  vat_period_id uuid not null references public.vat_periods(id) on delete cascade,
  period_key text not null,
  invoice_vat_entry_id uuid references public.invoice_vat_entries(id) on delete set null,
  entry_payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_vat_period_entry_snapshots_company_period
  on public.vat_period_entry_snapshots(company_id, vat_period_id);

create index if not exists idx_vat_period_entry_snapshots_company_key
  on public.vat_period_entry_snapshots(company_id, period_key);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table public.vat_period_entry_snapshots enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_entry_snapshots'
      and policyname = 'vpes_select'
  ) then
    create policy "vpes_select"
      on public.vat_period_entry_snapshots
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_entry_snapshots'
      and policyname = 'vpes_insert'
  ) then
    create policy "vpes_insert"
      on public.vat_period_entry_snapshots
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_entry_snapshots'
      and policyname = 'vpes_update'
  ) then
    create policy "vpes_update"
      on public.vat_period_entry_snapshots
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'vat_period_entry_snapshots'
      and policyname = 'vpes_delete'
  ) then
    create policy "vpes_delete"
      on public.vat_period_entry_snapshots
      for delete
      using (is_company_member(company_id));
  end if;
end $$;
