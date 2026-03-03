-- ============================================================
-- Bank AI embeddings (Gemini 3072) + pgvector retrieval + lock
-- ============================================================

create extension if not exists vector;

alter table public.bank_transactions
  add column if not exists embedding vector(3072);

alter table public.bank_transactions
  add column if not exists embedding_status text not null default 'pending';

alter table public.bank_transactions
  add column if not exists embedding_model text;

alter table public.bank_transactions
  add column if not exists embedding_updated_at timestamptz;

alter table public.bank_transactions
  add column if not exists embedding_error text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bank_transactions_embedding_status_check'
      and conrelid = 'public.bank_transactions'::regclass
  ) then
    alter table public.bank_transactions
      add constraint bank_transactions_embedding_status_check
      check (embedding_status in ('pending', 'processing', 'ready', 'error'));
  end if;
end $$;

update public.bank_transactions
set embedding_status = case when embedding is null then 'pending' else 'ready' end
where embedding_status is null
   or (embedding is null and embedding_status <> 'pending')
   or (embedding is not null and embedding_status <> 'ready');

create index if not exists idx_bank_tx_embedding_status_date
  on public.bank_transactions(company_id, embedding_status, date desc);

do $$
begin
  begin
    execute '
      create index if not exists idx_bank_tx_embedding_cosine_hnsw_halfvec
      on public.bank_transactions
      using hnsw ((embedding::halfvec(3072)) halfvec_cosine_ops)
      with (m = 16, ef_construction = 64)
      where embedding is not null and embedding_status = ''ready''
    ';
  exception
    when others then
      raise notice 'Skipping ANN vector index creation: %', sqlerrm;
  end;
end $$;

create table if not exists public.bank_embedding_locks (
  company_id uuid primary key references public.companies(id) on delete cascade,
  run_id uuid not null default gen_random_uuid(),
  locked_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null
);

alter table public.bank_embedding_locks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bank_embedding_locks'
      and policyname = 'bank_embedding_locks_select'
  ) then
    create policy bank_embedding_locks_select
      on public.bank_embedding_locks
      for select using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bank_embedding_locks'
      and policyname = 'bank_embedding_locks_insert'
  ) then
    create policy bank_embedding_locks_insert
      on public.bank_embedding_locks
      for insert with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bank_embedding_locks'
      and policyname = 'bank_embedding_locks_update'
  ) then
    create policy bank_embedding_locks_update
      on public.bank_embedding_locks
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bank_embedding_locks'
      and policyname = 'bank_embedding_locks_delete'
  ) then
    create policy bank_embedding_locks_delete
      on public.bank_embedding_locks
      for delete using (is_company_member(company_id));
  end if;
end $$;

