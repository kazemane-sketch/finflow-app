import { supabase } from '@/integrations/supabase/client'
import { reparseXml } from '@/lib/invoiceParser'

export type VatLiquidationRegime = 'monthly' | 'quarterly'
export type VatActivityType = 'services' | 'other'
export type VatDeferredMode = 'on_verified_payment'
export type VatAccontoMethod = 'historical'
export type VatEntryStatus = 'pending_effective' | 'effective'
export type VatPeriodType = 'regular' | 'acconto' | 'annual'
export type VatPeriodStatus = 'draft' | 'to_pay' | 'paid' | 'credit' | 'under_threshold' | 'overdue'
export type VatPaymentMatchStatus = 'suggested' | 'accepted' | 'rejected'
export type CompanyRole = 'owner' | 'admin' | 'editor' | 'viewer'

const CREDIT_NOTE_TYPES = new Set(['TD04', 'TD05'])
const NON_VAT_REGIMES = new Set(['RF02', 'RF19'])

export interface VatProfile {
  company_id: string
  liquidation_regime: VatLiquidationRegime
  activity_type: VatActivityType
  start_date: string
  opening_vat_credit: number
  opening_vat_debit: number
  deferred_mode: VatDeferredMode
  acconto_method: VatAccontoMethod
  acconto_override_amount: number | null
  commercialista_confirmed: boolean
  backfill_confirmed: boolean
  backfill_preview_json: Record<string, unknown> | null
  backfill_confirmed_at: string | null
  configured_by: string | null
  configured_at: string
  created_at: string
  updated_at: string
}

export interface VatProfileInput {
  liquidation_regime: VatLiquidationRegime
  activity_type: VatActivityType
  start_date: string
  opening_vat_credit: number
  opening_vat_debit: number
  deferred_mode?: VatDeferredMode
  acconto_method?: VatAccontoMethod
  acconto_override_amount?: number | null
  commercialista_confirmed: boolean
  backfill_confirmed?: boolean
  backfill_preview_json?: Record<string, unknown> | null
  backfill_confirmed_at?: string | null
}

export interface VatEntry {
  id: string
  company_id: string
  invoice_id: string | null
  source_invoice_line_id: string | null
  rc_pair_id: string | null
  invoice_date: string
  effective_date: string | null
  direction: 'in' | 'out'
  doc_type: string
  vat_rate: number
  vat_nature: string | null
  esigibilita: 'I' | 'D' | 'S'
  taxable_amount: number
  vat_amount: number
  vat_debit_amount: number
  vat_credit_amount: number
  is_credit_note: boolean
  is_reverse_charge: boolean
  is_split_payment: boolean
  is_manual: boolean
  manual_note: string | null
  status: VatEntryStatus
  notes: string | null
  created_at: string
  updated_at: string
}

export interface VatPeriod {
  id: string
  company_id: string
  regime: VatLiquidationRegime
  period_type: VatPeriodType
  year: number
  period_index: number
  period_start: string
  period_end: string
  due_date: string
  vat_debit: number
  vat_credit: number
  prev_credit_used: number
  prev_debit_under_threshold: number
  quarterly_interest: number
  acconto_amount: number | null
  amount_due: number
  amount_credit_carry: number
  status: VatPeriodStatus
  snapshot_json: Record<string, unknown> | null
  paid_amount: number | null
  paid_at: string | null
  payment_method: string | null
  payment_note: string | null
  generated_at: string
  created_at: string
  updated_at: string
}

export interface VatBreakdownRow {
  vat_rate: number
  vat_nature: string
  esigibilita: 'I' | 'D' | 'S'
  direction: 'in' | 'out'
  is_reverse_charge: boolean
  is_split_payment: boolean
  taxable_amount: number
  vat_amount: number
  vat_debit_amount: number
  vat_credit_amount: number
}

export interface VatPaymentMatch {
  id: string
  company_id: string
  vat_period_id: string
  bank_transaction_id: string
  score: number
  reason: string | null
  suggested_amount: number | null
  status: VatPaymentMatchStatus
  confirmed_by: string | null
  confirmed_at: string | null
  created_at: string
  updated_at: string
  bank_transaction?: {
    id: string
    date: string
    amount: number
    description: string | null
    raw_text: string | null
    reference: string | null
  }
}

export interface VatCurrentSummary {
  period: VatPeriod
  days_to_due: number
  period_label: string
}

interface InvoiceForVat {
  id: string
  date: string
  direction: 'in' | 'out'
  doc_type: string
  tax_amount: number | null
  taxable_amount: number | null
  raw_xml: string | null
  paid_date: string | null
}

interface InvoiceLineForVat {
  id: string
  invoice_id: string
  vat_rate: number | null
  vat_nature: string | null
}

interface VatEntryInsertRow {
  company_id: string
  invoice_id: string | null
  source_invoice_line_id: string | null
  rc_pair_id: string | null
  invoice_date: string
  effective_date: string | null
  direction: 'in' | 'out'
  doc_type: string
  vat_rate: number
  vat_nature: string | null
  esigibilita: 'I' | 'D' | 'S'
  taxable_amount: number
  vat_amount: number
  vat_debit_amount: number
  vat_credit_amount: number
  is_credit_note: boolean
  is_reverse_charge: boolean
  is_split_payment: boolean
  is_manual: boolean
  manual_note: string | null
  status: VatEntryStatus
  notes: string | null
}

export interface ManualVatEntryInput {
  effective_date: string
  taxable_amount: number
  vat_amount: number
  vat_debit_amount: number
  vat_credit_amount: number
  vat_rate?: number
  vat_nature?: string | null
  esigibilita?: 'I' | 'D' | 'S'
  manual_note: string
}

function toIsoDate(v: Date): string {
  return v.toISOString().slice(0, 10)
}

function parseIsoDate(v: string): Date {
  return new Date(`${v}T00:00:00`)
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function daysDiff(aIso: string, bIso: string): number {
  const a = parseIsoDate(aIso).getTime()
  const b = parseIsoDate(bIso).getTime()
  return Math.round((a - b) / (1000 * 60 * 60 * 24))
}

function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0)
}

function startOfQuarter(date: Date): Date {
  const qMonth = Math.floor(date.getMonth() / 3) * 3
  return new Date(date.getFullYear(), qMonth, 1)
}

