-- ============================================================
-- Counterparties module v1
-- - hardening entity fields
-- - VAT-based key and dedup
-- - invoice linkage/backfill from invoice JSON payload
-- ============================================================

-- Normalize VAT helper (uppercase, remove IT prefix, keep alnum)
create or replace function public.normalize_vat_key(p_vat text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(upper(coalesce(p_vat, '')), '^IT', ''),
      '[^A-Z0-9]',
      '',
      'g'
    ),
    ''
  );
$$;

-- -----------------------------------------------------------------
-- counterparties: columns for verification/classification workflow
-- -----------------------------------------------------------------
alter table public.counterparties
  add column if not exists status text;

alter table public.counterparties
  alter column status set default 'pending';

update public.counterparties
set status = 'pending'
where status is null;

alter table public.counterparties
  alter column status set not null;

alter table public.counterparties
  add column if not exists legal_type text;

alter table public.counterparties
  add column if not exists vat_key text;

alter table public.counterparties
  add column if not exists classification_source text;

alter table public.counterparties
  add column if not exists classification_confidence numeric(5,2);

alter table public.counterparties
  add column if not exists verified_at timestamptz;

alter table public.counterparties
  add column if not exists verified_by uuid references auth.users(id);

alter table public.counterparties
  add column if not exists rejection_reason text;

-- Existing rows get normalized VAT key
update public.counterparties
set vat_key = public.normalize_vat_key(vat_number)
where coalesce(vat_key, '') = '';

-- -----------------------------------------------------------------
-- deduplicate same company + vat_key before unique partial index
-- -----------------------------------------------------------------
with ranked as (
  select
    id,
    company_id,
    vat_key,
    first_value(id) over (
      partition by company_id, vat_key
      order by created_at asc nulls last, id asc
    ) as keep_id,
    row_number() over (
      partition by company_id, vat_key
      order by created_at asc nulls last, id asc
    ) as rn
  from public.counterparties
  where vat_key is not null
), dupes as (
  select id, keep_id
  from ranked
  where rn > 1
)
update public.invoices i
set counterparty_id = d.keep_id
from dupes d
where i.counterparty_id = d.id;

with ranked as (
  select
    id,
    company_id,
    vat_key,
    row_number() over (
      partition by company_id, vat_key
      order by created_at asc nulls last, id asc
    ) as rn
  from public.counterparties
  where vat_key is not null
)
delete from public.counterparties c
using ranked r
where c.id = r.id
  and r.rn > 1;

create unique index if not exists idx_counterparties_company_vat_key_unique
  on public.counterparties(company_id, vat_key)
  where vat_key is not null;

create index if not exists idx_counterparties_status
  on public.counterparties(company_id, status);

create index if not exists idx_counterparties_type
  on public.counterparties(company_id, type);

create index if not exists idx_counterparties_legal_type
  on public.counterparties(company_id, legal_type);

-- -----------------------------------------------------------------
-- constraints for status/legal_type/classification_source
-- -----------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'counterparties_status_check'
      and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties
      add constraint counterparties_status_check
      check (status in ('pending', 'verified', 'rejected'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'counterparties_legal_type_check'
      and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties
      add constraint counterparties_legal_type_check
      check (legal_type in ('azienda', 'pa', 'professionista', 'persona', 'altro'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'counterparties_classification_source_check'
      and conrelid = 'public.counterparties'::regclass
  ) then
    alter table public.counterparties
      add constraint counterparties_classification_source_check
      check (classification_source in ('rule', 'ai', 'manual'));
  end if;
end $$;

-- -----------------------------------------------------------------
-- invoices: compatibility + snapshot field for quick UI alerts
-- -----------------------------------------------------------------
alter table public.invoices
  add column if not exists counterparty jsonb;

alter table public.invoices
  add column if not exists xml_hash text;

alter table public.invoices
  add column if not exists counterparty_status_snapshot text;

-- -----------------------------------------------------------------
-- Backfill counterparties from invoices JSON (only when VAT available)
-- -----------------------------------------------------------------
with invoice_cp as (
  select
    i.company_id,
    public.normalize_vat_key(i.counterparty->>'piva') as vat_key,
    nullif(trim(i.counterparty->>'piva'), '') as vat_number,
    coalesce(nullif(trim(i.counterparty->>'denom'), ''), 'Controparte senza nome') as name,
    nullif(trim(i.counterparty->>'cf'), '') as fiscal_code,
    nullif(trim(i.counterparty->>'sede'), '') as address,
    i.direction,
    i.date,
    i.created_at,
    i.id
  from public.invoices i
  where i.counterparty_id is null
    and i.counterparty is not null
    and public.normalize_vat_key(i.counterparty->>'piva') is not null
), ranked as (
  select
    company_id,
    vat_key,
    vat_number,
    name,
    fiscal_code,
    address,
    bool_or(direction = 'out') over (partition by company_id, vat_key) as has_out,
    bool_or(direction = 'in') over (partition by company_id, vat_key) as has_in,
    row_number() over (
      partition by company_id, vat_key
      order by length(name) desc, created_at desc nulls last, date desc nulls last, id desc
    ) as rn
  from invoice_cp
), upsert_source as (
  select
    company_id,
    case
      when has_out and has_in then 'both'
      when has_out then 'client'
      else 'supplier'
    end as type,
    name,
    vat_number,
    fiscal_code,
    address,
    vat_key
  from ranked
  where rn = 1
)
insert into public.counterparties (
  company_id,
  type,
  name,
  vat_number,
  fiscal_code,
  address,
  auto_created,
  status,
  vat_key,
  legal_type,
  classification_source,
  classification_confidence
)
select
  s.company_id,
  s.type,
  s.name,
  s.vat_number,
  s.fiscal_code,
  s.address,
  true,
  'pending',
  s.vat_key,
  'azienda',
  'rule',
  0.70
from upsert_source s
on conflict (company_id, vat_key) where vat_key is not null do update
set
  name = excluded.name,
  vat_number = coalesce(public.counterparties.vat_number, excluded.vat_number),
  fiscal_code = coalesce(public.counterparties.fiscal_code, excluded.fiscal_code),
  address = coalesce(public.counterparties.address, excluded.address),
  type = case
    when public.counterparties.type = excluded.type then public.counterparties.type
    else 'both'
  end,
  updated_at = now();

-- Link invoices to counterparties by VAT key
update public.invoices i
set counterparty_id = c.id
from public.counterparties c
where i.counterparty_id is null
  and i.company_id = c.company_id
  and c.vat_key is not null
  and public.normalize_vat_key(i.counterparty->>'piva') = c.vat_key;

-- Promote type to both where needed (in+out invoices)
with usage as (
  select
    i.counterparty_id,
    bool_or(i.direction = 'out') as has_out,
    bool_or(i.direction = 'in') as has_in
  from public.invoices i
  where i.counterparty_id is not null
  group by i.counterparty_id
)
update public.counterparties c
set type = case
  when u.has_out and u.has_in then 'both'
  when u.has_out then 'client'
  when u.has_in then 'supplier'
  else c.type
end,
updated_at = now()
from usage u
where c.id = u.counterparty_id;

-- Snapshot for invoice detail alerts
update public.invoices i
set counterparty_status_snapshot = c.status
from public.counterparties c
where i.counterparty_id = c.id
  and (i.counterparty_status_snapshot is null or i.counterparty_status_snapshot <> c.status);
