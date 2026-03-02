-- ============================================================
-- Scadenzario v3.1: passive credit notes netting + audit
-- ============================================================

alter table public.invoice_installments
  add column if not exists is_credit_note boolean not null default false;

update public.invoice_installments ii
set is_credit_note = (upper(coalesce(inv.doc_type, '')) in ('TD04', 'TD08'))
from public.invoices inv
where inv.id = ii.invoice_id;

with normalized as (
  select
    ii.id,
    case
      when ii.is_credit_note then -abs(coalesce(ii.amount_due, 0))
      else abs(coalesce(ii.amount_due, 0))
    end::numeric(15,2) as signed_due
  from public.invoice_installments ii
)
update public.invoice_installments ii
set
  amount_due = n.signed_due,
  paid_amount = least(abs(n.signed_due), greatest(coalesce(ii.paid_amount, 0), 0))::numeric(15,2),
  status = case
    when greatest(abs(n.signed_due) - least(abs(n.signed_due), greatest(coalesce(ii.paid_amount, 0), 0)), 0) <= 0.01 then 'paid'
    when least(abs(n.signed_due), greatest(coalesce(ii.paid_amount, 0), 0)) > 0 then 'partial'
    when ii.due_date < current_date then 'overdue'
    else 'pending'
  end,
  updated_at = now()
from normalized n
where n.id = ii.id;

create index if not exists idx_invoice_installments_company_counterparty_nc_status_due
  on public.invoice_installments(company_id, counterparty_id, direction, is_credit_note, status, due_date);

create index if not exists idx_invoice_installments_company_invoice_status
  on public.invoice_installments(company_id, invoice_id, status);

create table if not exists public.invoice_installment_compensations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  debit_installment_id uuid not null references public.invoice_installments(id) on delete cascade,
  credit_installment_id uuid not null references public.invoice_installments(id) on delete cascade,
  amount numeric(15,2) not null check (amount > 0),
  compensated_at date not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_invoice_installment_compensations_company_date
  on public.invoice_installment_compensations(company_id, compensated_at desc);

create index if not exists idx_invoice_installment_compensations_debit
  on public.invoice_installment_compensations(debit_installment_id);

create index if not exists idx_invoice_installment_compensations_credit
  on public.invoice_installment_compensations(credit_installment_id);

alter table public.invoice_installment_compensations enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installment_compensations'
      and policyname = 'iic_select'
  ) then
    create policy "iic_select"
      on public.invoice_installment_compensations
      for select
      using (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installment_compensations'
      and policyname = 'iic_insert'
  ) then
    create policy "iic_insert"
      on public.invoice_installment_compensations
      for insert
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installment_compensations'
      and policyname = 'iic_update'
  ) then
    create policy "iic_update"
      on public.invoice_installment_compensations
      for update
      using (is_company_member(company_id))
      with check (is_company_member(company_id));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'invoice_installment_compensations'
      and policyname = 'iic_delete'
  ) then
    create policy "iic_delete"
      on public.invoice_installment_compensations
      for delete
      using (is_company_member(company_id));
  end if;
end $$;

create or replace function public.scadenzario_recompute_invoice_payment_snapshot(
  p_company_id uuid,
  p_invoice_id uuid,
  p_reference_date date default current_date
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_total int := 0;
  v_all_paid boolean := false;
  v_any_partial boolean := false;
  v_any_overdue boolean := false;
  v_first_open_due date := null;
  v_last_due date := null;
  v_last_paid_date date := null;
  v_status text := 'pending';
begin
  select
    count(*)::int,
    coalesce(bool_and(greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) <= 0.01), false),
    coalesce(bool_or(coalesce(ii.paid_amount, 0) > 0 and greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) > 0.01), false),
    coalesce(bool_or(greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) > 0.01 and ii.due_date < current_date), false),
    min(ii.due_date) filter (where greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) > 0.01),
    max(ii.due_date),
    max(ii.last_payment_date)
  into
    v_total,
    v_all_paid,
    v_any_partial,
    v_any_overdue,
    v_first_open_due,
    v_last_due,
    v_last_paid_date
  from public.invoice_installments ii
  where ii.company_id = p_company_id
    and ii.invoice_id = p_invoice_id;

  if v_total = 0 then
    v_status := 'pending';
  elsif v_all_paid then
    v_status := 'paid';
  elsif v_any_partial then
    v_status := 'partial';
  elsif v_any_overdue then
    v_status := 'overdue';
  else
    v_status := 'pending';
  end if;

  update public.invoices i
  set
    payment_status = v_status,
    payment_due_date = coalesce(v_first_open_due, v_last_due, i.payment_due_date),
    paid_date = case when v_status = 'paid' then coalesce(v_last_paid_date, p_reference_date) else null end,
    updated_at = now()
  where i.company_id = p_company_id
    and i.id = p_invoice_id;
