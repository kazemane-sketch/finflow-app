-- ============================================================
-- VAT v2 incremental recompute RPC (Postgres-first)
-- ============================================================

create index if not exists idx_invoice_vat_entries_company_invoice
  on public.invoice_vat_entries(company_id, invoice_id);

create index if not exists idx_invoice_vat_entries_company_effective
  on public.invoice_vat_entries(company_id, status, effective_date);

create or replace function public.vat_to_business_day(p_date date)
returns date
language plpgsql
immutable
as $$
declare
  v_date date := p_date;
begin
  while extract(isodow from v_date) in (6, 7) loop
    v_date := v_date + 1;
  end loop;
  return v_date;
end;
$$;

create or replace function public.recompute_vat_periods_incremental(
  p_company_id uuid,
  p_start_date date default null,
  p_force_full boolean default false
)
returns table(
  periods_upserted int,
  snapshot_entries_written int,
  from_period text,
  to_period text,
  elapsed_ms int,
  status text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_started_at timestamptz := clock_timestamp();
  v_lock_key bigint := hashtextextended('vat_recompute:' || p_company_id::text, 0);
  v_lock_acquired boolean := false;

  v_regime text;
  v_profile_start date;
  v_profile_period_start date;
  v_scope_start date;
  v_end_date date;
  v_max_effective date;
  v_opening_credit numeric(15,2);
  v_opening_debit numeric(15,2);
  v_acconto_override numeric(15,2);

  v_prev_year int;
  v_prev_index int;
  v_prev_status text;
  v_prev_paid_amount numeric(15,2);
  v_prev_paid_at timestamptz;
  v_prev_payment_method text;
  v_prev_payment_note text;

  v_carry_credit numeric(15,2) := 0;
  v_carry_under_threshold numeric(15,2) := 0;

  v_period_rec record;
  v_vat_debit numeric(15,2);
  v_vat_credit numeric(15,2);
  v_entry_count int;
  v_prev_credit_used numeric(15,2);
  v_prev_under_used numeric(15,2);
  v_base_balance numeric(15,2);
  v_quarterly_interest numeric(15,2);
  v_saldo numeric(15,2);
  v_amount_due numeric(15,2);
  v_amount_credit_carry numeric(15,2);
  v_status text;
  v_paid_amount numeric(15,2);
  v_paid_at timestamptz;
  v_payment_method text;
  v_payment_note text;

  v_start_year int;
  v_end_year int;
  v_year int;
  v_prev_year_due numeric(15,2);
  v_prev_year_index int;
  v_due_date date;
  v_acconto_due numeric(15,2);
  v_now_iso timestamptz := now();

  v_periods_upserted int := 0;
  v_snapshot_rows int := 0;
  v_from_period text;
  v_to_period text;
begin
  if auth.uid() is null then
    raise exception 'Utente non autenticato' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = auth.uid()
  ) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  select
    cvp.liquidation_regime,
    cvp.start_date,
    coalesce(cvp.opening_vat_credit, 0),
    coalesce(cvp.opening_vat_debit, 0),
    cvp.acconto_override_amount
  into
    v_regime,
    v_profile_start,
    v_opening_credit,
    v_opening_debit,
    v_acconto_override
  from public.company_vat_profiles cvp
  where cvp.company_id = p_company_id;

  if v_regime is null then
    raise exception 'Profilo IVA non configurato' using errcode = 'P0001';
  end if;

  v_lock_acquired := pg_try_advisory_lock(v_lock_key);
  if not v_lock_acquired then
    return query
    select
      0::int,
      0::int,
      null::text,
      null::text,
      (extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::int,
      'locked'::text;
    return;
  end if;

  if v_regime = 'monthly' then
    v_profile_period_start := date_trunc('month', v_profile_start)::date;
  else
    v_profile_period_start := date_trunc('quarter', v_profile_start)::date;
  end if;

  if p_force_full or p_start_date is null then
    v_scope_start := v_profile_period_start;
  else
    v_scope_start := greatest(v_profile_start, p_start_date);
    if v_regime = 'monthly' then
      v_scope_start := date_trunc('month', v_scope_start)::date;
    else
      v_scope_start := date_trunc('quarter', v_scope_start)::date;
    end if;
  end if;

  select max(e.effective_date)::date
  into v_max_effective
  from public.invoice_vat_entries e
  where e.company_id = p_company_id
    and e.status = 'effective'
    and e.effective_date is not null
    and e.effective_date >= v_profile_start;

  v_end_date := greatest(current_date, coalesce(v_max_effective, current_date));
  if v_regime = 'monthly' then
    v_end_date := date_trunc('month', v_end_date)::date;
  else
    v_end_date := date_trunc('quarter', v_end_date)::date;
  end if;

  if v_scope_start > v_end_date then
    v_end_date := v_scope_start;
  end if;

  if not p_force_full and v_scope_start > v_profile_period_start then
    if v_regime = 'monthly' then
      v_prev_year := extract(year from (v_scope_start - interval '1 month'))::int;
      v_prev_index := extract(month from (v_scope_start - interval '1 month'))::int;
    else
      v_prev_year := extract(year from (v_scope_start - interval '3 month'))::int;
      v_prev_index := extract(quarter from (v_scope_start - interval '3 month'))::int;
    end if;

    select
      p.status,
      p.amount_credit_carry,
      coalesce((p.snapshot_json ->> 'saldo')::numeric, 0)
    into
      v_prev_status,
      v_carry_credit,
      v_carry_under_threshold
    from public.vat_periods p
    where p.company_id = p_company_id
      and p.period_type = 'regular'
      and p.year = v_prev_year
      and p.period_index = v_prev_index
    limit 1;

    if not found then
      v_scope_start := v_profile_period_start;
      v_carry_credit := v_opening_credit;
      v_carry_under_threshold := v_opening_debit;
    else
      if v_prev_status <> 'credit' then
        v_carry_credit := 0;
      end if;
      if v_prev_status <> 'under_threshold' then
        v_carry_under_threshold := 0;
      end if;
    end if;
  else
    v_carry_credit := v_opening_credit;
    v_carry_under_threshold := v_opening_debit;
  end if;

  create temporary table tmp_scope (
    period_start date not null,
    period_end date not null,
    year int not null,
    period_index int not null,
    due_date date not null
  ) on commit drop;

  if v_regime = 'monthly' then
    insert into tmp_scope (period_start, period_end, year, period_index, due_date)
    select
      gs::date as period_start,
      (date_trunc('month', gs) + interval '1 month - 1 day')::date as period_end,
      extract(year from gs)::int as year,
      extract(month from gs)::int as period_index,
      public.vat_to_business_day((date_trunc('month', gs + interval '1 month') + interval '15 day')::date) as due_date
    from generate_series(v_scope_start, v_end_date, interval '1 month') as gs;
  else
    insert into tmp_scope (period_start, period_end, year, period_index, due_date)
    select
      gs::date as period_start,
      (date_trunc('quarter', gs) + interval '3 month - 1 day')::date as period_end,
      extract(year from gs)::int as year,
      extract(quarter from gs)::int as period_index,
      public.vat_to_business_day(
        case extract(quarter from gs)::int
          when 1 then make_date(extract(year from gs)::int, 5, 16)
          when 2 then make_date(extract(year from gs)::int, 8, 20)
          when 3 then make_date(extract(year from gs)::int, 11, 16)
          else make_date(extract(year from gs)::int + 1, 3, 16)
        end
      ) as due_date
    from generate_series(v_scope_start, v_end_date, interval '3 month') as gs;
  end if;

  create temporary table tmp_agg on commit drop as
  select
    case
      when v_regime = 'monthly' then date_trunc('month', e.effective_date)::date
      else date_trunc('quarter', e.effective_date)::date
    end as period_start,
    round(sum(coalesce(e.vat_debit_amount, 0))::numeric, 2) as vat_debit,
    round(sum(coalesce(e.vat_credit_amount, 0))::numeric, 2) as vat_credit,
    count(*)::int as entry_count
  from public.invoice_vat_entries e
  where e.company_id = p_company_id
    and e.status = 'effective'
    and e.effective_date is not null
    and e.effective_date >= v_profile_start
  group by 1;

  create temporary table tmp_regular_result (
    company_id uuid not null,
    regime text not null,
    period_type text not null,
    year int not null,
    period_index int not null,
    period_start date not null,
    period_end date not null,
    due_date date not null,
    vat_debit numeric(15,2) not null,
    vat_credit numeric(15,2) not null,
    prev_credit_used numeric(15,2) not null,
    prev_debit_under_threshold numeric(15,2) not null,
    quarterly_interest numeric(15,2) not null,
    acconto_amount numeric(15,2),
    amount_due numeric(15,2) not null,
    amount_credit_carry numeric(15,2) not null,
    status text not null,
    snapshot_json jsonb,
    paid_amount numeric(15,2),
    paid_at timestamptz,
    payment_method text,
    payment_note text,
    generated_at timestamptz not null,
    updated_at timestamptz not null
  ) on commit drop;

  for v_period_rec in
    select *
    from tmp_scope
    order by period_start
  loop
    select
      coalesce(a.vat_debit, 0),
      coalesce(a.vat_credit, 0),
      coalesce(a.entry_count, 0)
    into
      v_vat_debit,
      v_vat_credit,
      v_entry_count
    from tmp_agg a
    where a.period_start = v_period_rec.period_start;

    if not found then
      v_vat_debit := 0;
      v_vat_credit := 0;
      v_entry_count := 0;
    end if;

    v_prev_credit_used := v_carry_credit;
    v_prev_under_used := v_carry_under_threshold;
    v_base_balance := round((v_vat_debit - v_vat_credit - v_prev_credit_used + v_prev_under_used)::numeric, 2);
    v_quarterly_interest := 0;
    if v_regime = 'quarterly' and v_base_balance > 0 then
      v_quarterly_interest := round((v_base_balance * 0.01)::numeric, 2);
    end if;
    v_saldo := round((v_base_balance + v_quarterly_interest)::numeric, 2);

    v_amount_due := 0;
    v_amount_credit_carry := 0;
    v_status := 'draft';
    v_paid_amount := null;
    v_paid_at := null;
    v_payment_method := null;
    v_payment_note := null;

    if v_saldo > 0 then
      if v_saldo < 100 then
        v_status := 'under_threshold';
        v_carry_under_threshold := v_saldo;
        v_carry_credit := 0;
      else
        if v_period_rec.due_date < current_date then
          v_status := 'overdue';
        else
          v_status := 'to_pay';
        end if;
        v_amount_due := v_saldo;
        v_carry_under_threshold := 0;
        v_carry_credit := 0;
      end if;
    elsif v_saldo < 0 then
      v_status := 'credit';
      v_amount_credit_carry := round(abs(v_saldo)::numeric, 2);
      v_carry_credit := v_amount_credit_carry;
      v_carry_under_threshold := 0;
    else
      v_status := 'draft';
      v_carry_credit := 0;
      v_carry_under_threshold := 0;
    end if;

    select
      p.status,
      p.paid_amount,
      p.paid_at,
      p.payment_method,
      p.payment_note
    into
      v_prev_status,
      v_prev_paid_amount,
      v_prev_paid_at,
      v_prev_payment_method,
      v_prev_payment_note
    from public.vat_periods p
    where p.company_id = p_company_id
      and p.period_type = 'regular'
      and p.year = v_period_rec.year
      and p.period_index = v_period_rec.period_index
    limit 1;

    if coalesce(v_prev_status, '') = 'paid' then
      v_status := 'paid';
      v_paid_amount := coalesce(v_prev_paid_amount, v_amount_due);
      v_paid_at := coalesce(v_prev_paid_at, now());
      v_payment_method := coalesce(v_prev_payment_method, 'f24');
      v_payment_note := v_prev_payment_note;
    end if;

    insert into tmp_regular_result (
      company_id,
      regime,
      period_type,
      year,
      period_index,
      period_start,
      period_end,
      due_date,
      vat_debit,
      vat_credit,
      prev_credit_used,
      prev_debit_under_threshold,
      quarterly_interest,
      acconto_amount,
      amount_due,
      amount_credit_carry,
      status,
      snapshot_json,
      paid_amount,
      paid_at,
      payment_method,
      payment_note,
      generated_at,
      updated_at
    ) values (
      p_company_id,
      v_regime,
      'regular',
      v_period_rec.year,
      v_period_rec.period_index,
      v_period_rec.period_start,
      v_period_rec.period_end,
      v_period_rec.due_date,
      round(v_vat_debit::numeric, 2),
      round(v_vat_credit::numeric, 2),
      round(v_prev_credit_used::numeric, 2),
      round(v_prev_under_used::numeric, 2),
      round(v_quarterly_interest::numeric, 2),
      null,
      round(v_amount_due::numeric, 2),
      round(v_amount_credit_carry::numeric, 2),
      v_status,
      jsonb_build_object(
        'entry_count', v_entry_count,
        'base_balance', v_base_balance,
        'saldo', v_saldo,
        'snapshot_version', 3,
        'snapshot_storage', 'vat_period_entry_snapshots'
      ),
      v_paid_amount,
      v_paid_at,
      v_payment_method,
      v_payment_note,
      v_now_iso,
      v_now_iso
    );
  end loop;

  select min(year), max(year)
  into v_start_year, v_end_year
  from tmp_scope;

  create temporary table tmp_acconto_result (
    company_id uuid not null,
    regime text not null,
    period_type text not null,
    year int not null,
    period_index int not null,
    period_start date not null,
    period_end date not null,
    due_date date not null,
    vat_debit numeric(15,2) not null,
    vat_credit numeric(15,2) not null,
    prev_credit_used numeric(15,2) not null,
    prev_debit_under_threshold numeric(15,2) not null,
    quarterly_interest numeric(15,2) not null,
    acconto_amount numeric(15,2),
    amount_due numeric(15,2) not null,
    amount_credit_carry numeric(15,2) not null,
    status text not null,
    snapshot_json jsonb,
    paid_amount numeric(15,2),
    paid_at timestamptz,
    payment_method text,
    payment_note text,
    generated_at timestamptz not null,
    updated_at timestamptz not null
  ) on commit drop;

  if v_start_year is not null and v_end_year is not null then
    for v_year in v_start_year..v_end_year loop
      if v_regime = 'monthly' then
        v_prev_year_index := 12;
      else
        v_prev_year_index := 4;
      end if;

      select amount_due
      into v_prev_year_due
      from tmp_regular_result r
      where r.year = v_year - 1
        and r.period_index = v_prev_year_index
      limit 1;

      if v_prev_year_due is null then
        select p.amount_due
        into v_prev_year_due
        from public.vat_periods p
        where p.company_id = p_company_id
          and p.period_type = 'regular'
          and p.year = v_year - 1
          and p.period_index = v_prev_year_index
        limit 1;
      end if;

      if coalesce(v_prev_year_due, 0) > 0 then
        v_acconto_due := round((v_prev_year_due * 0.88)::numeric, 2);
      else
        v_acconto_due := 0;
      end if;

      if v_year = extract(year from current_date)::int and v_acconto_override is not null then
        v_acconto_due := round(v_acconto_override::numeric, 2);
      end if;

      v_due_date := public.vat_to_business_day(make_date(v_year, 12, 27));
      if v_acconto_due > 0 then
        if v_due_date < current_date then
          v_status := 'overdue';
        else
          v_status := 'to_pay';
        end if;
      else
        v_status := 'draft';
      end if;

      v_paid_amount := null;
      v_paid_at := null;
      v_payment_method := null;
      v_payment_note := null;

      select
        p.status,
        p.paid_amount,
        p.paid_at,
        p.payment_method,
        p.payment_note
      into
        v_prev_status,
        v_prev_paid_amount,
        v_prev_paid_at,
        v_prev_payment_method,
        v_prev_payment_note
      from public.vat_periods p
      where p.company_id = p_company_id
        and p.period_type = 'acconto'
        and p.year = v_year
        and p.period_index = 0
      limit 1;

      if coalesce(v_prev_status, '') = 'paid' then
        v_status := 'paid';
        v_paid_amount := coalesce(v_prev_paid_amount, v_acconto_due);
        v_paid_at := coalesce(v_prev_paid_at, now());
        v_payment_method := coalesce(v_prev_payment_method, 'f24');
        v_payment_note := v_prev_payment_note;
      end if;

      insert into tmp_acconto_result (
        company_id,
        regime,
        period_type,
        year,
        period_index,
        period_start,
        period_end,
        due_date,
        vat_debit,
        vat_credit,
        prev_credit_used,
        prev_debit_under_threshold,
        quarterly_interest,
        acconto_amount,
        amount_due,
        amount_credit_carry,
        status,
        snapshot_json,
        paid_amount,
        paid_at,
        payment_method,
        payment_note,
        generated_at,
        updated_at
      ) values (
        p_company_id,
        v_regime,
        'acconto',
        v_year,
        0,
        make_date(v_year, 12, 1),
        make_date(v_year, 12, 31),
        v_due_date,
        0,
        0,
        0,
        0,
        0,
        v_acconto_due,
        v_acconto_due,
        0,
        v_status,
        jsonb_build_object(
          'method', 'historical',
          'base_previous_year_due', v_prev_year_due,
          'requires_manual_override', (v_prev_year_due is null and v_year = extract(year from current_date)::int),
          'snapshot_version', 3
        ),
        v_paid_amount,
        v_paid_at,
        v_payment_method,
        v_payment_note,
        v_now_iso,
        v_now_iso
      );
    end loop;
  end if;

  create temporary table tmp_upsert_ids (
    id uuid not null,
    period_type text not null,
    year int not null,
    period_index int not null,
    period_start date not null,
    period_end date not null
  ) on commit drop;

  with upserted_regular as (
    insert into public.vat_periods (
      company_id,
      regime,
      period_type,
      year,
      period_index,
      period_start,
      period_end,
      due_date,
      vat_debit,
      vat_credit,
      prev_credit_used,
      prev_debit_under_threshold,
      quarterly_interest,
      acconto_amount,
      amount_due,
      amount_credit_carry,
      status,
      snapshot_json,
      paid_amount,
      paid_at,
      payment_method,
      payment_note,
      generated_at,
      updated_at
    )
    select
      r.company_id,
      r.regime,
      r.period_type,
      r.year,
      r.period_index,
      r.period_start,
      r.period_end,
      r.due_date,
      r.vat_debit,
      r.vat_credit,
      r.prev_credit_used,
      r.prev_debit_under_threshold,
      r.quarterly_interest,
      r.acconto_amount,
      r.amount_due,
      r.amount_credit_carry,
      r.status,
      r.snapshot_json,
      r.paid_amount,
      r.paid_at,
      r.payment_method,
      r.payment_note,
      r.generated_at,
      r.updated_at
    from tmp_regular_result r
    on conflict (company_id, period_type, year, period_index)
    do update set
      regime = excluded.regime,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      due_date = excluded.due_date,
      vat_debit = excluded.vat_debit,
      vat_credit = excluded.vat_credit,
      prev_credit_used = excluded.prev_credit_used,
      prev_debit_under_threshold = excluded.prev_debit_under_threshold,
      quarterly_interest = excluded.quarterly_interest,
      acconto_amount = excluded.acconto_amount,
      amount_due = excluded.amount_due,
      amount_credit_carry = excluded.amount_credit_carry,
      status = excluded.status,
      snapshot_json = excluded.snapshot_json,
      paid_amount = excluded.paid_amount,
      paid_at = excluded.paid_at,
      payment_method = excluded.payment_method,
      payment_note = excluded.payment_note,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at
    returning id, period_type, year, period_index, period_start, period_end
  )
  insert into tmp_upsert_ids (id, period_type, year, period_index, period_start, period_end)
  select id, period_type, year, period_index, period_start, period_end
  from upserted_regular;

  with upserted_acconto as (
    insert into public.vat_periods (
      company_id,
      regime,
      period_type,
      year,
      period_index,
      period_start,
      period_end,
      due_date,
      vat_debit,
      vat_credit,
      prev_credit_used,
      prev_debit_under_threshold,
      quarterly_interest,
      acconto_amount,
      amount_due,
      amount_credit_carry,
      status,
      snapshot_json,
      paid_amount,
      paid_at,
      payment_method,
      payment_note,
      generated_at,
      updated_at
    )
    select
      a.company_id,
      a.regime,
      a.period_type,
      a.year,
      a.period_index,
      a.period_start,
      a.period_end,
      a.due_date,
      a.vat_debit,
      a.vat_credit,
      a.prev_credit_used,
      a.prev_debit_under_threshold,
      a.quarterly_interest,
      a.acconto_amount,
      a.amount_due,
      a.amount_credit_carry,
      a.status,
      a.snapshot_json,
      a.paid_amount,
      a.paid_at,
      a.payment_method,
      a.payment_note,
      a.generated_at,
      a.updated_at
    from tmp_acconto_result a
    on conflict (company_id, period_type, year, period_index)
    do update set
      regime = excluded.regime,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      due_date = excluded.due_date,
      vat_debit = excluded.vat_debit,
      vat_credit = excluded.vat_credit,
      prev_credit_used = excluded.prev_credit_used,
      prev_debit_under_threshold = excluded.prev_debit_under_threshold,
      quarterly_interest = excluded.quarterly_interest,
      acconto_amount = excluded.acconto_amount,
      amount_due = excluded.amount_due,
      amount_credit_carry = excluded.amount_credit_carry,
      status = excluded.status,
      snapshot_json = excluded.snapshot_json,
      paid_amount = excluded.paid_amount,
      paid_at = excluded.paid_at,
      payment_method = excluded.payment_method,
      payment_note = excluded.payment_note,
      generated_at = excluded.generated_at,
      updated_at = excluded.updated_at
    returning id, period_type, year, period_index, period_start, period_end
  )
  insert into tmp_upsert_ids (id, period_type, year, period_index, period_start, period_end)
  select id, period_type, year, period_index, period_start, period_end
  from upserted_acconto;

  select count(*)::int
  into v_periods_upserted
  from tmp_upsert_ids;

  delete from public.vat_period_entry_snapshots s
  where s.company_id = p_company_id
    and s.vat_period_id in (
      select u.id
      from tmp_upsert_ids u
      where u.period_type = 'regular'
    );

  insert into public.vat_period_entry_snapshots (
    company_id,
    vat_period_id,
    period_key,
    invoice_vat_entry_id,
    entry_payload
  )
  select
    p_company_id,
    u.id,
    format('regular:%s:%s', u.year, u.period_index),
    e.id,
    to_jsonb(e)
  from tmp_upsert_ids u
  join public.invoice_vat_entries e
    on u.period_type = 'regular'
   and e.company_id = p_company_id
   and e.status = 'effective'
   and e.effective_date is not null
   and e.effective_date >= v_profile_start
   and e.effective_date between u.period_start and u.period_end;

  get diagnostics v_snapshot_rows = row_count;

  if v_regime = 'monthly' then
    v_from_period := format('regular:%s:%s', extract(year from v_scope_start)::int, extract(month from v_scope_start)::int);
    v_to_period := format('regular:%s:%s', extract(year from v_end_date)::int, extract(month from v_end_date)::int);
  else
    v_from_period := format('regular:%s:%s', extract(year from v_scope_start)::int, extract(quarter from v_scope_start)::int);
    v_to_period := format('regular:%s:%s', extract(year from v_end_date)::int, extract(quarter from v_end_date)::int);
  end if;

  perform pg_advisory_unlock(v_lock_key);
  v_lock_acquired := false;

  return query
  select
    v_periods_upserted,
    v_snapshot_rows,
    v_from_period,
    v_to_period,
    (extract(epoch from (clock_timestamp() - v_started_at)) * 1000)::int,
    'ok'::text;
exception
  when others then
    if v_lock_acquired then
      perform pg_advisory_unlock(v_lock_key);
    end if;
    raise;
end;
$$;

grant execute
  on function public.recompute_vat_periods_incremental(uuid, date, boolean)
  to authenticated;
