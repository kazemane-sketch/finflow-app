import { supabase } from '@/integrations/supabase/client'
import { reparseXml, type ParsedInvoice } from '@/lib/invoiceParser'
import { formatVatPeriodLabel, type VatPeriod } from '@/lib/vat'

export type InstallmentDirection = 'in' | 'out'
export type InstallmentStatus = 'pending' | 'overdue' | 'partial' | 'paid'
export type InstallmentEstimateSource =
  | 'xml'
  | 'legacy_due_date'
  | 'counterparty_override'
  | 'company_default'
  | 'fallback_30'

export interface InvoiceInstallment {
  id: string
  company_id: string
  invoice_id: string
  counterparty_id: string | null
  is_credit_note: boolean
  direction: InstallmentDirection
  installment_no: number
  installment_total: number
  due_date: string
  amount_due: number
  paid_amount: number
  last_payment_date: string | null
  status: InstallmentStatus
  is_estimated: boolean
  estimate_source: InstallmentEstimateSource | null
  estimate_days: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

export interface InstallmentSyncResult {
  invoices_processed: number
  installments_written: number
  min_due_date_impacted: string | null
}

export interface RecordInstallmentPaymentInput {
  installmentId: string
  paymentDate: string
  amount: number
}

export interface SettleInstallmentInput {
  companyId: string
  installmentId: string
  paymentDate: string
  cashAmount: number
  mode: 'cash' | 'net'
}

export interface SettleInstallmentResult {
  mode: 'cash' | 'net'
  debit_open: number
  credit_available: number
  credit_used: number
  cash_paid: number
  credit_residual: number
  affected_installments: number
  affected_invoices: number
}

export interface ScadenzarioFilters {
  mode?: 'all' | 'incassi' | 'pagamenti' | 'iva'
  periodPreset?: 'next_7' | 'next_30' | 'next_90' | 'this_month' | 'next_month' | 'custom' | 'all'
  dateFrom?: string | null
  dateTo?: string | null
  statuses?: InstallmentStatus[]
  counterpartyId?: string | null
  query?: string
  sortBy?: 'due_date' | 'type' | 'counterparty' | 'reference' | 'amount' | 'status' | 'days'
  sortDir?: 'asc' | 'desc'
}

export interface ScadenzarioRow {
  id: string
  kind: 'installment' | 'vat'
  invoice_id: string | null
  invoice_doc_type: string | null
  is_credit_note: boolean
  due_date: string
  type: 'incasso' | 'pagamento' | 'iva'
  direction: InstallmentDirection | null
  counterparty_id: string | null
  counterparty_name: string
  counterparty_link: string | null
  reference: string
  reference_link: string
  installment_label: string | null
  amount: number
  remaining_amount: number
  status: InstallmentStatus
  status_label: string
  is_estimated: boolean
  estimate_source: InstallmentEstimateSource | null
  nc_available_amount: number
  nc_net_amount: number
  nc_residual_after_compensation_preview: number
  days: number
  notes: string | null
}

export interface ScadenzarioKpis {
  da_incassare: number
  da_pagare: number
  scaduto_clienti: number
  scaduto_fornitori: number
  eventi_iva: number
}

export interface AgingRow {
  counterparty_id: string | null
  counterparty_name: string
  total: number
  current: number
  bucket_1_30: number
  bucket_31_60: number
  bucket_61_90: number
  bucket_90_plus: number
}

export interface AgingResult {
  rows: AgingRow[]
  total: number
  kpi_days: number
}

export interface InstallmentConsistencyAnomaly {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  doc_type: string
  total_amount: number
  installments_total: number
  delta: number
}

export interface ScadenzarioAuditTotals {
  invoices_count: number
  invoices_covered: number
  missing_count: number
  orphan_count: number
  duplicate_count: number
  fatture_incassi_netto: number
  fatture_uscite_netto: number
  scadenzario_incassi_netto: number
  scadenzario_uscite_netto: number
  delta_incassi: number
  delta_uscite: number
}

interface InvoiceForInstallments {
  id: string
  company_id: string
  counterparty_id: string | null
  direction: InstallmentDirection
  date: string
  number: string
  doc_type: string
  total_amount: number
  payment_due_date: string | null
  payment_status: InstallmentStatus
  paid_date: string | null
  raw_xml: string | null
}

interface CounterpartyFallbackRow {
  id: string
  dso_days_override: number | null
  pso_days_override: number | null
  name?: string | null
}

interface BuildInstallmentRow {
  invoice_id: string
  is_credit_note: boolean
  counterparty_id: string | null
  direction: InstallmentDirection
  installment_no: number
  installment_total: number
  due_date: string
  amount_due: number
  paid_amount: number
  last_payment_date: string | null
  status: InstallmentStatus
  is_estimated: boolean
  estimate_source: InstallmentEstimateSource | null
  estimate_days: number | null
  notes: string | null
}

interface ExistingInstallmentForSync {
  installment_no: number
  paid_amount: number
  last_payment_date: string | null
}

interface FallbackContext {
  companyDefaultDso: number
  companyDefaultPso: number
  counterpartiesById: Map<string, CounterpartyFallbackRow>
}

interface InstallmentBuildOutput {
  rows: BuildInstallmentRow[]
  minDueDate: string | null
}

interface ListInstallmentJoinRow {
  id: string
  invoice_id: string
  counterparty_id: string | null
  is_credit_note: boolean
  direction: InstallmentDirection
  installment_no: number
  installment_total: number
  due_date: string
  amount_due: number
  paid_amount: number
  last_payment_date: string | null
  status: InstallmentStatus
  is_estimated: boolean
  estimate_source: InstallmentEstimateSource | null
  estimate_days: number | null
  notes: string | null
  invoice?: {
    id: string
    number: string
    doc_type: string
    date: string
  } | Array<{
    id: string
    number: string
    doc_type: string
    date: string
  }> | null
  counterparty?: {
    id: string
    name: string
  } | Array<{
    id: string
    name: string
  }> | null
}

interface NcAvailableRow {
  counterparty_id: string | null
  amount_due: number
  paid_amount: number
  is_credit_note?: boolean | null
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function todayIso(): string {
  return toIsoDate(new Date())
}

function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00`)
}

function addDays(isoDate: string, days: number): string {
  const d = parseIsoDate(isoDate)
  d.setDate(d.getDate() + days)
  return toIsoDate(d)
}

function round2(v: number): number {
  return Math.round(Number(v || 0) * 100) / 100
}

function ensureAmount(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? round2(n) : 0
}

function ensurePositiveAmount(v: unknown): number {
  return round2(Math.max(0, Math.abs(ensureAmount(v))))
}

function isCreditNoteDocType(docType: unknown): boolean {
  const doc = String(docType || '').toUpperCase()
  return doc === 'TD04' || doc === 'TD08'
}

function computeOpenAbs(amountDue: number, paidAmount: number): number {
  return round2(Math.max(0, Math.abs(Number(amountDue || 0)) - Number(paidAmount || 0)))
}

function computeOpenSigned(amountDue: number, paidAmount: number): number {
  const openAbs = computeOpenAbs(amountDue, paidAmount)
  return Number(amountDue || 0) < 0 ? -openAbs : openAbs
}

function computeStatusFromAmounts(amountDue: number, paidAmount: number, dueDate: string, today: string): InstallmentStatus {
  const openAbs = computeOpenAbs(amountDue, paidAmount)
  if (openAbs <= 0.01) return 'paid'
  if (Number(paidAmount || 0) > 0) return 'partial'
  return dueDate < today ? 'overdue' : 'pending'
}

function signedInvoiceTotal(docType: unknown, totalAmount: unknown): number {
  const totalAbs = ensurePositiveAmount(totalAmount)
  return isCreditNoteDocType(docType) ? -totalAbs : totalAbs
}

function ensureIsoDate(v: unknown): string | null {
  const s = String(v || '').trim()
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return toIsoDate(d)
}

function minIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a <= b ? a : b
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a >= b ? a : b
}

function daysBetween(fromIso: string, toIsoValue: string): number {
  const a = parseIsoDate(fromIso).getTime()
  const b = parseIsoDate(toIsoValue).getTime()
  return Math.round((b - a) / (1000 * 60 * 60 * 24))
}

function mapVatStatusToInstallment(status: string): InstallmentStatus | null {
  if (status === 'paid') return 'paid'
  if (status === 'overdue') return 'overdue'
  if (status === 'to_pay') return 'pending'
  if (status === 'credit') return 'pending'
  if (status === 'under_threshold') return 'pending'
  if (status === 'draft') return 'pending'
  return null
}

function installmentStatusLabel(status: InstallmentStatus, type: 'incasso' | 'pagamento' | 'iva'): string {
  if (status === 'paid') return type === 'incasso' ? 'Incassato' : 'Pagato'
  if (status === 'partial') return 'Parziale'
  if (status === 'overdue') return 'Scaduto'
  if (type === 'incasso') return 'Da incassare'
  return type === 'iva' ? 'Da versare' : 'Da pagare'
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null
  return Array.isArray(value) ? (value[0] || null) : value
}

function deriveInvoicePaymentStatus(rows: BuildInstallmentRow[], today: string): InstallmentStatus {
  if (!rows.length) return 'pending'

  const withRemaining = rows.map((row) => ({
    ...row,
    remaining: computeOpenAbs(row.amount_due, row.paid_amount),
  }))

  if (withRemaining.every((row) => row.remaining <= 0.01)) return 'paid'
  if (withRemaining.some((row) => row.paid_amount > 0 && row.remaining > 0.01)) return 'partial'
  if (withRemaining.some((row) => row.remaining > 0.01 && row.due_date < today)) return 'overdue'
  return 'pending'
}

function computeFallbackDays(
  direction: InstallmentDirection,
  context: FallbackContext,
  counterpartyId: string | null,
): { days: number; source: InstallmentEstimateSource } {
  const counterparty = counterpartyId ? context.counterpartiesById.get(counterpartyId) : undefined

  const override = direction === 'out'
    ? Number(counterparty?.dso_days_override)
    : Number(counterparty?.pso_days_override)

  if (Number.isFinite(override) && override >= 0) {
    return { days: Math.round(override), source: 'counterparty_override' }
  }

  const companyDefault = direction === 'out'
    ? Number(context.companyDefaultDso)
    : Number(context.companyDefaultPso)

  if (Number.isFinite(companyDefault) && companyDefault >= 0) {
    return { days: Math.round(companyDefault), source: 'company_default' }
  }

  return { days: 30, source: 'fallback_30' }
}

function extractParsedPayments(parsed?: ParsedInvoice | null): Array<{ due_date: string | null; amount: number | null; modalita: string }> {
  const body = parsed?.bodies?.[0]
  if (!body?.pagamenti?.length) return []

  return body.pagamenti.map((payment) => {
    const amountRaw = Number.parseFloat(String(payment.importo || '').replace(',', '.'))
    return {
      due_date: ensureIsoDate(payment.scadenza),
      amount: Number.isFinite(amountRaw) && amountRaw > 0 ? round2(Math.abs(amountRaw)) : null,
      modalita: String(payment.modalita || '').trim(),
    }
  })
}

function normalizeInstallmentAmounts(
  rows: Array<{
    amount_due: number | null
  }>,
  targetTotal: number,
): number[] {
  if (!rows.length) return []

  const normalized: number[] = rows.map((r) => (r.amount_due != null && r.amount_due > 0 ? round2(r.amount_due) : 0))
  const missingIdx: number[] = []

  for (let i = 0; i < rows.length; i += 1) {
    const amount = rows[i].amount_due
    if (amount == null || amount <= 0) missingIdx.push(i)
  }

  const knownTotal = round2(normalized.reduce((acc, value) => acc + value, 0))
  const effectiveTotal = targetTotal > 0 ? targetTotal : knownTotal

  if (missingIdx.length > 0) {
    let remaining = round2(Math.max(0, effectiveTotal - knownTotal))
    let slots = missingIdx.length

    for (const idx of missingIdx) {
      const value = slots === 1 ? remaining : round2(remaining / slots)
      normalized[idx] = value
      remaining = round2(remaining - value)
      slots -= 1
    }
  }

  if (effectiveTotal > 0) {
    const currentTotal = round2(normalized.reduce((acc, value) => acc + value, 0))
    const delta = round2(effectiveTotal - currentTotal)
    if (Math.abs(delta) > 0.009) {
      const last = normalized.length - 1
      normalized[last] = round2(Math.max(0, normalized[last] + delta))
    }
  }

  return normalized.map((n) => round2(Math.max(0, n)))
}

function getPeriodRange(filters: ScadenzarioFilters): { from: string | null; to: string | null } {
  const preset = filters.periodPreset || 'all'
  const today = parseIsoDate(todayIso())

  const startOfMonth = (date: Date): Date => new Date(date.getFullYear(), date.getMonth(), 1)
  const endOfMonth = (date: Date): Date => new Date(date.getFullYear(), date.getMonth() + 1, 0)

  if (preset === 'custom') {
    return {
      from: ensureIsoDate(filters.dateFrom),
      to: ensureIsoDate(filters.dateTo),
    }
  }

  if (preset === 'next_7') {
    return { from: toIsoDate(today), to: toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7)) }
  }
  if (preset === 'next_30') {
    return { from: toIsoDate(today), to: toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30)) }
  }
  if (preset === 'next_90') {
    return { from: toIsoDate(today), to: toIsoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90)) }
  }
  if (preset === 'this_month') {
    return { from: toIsoDate(startOfMonth(today)), to: toIsoDate(endOfMonth(today)) }
  }
  if (preset === 'next_month') {
    const next = new Date(today.getFullYear(), today.getMonth() + 1, 1)
    return { from: toIsoDate(startOfMonth(next)), to: toIsoDate(endOfMonth(next)) }
  }

  return {
    from: ensureIsoDate(filters.dateFrom),
    to: ensureIsoDate(filters.dateTo),
  }
}

async function loadFallbackContext(
  companyId: string,
  counterpartyIds: string[],
): Promise<FallbackContext> {
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('default_dso_days, default_pso_days')
    .eq('id', companyId)
    .single()

  if (companyErr) throw new Error(companyErr.message)

  const counterpartiesById = new Map<string, CounterpartyFallbackRow>()
  if (counterpartyIds.length > 0) {
    const { data: counterparties, error: cpErr } = await supabase
      .from('counterparties')
      .select('id, name, dso_days_override, pso_days_override')
      .eq('company_id', companyId)
      .in('id', counterpartyIds)

    if (cpErr) throw new Error(cpErr.message)
    for (const cp of (counterparties || []) as CounterpartyFallbackRow[]) {
      counterpartiesById.set(String(cp.id), cp)
    }
  }

  return {
    companyDefaultDso: Number(company?.default_dso_days || 30),
    companyDefaultPso: Number(company?.default_pso_days || 30),
    counterpartiesById,
  }
}

function buildInstallmentsForInvoice(
  invoice: InvoiceForInstallments,
  context: FallbackContext,
  existingByNo: Map<number, ExistingInstallmentForSync>,
  parsedInvoice?: ParsedInvoice | null,
): InstallmentBuildOutput {
  const today = todayIso()
  const fallback = computeFallbackDays(invoice.direction, context, invoice.counterparty_id)
  const isCreditNote = isCreditNoteDocType(invoice.doc_type)

  const parsedPayments = extractParsedPayments(parsedInvoice)
  const targetTotal = ensurePositiveAmount(invoice.total_amount)

  const draftRows: Array<{
    due_date: string
    amount_due: number | null
    is_estimated: boolean
    estimate_source: InstallmentEstimateSource | null
    estimate_days: number | null
    notes: string | null
  }> = []

  if (parsedPayments.length > 0) {
    for (const payment of parsedPayments) {
      const dueDate = payment.due_date || addDays(invoice.date, fallback.days)
      const isEstimated = !payment.due_date
      draftRows.push({
        due_date: dueDate,
        amount_due: payment.amount,
        is_estimated: isEstimated,
        estimate_source: isEstimated ? fallback.source : 'xml',
        estimate_days: isEstimated ? fallback.days : daysBetween(invoice.date, dueDate),
        notes: payment.modalita ? `Modalita: ${payment.modalita}` : null,
      })
    }
  } else {
    const legacyDueDate = ensureIsoDate(invoice.payment_due_date)
    const dueDate = legacyDueDate || addDays(invoice.date, fallback.days)
    draftRows.push({
      due_date: dueDate,
      amount_due: targetTotal,
      is_estimated: !legacyDueDate,
      estimate_source: legacyDueDate ? 'legacy_due_date' : fallback.source,
      estimate_days: legacyDueDate ? daysBetween(invoice.date, dueDate) : fallback.days,
      notes: null,
    })
  }

  const normalizedAmounts = normalizeInstallmentAmounts(draftRows, targetTotal)
  const totalInstallments = draftRows.length

  const rows: BuildInstallmentRow[] = draftRows.map((draft, idx) => {
    const installmentNo = idx + 1
    const amountDueAbs = normalizedAmounts[idx] || 0
    const amountDue = isCreditNote ? -amountDueAbs : amountDueAbs

    const prev = existingByNo.get(installmentNo)
    const preservedPaid = prev ? round2(Math.max(0, Math.min(amountDueAbs, Number(prev.paid_amount || 0)))) : 0
    const preservedDate = prev?.last_payment_date || null

    let paidAmount = invoice.payment_status === 'paid' ? amountDueAbs : preservedPaid
    let lastPaymentDate = invoice.payment_status === 'paid' ? (invoice.paid_date || today) : preservedDate

    let status = computeStatusFromAmounts(amountDue, paidAmount, draft.due_date, today)
    if (!prev && invoice.payment_status === 'partial' && status === 'pending') {
      status = 'partial'
    }

    return {
      invoice_id: invoice.id,
      is_credit_note: isCreditNote,
      counterparty_id: invoice.counterparty_id,
      direction: invoice.direction,
      installment_no: installmentNo,
      installment_total: totalInstallments,
      due_date: draft.due_date,
      amount_due: amountDue,
      paid_amount: paidAmount,
      last_payment_date: lastPaymentDate,
      status,
      is_estimated: draft.is_estimated,
      estimate_source: draft.estimate_source,
      estimate_days: draft.estimate_days,
      notes: draft.notes,
    }
  })

  const minDueDate = rows.reduce<string | null>((acc, row) => minIso(acc, row.due_date), null)
  return { rows, minDueDate }
}

async function updateInvoicePaymentSnapshot(
  companyId: string,
  invoiceId: string,
  rows: BuildInstallmentRow[],
): Promise<void> {
  if (!rows.length) return

  const today = todayIso()
  const status = deriveInvoicePaymentStatus(rows, today)

  const openRows = rows
    .filter((row) => computeOpenAbs(row.amount_due, row.paid_amount) > 0.01)
    .sort((a, b) => a.due_date.localeCompare(b.due_date))

  const paymentDueDate = openRows[0]?.due_date || rows.slice().sort((a, b) => a.due_date.localeCompare(b.due_date))[rows.length - 1]?.due_date || null

  const paidDate = status === 'paid'
    ? rows.reduce<string | null>((acc, row) => maxIso(acc, row.last_payment_date), null) || today
    : null

  const { error } = await supabase
    .from('invoices')
    .update({
      payment_status: status,
      payment_due_date: paymentDueDate,
      paid_date: paidDate,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)
    .eq('id', invoiceId)

  if (error) throw new Error(error.message)
}

function buildParsedLookup(parsedByInvoiceId?: Record<string, ParsedInvoice | null | undefined>): Map<string, ParsedInvoice | null> {
  const lookup = new Map<string, ParsedInvoice | null>()
  if (!parsedByInvoiceId) return lookup

  for (const [invoiceId, parsed] of Object.entries(parsedByInvoiceId)) {
    lookup.set(String(invoiceId), parsed || null)
  }

  return lookup
}

export async function syncInstallmentsForInvoice(
  companyId: string,
  invoiceId: string,
  parsedInvoice?: ParsedInvoice | null,
): Promise<InstallmentSyncResult> {
  return syncInstallmentsForInvoicesBatch(companyId, [invoiceId], parsedInvoice ? { [invoiceId]: parsedInvoice } : undefined)
}

export async function syncInstallmentsForInvoicesBatch(
  companyId: string,
  invoiceIds: string[],
  parsedByInvoiceId?: Record<string, ParsedInvoice | null | undefined>,
): Promise<InstallmentSyncResult> {
  const normalizedIds = Array.from(new Set(invoiceIds.map((id) => String(id || '').trim()).filter(Boolean)))
  if (!normalizedIds.length) {
    return { invoices_processed: 0, installments_written: 0, min_due_date_impacted: null }
  }

  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, company_id, counterparty_id, direction, date, number, doc_type, total_amount, payment_due_date, payment_status, paid_date, raw_xml')
    .eq('company_id', companyId)
    .in('id', normalizedIds)

  if (invErr) throw new Error(invErr.message)

  const invoiceRows = (invoices || []) as InvoiceForInstallments[]
  if (!invoiceRows.length) {
    return { invoices_processed: 0, installments_written: 0, min_due_date_impacted: null }
  }

  const counterpartyIds = Array.from(
    new Set(invoiceRows.map((inv) => (inv.counterparty_id ? String(inv.counterparty_id) : '')).filter(Boolean)),
  )

  const [context, existingRes] = await Promise.all([
    loadFallbackContext(companyId, counterpartyIds),
    supabase
      .from('invoice_installments')
      .select('invoice_id, installment_no, paid_amount, last_payment_date')
      .eq('company_id', companyId)
      .in('invoice_id', invoiceRows.map((inv) => inv.id)),
  ])

  if (existingRes.error) throw new Error(existingRes.error.message)

  const existingByInvoice = new Map<string, Map<number, ExistingInstallmentForSync>>()
  for (const row of (existingRes.data || []) as Array<{
    invoice_id: string
    installment_no: number
    paid_amount: number
    last_payment_date: string | null
  }>) {
    const invoiceId = String(row.invoice_id)
    const bucket = existingByInvoice.get(invoiceId) || new Map<number, ExistingInstallmentForSync>()
    bucket.set(Number(row.installment_no), {
      installment_no: Number(row.installment_no),
      paid_amount: ensureAmount(row.paid_amount),
      last_payment_date: row.last_payment_date ? String(row.last_payment_date) : null,
    })
    existingByInvoice.set(invoiceId, bucket)
  }

  const parsedLookup = buildParsedLookup(parsedByInvoiceId)

  const rowsToInsert: Array<Record<string, unknown>> = []
  const perInvoiceRows = new Map<string, BuildInstallmentRow[]>()
  let minDueDate: string | null = null

  for (const invoice of invoiceRows) {
    let parsed: ParsedInvoice | null | undefined = parsedLookup.get(invoice.id)

    if (parsed === undefined && invoice.raw_xml) {
      try {
        parsed = reparseXml(invoice.raw_xml)
      } catch {
        parsed = null
      }
    }

    const built = buildInstallmentsForInvoice(
      invoice,
      context,
      existingByInvoice.get(invoice.id) || new Map<number, ExistingInstallmentForSync>(),
      parsed || null,
    )

    minDueDate = minIso(minDueDate, built.minDueDate)
    perInvoiceRows.set(invoice.id, built.rows)

    for (const row of built.rows) {
      rowsToInsert.push({
        company_id: companyId,
        invoice_id: row.invoice_id,
        is_credit_note: row.is_credit_note,
        counterparty_id: row.counterparty_id,
        direction: row.direction,
        installment_no: row.installment_no,
        installment_total: row.installment_total,
        due_date: row.due_date,
        amount_due: row.amount_due,
        paid_amount: row.paid_amount,
        last_payment_date: row.last_payment_date,
        status: row.status,
        is_estimated: row.is_estimated,
        estimate_source: row.estimate_source,
        estimate_days: row.estimate_days,
        notes: row.notes,
      })
    }
  }

  const { error: deleteErr } = await supabase
    .from('invoice_installments')
    .delete()
    .eq('company_id', companyId)
    .in('invoice_id', invoiceRows.map((inv) => inv.id))

  if (deleteErr) throw new Error(deleteErr.message)

  const CHUNK = 400
  for (let i = 0; i < rowsToInsert.length; i += CHUNK) {
    const chunk = rowsToInsert.slice(i, i + CHUNK)
    const { error: insertErr } = await supabase
      .from('invoice_installments')
      .insert(chunk as any)

    if (insertErr) throw new Error(insertErr.message)
  }

  for (const invoice of invoiceRows) {
    const rows = perInvoiceRows.get(invoice.id) || []
    await updateInvoicePaymentSnapshot(companyId, invoice.id, rows)
  }

  return {
    invoices_processed: invoiceRows.length,
    installments_written: rowsToInsert.length,
    min_due_date_impacted: minDueDate,
  }
}

export async function rebuildInstallmentsFull(companyId: string): Promise<InstallmentSyncResult> {
  let from = 0
  const pageSize = 600
  let totalInvoices = 0
  let totalInstallments = 0
  let minDueDate: string | null = null

  for (;;) {
    const to = from + pageSize - 1
    const { data, error } = await supabase
      .from('invoices')
      .select('id')
      .eq('company_id', companyId)
      .order('date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)

    if (error) throw new Error(error.message)

    const ids = (data || []).map((row: any) => String(row.id))
    if (!ids.length) break

    const synced = await syncInstallmentsForInvoicesBatch(companyId, ids)
    totalInvoices += synced.invoices_processed
    totalInstallments += synced.installments_written
    minDueDate = minIso(minDueDate, synced.min_due_date_impacted)

    from += pageSize
    if (ids.length < pageSize) break
  }

  try {
    await validateInstallmentConsistency(companyId)
  } catch (e) {
    console.warn('[SCADENZARIO] consistency check skipped', {
      company_id: companyId,
      error: (e as Error)?.message || String(e),
    })
  }

  return {
    invoices_processed: totalInvoices,
    installments_written: totalInstallments,
    min_due_date_impacted: minDueDate,
  }
}

export async function touchOverdueInstallments(companyId: string): Promise<number> {
  const today = todayIso()

  const { data, error } = await supabase
    .from('invoice_installments')
    .update({ status: 'overdue', updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('status', 'pending')
    .lt('due_date', today)
    .select('id')

  if (error) throw new Error(error.message)
  return (data || []).length
}

export async function listInstallmentsForInvoice(companyId: string, invoiceId: string): Promise<InvoiceInstallment[]> {
  const { data, error } = await supabase
    .from('invoice_installments')
    .select('id, company_id, invoice_id, counterparty_id, is_credit_note, direction, installment_no, installment_total, due_date, amount_due, paid_amount, last_payment_date, status, is_estimated, estimate_source, estimate_days, notes, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
    .order('installment_no', { ascending: true })

  if (error) throw new Error(error.message)
  return (data || []) as InvoiceInstallment[]
}

export async function settleInstallment(input: SettleInstallmentInput): Promise<SettleInstallmentResult> {
  const paymentDate = ensureIsoDate(input.paymentDate)
  if (!paymentDate) throw new Error('Data pagamento non valida')

  const cashAmount = round2(Math.max(0, Number(input.cashAmount || 0)))
  const mode = input.mode === 'net' ? 'net' : 'cash'

  const { data, error } = await supabase.rpc('scadenzario_settle_installment', {
    p_company_id: input.companyId,
    p_installment_id: input.installmentId,
    p_payment_date: paymentDate,
    p_cash_amount: cashAmount,
    p_mode: mode,
  })

  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) throw new Error('Risposta vuota da scadenzario_settle_installment')

  return {
    mode: String(row.mode || mode) as 'cash' | 'net',
    debit_open: ensureAmount(row.debit_open),
    credit_available: ensureAmount(row.credit_available),
    credit_used: ensureAmount(row.credit_used),
    cash_paid: ensureAmount(row.cash_paid),
    credit_residual: ensureAmount(row.credit_residual),
    affected_installments: Number(row.affected_installments || 0),
    affected_invoices: Number(row.affected_invoices || 0),
  }
}

export async function recordInstallmentPayment(input: RecordInstallmentPaymentInput): Promise<InvoiceInstallment> {
  const { data: installment, error: loadErr } = await supabase
    .from('invoice_installments')
    .select('id, company_id, invoice_id, counterparty_id, is_credit_note, direction, installment_no, installment_total, due_date, amount_due, paid_amount, last_payment_date, status, is_estimated, estimate_source, estimate_days, notes, created_at, updated_at')
    .eq('id', input.installmentId)
    .single()

  if (loadErr) throw new Error(loadErr.message)

  const current = installment as InvoiceInstallment
  const amount = round2(Math.max(0, Number(input.amount || 0)))
  if (!amount) throw new Error('Importo pagamento non valido')

  await settleInstallment({
    companyId: current.company_id,
    installmentId: current.id,
    paymentDate: input.paymentDate,
    cashAmount: amount,
    mode: 'cash',
  })

  const { data: updated, error: updatedErr } = await supabase
    .from('invoice_installments')
    .select('id, company_id, invoice_id, counterparty_id, is_credit_note, direction, installment_no, installment_total, due_date, amount_due, paid_amount, last_payment_date, status, is_estimated, estimate_source, estimate_days, notes, created_at, updated_at')
    .eq('id', current.id)
    .single()

  if (updatedErr) throw new Error(updatedErr.message)
  return updated as InvoiceInstallment
}

function toScadenzarioInstallmentRow(item: ListInstallmentJoinRow): ScadenzarioRow {
  const invoice = firstRelation(item.invoice)
  const counterparty = firstRelation(item.counterparty)
  const amountDue = ensureAmount(item.amount_due)
  const paidAmount = ensureAmount(item.paid_amount)
  const remainingSigned = computeOpenSigned(amountDue, paidAmount)
  const reference = `Fatt. ${invoice?.number || 'senza numero'}`
  const dueDate = String(item.due_date)
  const today = todayIso()
  const days = daysBetween(dueDate, today)
  const type = item.direction === 'out' ? 'incasso' : 'pagamento'
  const status = computeStatusFromAmounts(amountDue, paidAmount, dueDate, today)
  const isCreditNote = Boolean(item.is_credit_note || isCreditNoteDocType(invoice?.doc_type))

  return {
    id: String(item.id),
    kind: 'installment',
    invoice_id: String(item.invoice_id),
    invoice_doc_type: invoice?.doc_type ? String(invoice.doc_type) : null,
    is_credit_note: isCreditNote,
    due_date: dueDate,
    type,
    direction: item.direction,
    counterparty_id: counterparty?.id ? String(counterparty.id) : item.counterparty_id,
    counterparty_name: counterparty?.name || 'Controparte non assegnata',
    counterparty_link: counterparty?.id ? `/controparti?counterpartyId=${counterparty.id}` : null,
    reference,
    reference_link: `/fatture?invoiceId=${item.invoice_id}`,
    installment_label: item.installment_total > 1 ? `${item.installment_no} di ${item.installment_total}` : null,
    amount: amountDue,
    remaining_amount: remainingSigned,
    status,
    status_label: installmentStatusLabel(status, type),
    is_estimated: Boolean(item.is_estimated),
    estimate_source: item.estimate_source || null,
    nc_available_amount: 0,
    nc_net_amount: Math.max(0, remainingSigned),
    nc_residual_after_compensation_preview: 0,
    days,
    notes: item.notes || null,
  }
}

function toScadenzarioVatRow(row: {
  id: string
  regime: string
  period_type: string
  year: number
  period_index: number
  due_date: string
  amount_due: number
  amount_credit_carry: number | null
  status: string
  paid_amount: number | null
}): ScadenzarioRow | null {
  const mappedStatus = mapVatStatusToInstallment(String(row.status || ''))
  if (!mappedStatus) return null

  const vatPeriod = {
    id: String(row.id),
    company_id: '',
    regime: String(row.regime) as any,
    period_type: String(row.period_type) as any,
    year: Number(row.year),
    period_index: Number(row.period_index),
    period_start: row.due_date,
    period_end: row.due_date,
    due_date: row.due_date,
    vat_debit: 0,
    vat_credit: 0,
    prev_credit_used: 0,
    prev_debit_under_threshold: 0,
    quarterly_interest: 0,
    acconto_amount: null,
    amount_due: ensureAmount(row.amount_due),
    amount_credit_carry: ensureAmount(row.amount_credit_carry),
    status: String(row.status) as any,
    snapshot_json: null,
    paid_amount: row.paid_amount == null ? null : ensureAmount(row.paid_amount),
    paid_at: null,
    payment_method: null,
    payment_note: null,
    generated_at: '',
    created_at: '',
    updated_at: '',
  } as VatPeriod

  const dueDate = String(row.due_date)
  const today = todayIso()
  const days = daysBetween(dueDate, today)
  const dueAmount = ensureAmount(row.amount_due)
  const creditCarry = ensureAmount(row.amount_credit_carry)

  let amountSigned = 0
  if (dueAmount > 0) {
    amountSigned = mappedStatus === 'paid'
      ? ensureAmount(row.paid_amount ?? row.amount_due)
      : dueAmount
  } else if (creditCarry > 0) {
    amountSigned = -creditCarry
  }
  amountSigned = round2(amountSigned)

  const remainingSigned = mappedStatus === 'paid'
    ? 0
    : amountSigned

  const statusLabel = row.status === 'credit'
    ? 'A credito'
    : installmentStatusLabel(mappedStatus, 'iva')

  return {
    id: String(row.id),
    kind: 'vat',
    invoice_id: null,
    invoice_doc_type: null,
    is_credit_note: false,
    due_date: dueDate,
    type: 'iva',
    direction: 'in',
    counterparty_id: null,
    counterparty_name: 'Agenzia delle Entrate',
    counterparty_link: null,
    reference: `Liquidazione ${formatVatPeriodLabel(vatPeriod)}`,
    reference_link: `/iva?periodId=${row.id}`,
    installment_label: null,
    amount: amountSigned,
    remaining_amount: remainingSigned,
    status: mappedStatus,
    status_label: statusLabel,
    is_estimated: false,
    estimate_source: null,
    nc_available_amount: 0,
    nc_net_amount: Math.max(0, remainingSigned),
    nc_residual_after_compensation_preview: 0,
    days,
    notes: null,
  }
}

function applyRowsFilters(rows: ScadenzarioRow[], filters: ScadenzarioFilters): ScadenzarioRow[] {
  const q = String(filters.query || '').trim().toLowerCase()
  const statuses = new Set((filters.statuses || []).map((s) => String(s)))

  const { from, to } = getPeriodRange(filters)

  let out = rows.filter((row) => {
    if (from && row.due_date < from) return false
    if (to && row.due_date > to) return false

    if (filters.mode === 'incassi' && row.type !== 'incasso') return false
    if (filters.mode === 'pagamenti' && !(row.type === 'pagamento' || row.type === 'iva')) return false
    if (filters.mode === 'iva' && row.type !== 'iva') return false

    if (filters.counterpartyId && row.counterparty_id !== filters.counterpartyId) return false
    if (statuses.size > 0 && !statuses.has(row.status)) return false

    if (q) {
      const hay = [row.counterparty_name, row.reference, row.notes || ''].join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }

    return true
  })

  const sortBy = filters.sortBy || 'due_date'
  const sortDir = filters.sortDir || 'asc'

  const factor = sortDir === 'desc' ? -1 : 1

  out = out.sort((a, b) => {
    let cmp = 0

    if (sortBy === 'due_date') cmp = a.due_date.localeCompare(b.due_date)
    else if (sortBy === 'type') cmp = a.type.localeCompare(b.type)
    else if (sortBy === 'counterparty') cmp = a.counterparty_name.localeCompare(b.counterparty_name)
    else if (sortBy === 'reference') cmp = a.reference.localeCompare(b.reference)
    else if (sortBy === 'amount') cmp = a.remaining_amount - b.remaining_amount
    else if (sortBy === 'status') cmp = a.status.localeCompare(b.status)
    else if (sortBy === 'days') cmp = a.days - b.days

    if (cmp !== 0) return cmp * factor

    const dueCmp = a.due_date.localeCompare(b.due_date)
    if (dueCmp !== 0) return dueCmp

    return a.reference.localeCompare(b.reference)
  })

  return out
}

export async function listScadenzarioRows(companyId: string, filters: ScadenzarioFilters = {}): Promise<ScadenzarioRow[]> {
  const mode = filters.mode || 'all'
  const rows: ScadenzarioRow[] = []

  if (mode !== 'iva') {
    let installmentQuery = supabase
      .from('invoice_installments')
      .select('id, invoice_id, counterparty_id, is_credit_note, direction, installment_no, installment_total, due_date, amount_due, paid_amount, last_payment_date, status, is_estimated, estimate_source, estimate_days, notes, invoice:invoices(id, number, doc_type, date), counterparty:counterparties(id, name)')
      .eq('company_id', companyId)

    if (mode === 'incassi') installmentQuery = installmentQuery.eq('direction', 'out')
    if (mode === 'pagamenti') installmentQuery = installmentQuery.eq('direction', 'in')

    const { data: installmentRows, error: installmentsErr } = await installmentQuery
    if (installmentsErr) throw new Error(installmentsErr.message)

    rows.push(
      ...((installmentRows || []) as unknown as ListInstallmentJoinRow[])
        .map(toScadenzarioInstallmentRow),
    )
  }

  if (mode === 'all' || mode === 'pagamenti' || mode === 'iva') {
    const { data: vatRows, error: vatErr } = await supabase
      .from('vat_periods')
      .select('id, regime, period_type, year, period_index, due_date, amount_due, amount_credit_carry, status, paid_amount')
      .eq('company_id', companyId)
      .or('amount_due.gt.0,amount_credit_carry.gt.0')
      .in('status', ['to_pay', 'overdue', 'paid', 'credit', 'under_threshold', 'draft'])

    if (vatErr) throw new Error(vatErr.message)

    for (const row of (vatRows || []) as Array<{
      id: string
      regime: string
      period_type: string
      year: number
      period_index: number
      due_date: string
      amount_due: number
      amount_credit_carry: number | null
      status: string
      paid_amount: number | null
    }>) {
      const mapped = toScadenzarioVatRow(row)
      if (mapped) rows.push(mapped)
    }
  }

  if (mode === 'all' || mode === 'pagamenti') {
    const { data: ncRows, error: ncErr } = await supabase
      .from('invoice_installments')
      .select('counterparty_id, amount_due, paid_amount, is_credit_note')
      .eq('company_id', companyId)
      .eq('direction', 'in')
      .in('status', ['pending', 'overdue', 'partial'])

    if (ncErr) throw new Error(ncErr.message)

    const ncByCounterparty = new Map<string, number>()
    for (const row of (ncRows || []) as NcAvailableRow[]) {
      const isNc = Boolean(row.is_credit_note) || Number(row.amount_due || 0) < 0
      if (!isNc) continue
      const key = row.counterparty_id ? String(row.counterparty_id) : ''
      if (!key) continue
      const openAbs = computeOpenAbs(row.amount_due, row.paid_amount)
      if (openAbs <= 0.01) continue
      ncByCounterparty.set(key, round2((ncByCounterparty.get(key) || 0) + openAbs))
    }

    for (const row of rows) {
      if (
        row.kind !== 'installment'
        || row.type !== 'pagamento'
        || row.is_credit_note
        || row.status === 'paid'
        || !row.counterparty_id
      ) {
        continue
      }
      const ncAvailable = round2(ncByCounterparty.get(row.counterparty_id) || 0)
      const debitOpen = round2(Math.max(row.remaining_amount, 0))
      row.nc_available_amount = ncAvailable
      row.nc_net_amount = round2(Math.max(debitOpen - ncAvailable, 0))
      row.nc_residual_after_compensation_preview = round2(Math.max(ncAvailable - debitOpen, 0))
    }
  }

  return applyRowsFilters(rows, filters)
}

export async function buildScadenzarioKpis(companyId: string, horizonDays = 30): Promise<ScadenzarioKpis> {
  const today = todayIso()
  const toDate = addDays(today, horizonDays)

  const { data: installments, error: installmentsErr } = await supabase
    .from('invoice_installments')
    .select('direction, due_date, amount_due, paid_amount, status')
    .eq('company_id', companyId)
    .in('status', ['pending', 'overdue', 'partial'])

  if (installmentsErr) throw new Error(installmentsErr.message)

  const { data: vatRows, error: vatErr } = await supabase
    .from('vat_periods')
    .select('due_date, amount_due, amount_credit_carry, status')
    .eq('company_id', companyId)
    .or('amount_due.gt.0,amount_credit_carry.gt.0')
    .in('status', ['to_pay', 'overdue', 'credit', 'under_threshold'])

  if (vatErr) throw new Error(vatErr.message)

  let daIncassare = 0
  let daPagare = 0
  let scadutoClienti = 0
  let scadutoFornitori = 0

  for (const row of (installments || []) as Array<{
    direction: InstallmentDirection
    due_date: string
    amount_due: number
    paid_amount: number
    status: InstallmentStatus
  }>) {
    const dueDate = String(row.due_date)
    const remainingSigned = computeOpenSigned(row.amount_due, row.paid_amount)
    if (Math.abs(remainingSigned) <= 0.01) continue

    if (row.direction === 'out') {
      if (dueDate < today) scadutoClienti = round2(scadutoClienti + remainingSigned)
      if (dueDate >= today && dueDate <= toDate) daIncassare = round2(daIncassare + remainingSigned)
    } else {
      if (dueDate < today) scadutoFornitori = round2(scadutoFornitori + remainingSigned)
      if (dueDate >= today && dueDate <= toDate) daPagare = round2(daPagare + remainingSigned)
    }
  }

  let ivaEvents = 0
  for (const row of (vatRows || []) as Array<{ due_date: string; amount_due: number; amount_credit_carry: number | null; status: string }>) {
    const dueDate = String(row.due_date)
    const dueAmount = ensureAmount(row.amount_due)
    const creditAmount = ensureAmount(row.amount_credit_carry)
    const signedAmount = dueAmount > 0 ? dueAmount : creditAmount > 0 ? -creditAmount : 0
    if (Math.abs(signedAmount) <= 0.01) continue

    if (dueDate >= today && dueDate <= toDate) daPagare = round2(daPagare + signedAmount)
    ivaEvents += 1
  }

  return {
    da_incassare: round2(Math.max(daIncassare, 0)),
    da_pagare: round2(Math.max(daPagare, 0)),
    scaduto_clienti: round2(Math.max(scadutoClienti, 0)),
    scaduto_fornitori: round2(Math.max(scadutoFornitori, 0)),
    eventi_iva: ivaEvents,
  }
}

export async function buildAging(
  companyId: string,
  mode: 'incassi' | 'pagamenti',
  filters: Pick<ScadenzarioFilters, 'query' | 'counterpartyId'> = {},
): Promise<AgingResult> {
  const direction = mode === 'incassi' ? 'out' : 'in'
  const today = todayIso()
  const q = String(filters.query || '').trim().toLowerCase()

  let query = supabase
    .from('invoice_installments')
    .select('counterparty_id, due_date, amount_due, paid_amount, counterparty:counterparties(id, name)')
    .eq('company_id', companyId)
    .eq('direction', direction)
    .in('status', ['pending', 'overdue', 'partial'])

  if (filters.counterpartyId) {
    query = query.eq('counterparty_id', filters.counterpartyId)
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rowsMap = new Map<string, AgingRow>()
  let totalOutstanding = 0
  let weightedDays = 0

  for (const row of (data || []) as unknown as Array<{
    counterparty_id: string | null
    due_date: string
    amount_due: number
    paid_amount: number
    counterparty?: { id: string; name: string } | Array<{ id: string; name: string }> | null
  }>) {
    const remaining = computeOpenSigned(ensureAmount(row.amount_due), ensureAmount(row.paid_amount))
    if (Math.abs(remaining) <= 0.01) continue

    const counterparty = firstRelation(row.counterparty)
    const counterpartyName = counterparty?.name || 'Controparte non assegnata'
    if (q) {
      const hay = `${counterpartyName}`.toLowerCase()
      if (!hay.includes(q)) continue
    }

    const counterpartyId = row.counterparty_id || `unknown:${counterpartyName}`
    const bucket = rowsMap.get(counterpartyId) || {
      counterparty_id: row.counterparty_id,
      counterparty_name: counterpartyName,
      total: 0,
      current: 0,
      bucket_1_30: 0,
      bucket_31_60: 0,
      bucket_61_90: 0,
      bucket_90_plus: 0,
    }

    const overdueDays = daysBetween(row.due_date, today)

    if (overdueDays <= 0) {
      bucket.current = round2(bucket.current + remaining)
    } else if (overdueDays <= 30) {
      bucket.bucket_1_30 = round2(bucket.bucket_1_30 + remaining)
    } else if (overdueDays <= 60) {
      bucket.bucket_31_60 = round2(bucket.bucket_31_60 + remaining)
    } else if (overdueDays <= 90) {
      bucket.bucket_61_90 = round2(bucket.bucket_61_90 + remaining)
    } else {
      bucket.bucket_90_plus = round2(bucket.bucket_90_plus + remaining)
    }

    bucket.total = round2(bucket.total + remaining)
    rowsMap.set(counterpartyId, bucket)

    totalOutstanding = round2(totalOutstanding + remaining)
    weightedDays = round2(weightedDays + Math.max(overdueDays, 0) * Math.abs(remaining))
  }

  const agingRows = Array.from(rowsMap.values()).sort((a, b) => b.total - a.total)
  const kpiDays = Math.abs(totalOutstanding) > 0 ? round2(weightedDays / Math.abs(totalOutstanding)) : 0

  return {
    rows: agingRows,
    total: totalOutstanding,
    kpi_days: kpiDays,
  }
}

export async function validateInstallmentConsistency(companyId: string): Promise<InstallmentConsistencyAnomaly[]> {
  const [invoiceRes, installmentsRes] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, number, date, doc_type, total_amount')
      .eq('company_id', companyId),
    supabase
      .from('invoice_installments')
      .select('invoice_id, amount_due')
      .eq('company_id', companyId),
  ])

  if (invoiceRes.error) throw new Error(invoiceRes.error.message)
  if (installmentsRes.error) throw new Error(installmentsRes.error.message)

  const totalsByInvoice = new Map<string, number>()
  for (const row of (installmentsRes.data || []) as Array<{ invoice_id: string; amount_due: number }>) {
    const key = String(row.invoice_id)
    const next = round2((totalsByInvoice.get(key) || 0) + ensureAmount(row.amount_due))
    totalsByInvoice.set(key, next)
  }

  const anomalies: InstallmentConsistencyAnomaly[] = []
  for (const invoice of (invoiceRes.data || []) as Array<{ id: string; number: string; date: string; doc_type: string; total_amount: number }>) {
    const installmentsTotal = round2(totalsByInvoice.get(invoice.id) || 0)
    const totalAmount = round2(signedInvoiceTotal(invoice.doc_type, invoice.total_amount))
    const delta = round2(installmentsTotal - totalAmount)

    if (Math.abs(delta) > 0.01) {
      anomalies.push({
        invoice_id: String(invoice.id),
        invoice_number: String(invoice.number || ''),
        invoice_date: String(invoice.date || ''),
        doc_type: String(invoice.doc_type || ''),
        total_amount: totalAmount,
        installments_total: installmentsTotal,
        delta,
      })
    }
  }

  if (anomalies.length > 0) {
    console.warn('[SCADENZARIO] Consistency anomalies', {
      company_id: companyId,
      count: anomalies.length,
      top: anomalies.slice(0, 20),
    })
  }

  return anomalies.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
}

export async function getScadenzarioAuditTotals(companyId: string): Promise<ScadenzarioAuditTotals> {
  const { data, error } = await supabase.rpc('scadenzario_audit_totals', {
    p_company_id: companyId,
  })

  if (error) throw new Error(error.message)
  const row = Array.isArray(data) ? data[0] : data
  if (!row) {
    return {
      invoices_count: 0,
      invoices_covered: 0,
      missing_count: 0,
      orphan_count: 0,
      duplicate_count: 0,
      fatture_incassi_netto: 0,
      fatture_uscite_netto: 0,
      scadenzario_incassi_netto: 0,
      scadenzario_uscite_netto: 0,
      delta_incassi: 0,
      delta_uscite: 0,
    }
  }

  return {
    invoices_count: Number(row.invoices_count || 0),
    invoices_covered: Number(row.invoices_covered || 0),
    missing_count: Number(row.missing_count || 0),
    orphan_count: Number(row.orphan_count || 0),
    duplicate_count: Number(row.duplicate_count || 0),
    fatture_incassi_netto: ensureAmount(row.fatture_incassi_netto),
    fatture_uscite_netto: ensureAmount(row.fatture_uscite_netto),
    scadenzario_incassi_netto: ensureAmount(row.scadenzario_incassi_netto),
    scadenzario_uscite_netto: ensureAmount(row.scadenzario_uscite_netto),
    delta_incassi: ensureAmount(row.delta_incassi),
    delta_uscite: ensureAmount(row.delta_uscite),
  }
}