create or replace function public.bank_embedding_has_company_access(
  p_company_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role' then
    return true;
  end if;

  if auth.uid() is null then
    return false;
  end if;

  return exists (
    select 1
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
  );
end;
$$;

create or replace function public.bank_ai_search_candidates(
  p_company_id uuid,
  p_query_vector vector(3072),
  p_limit int default 50,
  p_direction text default 'all',
  p_date_from date default null,
  p_date_to date default null
)
returns table(
  id uuid,
  date date,
  value_date date,
  amount numeric(15,2),
  description text,
  counterparty_name text,
  transaction_type text,
  reference text,
  invoice_ref text,
  direction text,
  similarity numeric
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_limit int := greatest(1, least(coalesce(p_limit, 50), 200));
  v_direction text := case when lower(coalesce(p_direction, 'all')) in ('in', 'out', 'all') then lower(p_direction) else 'all' end;
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  return query
  select
    bt.id,
    bt.date,
    bt.value_date,
    bt.amount,
    bt.description,
    bt.counterparty_name,
    bt.transaction_type,
    bt.reference,
    bt.invoice_ref,
    bt.direction,
    (bt.embedding <=> p_query_vector)::numeric as similarity
  from public.bank_transactions bt
  where bt.company_id = p_company_id
    and bt.embedding is not null
    and bt.embedding_status = 'ready'
    and (v_direction = 'all' or bt.direction = v_direction)
    and (p_date_from is null or bt.date >= p_date_from)
    and (p_date_to is null or bt.date <= p_date_to)
  order by bt.embedding <=> p_query_vector, bt.date desc, bt.id
  limit v_limit;
end;
$$;

create or replace function public.bank_embedding_health(
  p_company_id uuid
)
returns table(
  total_rows bigint,
  ready_rows bigint,
  processing_rows bigint,
  pending_rows bigint,
  error_rows bigint
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  return query
  select
    count(*)::bigint as total_rows,
    count(*) filter (where embedding_status = 'ready')::bigint as ready_rows,
    count(*) filter (where embedding_status = 'processing')::bigint as processing_rows,
    count(*) filter (where embedding_status = 'pending')::bigint as pending_rows,
    count(*) filter (where embedding_status = 'error')::bigint as error_rows
  from public.bank_transactions bt
  where bt.company_id = p_company_id;
end;
$$;

create or replace function public.bank_embedding_acquire_lock(
  p_company_id uuid,
  p_run_id uuid,
  p_ttl_seconds int default 180
)
returns table(
  acquired boolean,
  current_run_id uuid,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_ttl int := greatest(coalesce(p_ttl_seconds, 180), 30);
  v_expires timestamptz := v_now + make_interval(secs => v_ttl);
  v_current_run uuid;
  v_current_expiry timestamptz;
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  insert into public.bank_embedding_locks (
    company_id,
    run_id,
    locked_at,
    heartbeat_at,
    expires_at
  ) values (
    p_company_id,
    p_run_id,
    v_now,
    v_now,
    v_expires
  )
  on conflict (company_id) do update
    set run_id = excluded.run_id,
        locked_at = excluded.locked_at,
        heartbeat_at = excluded.heartbeat_at,
        expires_at = excluded.expires_at
  where public.bank_embedding_locks.expires_at <= v_now
     or public.bank_embedding_locks.run_id = p_run_id
  returning public.bank_embedding_locks.run_id, public.bank_embedding_locks.expires_at
  into v_current_run, v_current_expiry;

  if found then
    return query select true, v_current_run, v_current_expiry;
    return;
  end if;

  select l.run_id, l.expires_at
  into v_current_run, v_current_expiry
  from public.bank_embedding_locks l
  where l.company_id = p_company_id;

  return query select false, v_current_run, v_current_expiry;
end;
$$;

create or replace function public.bank_embedding_heartbeat_lock(
  p_company_id uuid,
  p_run_id uuid,
  p_ttl_seconds int default 180
)
returns table(
  updated boolean,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ttl int := greatest(coalesce(p_ttl_seconds, 180), 30);
  v_expires timestamptz := now() + make_interval(secs => v_ttl);
  v_exp timestamptz;
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  update public.bank_embedding_locks l
  set heartbeat_at = now(),
      expires_at = v_expires
  where l.company_id = p_company_id
    and l.run_id = p_run_id
  returning l.expires_at into v_exp;

  if found then
    return query select true, v_exp;
  else
    return query select false, null::timestamptz;
  end if;
end;
$$;

create or replace function public.bank_embedding_release_lock(
  p_company_id uuid,
  p_run_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  delete from public.bank_embedding_locks l
  where l.company_id = p_company_id
    and l.run_id = p_run_id;

  return found;
end;
$$;

create or replace function public.bank_embedding_claim_pending(
  p_company_id uuid,
  p_batch_size int default 100
)
returns table(
  id uuid,
  date date,
  value_date date,
  amount numeric(15,2),
  description text,
  counterparty_name text,
  transaction_type text,
  reference text,
  invoice_ref text,
  direction text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_batch int := greatest(1, least(coalesce(p_batch_size, 100), 500));
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  return query
  with picked as (
    select bt.id
    from public.bank_transactions bt
    where bt.company_id = p_company_id
      and bt.embedding_status = 'pending'
    order by bt.date desc, bt.id
    limit v_batch
    for update skip locked
  ),
  updated as (
    update public.bank_transactions bt
    set embedding_status = 'processing',
        embedding_updated_at = now(),
        embedding_error = null
    from picked p
    where bt.id = p.id
    returning
      bt.id,
      bt.date,
      bt.value_date,
      bt.amount,
      bt.description,
      bt.counterparty_name,
      bt.transaction_type,
      bt.reference,
      bt.invoice_ref,
      bt.direction
  )
  select
    u.id,
    u.date,
    u.value_date,
    u.amount,
    u.description,
    u.counterparty_name,
    u.transaction_type,
    u.reference,
    u.invoice_ref,
    u.direction
  from updated u;
end;
$$;

create or replace function public.bank_embedding_apply_result(
  p_company_id uuid,
  p_tx_id uuid,
  p_embedding_text text,
  p_embedding_model text,
  p_error text default null
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.bank_embedding_has_company_access(p_company_id) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  if p_error is not null then
    update public.bank_transactions bt
    set embedding_status = 'error',
        embedding_error = left(p_error, 500),
        embedding_updated_at = now()
    where bt.company_id = p_company_id
      and bt.id = p_tx_id;
    return found;
  end if;

  if p_embedding_text is null or length(trim(p_embedding_text)) = 0 then
    update public.bank_transactions bt
    set embedding_status = 'error',
        embedding_error = 'Embedding vuoto',
        embedding_updated_at = now()
    where bt.company_id = p_company_id
      and bt.id = p_tx_id;
    return found;
  end if;

  begin
    update public.bank_transactions bt
    set embedding = p_embedding_text::vector(3072),
        embedding_status = 'ready',
        embedding_model = nullif(trim(p_embedding_model), ''),
        embedding_error = null,
        embedding_updated_at = now()
    where bt.company_id = p_company_id
      and bt.id = p_tx_id;
    return found;
  exception
    when others then
      update public.bank_transactions bt
      set embedding_status = 'error',
          embedding_error = left('Embedding invalido: ' || sqlerrm, 500),
          embedding_updated_at = now()
      where bt.company_id = p_company_id
        and bt.id = p_tx_id;
      return found;
  end;
end;
$$;

grant execute on function public.bank_ai_search_candidates(uuid, vector(3072), int, text, date, date) to authenticated;
grant execute on function public.bank_ai_search_candidates(uuid, vector(3072), int, text, date, date) to service_role;

grant execute on function public.bank_embedding_health(uuid) to authenticated;
grant execute on function public.bank_embedding_health(uuid) to service_role;

grant execute on function public.bank_embedding_acquire_lock(uuid, uuid, int) to authenticated;
grant execute on function public.bank_embedding_acquire_lock(uuid, uuid, int) to service_role;

grant execute on function public.bank_embedding_heartbeat_lock(uuid, uuid, int) to authenticated;
grant execute on function public.bank_embedding_heartbeat_lock(uuid, uuid, int) to service_role;

grant execute on function public.bank_embedding_release_lock(uuid, uuid) to authenticated;
grant execute on function public.bank_embedding_release_lock(uuid, uuid) to service_role;

grant execute on function public.bank_embedding_claim_pending(uuid, int) to authenticated;
grant execute on function public.bank_embedding_claim_pending(uuid, int) to service_role;

grant execute on function public.bank_embedding_apply_result(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.bank_embedding_apply_result(uuid, uuid, text, text, text) to service_role;
