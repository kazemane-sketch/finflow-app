-- ============================================================
-- Scadenzario performance RPC (no blocking load)
-- ============================================================

create index if not exists idx_invoice_installments_company_direction_status_due
  on public.invoice_installments(company_id, direction, status, due_date);

create index if not exists idx_invoices_company_number
  on public.invoices(company_id, number);

create index if not exists idx_counterparties_company_name
  on public.counterparties(company_id, name);

create or replace function public.scadenzario_touch_overdue(
  p_company_id uuid
)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_updated int := 0;
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

  update public.invoice_installments ii
  set
    status = 'overdue',
    updated_at = now()
  where ii.company_id = p_company_id
    and ii.status = 'pending'
    and ii.due_date < current_date;

  get diagnostics v_updated = row_count;
  return coalesce(v_updated, 0);
end;
$$;

create or replace function public.scadenzario_health(
  p_company_id uuid
)
returns table(
  invoices_count bigint,
  installments_count bigint,
  needs_backfill boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_invoices bigint := 0;
  v_installments bigint := 0;
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

  select count(*) into v_invoices
  from public.invoices i
  where i.company_id = p_company_id;

  select count(*) into v_installments
  from public.invoice_installments ii
  where ii.company_id = p_company_id;

  return query
  select
    coalesce(v_invoices, 0),
    coalesce(v_installments, 0),
    (coalesce(v_invoices, 0) > 0 and coalesce(v_installments, 0) = 0);
end;
$$;

create or replace function public.scadenzario_kpis(
  p_company_id uuid,
  p_horizon_days int default 30
)
returns table(
  da_incassare numeric(15,2),
  da_pagare numeric(15,2),
  scaduto_clienti numeric(15,2),
  scaduto_fornitori numeric(15,2),
  eventi_iva int
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_horizon int := greatest(coalesce(p_horizon_days, 30), 0);
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
  with installments as (
    select
      ii.direction,
      ii.due_date,
      greatest(coalesce(ii.amount_due, 0) - coalesce(ii.paid_amount, 0), 0)::numeric(15,2) as remaining
    from public.invoice_installments ii
    where ii.company_id = p_company_id
      and ii.status in ('pending', 'overdue', 'partial')
  ),
  vat_due as (
    select
      vp.due_date,
      coalesce(vp.amount_due, 0)::numeric(15,2) as amount_due
    from public.vat_periods vp
    where vp.company_id = p_company_id
      and vp.amount_due > 0
      and vp.status in ('to_pay', 'overdue')
  )
  select
    coalesce(sum(case when i.direction = 'out' and i.due_date between current_date and (current_date + v_horizon) then i.remaining else 0 end), 0)::numeric(15,2) as da_incassare,
    (
      coalesce(sum(case when i.direction = 'in' and i.due_date between current_date and (current_date + v_horizon) then i.remaining else 0 end), 0)
      +
      coalesce((select sum(v.amount_due) from vat_due v where v.due_date between current_date and (current_date + v_horizon)), 0)
    )::numeric(15,2) as da_pagare,
    coalesce(sum(case when i.direction = 'out' and i.due_date < current_date then i.remaining else 0 end), 0)::numeric(15,2) as scaduto_clienti,
    coalesce(sum(case when i.direction = 'in' and i.due_date < current_date then i.remaining else 0 end), 0)::numeric(15,2) as scaduto_fornitori,
    coalesce((select count(*) from vat_due), 0)::int as eventi_iva
  from installments i;
end;
$$;

create or replace function public.scadenzario_aging(
  p_company_id uuid,
  p_mode text default 'incassi',
  p_counterparty_id uuid default null,
  p_query text default null
)
returns table(
  counterparty_id uuid,
  counterparty_name text,
  total numeric(15,2),
  current numeric(15,2),
  bucket_1_30 numeric(15,2),
  bucket_31_60 numeric(15,2),
  bucket_61_90 numeric(15,2),
  bucket_90_plus numeric(15,2),
  total_outstanding numeric(15,2),
  kpi_days numeric(15,2)
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_mode text := case when lower(coalesce(p_mode, 'incassi')) = 'pagamenti' then 'pagamenti' else 'incassi' end;
  v_direction text := case when lower(coalesce(p_mode, 'incassi')) = 'pagamenti' then 'in' else 'out' end;
  v_query text := lower(trim(coalesce(p_query, '')));
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
  with base as (
    select
      ii.counterparty_id,
      coalesce(cp.name, 'Controparte non assegnata') as counterparty_name,
      greatest(coalesce(ii.amount_due, 0) - coalesce(ii.paid_amount, 0), 0)::numeric(15,2) as remaining,
      greatest((current_date - ii.due_date)::int, 0) as overdue_days
    from public.invoice_installments ii
    left join public.counterparties cp on cp.id = ii.counterparty_id
    where ii.company_id = p_company_id
      and ii.direction = v_direction
      and ii.status in ('pending', 'overdue', 'partial')
      and (p_counterparty_id is null or ii.counterparty_id = p_counterparty_id)
      and (
        v_query = ''
        or lower(coalesce(cp.name, '')) like '%' || v_query || '%'
      )
  ),
  grouped as (
    select
      b.counterparty_id,
      b.counterparty_name,
      sum(b.remaining)::numeric(15,2) as total,
      sum(case when b.overdue_days = 0 then b.remaining else 0 end)::numeric(15,2) as current,
      sum(case when b.overdue_days between 1 and 30 then b.remaining else 0 end)::numeric(15,2) as bucket_1_30,
      sum(case when b.overdue_days between 31 and 60 then b.remaining else 0 end)::numeric(15,2) as bucket_31_60,
      sum(case when b.overdue_days between 61 and 90 then b.remaining else 0 end)::numeric(15,2) as bucket_61_90,
      sum(case when b.overdue_days > 90 then b.remaining else 0 end)::numeric(15,2) as bucket_90_plus,
      sum((b.overdue_days::numeric * b.remaining))::numeric(18,2) as weighted_days
    from base b
    group by b.counterparty_id, b.counterparty_name
  ),
  totals as (
    select
      coalesce(sum(g.total), 0)::numeric(15,2) as total_outstanding,
      case
        when coalesce(sum(g.total), 0) > 0 then round((coalesce(sum(g.weighted_days), 0) / sum(g.total))::numeric, 2)
        else 0::numeric
      end as kpi_days
    from grouped g
  )
  select
    g.counterparty_id,
    g.counterparty_name,
    g.total,
    g.current,
    g.bucket_1_30,
    g.bucket_31_60,
    g.bucket_61_90,
    g.bucket_90_plus,
    t.total_outstanding,
    t.kpi_days::numeric(15,2)
  from grouped g
  cross join totals t
  order by g.total desc;
end;
$$;

create or replace function public.scadenzario_list_rows(
  p_company_id uuid,
  p_mode text default 'all',
  p_period_preset text default 'all',
  p_date_from date default null,
  p_date_to date default null,
  p_statuses text[] default null,
  p_counterparty_id uuid default null,
  p_query text default null,
  p_sort_by text default 'due_date',
  p_sort_dir text default 'asc',
  p_page int default 1,
  p_page_size int default 200
)
returns table(
  row_id text,
  kind text,
  due_date date,
  row_type text,
  direction text,
  counterparty_id uuid,
  counterparty_name text,
  reference text,
  reference_link text,
  installment_label text,
  amount numeric(15,2),
  remaining_amount numeric(15,2),
  status text,
  status_label text,
  is_estimated boolean,
  estimate_source text,
  days int,
  notes text,
  total_count bigint
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_mode text := lower(coalesce(p_mode, 'all'));
  v_preset text := lower(coalesce(p_period_preset, 'all'));
  v_query text := lower(trim(coalesce(p_query, '')));
  v_sort_by text := lower(coalesce(p_sort_by, 'due_date'));
  v_sort_dir text := lower(coalesce(p_sort_dir, 'asc'));
  v_page int := greatest(coalesce(p_page, 1), 1);
  v_page_size int := least(greatest(coalesce(p_page_size, 200), 1), 1000);
  v_offset int;
  v_from date;
  v_to date;
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

  if v_mode not in ('all', 'incassi', 'pagamenti') then
    v_mode := 'all';
  end if;

  if v_sort_by not in ('due_date', 'type', 'counterparty', 'reference', 'amount', 'status', 'days') then
    v_sort_by := 'due_date';
  end if;

  if v_sort_dir not in ('asc', 'desc') then
    v_sort_dir := 'asc';
  end if;

  v_offset := (v_page - 1) * v_page_size;

  if v_preset = 'next_7' then
    v_from := current_date;
    v_to := current_date + 7;
  elsif v_preset = 'next_30' then
    v_from := current_date;
    v_to := current_date + 30;
  elsif v_preset = 'next_90' then
    v_from := current_date;
    v_to := current_date + 90;
  elsif v_preset = 'this_month' then
    v_from := date_trunc('month', current_date)::date;
    v_to := (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date;
  elsif v_preset = 'next_month' then
    v_from := date_trunc('month', current_date + interval '1 month')::date;
    v_to := (date_trunc('month', current_date + interval '1 month') + interval '1 month' - interval '1 day')::date;
  elsif v_preset = 'custom' then
    v_from := p_date_from;
    v_to := p_date_to;
  else
    v_from := p_date_from;
    v_to := p_date_to;
  end if;

  return query
  with installment_rows as (
    select
      ii.id::text as row_id,
      'installment'::text as kind,
      ii.due_date,
      case when ii.direction = 'out' then 'incasso' else 'pagamento' end::text as row_type,
      ii.direction::text,
      ii.counterparty_id,
      coalesce(cp.name, 'Controparte non assegnata') as counterparty_name,
      ('Fatt. ' || coalesce(inv.number, 'senza numero'))::text as reference,
      ('/fatture?invoiceId=' || ii.invoice_id::text)::text as reference_link,
      case when ii.installment_total > 1 then (ii.installment_no::text || ' di ' || ii.installment_total::text) else null end::text as installment_label,
      coalesce(ii.amount_due, 0)::numeric(15,2) as amount,
      greatest(coalesce(ii.amount_due, 0) - coalesce(ii.paid_amount, 0), 0)::numeric(15,2) as remaining_amount,
      ii.status::text as status,
      case
        when ii.status = 'paid' and ii.direction = 'out' then 'Incassato'
        when ii.status = 'paid' then 'Pagato'
        when ii.status = 'partial' then 'Parziale'
        when ii.status = 'overdue' then 'Scaduto'
        when ii.direction = 'out' then 'Da incassare'
        else 'Da pagare'
      end::text as status_label,
      ii.is_estimated,
      ii.estimate_source::text,
      (current_date - ii.due_date)::int as days,
      ii.notes
    from public.invoice_installments ii
    left join public.invoices inv on inv.id = ii.invoice_id
    left join public.counterparties cp on cp.id = ii.counterparty_id
    where ii.company_id = p_company_id
  ),
  vat_rows as (
    select
      vp.id::text as row_id,
      'vat'::text as kind,
      vp.due_date,
      'iva'::text as row_type,
      'in'::text as direction,
      null::uuid as counterparty_id,
      'Agenzia delle Entrate'::text as counterparty_name,
      (
        'Liquidazione ' ||
        case
          when vp.period_type = 'acconto' then ('Acconto ' || vp.year::text)
          when vp.period_type = 'annual' then ('Annuale ' || vp.year::text)
          when vp.regime = 'monthly' then (lpad(vp.period_index::text, 2, '0') || '/' || vp.year::text)
          else ('Q' || vp.period_index::text || ' ' || vp.year::text)
        end
      )::text as reference,
      ('/iva?periodId=' || vp.id::text)::text as reference_link,
      null::text as installment_label,
      case when vp.status = 'paid' then coalesce(vp.paid_amount, vp.amount_due, 0) else coalesce(vp.amount_due, 0) end::numeric(15,2) as amount,
      case when vp.status = 'paid' then 0::numeric else coalesce(vp.amount_due, 0) end::numeric(15,2) as remaining_amount,
      case
        when vp.status = 'to_pay' then 'pending'
        when vp.status = 'overdue' then 'overdue'
        when vp.status = 'paid' then 'paid'
        else 'pending'
      end::text as status,
      case
        when vp.status = 'paid' then 'Pagato'
        when vp.status = 'overdue' then 'Scaduto'
        else 'Da versare'
      end::text as status_label,
      false::boolean as is_estimated,
      null::text as estimate_source,
      (current_date - vp.due_date)::int as days,
      null::text as notes
    from public.vat_periods vp
    where vp.company_id = p_company_id
      and vp.amount_due > 0
      and vp.status in ('to_pay', 'overdue', 'paid')
  ),
  all_rows as (
    select * from installment_rows
    union all
    select * from vat_rows
  ),
  filtered as (
    select r.*
    from all_rows r
    where
      (
        v_mode = 'all'
        or (v_mode = 'incassi' and r.row_type = 'incasso')
        or (v_mode = 'pagamenti' and r.row_type in ('pagamento', 'iva'))
      )
      and (v_from is null or r.due_date >= v_from)
      and (v_to is null or r.due_date <= v_to)
      and (
        p_statuses is null
        or array_length(p_statuses, 1) is null
        or r.status = any(p_statuses)
      )
      and (p_counterparty_id is null or r.counterparty_id = p_counterparty_id)
      and (
        v_query = ''
        or lower(coalesce(r.counterparty_name, '') || ' ' || coalesce(r.reference, '') || ' ' || coalesce(r.notes, '')) like '%' || v_query || '%'
      )
  ),
  counted as (
    select
      f.*,
      count(*) over() as total_count
    from filtered f
  )
  select
    c.row_id,
    c.kind,
    c.due_date,
    c.row_type,
    c.direction,
    c.counterparty_id,
    c.counterparty_name,
    c.reference,
    c.reference_link,
    c.installment_label,
    c.amount,
    c.remaining_amount,
    c.status,
    c.status_label,
    c.is_estimated,
    c.estimate_source,
    c.days,
    c.notes,
    c.total_count
  from counted c
  order by
    case when v_sort_by = 'due_date' and v_sort_dir = 'asc' then c.due_date end asc,
    case when v_sort_by = 'due_date' and v_sort_dir = 'desc' then c.due_date end desc,

    case when v_sort_by = 'type' and v_sort_dir = 'asc' then c.row_type end asc,
    case when v_sort_by = 'type' and v_sort_dir = 'desc' then c.row_type end desc,

    case when v_sort_by = 'counterparty' and v_sort_dir = 'asc' then c.counterparty_name end asc,
    case when v_sort_by = 'counterparty' and v_sort_dir = 'desc' then c.counterparty_name end desc,

    case when v_sort_by = 'reference' and v_sort_dir = 'asc' then c.reference end asc,
    case when v_sort_by = 'reference' and v_sort_dir = 'desc' then c.reference end desc,

    case when v_sort_by = 'amount' and v_sort_dir = 'asc' then c.remaining_amount end asc,
    case when v_sort_by = 'amount' and v_sort_dir = 'desc' then c.remaining_amount end desc,

    case when v_sort_by = 'status' and v_sort_dir = 'asc' then c.status end asc,
    case when v_sort_by = 'status' and v_sort_dir = 'desc' then c.status end desc,

    case when v_sort_by = 'days' and v_sort_dir = 'asc' then c.days end asc,
    case when v_sort_by = 'days' and v_sort_dir = 'desc' then c.days end desc,

    c.due_date asc,
    c.reference asc
  limit v_page_size
  offset v_offset;
end;
$$;

grant execute on function public.scadenzario_touch_overdue(uuid) to authenticated;
grant execute on function public.scadenzario_touch_overdue(uuid) to service_role;

grant execute on function public.scadenzario_health(uuid) to authenticated;
grant execute on function public.scadenzario_health(uuid) to service_role;

grant execute on function public.scadenzario_kpis(uuid, int) to authenticated;
grant execute on function public.scadenzario_kpis(uuid, int) to service_role;

grant execute on function public.scadenzario_aging(uuid, text, uuid, text) to authenticated;
grant execute on function public.scadenzario_aging(uuid, text, uuid, text) to service_role;

grant execute on function public.scadenzario_list_rows(uuid, text, text, date, date, text[], uuid, text, text, text, int, int) to authenticated;
grant execute on function public.scadenzario_list_rows(uuid, text, text, date, date, text[], uuid, text, text, text, int, int) to service_role;
