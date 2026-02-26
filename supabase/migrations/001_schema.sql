-- ============================================================
-- FinFlow — Schema v2
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============================================================
-- COMPANIES
-- ============================================================
create table public.companies (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  vat_number text,          -- P.IVA
  fiscal_code text,         -- Codice Fiscale
  sdi_code text,            -- Codice Destinatario SDI
  pec text,
  address text,
  city text,
  province text,
  zip text,
  country text default 'IT',
  phone text,
  email text,
  logo_url text,
  rea_office text,
  rea_number text,
  share_capital numeric(15,2),
  fiscal_regime text,       -- RF01, RF19, etc.
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- COMPANY MEMBERS (multi-tenant)
-- ============================================================
create table public.company_members (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'viewer' check (role in ('owner','admin','editor','viewer')),
  created_at timestamptz default now(),
  unique(company_id, user_id)
);

-- ============================================================
-- COUNTERPARTIES (clienti / fornitori)
-- ============================================================
create table public.counterparties (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null check (type in ('client','supplier','both')),
  name text not null,
  vat_number text,
  fiscal_code text,
  sdi_code text,
  pec text,
  address text,
  city text,
  province text,
  zip text,
  country text default 'IT',
  phone text,
  email text,
  payment_terms_days int,
  default_payment_method text,
  notes text,
  vies_verified boolean default false,
  vies_checked_at timestamptz,
  auto_created boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_counterparties_company on public.counterparties(company_id);
create index idx_counterparties_vat on public.counterparties(vat_number);

-- ============================================================
-- INVOICES
-- ============================================================
create table public.invoices (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  counterparty_id uuid references public.counterparties(id),
  direction text not null check (direction in ('in','out')),  -- in=ricevuta, out=emessa
  doc_type text not null,                                      -- TD01, TD04, etc.
  number text not null,
  date date not null,
  currency text default 'EUR',
  total_amount numeric(15,2) not null,
  taxable_amount numeric(15,2),
  tax_amount numeric(15,2),
  withholding_amount numeric(15,2),
  stamp_amount numeric(15,2),
  payment_method text,
  payment_terms text,
  payment_due_date date,
  payment_status text default 'pending' check (payment_status in ('pending','partial','paid','overdue')),
  reconciliation_status text default 'unmatched' check (reconciliation_status in ('unmatched','suggested','matched','manual')),
  sdi_id text,
  notes text,
  raw_xml text,
  xml_version text,
  parse_method text,
  source_filename text,
  import_batch_id uuid,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_invoices_company on public.invoices(company_id);
create index idx_invoices_counterparty on public.invoices(counterparty_id);
create index idx_invoices_date on public.invoices(date);
create index idx_invoices_due on public.invoices(payment_due_date);
create index idx_invoices_status on public.invoices(payment_status);

-- ============================================================
-- INVOICE LINES
-- ============================================================
create table public.invoice_lines (
  id uuid primary key default uuid_generate_v4(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  line_number int,
  description text,
  quantity numeric(15,4),
  unit_measure text,
  unit_price numeric(15,4),
  total_price numeric(15,2),
  vat_rate numeric(5,2),
  vat_nature text,
  article_code text,
  created_at timestamptz default now()
);

create index idx_invoice_lines_invoice on public.invoice_lines(invoice_id);

-- ============================================================
-- BANK ACCOUNTS
-- ============================================================
create table public.bank_accounts (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  bank_name text,
  iban text,
  bic text,
  currency text default 'EUR',
  current_balance numeric(15,2),
  balance_date date,
  is_primary boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index idx_bank_accounts_company on public.bank_accounts(company_id);

-- ============================================================
-- IMPORT BATCHES (tracking imports)
-- ============================================================
create table public.import_batches (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  type text not null check (type in ('invoice_xml','bank_pdf','bank_csv')),
  filename text,
  status text default 'processing' check (status in ('processing','completed','failed')),
  total_records int default 0,
  success_count int default 0,
  error_count int default 0,
  error_details jsonb,
  imported_by uuid references auth.users(id),
  created_at timestamptz default now()
);

-- ============================================================
-- BANK TRANSACTIONS
-- ============================================================
create table public.bank_transactions (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  import_batch_id uuid references public.import_batches(id),
  date date not null,
  value_date date,
  amount numeric(15,2) not null,
  balance numeric(15,2),
  description text,
  counterparty_name text,
  category_code text,           -- CS code from MPS (17, 26, 48, etc.)
  transaction_type text,        -- bonifico_in, bonifico_out, riba, sdd, etc.
  reference text,               -- CBI flow ID or other reference
  invoice_ref text,             -- extracted invoice reference (e.g. "195/FE/25")
  commission_amount numeric(15,2),
  raw_text text,                -- original full description from PDF
  hash text,                    -- for deduplication
  reconciliation_status text default 'unmatched' check (reconciliation_status in ('unmatched','suggested','matched','excluded')),
  created_at timestamptz default now()
);

create index idx_bank_tx_company on public.bank_transactions(company_id);
create index idx_bank_tx_account on public.bank_transactions(bank_account_id);
create index idx_bank_tx_date on public.bank_transactions(date);
create index idx_bank_tx_hash on public.bank_transactions(hash);
create unique index idx_bank_tx_dedup on public.bank_transactions(bank_account_id, hash);

-- ============================================================
-- RECONCILIATIONS
-- ============================================================
create table public.reconciliations (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  bank_transaction_id uuid not null references public.bank_transactions(id) on delete cascade,
  match_type text default 'manual' check (match_type in ('auto','suggested','manual')),
  confidence numeric(5,2),     -- 0-100 AI confidence score
  match_reason text,            -- "amount_exact + counterparty_fuzzy"
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  created_at timestamptz default now()
);

create index idx_reconciliations_company on public.reconciliations(company_id);
create index idx_reconciliations_invoice on public.reconciliations(invoice_id);
create index idx_reconciliations_tx on public.reconciliations(bank_transaction_id);

-- ============================================================
-- CHART OF ACCOUNTS
-- ============================================================
create table public.chart_of_accounts (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  code text not null,
  name text not null,
  type text check (type in ('asset','liability','equity','revenue','expense')),
  parent_id uuid references public.chart_of_accounts(id),
  is_active boolean default true,
  created_at timestamptz default now()
);

-- ============================================================
-- PROJECTS
-- ============================================================
create table public.projects (
  id uuid primary key default uuid_generate_v4(),
  company_id uuid not null references public.companies(id) on delete cascade,
  name text not null,
  code text,
  description text,
  budget numeric(15,2),
  status text default 'active' check (status in ('active','completed','archived')),
  start_date date,
  end_date date,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- Helper function: check if user is member of company
create or replace function public.is_company_member(p_company_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.company_members
    where company_id = p_company_id
    and user_id = auth.uid()
  );
$$;

-- Enable RLS on all tables
alter table public.companies enable row level security;
alter table public.company_members enable row level security;
alter table public.counterparties enable row level security;
alter table public.invoices enable row level security;
alter table public.invoice_lines enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.import_batches enable row level security;
alter table public.reconciliations enable row level security;
alter table public.chart_of_accounts enable row level security;
alter table public.projects enable row level security;

-- Companies: members can read, owners can update
create policy "company_select" on public.companies for select using (is_company_member(id));
create policy "company_update" on public.companies for update using (
  exists (select 1 from public.company_members where company_id = id and user_id = auth.uid() and role in ('owner','admin'))
);
create policy "company_insert" on public.companies for insert with check (true); -- anyone can create

-- Company members
create policy "members_select" on public.company_members for select using (is_company_member(company_id));
create policy "members_insert" on public.company_members for insert with check (true);

-- All other tables: company member access
create policy "cp_select" on public.counterparties for select using (is_company_member(company_id));
create policy "cp_insert" on public.counterparties for insert with check (is_company_member(company_id));
create policy "cp_update" on public.counterparties for update using (is_company_member(company_id));
create policy "cp_delete" on public.counterparties for delete using (is_company_member(company_id));

create policy "inv_select" on public.invoices for select using (is_company_member(company_id));
create policy "inv_insert" on public.invoices for insert with check (is_company_member(company_id));
create policy "inv_update" on public.invoices for update using (is_company_member(company_id));
create policy "inv_delete" on public.invoices for delete using (is_company_member(company_id));

create policy "il_select" on public.invoice_lines for select using (
  exists (select 1 from public.invoices i where i.id = invoice_id and is_company_member(i.company_id))
);
create policy "il_insert" on public.invoice_lines for insert with check (
  exists (select 1 from public.invoices i where i.id = invoice_id and is_company_member(i.company_id))
);

create policy "ba_select" on public.bank_accounts for select using (is_company_member(company_id));
create policy "ba_insert" on public.bank_accounts for insert with check (is_company_member(company_id));
create policy "ba_update" on public.bank_accounts for update using (is_company_member(company_id));

create policy "bt_select" on public.bank_transactions for select using (is_company_member(company_id));
create policy "bt_insert" on public.bank_transactions for insert with check (is_company_member(company_id));

create policy "ib_select" on public.import_batches for select using (is_company_member(company_id));
create policy "ib_insert" on public.import_batches for insert with check (is_company_member(company_id));
create policy "ib_update" on public.import_batches for update using (is_company_member(company_id));

create policy "rec_select" on public.reconciliations for select using (is_company_member(company_id));
create policy "rec_insert" on public.reconciliations for insert with check (is_company_member(company_id));
create policy "rec_delete" on public.reconciliations for delete using (is_company_member(company_id));

create policy "coa_select" on public.chart_of_accounts for select using (is_company_member(company_id));
create policy "coa_insert" on public.chart_of_accounts for insert with check (is_company_member(company_id));

create policy "proj_select" on public.projects for select using (is_company_member(company_id));
create policy "proj_insert" on public.projects for insert with check (is_company_member(company_id));
create policy "proj_update" on public.projects for update using (is_company_member(company_id));

-- ============================================================
-- STORAGE
-- ============================================================
insert into storage.buckets (id, name, public) values ('invoices', 'invoices', false)
on conflict do nothing;