function endOfQuarter(date: Date): Date {
  const s = startOfQuarter(date)
  return new Date(s.getFullYear(), s.getMonth() + 3, 0)
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

function toBusinessDay(date: Date): Date {
  const d = new Date(date)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1)
  }
  return d
}

function normalizeEsigibilita(v: unknown): 'I' | 'D' | 'S' {
  const s = String(v || '').trim().toUpperCase()
  if (s === 'D') return 'D'
  if (s === 'S') return 'S'
  return 'I'
}

function periodLabel(period: VatPeriod): string {
  if (period.period_type === 'acconto') return `Acconto ${period.year}`
  if (period.period_type === 'annual') return `Annuale ${period.year}`
  if (period.regime === 'monthly') return `${String(period.period_index).padStart(2, '0')}/${period.year}`
  return `Q${period.period_index} ${period.year}`
}

function dueDateForMonthly(year: number, monthIndex1to12: number): string {
  const d = new Date(year, monthIndex1to12, 16)
  return toIsoDate(toBusinessDay(d))
}

function dueDateForQuarterly(year: number, quarterIndex: number): string {
  if (quarterIndex === 1) return toIsoDate(toBusinessDay(new Date(year, 4, 16)))
  if (quarterIndex === 2) return toIsoDate(toBusinessDay(new Date(year, 7, 20)))
  if (quarterIndex === 3) return toIsoDate(toBusinessDay(new Date(year, 10, 16)))
  return toIsoDate(toBusinessDay(new Date(year + 1, 2, 16)))
}

function accontoDueDate(year: number): string {
  return toIsoDate(toBusinessDay(new Date(year, 11, 27)))
}

function isUserAllowedToEdit(role: CompanyRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

function getPeriodKey(periodType: VatPeriodType, year: number, periodIndex: number): string {
  return `${periodType}:${year}:${periodIndex}`
}

function getRegularPeriodKeyByDate(dateIso: string, regime: VatLiquidationRegime): { year: number; periodIndex: number } {
  const d = parseIsoDate(dateIso)
  const year = d.getFullYear()
  if (regime === 'monthly') return { year, periodIndex: d.getMonth() + 1 }
  return { year, periodIndex: Math.floor(d.getMonth() / 3) + 1 }
}

function getRegularBounds(year: number, periodIndex: number, regime: VatLiquidationRegime): {
  periodStart: string
  periodEnd: string
  dueDate: string
} {
  if (regime === 'monthly') {
    const monthDate = new Date(year, periodIndex - 1, 1)
    return {
      periodStart: toIsoDate(startOfMonth(monthDate)),
      periodEnd: toIsoDate(endOfMonth(monthDate)),
      dueDate: dueDateForMonthly(year, periodIndex),
    }
  }

  const qStartMonth = (periodIndex - 1) * 3
  const qDate = new Date(year, qStartMonth, 1)
  return {
    periodStart: toIsoDate(startOfQuarter(qDate)),
    periodEnd: toIsoDate(endOfQuarter(qDate)),
    dueDate: dueDateForQuarterly(year, periodIndex),
  }
}

function getTodayIso(): string {
  return toIsoDate(new Date())
}

function ensureVatNumber(v: unknown): number {
  const n = Number(v || 0)
  if (!Number.isFinite(n)) return 0
  return round2(n)
}

async function getAuthUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser()
  return data?.user?.id || null
}

export async function getCompanyRole(companyId: string): Promise<CompanyRole | null> {
  const userId = await getAuthUserId()
  if (!userId) return null

  const { data, error } = await supabase
    .from('company_members')
    .select('role')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (data?.role as CompanyRole) || null
}

export async function getVatProfile(companyId: string): Promise<VatProfile | null> {
  const { data, error } = await supabase
    .from('company_vat_profiles')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw new Error(error.message)
  return (data as VatProfile | null) || null
}

export async function getFirstInvoiceDate(companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('invoices')
    .select('date')
    .eq('company_id', companyId)
    .order('date', { ascending: true })
    .limit(1)

  if (error) throw new Error(error.message)
  if (!data?.length) return null
  return String(data[0].date)
}

export async function getCompanyFiscalRegime(companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('companies')
    .select('fiscal_regime')
    .eq('id', companyId)
    .single()

  if (error) throw new Error(error.message)
  return data?.fiscal_regime || null
}

export async function isVatApplicable(companyId: string): Promise<boolean> {
  const regime = await getCompanyFiscalRegime(companyId)
  if (!regime) return true
  return !NON_VAT_REGIMES.has(String(regime).toUpperCase())
}

export async function upsertVatProfile(companyId: string, payload: VatProfileInput): Promise<VatProfile> {
  const role = await getCompanyRole(companyId)
  if (!isUserAllowedToEdit(role)) {
    throw new Error('Permesso negato: solo owner/admin possono modificare la configurazione IVA')
  }

  const existing = await getVatProfile(companyId)
  const userId = await getAuthUserId()
  const nowIso = new Date().toISOString()

  const row = {
    company_id: companyId,
    liquidation_regime: payload.liquidation_regime,
    activity_type: payload.activity_type,
    start_date: payload.start_date,
    opening_vat_credit: ensureVatNumber(payload.opening_vat_credit),
    opening_vat_debit: ensureVatNumber(payload.opening_vat_debit),
    deferred_mode: payload.deferred_mode || 'on_verified_payment',
    acconto_method: payload.acconto_method || 'historical',
    acconto_override_amount: payload.acconto_override_amount == null ? null : ensureVatNumber(payload.acconto_override_amount),
    commercialista_confirmed: Boolean(payload.commercialista_confirmed),
    backfill_confirmed: payload.backfill_confirmed ?? existing?.backfill_confirmed ?? false,
    backfill_preview_json: payload.backfill_preview_json ?? existing?.backfill_preview_json ?? null,
    backfill_confirmed_at: payload.backfill_confirmed_at ?? existing?.backfill_confirmed_at ?? null,
    configured_by: userId,
    configured_at: nowIso,
    updated_at: nowIso,
  }

  const { data, error } = await supabase
    .from('company_vat_profiles')
    .upsert(row, { onConflict: 'company_id' })
    .select('*')
    .single()

  if (error) throw new Error(error.message)
  return data as VatProfile
}