end;
$$;

create or replace function public.scadenzario_settle_installment(
  p_company_id uuid,
  p_installment_id uuid,
  p_payment_date date,
  p_cash_amount numeric,
  p_mode text
)
returns table(
  mode text,
  debit_open numeric(15,2),
  credit_available numeric(15,2),
  credit_used numeric(15,2),
  cash_paid numeric(15,2),
  credit_residual numeric(15,2),
  affected_installments int,
  affected_invoices int
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_mode text := lower(coalesce(p_mode, 'cash'));
  v_payment_date date := coalesce(p_payment_date, current_date);
  v_cash_input numeric(15,2) := round(greatest(coalesce(p_cash_amount, 0), 0)::numeric, 2);

  v_target record;
  v_debit_open numeric(15,2) := 0;
  v_credit_available numeric(15,2) := 0;
  v_credit_used numeric(15,2) := 0;
  v_credit_to_consume numeric(15,2) := 0;
  v_cash_paid numeric(15,2) := 0;
  v_credit_residual numeric(15,2) := 0;

  v_target_next_paid numeric(15,2) := 0;
  v_target_next_status text := 'pending';

  v_credit_row record;
  v_credit_open numeric(15,2) := 0;
  v_use numeric(15,2) := 0;
  v_credit_next_paid numeric(15,2) := 0;
  v_credit_next_status text := 'pending';

  v_affected_installments int := 0;
  v_affected_invoice_ids uuid[] := '{}';
  v_affected_invoices int := 0;
  v_invoice_id uuid;
begin
  if v_user_id is null then
    raise exception 'Utente non autenticato' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.company_members cm
    where cm.company_id = p_company_id
      and cm.user_id = v_user_id
  ) then
    raise exception 'Permesso negato su azienda %', p_company_id using errcode = '42501';
  end if;

  if v_mode not in ('cash', 'net') then
    raise exception 'Modalita non valida: %', v_mode using errcode = '22023';
  end if;

  select
    ii.id,
    ii.invoice_id,
    ii.counterparty_id,
    ii.direction,
    ii.is_credit_note,
    ii.amount_due,
    ii.paid_amount,
    ii.due_date,
    ii.status
  into v_target
  from public.invoice_installments ii
  where ii.company_id = p_company_id
    and ii.id = p_installment_id
  for update;

  if not found then
    raise exception 'Installment non trovato' using errcode = 'P0002';
  end if;

  if v_target.direction <> 'in' then
    raise exception 'Compensazione disponibile solo su pagamenti fornitori' using errcode = '22023';
  end if;

  if v_target.is_credit_note or coalesce(v_target.amount_due, 0) <= 0 then
    raise exception 'Installment target non valido: deve essere un debito positivo' using errcode = '22023';
  end if;

  v_debit_open := round(greatest(abs(coalesce(v_target.amount_due, 0)) - coalesce(v_target.paid_amount, 0), 0)::numeric, 2);
  if v_debit_open <= 0.01 then
    raise exception 'Installment gia saldato' using errcode = '22023';
  end if;

  select coalesce(sum(greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0)), 0)::numeric(15,2)
  into v_credit_available
  from public.invoice_installments ii
  where ii.company_id = p_company_id
    and ii.counterparty_id = v_target.counterparty_id
    and ii.direction = 'in'
    and (ii.is_credit_note or coalesce(ii.amount_due, 0) < 0)
    and ii.status in ('pending', 'overdue', 'partial')
    and greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) > 0.01;

  if v_mode = 'net' then
    v_cash_paid := round(greatest(v_debit_open - v_credit_available, 0)::numeric, 2);
    if abs(v_cash_paid - v_cash_input) > 0.01 then
      raise exception 'Importo netto non coerente. Atteso %, ricevuto %', v_cash_paid, v_cash_input using errcode = '22023';
    end if;
    v_credit_to_consume := round((v_debit_open - v_cash_paid)::numeric, 2);
    v_target_next_paid := round(least(abs(v_target.amount_due), coalesce(v_target.paid_amount, 0) + v_debit_open)::numeric, 2);
  else
    v_cash_paid := round(least(v_cash_input, v_debit_open)::numeric, 2);
    v_target_next_paid := round(least(abs(v_target.amount_due), coalesce(v_target.paid_amount, 0) + v_cash_paid)::numeric, 2);
  end if;

  v_target_next_status := case
    when greatest(abs(v_target.amount_due) - v_target_next_paid, 0) <= 0.01 then 'paid'
    when v_target_next_paid > 0 then 'partial'
    when v_target.due_date < current_date then 'overdue'
    else 'pending'
  end;

  update public.invoice_installments ii
  set
    paid_amount = v_target_next_paid,
    last_payment_date = v_payment_date,
    status = v_target_next_status,
    updated_at = now()
  where ii.id = v_target.id;

  v_affected_installments := v_affected_installments + 1;
  v_affected_invoice_ids := array_append(v_affected_invoice_ids, v_target.invoice_id);

  if v_mode = 'net' and v_credit_to_consume > 0.01 then
    for v_credit_row in
      select
        ii.id,
        ii.invoice_id,
        ii.amount_due,
        ii.paid_amount,
        ii.due_date
      from public.invoice_installments ii
      where ii.company_id = p_company_id
        and ii.counterparty_id = v_target.counterparty_id
        and ii.direction = 'in'
        and (ii.is_credit_note or coalesce(ii.amount_due, 0) < 0)
        and ii.status in ('pending', 'overdue', 'partial')
        and greatest(abs(coalesce(ii.amount_due, 0)) - coalesce(ii.paid_amount, 0), 0) > 0.01
      order by ii.due_date asc, ii.id asc
      for update
    loop
      exit when v_credit_to_consume <= 0.01;

      v_credit_open := round(greatest(abs(v_credit_row.amount_due) - coalesce(v_credit_row.paid_amount, 0), 0)::numeric, 2);
      if v_credit_open <= 0.01 then
        continue;
      end if;

      v_use := round(least(v_credit_open, v_credit_to_consume)::numeric, 2);
      if v_use <= 0.01 then
        continue;
      end if;

      v_credit_next_paid := round(least(abs(v_credit_row.amount_due), coalesce(v_credit_row.paid_amount, 0) + v_use)::numeric, 2);
      v_credit_next_status := case
        when greatest(abs(v_credit_row.amount_due) - v_credit_next_paid, 0) <= 0.01 then 'paid'
        when v_credit_next_paid > 0 then 'partial'
        when v_credit_row.due_date < current_date then 'overdue'
        else 'pending'
      end;

      update public.invoice_installments ii
      set
        paid_amount = v_credit_next_paid,
        last_payment_date = v_payment_date,
        status = v_credit_next_status,
        updated_at = now()
      where ii.id = v_credit_row.id;

      insert into public.invoice_installment_compensations(
        company_id,
        debit_installment_id,
        credit_installment_id,
        amount,
        compensated_at,
        created_by
      ) values (
        p_company_id,
        v_target.id,
        v_credit_row.id,
        v_use,
        v_payment_date,
        v_user_id
      );

      v_credit_used := round(v_credit_used + v_use, 2);
      v_credit_to_consume := round(v_credit_to_consume - v_use, 2);
      v_affected_installments := v_affected_installments + 1;
      v_affected_invoice_ids := array_append(v_affected_invoice_ids, v_credit_row.invoice_id);
    end loop;

    if v_credit_to_consume > 0.01 then
      raise exception 'Credito NC non sufficiente al momento della compensazione' using errcode = '40001';
    end if;
  end if;

  v_credit_residual := round(greatest(v_credit_available - v_credit_used, 0)::numeric, 2);

  for v_invoice_id in
    select distinct x
    from unnest(v_affected_invoice_ids) as u(x)
    where x is not null
  loop
    perform public.scadenzario_recompute_invoice_payment_snapshot(p_company_id, v_invoice_id, v_payment_date);
    v_affected_invoices := v_affected_invoices + 1;
  end loop;

  return query
  select
    v_mode::text,
    v_debit_open::numeric(15,2),
    v_credit_available::numeric(15,2),
    v_credit_used::numeric(15,2),
    v_cash_paid::numeric(15,2),
    v_credit_residual::numeric(15,2),
    v_affected_installments,
    v_affected_invoices;
