-- Enable new bank import engine: plumber

do $$
declare
  c record;
begin
  -- Drop existing check constraints that guard engine allowed values.
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.bank_import_engine_settings'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%engine%'
  loop
    execute format('alter table public.bank_import_engine_settings drop constraint %I', c.conname);
  end loop;

  alter table public.bank_import_engine_settings
    add constraint bank_import_engine_settings_engine_check
    check (engine in ('legacy', 'ocr', 'plumber'));
end $$;

comment on table public.bank_import_engine_settings is
  'Feature flag per azienda per scegliere motore import banca: legacy, ocr o plumber.';