export async function updateVatBackfillPreview(
  companyId: string,
  preview: Record<string, unknown>,
): Promise<void> {
  const role = await getCompanyRole(companyId)
  if (!isUserAllowedToEdit(role)) {
    throw new Error('Permesso negato: solo owner/admin possono confermare il backfill IVA')
  }

  const { error } = await supabase
    .from('company_vat_profiles')
    .update({
      backfill_confirmed: false,
      backfill_preview_json: preview,
      backfill_confirmed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('company_id', companyId)

  if (error) throw new Error(error.message)
}

export async function confirmVatBackfill(companyId: string): Promise<void> {
  const role = await getCompanyRole(companyId)
  if (!isUserAllowedToEdit(role)) {
    throw new Error('Permesso negato: solo owner/admin possono confermare il backfill IVA')
  }

  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from('company_vat_profiles')
    .update({
      backfill_confirmed: true,
      backfill_confirmed_at: nowIso,
      updated_at: nowIso,
    })
    .eq('company_id', companyId)

  if (error) throw new Error(error.message)
}

async function loadInvoicePaidDateMap(companyId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()

  const { data: reconciliations, error: recErr } = await supabase
    .from('reconciliations')
    .select('invoice_id, bank_transaction_id')
    .eq('company_id', companyId)

  if (recErr) throw new Error(recErr.message)
  if (!reconciliations?.length) return map

  const txIds = Array.from(new Set(
    reconciliations
      .map((r: any) => String(r.bank_transaction_id || '').trim())
      .filter(Boolean),
  ))

  if (!txIds.length) return map

  const txDateById = new Map<string, string>()
  for (let i = 0; i < txIds.length; i += 500) {
    const chunk = txIds.slice(i, i + 500)
    const { data: txRows, error: txErr } = await supabase
      .from('bank_transactions')
      .select('id, date')
      .in('id', chunk)

    if (txErr) throw new Error(txErr.message)
    for (const tx of txRows || []) {
      if (tx?.id && tx?.date) txDateById.set(String(tx.id), String(tx.date))
    }
  }

  for (const rec of reconciliations as any[]) {
    const invoiceId = String(rec.invoice_id || '')
    const txId = String(rec.bank_transaction_id || '')
    if (!invoiceId || !txId) continue
    const txDate = txDateById.get(txId)
    if (!txDate) continue

    const prev = map.get(invoiceId)
    if (!prev || txDate > prev) map.set(invoiceId, txDate)
  }

  return map
}

function normalizeVatNature(v: string | null | undefined): string {
  return String(v || '').trim().toUpperCase()
}

function pickSourceInvoiceLineId(
  lines: InvoiceLineForVat[],
  vatRate: number,
  vatNature: string | null,
  usedLineIds: Set<string>,
): string | null {
  const targetRate = round2(vatRate)
  const targetNature = normalizeVatNature(vatNature)

  for (const line of lines) {
    if (usedLineIds.has(line.id)) continue
    const lineRate = round2(Number(line.vat_rate || 0))
    const lineNature = normalizeVatNature(line.vat_nature)
    if (lineRate === targetRate && lineNature === targetNature) {
      usedLineIds.add(line.id)
      return line.id
    }
  }

  return null
}

function toVatEntryRowsFromInvoice(
  invoice: InvoiceForVat,
  paidDateFromRecon: string | null,
  invoiceLines: InvoiceLineForVat[],
): VatEntryInsertRow[] {
  const rows: VatEntryInsertRow[] = []
  const invoiceDate = String(invoice.date)
  const paidDate = invoice.paid_date || paidDateFromRecon || null
  const isCreditNote = CREDIT_NOTE_TYPES.has(String(invoice.doc_type || '').toUpperCase())
  const sign = isCreditNote ? -1 : 1
  const usedLineIds = new Set<string>()

  const pushRow = (input: {
    vatRate: number
    vatNature: string | null
    esigibilita: 'I' | 'D' | 'S'
    taxableAmount: number
    vatAmount: number
    notes?: string
    isReverseCharge?: boolean
    forceDebit?: number
    forceCredit?: number
    rcPairId?: string | null
    sourceLineId?: string | null
  }) => {
    const esigibilita = input.esigibilita
    const effectiveDate = esigibilita === 'D' ? paidDate : invoiceDate
    const status: VatEntryStatus = esigibilita === 'D' && !effectiveDate ? 'pending_effective' : 'effective'
    const signedVat = round2(sign * input.vatAmount)
    const isReverseCharge = Boolean(input.isReverseCharge)
    const isSplitPayment = esigibilita === 'S' && invoice.direction === 'out'

    let vatDebitAmount = 0
    let vatCreditAmount = 0

    if (typeof input.forceDebit === 'number' || typeof input.forceCredit === 'number') {
      vatDebitAmount = round2(input.forceDebit || 0)
      vatCreditAmount = round2(input.forceCredit || 0)
    } else if (isReverseCharge) {
      vatDebitAmount = signedVat
      vatCreditAmount = signedVat
    } else if (invoice.direction === 'out') {
      vatDebitAmount = isSplitPayment ? 0 : signedVat
    } else {
      vatCreditAmount = signedVat
    }

    rows.push({
      company_id: '',
      invoice_id: invoice.id,
      source_invoice_line_id: input.sourceLineId !== undefined
        ? input.sourceLineId
        : pickSourceInvoiceLineId(invoiceLines, input.vatRate, input.vatNature, usedLineIds),
      rc_pair_id: input.rcPairId || null,
      invoice_date: invoiceDate,
      effective_date: effectiveDate,
      direction: invoice.direction,
      doc_type: invoice.doc_type,
      vat_rate: round2(input.vatRate),
      vat_nature: input.vatNature,
      esigibilita,
      taxable_amount: round2(sign * input.taxableAmount),
      vat_amount: signedVat,
      vat_debit_amount: round2(vatDebitAmount),
      vat_credit_amount: round2(vatCreditAmount),
      is_credit_note: isCreditNote,
      is_reverse_charge: isReverseCharge,
      is_split_payment: isSplitPayment,
      is_manual: false,
      manual_note: null,
      status,
      notes: input.notes || null,
    })
  }

  try {
    if (invoice.raw_xml) {
      const parsed = reparseXml(invoice.raw_xml)
      const body = parsed.bodies?.[0]
      const riepilogo = body?.riepilogo || []

      for (const r of riepilogo) {
        const vatAmount = ensureVatNumber(r.imposta)
        const taxableAmount = ensureVatNumber(r.imponibile)
        const vatRate = ensureVatNumber(r.aliquota)
        const vatNature = String(r.natura || '').trim() || null
        const esigibilita = normalizeEsigibilita(r.esigibilita)
        const isReverseCharge = invoice.direction === 'in' && Boolean(vatNature && vatNature.startsWith('N6'))

        if (isReverseCharge) {
          const rcPairId = crypto.randomUUID()
          const signedVat = round2(sign * vatAmount)
          const sourceLineId = pickSourceInvoiceLineId(invoiceLines, vatRate, vatNature, usedLineIds)
          pushRow({
            vatRate,
            vatNature,
            esigibilita,
            taxableAmount,
            vatAmount,
            isReverseCharge: true,
            forceDebit: signedVat,
            forceCredit: 0,
            rcPairId,
            sourceLineId,
            notes: 'reverse_charge_debit',
          })
          pushRow({
            vatRate,
            vatNature,
            esigibilita,
            taxableAmount,
            vatAmount,
            isReverseCharge: true,
            forceDebit: 0,
            forceCredit: signedVat,
            rcPairId,
            sourceLineId,
            notes: 'reverse_charge_credit',
          })
        } else {
          pushRow({
            vatRate,
            vatNature,
            esigibilita,
            taxableAmount,
            vatAmount,
            isReverseCharge,
          })
        }
      }

      if (rows.length > 0) return rows
    }
  } catch {
    // Fallback below when XML cannot be reparsed.
  }

  const fallbackVat = ensureVatNumber(invoice.tax_amount)
  const fallbackTaxable = ensureVatNumber(invoice.taxable_amount)
  if (fallbackVat !== 0 || fallbackTaxable !== 0) {
    pushRow({
      vatRate: 0,
      vatNature: null,
      esigibilita: 'I',
      taxableAmount: fallbackTaxable,
      vatAmount: fallbackVat,
      notes: 'fallback_totals',
    })
  }

  return rows
}

export async function rebuildVatEntries(companyId: string): Promise<{ invoices: number; entries: number; pendingDeferred: number }> {
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('id, date, direction, doc_type, tax_amount, taxable_amount, raw_xml, paid_date')
    .eq('company_id', companyId)
    .order('date', { ascending: true })

  if (invErr) throw new Error(invErr.message)

  const invoiceIds = ((invoices || []) as InvoiceForVat[]).map((i) => i.id)
  const linesByInvoice = new Map<string, InvoiceLineForVat[]>()

  if (invoiceIds.length > 0) {
    for (let i = 0; i < invoiceIds.length; i += 500) {
      const chunk = invoiceIds.slice(i, i + 500)
      const { data: lineRows, error: lineErr } = await supabase
        .from('invoice_lines')
        .select('id, invoice_id, vat_rate, vat_nature')
        .in('invoice_id', chunk)

      if (lineErr) throw new Error(lineErr.message)
      for (const line of (lineRows || []) as InvoiceLineForVat[]) {
        const list = linesByInvoice.get(line.invoice_id) || []
        list.push(line)
        linesByInvoice.set(line.invoice_id, list)
      }
    }
  }

  const paidDateMap = await loadInvoicePaidDateMap(companyId)
  const rows: VatEntryInsertRow[] = []

  for (const invoice of (invoices || []) as InvoiceForVat[]) {
    const fromInvoice = toVatEntryRowsFromInvoice(
      invoice,
      paidDateMap.get(invoice.id) || null,
      linesByInvoice.get(invoice.id) || [],
    )
    for (const row of fromInvoice) {
      row.company_id = companyId
      rows.push(row)
    }
  }

  const { error: delErr } = await supabase
    .from('invoice_vat_entries')
    .delete()
    .eq('company_id', companyId)
    .eq('is_manual', false)

  if (delErr) throw new Error(delErr.message)

  for (let i = 0; i < rows.length; i += 400) {
    const chunk = rows.slice(i, i + 400)
    const { error: insErr } = await supabase
      .from('invoice_vat_entries')
      .insert(chunk as any)

    if (insErr) throw new Error(insErr.message)
  }

  const pendingDeferred = rows.filter((r) => r.status === 'pending_effective').length

  return {
    invoices: (invoices || []).length,
    entries: rows.length,
    pendingDeferred,
  }
}

export async function createManualVatEntry(companyId: string, input: ManualVatEntryInput): Promise<void> {
  const role = await getCompanyRole(companyId)
  if (!isUserAllowedToEdit(role)) {
    throw new Error('Permesso negato: solo owner/admin possono creare rettifiche manuali IVA')
  }

  if (!input.manual_note || !input.manual_note.trim()) {
    throw new Error('La nota della rettifica manuale e obbligatoria')
  }

  const effectiveDate = input.effective_date
  const taxableAmount = ensureVatNumber(input.taxable_amount)
  const vatAmount = ensureVatNumber(input.vat_amount)
  const vatDebitAmount = ensureVatNumber(input.vat_debit_amount)
  const vatCreditAmount = ensureVatNumber(input.vat_credit_amount)

  const { error } = await supabase
    .from('invoice_vat_entries')
    .insert({
      company_id: companyId,
      invoice_id: null,
      source_invoice_line_id: null,
      rc_pair_id: null,
      invoice_date: effectiveDate,
      effective_date: effectiveDate,
      direction: vatDebitAmount >= vatCreditAmount ? 'out' : 'in',
      doc_type: 'MANUAL',
      vat_rate: ensureVatNumber(input.vat_rate || 0),
      vat_nature: input.vat_nature || null,
      esigibilita: normalizeEsigibilita(input.esigibilita || 'I'),
      taxable_amount: taxableAmount,
      vat_amount: vatAmount,
      vat_debit_amount: vatDebitAmount,
      vat_credit_amount: vatCreditAmount,
      is_credit_note: false,
      is_reverse_charge: false,
      is_split_payment: false,
      is_manual: true,
      manual_note: input.manual_note.trim(),
      status: 'effective',
      notes: 'manual_adjustment',
      updated_at: new Date().toISOString(),
    } as any)

  if (error) throw new Error(error.message)
}

export async function listManualVatEntries(companyId: string): Promise<VatEntry[]> {
  const { data, error } = await supabase
    .from('invoice_vat_entries')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_manual', true)
    .order('effective_date', { ascending: false })

  if (error) throw new Error(error.message)
  return (data || []) as VatEntry[]
}

export async function deleteManualVatEntry(companyId: string, entryId: string): Promise<void> {
  const role = await getCompanyRole(companyId)
  if (!isUserAllowedToEdit(role)) {
    throw new Error('Permesso negato: solo owner/admin possono eliminare rettifiche manuali IVA')
  }

  const { error } = await supabase
    .from('invoice_vat_entries')
    .delete()
    .eq('company_id', companyId)
    .eq('id', entryId)
    .eq('is_manual', true)

  if (error) throw new Error(error.message)
}

export async function buildVatBackfillPreview(companyId: string): Promise<Record<string, unknown>> {
  const [{ count: invoicesCount, error: invErr }, { count: pendingDeferredCount, error: pendingErr }] = await Promise.all([
    supabase.from('invoices').select('*', { count: 'exact', head: true }).eq('company_id', companyId),
    supabase.from('invoice_vat_entries').select('*', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'pending_effective'),
  ])

  if (invErr) throw new Error(invErr.message)
  if (pendingErr) throw new Error(pendingErr.message)

  const periods = await listVatPeriods(companyId)
  const regular = periods.filter((p) => p.period_type === 'regular')
  const acconto = periods.filter((p) => p.period_type === 'acconto')

  const totalDebit = round2(regular.reduce((sum, p) => sum + ensureVatNumber(p.vat_debit), 0))
  const totalCredit = round2(regular.reduce((sum, p) => sum + ensureVatNumber(p.vat_credit), 0))
  const totalDue = round2(regular.reduce((sum, p) => sum + ensureVatNumber(p.amount_due), 0))
  const totalCarry = round2(regular.reduce((sum, p) => sum + ensureVatNumber(p.amount_credit_carry), 0))

  return {
    generated_at: new Date().toISOString(),
    invoices_count: invoicesCount || 0,
    periods_regular_count: regular.length,
    periods_acconto_count: acconto.length,
    pending_deferred_entries: pendingDeferredCount || 0,
    totals: {
      vat_debit: totalDebit,
      vat_credit: totalCredit,
      amount_due: totalDue,
      amount_credit_carry: totalCarry,
    },
    periods: regular
      .slice()
      .sort((a, b) => a.period_start.localeCompare(b.period_start))
      .map((p) => ({
        period: formatVatPeriodLabel(p),
        period_start: p.period_start,
        period_end: p.period_end,
        due_date: p.due_date,
        status: p.status,
        vat_debit: p.vat_debit,
        vat_credit: p.vat_credit,
        amount_due: p.amount_due,
        amount_credit_carry: p.amount_credit_carry,
      })),
  }
}

function computeRegularPeriodsRange(startDateIso: string, endDateIso: string, regime: VatLiquidationRegime): Array<{
  year: number
  periodIndex: number
  periodStart: string
  periodEnd: string
  dueDate: string
}> {
  const out: Array<{
    year: number
    periodIndex: number
    periodStart: string
    periodEnd: string
    dueDate: string
  }> = []

  if (regime === 'monthly') {
    let cursor = startOfMonth(parseIsoDate(startDateIso))
    const limit = endOfMonth(parseIsoDate(endDateIso))

    while (cursor <= limit) {
      const year = cursor.getFullYear()
      const periodIndex = cursor.getMonth() + 1
      const bounds = getRegularBounds(year, periodIndex, regime)
      out.push({ year, periodIndex, ...bounds })
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)
    }
    return out
  }

  let cursor = startOfQuarter(parseIsoDate(startDateIso))
  const limit = endOfQuarter(parseIsoDate(endDateIso))
  while (cursor <= limit) {
    const year = cursor.getFullYear()
    const periodIndex = Math.floor(cursor.getMonth() / 3) + 1
    const bounds = getRegularBounds(year, periodIndex, regime)
    out.push({ year, periodIndex, ...bounds })
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 3, 1)
  }

  return out
}

