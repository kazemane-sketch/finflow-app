-- Add explicit direction/review metadata for bank transactions.
alter table public.bank_transactions
  add column if not exists posting_side text not null default 'unknown';

alter table public.bank_transactions
  add column if not exists direction text;

alter table public.bank_transactions
  add column if not exists direction_source text;

alter table public.bank_transactions
  add column if not exists direction_confidence numeric(5,2);

alter table public.bank_transactions
  add column if not exists direction_needs_review boolean not null default false;

alter table public.bank_transactions
  add column if not exists direction_reason text;

alter table public.bank_transactions
  add column if not exists direction_updated_at timestamptz;

alter table public.bank_transactions
  add column if not exists direction_updated_by uuid references auth.users(id);

-- Backfill historical rows from legacy amount sign.
update public.bank_transactions
set
  direction = coalesce(direction, case when amount >= 0 then 'in' else 'out' end),
  direction_source = coalesce(direction_source, 'amount_fallback'),
  posting_side = coalesce(posting_side, 'unknown'),
  direction_needs_review = coalesce(direction_needs_review, false),
  direction_confidence = coalesce(direction_confidence, 0.50),
  direction_reason = coalesce(direction_reason, 'backfill da segno storico')
where
  direction is null
  or direction_source is null
  or posting_side is null
  or direction_confidence is null
  or direction_reason is null;

alter table public.bank_transactions
  alter column direction set not null;

alter table public.bank_transactions
  alter column direction_source set not null;

alter table public.bank_transactions
  alter column direction_confidence set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bank_transactions_posting_side_check'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_posting_side_check
      check (posting_side in ('dare','avere','unknown'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bank_transactions_direction_check'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_direction_check
      check (direction in ('in','out'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'bank_transactions_direction_source_check'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_direction_source_check
      check (direction_source in ('side_rule','semantic_rule','amount_fallback','manual'));
  end if;
end $$;

create index if not exists idx_bank_tx_review
  on public.bank_transactions(company_id, direction_needs_review, date desc);

do $$
begin
  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'bank_transactions'
      and policyname = 'bt_update'
  ) then
    create policy "bt_update"
      on public.bank_transactions
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;
end $$;
