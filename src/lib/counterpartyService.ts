import { supabase } from '@/integrations/supabase/client'

export type CounterpartyRole = 'client' | 'supplier' | 'both'
export type CounterpartyStatus = 'pending' | 'verified' | 'rejected'
export type CounterpartyLegalType = 'azienda' | 'pa' | 'professionista' | 'persona' | 'altro'
export type CounterpartyClassificationSource = 'rule' | 'ai' | 'manual'

export interface Counterparty {
  id: string
  company_id: string
  type: CounterpartyRole
  status: CounterpartyStatus
  name: string
  vat_number: string | null
  vat_key: string | null
  fiscal_code: string | null
  legal_type: CounterpartyLegalType | null
  classification_source: CounterpartyClassificationSource | null
  classification_confidence: number | null
  address: string | null
  dso_days_override: number | null
  pso_days_override: number | null
  notes: string | null
  auto_created: boolean | null
  ateco_code: string | null
  ateco_description: string | null
  business_sector: string | null
  business_description: string | null
  enrichment_source: string | null
  enriched_at: string | null
  created_at: string
  updated_at: string
}

export interface ResolveCounterpartyInput {
  name: string
  vat_number?: string | null
  fiscal_code?: string | null
  address?: string | null
  ateco_code?: string | null
  source_context?: string
}

export interface ResolveCounterpartyResult {
  counterpartyId: string
  status: CounterpartyStatus
  alertRequired: boolean
}

export interface CounterpartyFilters {
  role?: 'all' | CounterpartyRole
  status?: 'all' | CounterpartyStatus
  legalType?: 'all' | CounterpartyLegalType
  query?: string
}

export interface CounterpartyAnalytics {
  totalActiveAmount: number
  totalPassiveAmount: number
  totalNetAmount: number
  countActive: number
  countPassive: number
  trend: Array<{
    month: string
    activeAmount: number
    passiveAmount: number
  }>
  byCounterparty: Array<{
    counterparty_id: string
    counterparty_name: string
    activeAmount: number
    passiveAmount: number
    activeCount: number
    passiveCount: number
  }>
}

export interface CounterpartyInstallmentFlowRow {
  installment_id: string
  invoice_id: string
  counterparty_id: string
  direction: 'in' | 'out'
  due_date: string
  last_payment_date: string | null
  amount_due: number
  paid_amount: number
  status: string
  invoice_doc_type: string | null
  invoice_number: string | null
}

const PA_KEYWORDS = [
  'comune', 'ministero', 'regione', 'provincia', 'asl', 'azienda sanitaria', 'universita',
  'istituto comprensivo', 'ente', 'agenzia delle entrate', 'inps', 'inail', 'camera di commercio',
]

const PROFESSIONAL_KEYWORDS = [
  'studio', 'avv', 'avvocato', 'dott', 'dott.', 'commercialista', 'consulente',
  'ing', 'ing.', 'arch', 'arch.', 'notaio', 'geometra',
]

const COMPANY_KEYWORDS = [
  'srl', 'spa', 'snc', 'sas', 'sapa', 'srls', 'societa', 'cooperativa', 'consorzio', 'impresa',
]