export async function computeVatPeriods(companyId: string): Promise<{ periods: number }> {
  const profile = await getVatProfile(companyId)
  if (!profile) throw new Error('Profilo IVA non configurato')

  const { data: entries, error: entriesErr } = await supabase
    .from('invoice_vat_entries')
    .select('*')
    .eq('company_id', companyId)

  if (entriesErr) throw new Error(entriesErr.message)

  const { data: existingPeriods, error: existingErr } = await supabase
    .from('vat_periods')
    .select('*')
    .eq('company_id', companyId)

  if (existingErr) throw new Error(existingErr.message)

  const existingMap = new Map<string, VatPeriod>()
  for (const p of (existingPeriods || []) as VatPeriod[]) {
    existingMap.set(getPeriodKey(p.period_type, p.year, p.period_index), p)
  }

  const effectiveRows = ((entries || []) as VatEntry[])
    .filter((r) => r.status === 'effective' && Boolean(r.effective_date))
    .sort((a, b) => String(a.effective_date).localeCompare(String(b.effective_date)))

  const today = getTodayIso()
  const startDateIso = profile.start_date
  const maxDateIso = effectiveRows.length > 0
    ? String(effectiveRows[effectiveRows.length - 1].effective_date)
    : today
  const endDateIso = maxDateIso > today ? maxDateIso : today

  const periodRange = computeRegularPeriodsRange(startDateIso, endDateIso, profile.liquidation_regime)

  const aggregate = new Map<string, {
    vat_debit: number
    vat_credit: number
    count: number
    entries: Array<Record<string, unknown>>
  }>()

  for (const row of effectiveRows) {
    if (!row.effective_date || row.effective_date < startDateIso) continue
    const keyData = getRegularPeriodKeyByDate(row.effective_date, profile.liquidation_regime)
    const key = getPeriodKey('regular', keyData.year, keyData.periodIndex)

    const cur = aggregate.get(key) || { vat_debit: 0, vat_credit: 0, count: 0, entries: [] as Array<Record<string, unknown>> }
    cur.vat_debit = round2(cur.vat_debit + ensureVatNumber(row.vat_debit_amount))
    cur.vat_credit = round2(cur.vat_credit + ensureVatNumber(row.vat_credit_amount))
    cur.count += 1
    cur.entries.push({
      entry_id: row.id,
      invoice_id: row.invoice_id,
      source_invoice_line_id: row.source_invoice_line_id,
      rc_pair_id: row.rc_pair_id,
      invoice_date: row.invoice_date,
      effective_date: row.effective_date,
      direction: row.direction,
      doc_type: row.doc_type,
      vat_rate: row.vat_rate,
      vat_nature: row.vat_nature,
      esigibilita: row.esigibilita,
      taxable_amount: row.taxable_amount,
      vat_amount: row.vat_amount,
      vat_debit_amount: row.vat_debit_amount,
      vat_credit_amount: row.vat_credit_amount,
      is_credit_note: row.is_credit_note,
      is_reverse_charge: row.is_reverse_charge,
      is_split_payment: row.is_split_payment,
      is_manual: row.is_manual,
      manual_note: row.manual_note,
      notes: row.notes,
    })
    aggregate.set(key, cur)
  }

  let carryCredit = ensureVatNumber(profile.opening_vat_credit)
  let carryUnderThreshold = ensureVatNumber(profile.opening_vat_debit)

  const built: Array<Record<string, unknown>> = []

  for (const period of periodRange) {
    const key = getPeriodKey('regular', period.year, period.periodIndex)
    const agg = aggregate.get(key) || { vat_debit: 0, vat_credit: 0, count: 0, entries: [] as Array<Record<string, unknown>> }

    const prevCreditUsed = carryCredit
    const prevDebitUnderThreshold = carryUnderThreshold

    const baseBalance = round2(agg.vat_debit - agg.vat_credit - prevCreditUsed + prevDebitUnderThreshold)
    const quarterlyInterest = profile.liquidation_regime === 'quarterly' && baseBalance > 0
      ? round2(baseBalance * 0.01)
      : 0
    const saldo = round2(baseBalance + quarterlyInterest)

    let amountDue = 0
    let amountCreditCarry = 0
    let status: VatPeriodStatus = 'draft'

    if (saldo > 0) {
      if (saldo < 100) {
        status = 'under_threshold'
        carryUnderThreshold = saldo
        carryCredit = 0
      } else {
        status = period.dueDate < today ? 'overdue' : 'to_pay'
        amountDue = saldo
        carryUnderThreshold = 0
        carryCredit = 0
      }
    } else if (saldo < 0) {
      status = 'credit'
      amountCreditCarry = round2(Math.abs(saldo))
      carryCredit = amountCreditCarry
      carryUnderThreshold = 0
    } else {
      carryCredit = 0
      carryUnderThreshold = 0
      status = 'draft'
    }

    const prev = existingMap.get(key)
    const preservedPaid = prev?.status === 'paid'

    built.push({
      company_id: companyId,
      regime: profile.liquidation_regime,
      period_type: 'regular',
      year: period.year,
      period_index: period.periodIndex,
      period_start: period.periodStart,
      period_end: period.periodEnd,
      due_date: period.dueDate,
      vat_debit: round2(agg.vat_debit),
      vat_credit: round2(agg.vat_credit),
      prev_credit_used: round2(prevCreditUsed),
      prev_debit_under_threshold: round2(prevDebitUnderThreshold),
      quarterly_interest: quarterlyInterest,
      acconto_amount: null,
      amount_due: round2(amountDue),
      amount_credit_carry: round2(amountCreditCarry),
      status: preservedPaid ? 'paid' : status,
      snapshot_json: {
        entry_count: agg.count,
        base_balance: baseBalance,
        saldo,
        entries: agg.entries,
      },
      paid_amount: preservedPaid ? prev?.paid_amount || amountDue : null,
      paid_at: preservedPaid ? prev?.paid_at || new Date().toISOString() : null,
      payment_method: preservedPaid ? prev?.payment_method || 'f24' : null,
      payment_note: preservedPaid ? prev?.payment_note || null : null,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  const rangeYears = periodRange.map((p) => p.year)
  const startYear = rangeYears.length ? Math.min(...rangeYears) : parseIsoDate(startDateIso).getFullYear()
  const endYear = rangeYears.length ? Math.max(...rangeYears) : parseIsoDate(endDateIso).getFullYear()

  const regularByKey = new Map<string, any>()
  for (const row of built) {
    regularByKey.set(getPeriodKey('regular', Number(row.year), Number(row.period_index)), row)
  }

  const currentYear = new Date().getFullYear()

  for (let year = startYear; year <= endYear; year++) {
    const accontoKey = getPeriodKey('acconto', year, 0)
    const prevAcconto = existingMap.get(accontoKey)

    const prevYearIndex = profile.liquidation_regime === 'monthly' ? 12 : 4
    const prevRegular = regularByKey.get(getPeriodKey('regular', year - 1, prevYearIndex))

    let accontoBase = 0
    if (prevRegular && Number(prevRegular.amount_due || 0) > 0) {
      accontoBase = round2(Number(prevRegular.amount_due) * 0.88)
    }

    let amountDue = accontoBase
    if (year === currentYear && profile.acconto_override_amount != null) {
      amountDue = ensureVatNumber(profile.acconto_override_amount)
    }

    let status: VatPeriodStatus = 'draft'
    if (amountDue > 0) {
      const dueDate = accontoDueDate(year)
      status = dueDate < today ? 'overdue' : 'to_pay'
    }

    const preservedPaid = prevAcconto?.status === 'paid'

    built.push({
      company_id: companyId,
      regime: profile.liquidation_regime,
      period_type: 'acconto',
      year,
      period_index: 0,
      period_start: `${year}-12-01`,
      period_end: `${year}-12-31`,
      due_date: accontoDueDate(year),
      vat_debit: 0,
      vat_credit: 0,
      prev_credit_used: 0,
      prev_debit_under_threshold: 0,
      quarterly_interest: 0,
      acconto_amount: round2(amountDue),
      amount_due: round2(amountDue),
      amount_credit_carry: 0,
      status: preservedPaid ? 'paid' : status,
      snapshot_json: {
        method: 'historical',
        base_previous_year_due: prevRegular ? Number(prevRegular.amount_due || 0) : null,
        requires_manual_override: !prevRegular && year === currentYear,
      },
      paid_amount: preservedPaid ? prevAcconto?.paid_amount || amountDue : null,
      paid_at: preservedPaid ? prevAcconto?.paid_at || new Date().toISOString() : null,
      payment_method: preservedPaid ? prevAcconto?.payment_method || 'f24' : null,
      payment_note: preservedPaid ? prevAcconto?.payment_note || null : null,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
  }

  const { error: delErr } = await supabase
    .from('vat_periods')
    .delete()
    .eq('company_id', companyId)
    .in('period_type', ['regular', 'acconto'])

  if (delErr) throw new Error(delErr.message)

  for (let i = 0; i < built.length; i += 250) {
    const chunk = built.slice(i, i + 250)
    const { error: insErr } = await supabase
      .from('vat_periods')
      .insert(chunk as any)

    if (insErr) throw new Error(insErr.message)
  }

  return { periods: built.length }
}

export async function listVatPeriods(companyId: string): Promise<VatPeriod[]> {
  const { data, error } = await supabase
    .from('vat_periods')
    .select('*')
    .eq('company_id', companyId)
    .order('due_date', { ascending: false })

  if (error) throw new Error(error.message)
  return (data || []) as VatPeriod[]
}

export async function listVatBreakdown(companyId: string, vatPeriodId: string): Promise<VatBreakdownRow[]> {
  const { data: period, error: periodErr } = await supabase
    .from('vat_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .eq('id', vatPeriodId)
    .single()

  if (periodErr) throw new Error(periodErr.message)

  const { data: rows, error: rowsErr } = await supabase
    .from('invoice_vat_entries')
    .select('vat_rate, vat_nature, esigibilita, direction, is_reverse_charge, is_split_payment, taxable_amount, vat_amount, vat_debit_amount, vat_credit_amount')
    .eq('company_id', companyId)
    .eq('status', 'effective')
    .gte('effective_date', period.period_start)
    .lte('effective_date', period.period_end)

  if (rowsErr) throw new Error(rowsErr.message)

  const grouped = new Map<string, VatBreakdownRow>()

  for (const row of rows || []) {
    const key = [
      String(row.vat_rate || 0),
      String(row.vat_nature || ''),
      String(row.esigibilita || 'I'),
      String(row.direction || 'out'),
      row.is_reverse_charge ? '1' : '0',
      row.is_split_payment ? '1' : '0',
    ].join('|')

    const cur = grouped.get(key) || {
      vat_rate: Number(row.vat_rate || 0),
      vat_nature: String(row.vat_nature || ''),
      esigibilita: normalizeEsigibilita(row.esigibilita),
      direction: row.direction === 'in' ? 'in' : 'out',
      is_reverse_charge: Boolean(row.is_reverse_charge),
      is_split_payment: Boolean(row.is_split_payment),
      taxable_amount: 0,
      vat_amount: 0,
      vat_debit_amount: 0,
      vat_credit_amount: 0,
    }

    cur.taxable_amount = round2(cur.taxable_amount + ensureVatNumber(row.taxable_amount))
    cur.vat_amount = round2(cur.vat_amount + ensureVatNumber(row.vat_amount))
    cur.vat_debit_amount = round2(cur.vat_debit_amount + ensureVatNumber(row.vat_debit_amount))
    cur.vat_credit_amount = round2(cur.vat_credit_amount + ensureVatNumber(row.vat_credit_amount))

    grouped.set(key, cur)
  }

  return Array.from(grouped.values()).sort((a, b) => {
    if (a.vat_rate !== b.vat_rate) return a.vat_rate - b.vat_rate
    if (a.vat_nature !== b.vat_nature) return a.vat_nature.localeCompare(b.vat_nature)
    return a.direction.localeCompare(b.direction)
  })
}

export async function listVatPaymentMatches(companyId: string, vatPeriodId: string): Promise<VatPaymentMatch[]> {
  const { data: matches, error: matchesErr } = await supabase
    .from('vat_period_payment_matches')
    .select('*')
    .eq('company_id', companyId)
    .eq('vat_period_id', vatPeriodId)
    .order('score', { ascending: false })

  if (matchesErr) throw new Error(matchesErr.message)
  const out = (matches || []) as VatPaymentMatch[]
  if (!out.length) return out

  const txIds = out.map((m) => m.bank_transaction_id)
  const { data: txRows, error: txErr } = await supabase
    .from('bank_transactions')
    .select('id, date, amount, description, raw_text, reference')
    .in('id', txIds)

  if (txErr) throw new Error(txErr.message)
  const txById = new Map<string, any>()
  for (const tx of txRows || []) txById.set(String(tx.id), tx)

  return out.map((m) => ({
    ...m,
    bank_transaction: txById.get(m.bank_transaction_id)
      ? {
          id: String(txById.get(m.bank_transaction_id).id),
          date: String(txById.get(m.bank_transaction_id).date),
          amount: Number(txById.get(m.bank_transaction_id).amount || 0),
          description: txById.get(m.bank_transaction_id).description || null,
          raw_text: txById.get(m.bank_transaction_id).raw_text || null,
          reference: txById.get(m.bank_transaction_id).reference || null,
        }
      : undefined,
  }))
}

export async function suggestVatMatches(
  companyId: string,
  vatPeriodId?: string,
): Promise<VatPaymentMatch[]> {
  let periodsQuery = supabase
    .from('vat_periods')
    .select('id, due_date, amount_due, period_type, status')
    .eq('company_id', companyId)
    .in('period_type', ['regular', 'acconto'])
    .in('status', ['to_pay', 'overdue'])
    .gt('amount_due', 0)

  if (vatPeriodId) periodsQuery = periodsQuery.eq('id', vatPeriodId)

  const { data: periods, error: periodsErr } = await periodsQuery
  if (periodsErr) throw new Error(periodsErr.message)
  if (!periods?.length) return []

  let minDate = String(periods[0].due_date)
  let maxDate = String(periods[0].due_date)

  for (const p of periods as any[]) {
    if (String(p.due_date) < minDate) minDate = String(p.due_date)
    if (String(p.due_date) > maxDate) maxDate = String(p.due_date)
  }

  const fromDate = toIsoDate(addDays(parseIsoDate(minDate), -30))
  const toDate = toIsoDate(addDays(parseIsoDate(maxDate), 30))

  const { data: txRows, error: txErr } = await supabase
    .from('bank_transactions')
    .select('id, date, amount, description, raw_text, reference')
    .eq('company_id', companyId)
    .eq('transaction_type', 'f24')
    .gte('date', fromDate)
    .lte('date', toDate)

  if (txErr) throw new Error(txErr.message)
  if (!txRows?.length) return []

  const suggestions: Array<{
    company_id: string
    vat_period_id: string
    bank_transaction_id: string
    score: number
    reason: string
    suggested_amount: number
    status: VatPaymentMatchStatus
  }> = []

  for (const period of periods as any[]) {
    const amountDue = Math.abs(ensureVatNumber(period.amount_due))
    if (amountDue <= 0) continue

    const candidates: Array<{
      company_id: string
      vat_period_id: string
      bank_transaction_id: string
      score: number
      reason: string
      suggested_amount: number
      status: VatPaymentMatchStatus
    }> = []

    for (const tx of txRows as any[]) {
      const txAmount = Math.abs(ensureVatNumber(tx.amount))
      if (txAmount <= 0) continue

      const dateDistance = Math.abs(daysDiff(String(tx.date), String(period.due_date)))
      if (dateDistance > 30) continue

      const amountRatio = Math.abs(txAmount - amountDue) / amountDue
      if (amountRatio > 0.03) continue

      const amountScore = 1 - (amountRatio / 0.03)
      const dateScore = 1 - (dateDistance / 30)
      const score = round4(Math.max(0, amountScore * 0.7 + dateScore * 0.3))

      candidates.push({
        company_id: companyId,
        vat_period_id: String(period.id),
        bank_transaction_id: String(tx.id),
        score,
        reason: `F24: importo diff ${(amountRatio * 100).toFixed(2)}%, data diff ${dateDistance} gg`,
        suggested_amount: txAmount,
        status: 'suggested',
      })
    }

    candidates.sort((a, b) => b.score - a.score)
    suggestions.push(...candidates.slice(0, 3))
  }

  if (suggestions.length === 0) return []

  const { error: upErr } = await supabase
    .from('vat_period_payment_matches')
    .upsert(suggestions as any, {
      onConflict: 'vat_period_id,bank_transaction_id',
      ignoreDuplicates: true,
    })

  if (upErr) throw new Error(upErr.message)

  const periodIds = Array.from(new Set(suggestions.map((s) => s.vat_period_id)))
  const { data: matchesRows, error: listErr } = await supabase
    .from('vat_period_payment_matches')
    .select('*')
    .eq('company_id', companyId)
    .in('vat_period_id', periodIds)
    .in('status', ['suggested', 'accepted'])
    .order('score', { ascending: false })

  if (listErr) throw new Error(listErr.message)

  return (matchesRows || []) as VatPaymentMatch[]
}

export async function confirmVatPayment(
  companyId: string,
  input: {
    vatPeriodId: string
    bankTransactionId?: string | null
    paidAmount?: number | null
    paymentMethod?: string | null
    paymentNote?: string | null
  },
): Promise<void> {
  const { data: period, error: periodErr } = await supabase
    .from('vat_periods')
    .select('id, amount_due')
    .eq('company_id', companyId)
    .eq('id', input.vatPeriodId)
    .single()

  if (periodErr) throw new Error(periodErr.message)

  const userId = await getAuthUserId()
  const paidAmount = input.paidAmount == null
    ? ensureVatNumber(period.amount_due)
    : ensureVatNumber(input.paidAmount)

  const nowIso = new Date().toISOString()

  const { error: updErr } = await supabase
    .from('vat_periods')
    .update({
      status: 'paid',
      paid_amount: paidAmount,
      paid_at: nowIso,
      payment_method: input.paymentMethod || (input.bankTransactionId ? 'f24' : 'manual'),
      payment_note: input.paymentNote || null,
      updated_at: nowIso,
    })
    .eq('company_id', companyId)
    .eq('id', input.vatPeriodId)

  if (updErr) throw new Error(updErr.message)

  if (input.bankTransactionId) {
    const { error: upsertMatchErr } = await supabase
      .from('vat_period_payment_matches')
      .upsert({
        company_id: companyId,
        vat_period_id: input.vatPeriodId,
        bank_transaction_id: input.bankTransactionId,
        score: 1,
        reason: 'Conferma manuale utente',
        suggested_amount: paidAmount,
        status: 'accepted',
        confirmed_by: userId,
        confirmed_at: nowIso,
        updated_at: nowIso,
      } as any, {
        onConflict: 'vat_period_id,bank_transaction_id',
      })

    if (upsertMatchErr) throw new Error(upsertMatchErr.message)

    const { error: rejectOthersErr } = await supabase
      .from('vat_period_payment_matches')
      .update({
        status: 'rejected',
        confirmed_by: userId,
        confirmed_at: nowIso,
        updated_at: nowIso,
      })
      .eq('company_id', companyId)
      .eq('vat_period_id', input.vatPeriodId)
      .neq('bank_transaction_id', input.bankTransactionId)
      .eq('status', 'suggested')

    if (rejectOthersErr) throw new Error(rejectOthersErr.message)
  }
}

export async function getVatCurrentSummary(companyId: string): Promise<VatCurrentSummary | null> {
  const { data: periods, error } = await supabase
    .from('vat_periods')
    .select('*')
    .eq('company_id', companyId)
    .in('period_type', ['regular', 'acconto'])
    .order('period_start', { ascending: true })

  if (error) throw new Error(error.message)
  if (!periods?.length) return null

  const today = getTodayIso()
  const list = periods as VatPeriod[]

  let current = list.find((p) => p.period_type === 'regular' && p.period_start <= today && p.period_end >= today)

  if (!current) {
    current = list
      .filter((p) => p.status === 'to_pay' || p.status === 'overdue')
      .sort((a, b) => a.due_date.localeCompare(b.due_date))[0]
  }

  if (!current) {
    current = [...list].sort((a, b) => b.period_end.localeCompare(a.period_end))[0]
  }

  const daysToDue = daysDiff(current.due_date, today)

  return {
    period: current,
    days_to_due: daysToDue,
    period_label: periodLabel(current),
  }
}

export async function syncVatEngine(
  companyId: string,
  options?: { requireBackfillConfirmation?: boolean },
): Promise<void> {
  await rebuildVatEntries(companyId)
  await computeVatPeriods(companyId)
  await suggestVatMatches(companyId)
  if (options?.requireBackfillConfirmation) {
    const preview = await buildVatBackfillPreview(companyId)
    await updateVatBackfillPreview(companyId, preview)
  }
}

export function formatVatPeriodLabel(period: VatPeriod): string {
  return periodLabel(period)
}