end;
$$;

create or replace function public.scadenzario_audit_totals(
  p_company_id uuid
)
returns table(
  invoices_count bigint,
  invoices_covered bigint,
  missing_count bigint,
  orphan_count bigint,
  duplicate_count bigint,
  fatture_incassi_netto numeric(15,2),
  fatture_uscite_netto numeric(15,2),
  scadenzario_incassi_netto numeric(15,2),
  scadenzario_uscite_netto numeric(15,2),
  delta_incassi numeric(15,2),
  delta_uscite numeric(15,2)
)
language plpgsql
security invoker
set search_path = public
as $$
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

  return query
  with inv as (
    select
      count(*)::bigint as invoices_count,
      coalesce(sum(case
        when i.direction = 'out' then
          case when upper(coalesce(i.doc_type, '')) in ('TD04', 'TD08') then -abs(coalesce(i.total_amount, 0)) else abs(coalesce(i.total_amount, 0)) end
        else 0 end), 0)::numeric(15,2) as fatture_incassi_netto,
      coalesce(sum(case
        when i.direction = 'in' then
          case when upper(coalesce(i.doc_type, '')) in ('TD04', 'TD08') then -abs(coalesce(i.total_amount, 0)) else abs(coalesce(i.total_amount, 0)) end
        else 0 end), 0)::numeric(15,2) as fatture_uscite_netto
    from public.invoices i
    where i.company_id = p_company_id
  ),
  inst as (
    select
      count(*)::bigint as installments_count,
      count(distinct ii.invoice_id)::bigint as invoices_covered,
      coalesce(sum(case when ii.direction = 'out' then coalesce(ii.amount_due, 0) else 0 end), 0)::numeric(15,2) as scadenzario_incassi_netto,
      coalesce(sum(case when ii.direction = 'in' then coalesce(ii.amount_due, 0) else 0 end), 0)::numeric(15,2) as scadenzario_uscite_netto
    from public.invoice_installments ii
    where ii.company_id = p_company_id
  ),
  missing as (
    select count(*)::bigint as missing_count
    from public.invoices i
    where i.company_id = p_company_id
      and not exists (
        select 1
        from public.invoice_installments ii
        where ii.company_id = i.company_id
          and ii.invoice_id = i.id
      )
  ),
  orphan as (
    select count(*)::bigint as orphan_count
    from public.invoice_installments ii
    where ii.company_id = p_company_id
      and not exists (
        select 1
        from public.invoices i
        where i.id = ii.invoice_id
      )
  ),
  dup as (
    select count(*)::bigint as duplicate_count
    from (
      select ii.invoice_id, ii.installment_no
      from public.invoice_installments ii
      where ii.company_id = p_company_id
      group by ii.invoice_id, ii.installment_no
      having count(*) > 1
    ) d
  )
  select
    inv.invoices_count,
    inst.invoices_covered,
    missing.missing_count,
    orphan.orphan_count,
    dup.duplicate_count,
    inv.fatture_incassi_netto,
    inv.fatture_uscite_netto,
    inst.scadenzario_incassi_netto,
    inst.scadenzario_uscite_netto,
    round((inst.scadenzario_incassi_netto - inv.fatture_incassi_netto)::numeric, 2)::numeric(15,2) as delta_incassi,
    round((inst.scadenzario_uscite_netto - inv.fatture_uscite_netto)::numeric, 2)::numeric(15,2) as delta_uscite
  from inv
  cross join inst
  cross join missing
  cross join orphan
  cross join dup;
end;
$$;

grant execute on function public.scadenzario_settle_installment(uuid, uuid, date, numeric, text) to authenticated;
grant execute on function public.scadenzario_settle_installment(uuid, uuid, date, numeric, text) to service_role;

grant execute on function public.scadenzario_recompute_invoice_payment_snapshot(uuid, uuid, date) to authenticated;
grant execute on function public.scadenzario_recompute_invoice_payment_snapshot(uuid, uuid, date) to service_role;

grant execute on function public.scadenzario_audit_totals(uuid) to authenticated;
grant execute on function public.scadenzario_audit_totals(uuid) to service_role;
