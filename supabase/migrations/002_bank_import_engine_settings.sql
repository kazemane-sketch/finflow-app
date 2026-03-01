-- ============================================================
-- Bank Import Engine Feature Flag
-- ============================================================

create table if not exists public.bank_import_engine_settings (
  company_id uuid primary key references public.companies(id) on delete cascade,
  engine text not null default 'legacy' check (engine in ('legacy', 'ocr')),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_bank_import_engine_settings_engine
  on public.bank_import_engine_settings(engine);

alter table public.bank_import_engine_settings enable row level security;

create policy "bies_select"
  on public.bank_import_engine_settings
  for select
  using (is_company_member(company_id));

create policy "bies_insert"
  on public.bank_import_engine_settings
  for insert
  with check (is_company_member(company_id));

create policy "bies_update"
  on public.bank_import_engine_settings
  for update
  using (is_company_member(company_id))
  with check (is_company_member(company_id));

comment on table public.bank_import_engine_settings is
  'Feature flag per azienda per scegliere motore import banca: legacy o ocr.';