const PERSONA_REGEX = /^[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'`.-]+\s+[A-ZÀ-ÖØ-Ý][A-ZÀ-ÖØ-Ý'`.-]+$/i

export function normalizeVatKey(vat: string | null | undefined): string | null {
  if (!vat) return null
  const compact = String(vat)
    .toUpperCase()
    .replace(/^IT/, '')
    .replace(/[^A-Z0-9]/g, '')
    .trim()
  return compact || null
}

function normalizeFiscalCode(cf: string | null | undefined): string | null {
  if (!cf) return null
  const compact = String(cf).toUpperCase().replace(/[^A-Z0-9]/g, '').trim()
  return compact || null
}

function roleFromDirection(direction: 'in' | 'out'): CounterpartyRole {
  return direction === 'out' ? 'client' : 'supplier'
}

function mergeRoles(a: CounterpartyRole, b: CounterpartyRole): CounterpartyRole {
  if (a === b) return a
  if (a === 'both' || b === 'both') return 'both'
  return 'both'
}

function safeNum(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

async function updateInvoiceSnapshotsForCounterparty(
  counterpartyId: string,
  status: CounterpartyStatus,
): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update({ counterparty_status_snapshot: status })
    .eq('counterparty_id', counterpartyId)

  if (error) {
    console.warn('Snapshot counterparty status update skipped:', error.message)
  }
}

function inferLegalTypeByRules(input: ResolveCounterpartyInput): {
  legalType: CounterpartyLegalType
  confidence: number
  source: CounterpartyClassificationSource
} {
  const name = (input.name || '').trim().toLowerCase()
  const vatKey = normalizeVatKey(input.vat_number)
  const fiscalCode = normalizeFiscalCode(input.fiscal_code)

  if (!name) {
    return { legalType: 'altro', confidence: 0.35, source: 'rule' }
  }

  // ATECO-based classification (high confidence from structured data)
  if (input.ateco_code) {
    const ateco = input.ateco_code.trim()
    if (ateco.startsWith('84'))
      return { legalType: 'pa', confidence: 0.90, source: 'rule' }
    if (['86.2', '69', '71', '73', '74'].some(p => ateco.startsWith(p)))
      return { legalType: 'professionista', confidence: 0.85, source: 'rule' }
    if (vatKey)
      return { legalType: 'azienda', confidence: 0.82, source: 'rule' }
  }

  if (PA_KEYWORDS.some((k) => name.includes(k))) {
    return { legalType: 'pa', confidence: 0.93, source: 'rule' }
  }

  if (PROFESSIONAL_KEYWORDS.some((k) => name.includes(k))) {
    return { legalType: 'professionista', confidence: 0.83, source: 'rule' }
  }

  if (PERSONA_REGEX.test(input.name.trim()) && fiscalCode && fiscalCode.length === 16 && !vatKey) {
    return { legalType: 'persona', confidence: 0.8, source: 'rule' }
  }

  if (vatKey && (vatKey.length === 11 || COMPANY_KEYWORDS.some((k) => name.includes(k)))) {
    return { legalType: 'azienda', confidence: 0.76, source: 'rule' }
  }

  if (!vatKey && fiscalCode && fiscalCode.length === 16) {
    return { legalType: 'persona', confidence: 0.64, source: 'rule' }
  }

  return { legalType: 'altro', confidence: 0.45, source: 'rule' }
}

async function inferLegalTypeWithAiFallback(input: ResolveCounterpartyInput): Promise<{
  legalType: CounterpartyLegalType
  confidence: number
  source: CounterpartyClassificationSource
}> {
  // Deterministic rules only (ATECO + keywords). AI fallback removed.
  return inferLegalTypeByRules(input)
}

export async function resolveOrCreateCounterpartyFromInvoice(
  companyId: string,
  input: ResolveCounterpartyInput,
  direction: 'in' | 'out'
): Promise<ResolveCounterpartyResult> {
  const name = (input.name || '').trim() || 'Controparte senza nome'
  const vatNumber = input.vat_number?.trim() || null
  const vatKey = normalizeVatKey(vatNumber)
  const fiscalCode = normalizeFiscalCode(input.fiscal_code)
  const role = roleFromDirection(direction)

  const classification = await inferLegalTypeWithAiFallback({
    ...input,
    name,
    vat_number: vatNumber,
    fiscal_code: fiscalCode,
  })

  // 1) Strong key path: VAT key
  if (vatKey) {
    const { data: existingByVat, error: findVatErr } = await supabase
      .from('counterparties')
      .select('id, type, status, name, fiscal_code, legal_type, vat_number')
      .eq('company_id', companyId)
      .eq('vat_key', vatKey)
      .maybeSingle()

    if (findVatErr) throw new Error(findVatErr.message)

    if (existingByVat?.id) {
      const mergedType = mergeRoles(existingByVat.type as CounterpartyRole, role)
      const updatePayload: Record<string, unknown> = {
        type: mergedType,
        updated_at: new Date().toISOString(),
      }

      if (!existingByVat.legal_type && classification.legalType) {
        updatePayload.legal_type = classification.legalType
        updatePayload.classification_source = classification.source
        updatePayload.classification_confidence = classification.confidence
      }
      if (!existingByVat.fiscal_code && fiscalCode) updatePayload.fiscal_code = fiscalCode
      if (!existingByVat.vat_number && vatNumber) updatePayload.vat_number = vatNumber
      if (!existingByVat.name && name) updatePayload.name = name

      const { error: updateErr } = await supabase
        .from('counterparties')
        .update(updatePayload)
        .eq('id', existingByVat.id)

      if (updateErr) throw new Error(updateErr.message)

      const status = existingByVat.status as CounterpartyStatus
      return {
        counterpartyId: existingByVat.id,
        status,
        alertRequired: status !== 'verified',
      }
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('counterparties')
      .insert({
        company_id: companyId,
        type: role,
        status: 'pending',
        name,
        vat_number: vatNumber,
        vat_key: vatKey,
        fiscal_code: fiscalCode,
        address: input.address?.trim() || null,
        auto_created: true,
        legal_type: classification.legalType,
        classification_source: classification.source,
        classification_confidence: classification.confidence,
      })
      .select('id, status')
      .single()

    if (insertErr) throw new Error(insertErr.message)

    // Fire-and-forget ATECO enrichment for new counterparties with P.IVA
    if (vatKey) {
      enrichCounterparties(companyId, [inserted.id]).catch(() => {})
    }

    return {
      counterpartyId: inserted.id,
      status: inserted.status as CounterpartyStatus,
      alertRequired: inserted.status !== 'verified',
    }
  }

  // 2) No VAT: try conservative match on fiscal_code + normalized name
  const noVatQuery = supabase
    .from('counterparties')
    .select('id, type, status')
    .eq('company_id', companyId)
    .is('vat_key', null)
    .eq('name', name)

  const { data: existingNoVat, error: findNoVatErr } = fiscalCode
    ? await noVatQuery.eq('fiscal_code', fiscalCode).maybeSingle()
    : await noVatQuery.is('fiscal_code', null).maybeSingle()

  if (findNoVatErr) throw new Error(findNoVatErr.message)

  if (existingNoVat?.id) {
    const mergedType = mergeRoles(existingNoVat.type as CounterpartyRole, role)
    const { error: updateErr } = await supabase
      .from('counterparties')
      .update({ type: mergedType, updated_at: new Date().toISOString() })
      .eq('id', existingNoVat.id)

    if (updateErr) throw new Error(updateErr.message)

    const status = existingNoVat.status as CounterpartyStatus
    return {
      counterpartyId: existingNoVat.id,
      status,
      alertRequired: status !== 'verified',
    }
  }

  const { data: insertedNoVat, error: insertNoVatErr } = await supabase
    .from('counterparties')
    .insert({
      company_id: companyId,
      type: role,
      status: 'pending',
      name,
      vat_number: null,
      vat_key: null,
      fiscal_code: fiscalCode,
      address: input.address?.trim() || null,
      auto_created: true,
      legal_type: classification.legalType,
      classification_source: classification.source,
      classification_confidence: classification.confidence,
    })
    .select('id, status')
    .single()

  if (insertNoVatErr) throw new Error(insertNoVatErr.message)

  return {
    counterpartyId: insertedNoVat.id,
    status: insertedNoVat.status as CounterpartyStatus,
    alertRequired: true,
  }
}

export async function loadCounterparties(
  companyId: string,
  filters: CounterpartyFilters = {}
): Promise<Counterparty[]> {
  let query = supabase
    .from('counterparties')
    .select('id, company_id, type, status, name, vat_number, vat_key, fiscal_code, legal_type, classification_source, classification_confidence, address, dso_days_override, pso_days_override, notes, auto_created, ateco_code, ateco_description, business_sector, business_description, enrichment_source, enriched_at, created_at, updated_at')
    .eq('company_id', companyId)
    .order('name', { ascending: true })

  if (filters.role === 'client') query = query.in('type', ['client', 'both'])
  if (filters.role === 'supplier') query = query.in('type', ['supplier', 'both'])
  if (filters.role === 'both') query = query.eq('type', 'both')
  if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.legalType && filters.legalType !== 'all') query = query.eq('legal_type', filters.legalType)

  const q = filters.query?.trim()
  if (q) {
    query = query.or(
      `name.ilike.%${q}%,vat_number.ilike.%${q}%,fiscal_code.ilike.%${q}%`,
    )
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data || []) as Counterparty[]
}

export async function createManualCounterparty(
  companyId: string,
  payload: {
    name: string
    type?: CounterpartyRole
    status?: CounterpartyStatus
    vat_number?: string | null
    fiscal_code?: string | null
    legal_type?: CounterpartyLegalType | null
    dso_days_override?: number | null
    pso_days_override?: number | null
    notes?: string | null
    address?: string | null
  }
): Promise<Counterparty> {
  const name = payload.name?.trim()
  if (!name) throw new Error('Nome controparte obbligatorio')

  const role = payload.type || 'supplier'
  const status = payload.status || 'pending'
  const vatNumber = payload.vat_number?.trim() || null
  const vatKey = normalizeVatKey(vatNumber)
  const fiscalCode = normalizeFiscalCode(payload.fiscal_code)

  if (status === 'verified' && !vatKey) {
    throw new Error('Per verificare la controparte serve una Partita IVA valida')
  }

  const classification = payload.legal_type
    ? { legalType: payload.legal_type, confidence: 1, source: 'manual' as CounterpartyClassificationSource }
    : inferLegalTypeByRules({ name, vat_number: vatNumber, fiscal_code: fiscalCode, address: payload.address || null })

  const { data, error } = await supabase
    .from('counterparties')
    .insert({
      company_id: companyId,
      name,
      type: role,
      status,
      vat_number: vatNumber,
      vat_key: vatKey,
      fiscal_code: fiscalCode,
      legal_type: classification.legalType,
      classification_source: classification.source,
      classification_confidence: classification.confidence,
      dso_days_override: payload.dso_days_override ?? null,
      pso_days_override: payload.pso_days_override ?? null,
      notes: payload.notes || null,
      address: payload.address || null,
      auto_created: false,
      verified_at: status === 'verified' ? new Date().toISOString() : null,
    })
    .select('id, company_id, type, status, name, vat_number, vat_key, fiscal_code, legal_type, classification_source, classification_confidence, address, dso_days_override, pso_days_override, notes, auto_created, ateco_code, ateco_description, business_sector, business_description, enrichment_source, enriched_at, created_at, updated_at')
    .single()

  if (error) throw new Error(error.message)
  return data as Counterparty
}

export async function updateCounterparty(
  counterpartyId: string,
  updates: Partial<{
    name: string
    type: CounterpartyRole
    status: CounterpartyStatus
    vat_number: string | null
    fiscal_code: string | null
    legal_type: CounterpartyLegalType | null
    dso_days_override: number | null
    pso_days_override: number | null
    notes: string | null
    address: string | null
    rejection_reason: string | null
  }>
): Promise<void> {
  const payload: Record<string, unknown> = {}

  if (updates.name != null) payload.name = updates.name.trim()
  if (updates.type) payload.type = updates.type
  if (updates.notes !== undefined) payload.notes = updates.notes
  if (updates.address !== undefined) payload.address = updates.address
  if (updates.dso_days_override !== undefined) payload.dso_days_override = updates.dso_days_override
  if (updates.pso_days_override !== undefined) payload.pso_days_override = updates.pso_days_override
  if (updates.rejection_reason !== undefined) payload.rejection_reason = updates.rejection_reason

  if (updates.vat_number !== undefined) {
    const vatNumber = updates.vat_number?.trim() || null
    payload.vat_number = vatNumber
    payload.vat_key = normalizeVatKey(vatNumber)
  }
  if (updates.fiscal_code !== undefined) payload.fiscal_code = normalizeFiscalCode(updates.fiscal_code)

  if (updates.legal_type !== undefined) {
    payload.legal_type = updates.legal_type
    payload.classification_source = 'manual'
    payload.classification_confidence = 1
  }

  if (updates.status) {
    if (updates.status === 'verified' && !('vat_key' in payload)) {
      const { data: current, error: currentErr } = await supabase
        .from('counterparties')
        .select('vat_key')
        .eq('id', counterpartyId)
        .single()
      if (currentErr) throw new Error(currentErr.message)
      if (!current?.vat_key) {
        throw new Error('Per verificare la controparte serve una Partita IVA valida')
      }
    }

    payload.status = updates.status
    payload.verified_at = updates.status === 'verified' ? new Date().toISOString() : null
    if (updates.status !== 'rejected') payload.rejection_reason = null
  }

  payload.updated_at = new Date().toISOString()

  const { error } = await supabase
    .from('counterparties')
    .update(payload)
    .eq('id', counterpartyId)

  if (error) throw new Error(error.message)

  if (updates.status) {
    await updateInvoiceSnapshotsForCounterparty(counterpartyId, updates.status)
  }
}

export async function syncCounterpartyRoles(companyId: string): Promise<void> {
  const { data: invoices, error: invErr } = await supabase
    .from('invoices')
    .select('counterparty_id, direction')
    .eq('company_id', companyId)
    .not('counterparty_id', 'is', null)

  if (invErr) throw new Error(invErr.message)
  if (!invoices?.length) return

  const usage = new Map<string, { hasOut: boolean; hasIn: boolean }>()
  for (const inv of invoices as Array<{ counterparty_id: string | null; direction: 'in' | 'out' }>) {
    if (!inv.counterparty_id) continue
    const cur = usage.get(inv.counterparty_id) || { hasOut: false, hasIn: false }
    if (inv.direction === 'out') cur.hasOut = true
    if (inv.direction === 'in') cur.hasIn = true
    usage.set(inv.counterparty_id, cur)
  }

  if (usage.size === 0) return

  const ids = Array.from(usage.keys())
  const { data: cps, error: cpErr } = await supabase
    .from('counterparties')
    .select('id, type')
    .in('id', ids)

  if (cpErr) throw new Error(cpErr.message)
  if (!cps?.length) return

  const updates = (cps as Array<{ id: string; type: CounterpartyRole }>)
    .map((cp) => {
      const u = usage.get(cp.id)
      if (!u) return null
      const nextType: CounterpartyRole = u.hasOut && u.hasIn ? 'both' : u.hasOut ? 'client' : 'supplier'
      if (nextType === cp.type) return null
      return { id: cp.id, type: nextType }
    })
    .filter(Boolean) as Array<{ id: string; type: CounterpartyRole }>

  if (!updates.length) return

  for (const row of updates) {
    const { error } = await supabase
      .from('counterparties')
      .update({ type: row.type, updated_at: new Date().toISOString() })
      .eq('id', row.id)
    if (error) throw new Error(error.message)
  }
}

export async function verifyCounterparty(counterpartyId: string): Promise<void> {
  const { data: cp, error: cpErr } = await supabase
    .from('counterparties')
    .select('vat_key')
    .eq('id', counterpartyId)
    .single()

  if (cpErr) throw new Error(cpErr.message)
  if (!cp?.vat_key) throw new Error('Per verificare la controparte serve una Partita IVA valida')

  const { data: authData } = await supabase.auth.getUser()
  const userId = authData?.user?.id || null

  const { error } = await supabase
    .from('counterparties')
    .update({
      status: 'verified',
      rejection_reason: null,
      verified_at: new Date().toISOString(),
      verified_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', counterpartyId)

  if (error) throw new Error(error.message)
  await updateInvoiceSnapshotsForCounterparty(counterpartyId, 'verified')
}

export async function rejectCounterparty(counterpartyId: string, reason?: string): Promise<void> {
  const { error } = await supabase
    .from('counterparties')
    .update({
      status: 'rejected',
      rejection_reason: reason?.trim() || 'Da verificare manualmente',
      verified_at: null,
      verified_by: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', counterpartyId)

  if (error) throw new Error(error.message)
  await updateInvoiceSnapshotsForCounterparty(counterpartyId, 'rejected')
}

export async function loadInvoicesByCounterparty(
  companyId: string,
  counterpartyIds: string[],
  options: {
    direction?: 'all' | 'in' | 'out'
    dateFrom?: string
    dateTo?: string
  } = {}
): Promise<Array<{
  id: string
  counterparty_id: string
  direction: 'in' | 'out'
  doc_type: string
  number: string
  date: string
  total_amount: number
  taxable_amount: number | null
  tax_amount: number | null
  payment_status: string
  counterparty_status_snapshot: string | null
}>> {
  if (!counterpartyIds.length) return []

  let query = supabase
    .from('invoices')
    .select('id, counterparty_id, direction, doc_type, number, date, total_amount, taxable_amount, tax_amount, payment_status, counterparty_status_snapshot')
    .eq('company_id', companyId)
    .in('counterparty_id', counterpartyIds)

  if (options.direction && options.direction !== 'all') query = query.eq('direction', options.direction)
  if (options.dateFrom) query = query.gte('date', options.dateFrom)
  if (options.dateTo) query = query.lte('date', options.dateTo)

  const { data, error } = await query.order('date', { ascending: false })
  if (error) throw new Error(error.message)

  return (data || []) as Array<{
    id: string
    counterparty_id: string
    direction: 'in' | 'out'
    doc_type: string
    number: string
    date: string
    total_amount: number
    taxable_amount: number | null
    tax_amount: number | null
    payment_status: string
    counterparty_status_snapshot: string | null
  }>
}

export function buildCounterpartyAnalytics(
  rows: Array<{
    counterparty_id: string
    direction: 'in' | 'out'
    date: string
    total_amount: number
  }>,
  counterparties: Counterparty[],
  options: {
    useSignedAmounts?: boolean
  } = {},
): CounterpartyAnalytics {
  const monthMap = new Map<string, { activeAmount: number; passiveAmount: number }>()
  const perCounterparty = new Map<string, {
    counterparty_id: string
    counterparty_name: string
    activeAmount: number
    passiveAmount: number
    activeCount: number
    passiveCount: number
  }>()

  let totalActiveAmount = 0
  let totalPassiveAmount = 0
  let countActive = 0
  let countPassive = 0

  const cpNameMap = new Map(counterparties.map((c) => [c.id, c.name]))

  for (const row of rows) {
    const rawAmount = safeNum(row.total_amount)
    const amount = options.useSignedAmounts ? rawAmount : Math.abs(rawAmount)
    const month = row.date?.slice(0, 7) || 'n/a'
    const monthEntry = monthMap.get(month) || { activeAmount: 0, passiveAmount: 0 }

    const cpEntry = perCounterparty.get(row.counterparty_id) || {
      counterparty_id: row.counterparty_id,
      counterparty_name: cpNameMap.get(row.counterparty_id) || 'Controparte sconosciuta',
      activeAmount: 0,
      passiveAmount: 0,
      activeCount: 0,
      passiveCount: 0,
    }

    if (row.direction === 'out') {
      totalActiveAmount += amount
      countActive += 1
      monthEntry.activeAmount += amount
      cpEntry.activeAmount += amount
      cpEntry.activeCount += 1
    } else {
      totalPassiveAmount += amount
      countPassive += 1
      monthEntry.passiveAmount += amount
      cpEntry.passiveAmount += amount
      cpEntry.passiveCount += 1
    }

    monthMap.set(month, monthEntry)
    perCounterparty.set(row.counterparty_id, cpEntry)
  }

  const trend = Array.from(monthMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, values]) => ({
      month,
      activeAmount: Number(values.activeAmount.toFixed(2)),
      passiveAmount: Number(values.passiveAmount.toFixed(2)),
    }))

  const byCounterparty = Array.from(perCounterparty.values())
    .sort((a, b) => (b.activeAmount + b.passiveAmount) - (a.activeAmount + a.passiveAmount))

  return {
    totalActiveAmount: Number(totalActiveAmount.toFixed(2)),
    totalPassiveAmount: Number(totalPassiveAmount.toFixed(2)),
    totalNetAmount: Number((totalActiveAmount - totalPassiveAmount).toFixed(2)),
    countActive,
    countPassive,
    trend,
    byCounterparty,
  }
}

export async function loadInstallmentFlowsByCounterparty(
  companyId: string,
  counterpartyIds: string[],
  options: {
    direction?: 'all' | 'in' | 'out'
    dateFrom?: string
    dateTo?: string
    onlyPaidDates?: boolean
  } = {},
): Promise<CounterpartyInstallmentFlowRow[]> {
  if (!counterpartyIds.length) return []

  let query = supabase
    .from('invoice_installments')
    .select('id, invoice_id, counterparty_id, direction, due_date, last_payment_date, amount_due, paid_amount, status, invoice:invoices(doc_type, number)')
    .eq('company_id', companyId)
    .in('counterparty_id', counterpartyIds)

  if (options.direction && options.direction !== 'all') query = query.eq('direction', options.direction)
  if (options.onlyPaidDates ?? true) {
    query = query.not('last_payment_date', 'is', null)
  }
  if (options.dateFrom) query = query.gte('last_payment_date', options.dateFrom)
  if (options.dateTo) query = query.lte('last_payment_date', options.dateTo)

  const { data, error } = await query.order('last_payment_date', { ascending: false })
  if (error) throw new Error(error.message)

  const rows = (data || []) as Array<{
    id: string
    invoice_id: string
    counterparty_id: string
    direction: 'in' | 'out'
    due_date: string
    last_payment_date: string | null
    amount_due: number
    paid_amount: number
    status: string
    invoice?: { doc_type: string | null; number: string | null } | Array<{ doc_type: string | null; number: string | null }> | null
  }>

  const first = <T>(v: T | T[] | null | undefined): T | null => {
    if (!v) return null
    return Array.isArray(v) ? (v[0] || null) : v
  }

  return rows.map((row) => {
    const invoice = first(row.invoice)
    return {
      installment_id: row.id,
      invoice_id: row.invoice_id,
      counterparty_id: row.counterparty_id,
      direction: row.direction,
      due_date: row.due_date,
      last_payment_date: row.last_payment_date,
      amount_due: Number(row.amount_due || 0),
      paid_amount: Number(row.paid_amount || 0),
      status: row.status,
      invoice_doc_type: invoice?.doc_type || null,
      invoice_number: invoice?.number || null,
    }
  })
}

export async function enrichCounterparties(
  companyId: string,
  counterpartyIds?: string[],
  force = false,
): Promise<{ enriched: number; skipped: number; errors: number; details: Array<{ id: string; name: string; ateco_code: string | null; source: string; error: string | null }> }> {
  const { data, error } = await supabase.functions.invoke('enrich-counterparty', {
    body: {
      company_id: companyId,
      counterparty_ids: counterpartyIds || undefined,
      mode: counterpartyIds?.length ? 'single' : 'batch',
      force,
    },
  })

  if (error) throw new Error(error.message || 'Errore arricchimento controparti')
  return data
}

export async function syncInvoiceCounterpartySnapshots(companyId: string): Promise<void> {
  const { data: rows, error } = await supabase
    .from('invoices')
    .select('id, counterparty_id')
    .eq('company_id', companyId)
    .not('counterparty_id', 'is', null)

  if (error) throw new Error(error.message)
  if (!rows?.length) return

  const ids = Array.from(new Set(rows.map((r: any) => r.counterparty_id).filter(Boolean)))
  if (!ids.length) return

  const { data: cps, error: cpErr } = await supabase
    .from('counterparties')
    .select('id, status')
    .in('id', ids)

  if (cpErr) throw new Error(cpErr.message)

  const statusById = new Map((cps || []).map((cp: any) => [cp.id, cp.status]))

  for (const row of rows as any[]) {
    const status = statusById.get(row.counterparty_id)
    if (!status) continue
    await supabase
      .from('invoices')
      .update({ counterparty_status_snapshot: status })
      .eq('id', row.id)
  }
}
