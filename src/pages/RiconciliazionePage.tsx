import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Link2, CheckCircle2, XCircle, Sparkles, RefreshCw, ChevronRight,
  ArrowRightLeft, Loader2, AlertTriangle, Search, FileText, Landmark,
  ChevronDown, X, Check, Zap, Trash2, Unlink, ExternalLink, CircleDollarSign,
  ArrowRight, Ban,
} from 'lucide-react'
import { toast } from 'sonner'
import { useCompany } from '@/hooks/useCompany'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'
import { fmtDate, fmtEur } from '@/lib/utils'
import { mpLabel, tpLabel } from '@/lib/invoiceParser'
import BankTxDetail, { txTypeLabel, txTypeBadge, txDirection } from '@/components/BankTxDetail'
import { askInvoiceAiSearch, type InvoiceAiResult } from '@/lib/invoiceAiSearch'
import { createReconciliationExample } from '@/lib/learningService'
import { createMemoryFromReconciliation } from '@/lib/companyMemoryService'
import { useAIJob } from '@/hooks/useAIJob'

/* ─── types ──────────────────────────────────── */

interface SuggestionRow {
  id: string
  bank_transaction_id: string
  installment_id: string | null
  invoice_id: string | null
  match_score: number
  match_reason: string
  proposed_by: string
  rule_id: string | null
  suggestion_data: Record<string, unknown> | null
  status: string
  created_at: string
  bank_transaction: {
    id: string
    date: string | null
    amount: number
    counterparty_name: string | null
    description: string | null
    transaction_type: string | null
    direction: string | null
    reconciliation_status: string | null
    commission_amount: number | null
    reconciled_amount: number | null
    tx_nature: string | null
    notes: string | null
    extracted_refs?: Record<string, unknown> | null
    raw_text?: string | null
  } | null
  invoice: {
    id: string
    number: string | null
    counterparty: Record<string, unknown> | null
    total_amount: number | null
    date: string | null
    notes: string | null
    primary_contract_ref: string | null
    contract_refs: string[] | null
  } | null
  installment: {
    id: string
    installment_no: number
    due_date: string
    amount_due: number
    paid_amount: number
    status: string
    direction: string
  } | null
}

interface UnmatchedTx {
  id: string
  date: string | null
  amount: number
  counterparty_name: string | null
  description: string | null
  transaction_type: string | null
  direction: string | null
  notes: string | null
  raw_text: string | null
  extraction_status: string | null
  commission_amount: number | null
  extracted_refs: Record<string, unknown> | null
  reconciled_amount: number | null
  reconciliation_status: string | null
}

interface OpenInstallment {
  id: string
  invoice_id: string
  installment_no: number
  due_date: string
  amount_due: number
  paid_amount: number
  status: string
  direction: string
  invoice_number: string | null
  counterparty_name: string | null
  invoice_notes?: string | null
  primary_contract_ref?: string | null
  contract_refs?: string[] | null
}

interface ReconciledRow {
  id: string
  invoice_id: string
  bank_transaction_id: string
  match_type: string
  confidence: number
  match_reason: string | null
  confirmed_at: string | null
  created_at: string
  reconciled_amount: number | null
  bank_transaction: {
    id: string
    date: string | null
    amount: number
    counterparty_name: string | null
    description: string | null
    transaction_type: string | null
    direction: string | null
    commission_amount: number | null
    reconciled_amount: number | null
  } | null
  invoice: {
    id: string
    number: string | null
    counterparty: Record<string, unknown> | null
    total_amount: number | null
    date: string | null
    direction: string | null
  } | null
}

interface KpiData {
  unmatched: number
  partial: number
  pendingSuggestions: number
  matched: number
  total: number
}

/* ─── helpers ────────────────────────────────── */

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && 'message' in err) return String((err as any).message)
  return String(err)
}

/** Map suggestion proposed_by → reconciliations.match_type (CHECK constraint) */
function toMatchType(proposed: string): 'auto' | 'suggested' | 'manual' {
  if (proposed === 'deterministic') return 'auto'
  if (proposed === 'manual') return 'manual'
  return 'suggested' // rule, ai, etc.
}

function scoreBadge(score: number): string {
  if (score >= 90) return 'bg-emerald-100 text-emerald-700'
  if (score >= 75) return 'bg-blue-100 text-blue-700'
  if (score >= 60) return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-600'
}

function scoreLabel(score: number): string {
  if (score >= 90) return 'Ottimo'
  if (score >= 75) return 'Buono'
  if (score >= 60) return 'Discreto'
  return 'Basso'
}

function proposedByLabel(proposed: string): string {
  if (proposed === 'deterministic') return 'Deterministico'
  if (proposed === 'rule') return 'Regola appresa'
  if (proposed === 'ai') return 'AI'
  return proposed
}

function directionIcon(dir: string | null) {
  if (dir === 'in') return { color: 'text-emerald-600', bg: 'bg-emerald-50', label: 'Entrata' }
  if (dir === 'out') return { color: 'text-red-600', bg: 'bg-red-50', label: 'Uscita' }
  return { color: 'text-gray-600', bg: 'bg-gray-50', label: 'N.D.' }
}

/** Client-side extraction of invoice refs from extracted_refs + raw_text (mirrors edge function logic) */
function extractClientInvoiceRefs(refs: Record<string, unknown> | null, rawText: string | null): string[] {
  const results: string[] = []
  if (refs && typeof refs.error !== 'string') {
    for (const field of ['invoice_refs', 'numeri_fattura', 'fatture', 'riferimenti_fattura']) {
      const val = refs[field]
      if (Array.isArray(val)) {
        for (const v of val) { if (typeof v === 'string' && v.length >= 2) results.push(v.trim()) }
      }
    }
    for (const field of ['numero_fattura']) {
      const val = refs[field]
      if (typeof val === 'string' && val.length >= 2) results.push(val.trim())
    }
  }
  // Fallback: parse raw_text
  if (results.length === 0 && rawText) {
    for (const m of rawText.matchAll(/RI:\s*([\d\/\w\s]+?)(?:CAUS|$)/gi)) {
      for (const part of m[1].trim().split(/\s+/)) {
        if (/^\d+\/\w+\/\d{2,4}$/.test(part)) results.push(part)
      }
    }
    for (const m of rawText.matchAll(/(\d+\/FE\/\d{2,4})/gi)) results.push(m[1])
    for (const m of rawText.matchAll(/(?:Fattura|Fatt\.?)\s+(?:num\.?|n\.?)\s*(\S+)/gi)) results.push(m[1].replace(/[,;.]$/, ''))
    for (const m of rawText.matchAll(/SALDO\s+FATTURA\s+N\.?\s*(\S+)/gi)) results.push(m[1].replace(/[,;.]$/, ''))
  }
  return [...new Set(results)].filter(r => r.length >= 2)
}

function normalizeComparableRef(value: string | null | undefined): string {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map(v => String(v || '').trim()).filter(Boolean)))
}

function extractClientContractRefsFromRawText(rawText: string | null | undefined): string[] {
  const source = String(rawText || '')
  if (!source) return []
  const values: string[] = []
  for (const pattern of [
    /(?:CONTRATTO|CONTR\.?|LEASING\s+N\.?)\s*[:#=\-]?\s*([A-Z0-9\/.\-]{3,})/gi,
    /\b(?:N\.?\s*)?([A-Z]{0,4}\d{3,}[A-Z0-9\/.\-]*)\b/g,
  ]) {
    for (const m of source.matchAll(pattern)) {
      const normalized = normalizeComparableRef(m[1])
      if (normalized.length >= 5) values.push(normalized)
    }
  }
  return Array.from(new Set(values))
}

function extractClientContractRefs(refs: Record<string, unknown> | null, rawText: string | null): string[] {
  const values: string[] = []
  if (!refs || typeof refs.error === 'string') return extractClientContractRefsFromRawText(rawText)
  for (const field of ['contract_refs', 'contract_numbers', 'numeri_contratto', 'riferimenti_contratto']) {
    const val = refs[field]
    if (Array.isArray(val)) {
      for (const item of val) {
        const normalized = normalizeComparableRef(typeof item === 'string' ? item : null)
        if (normalized.length >= 3) values.push(normalized)
      }
    }
  }
  for (const field of ['contract_ref', 'contract_number', 'numero_contratto', 'contratto']) {
    const val = refs[field]
    const normalized = normalizeComparableRef(typeof val === 'string' ? val : null)
    if (normalized.length >= 3) values.push(normalized)
  }
  const unique = Array.from(new Set(values))
  return unique.length > 0 ? unique : extractClientContractRefsFromRawText(rawText)
}

function extractClientMandateId(refs: Record<string, unknown> | null): string | null {
  if (!refs || typeof refs.error === 'string') return null
  for (const field of ['mandate_id', 'codice_mandato_sdd', 'mandato_sdd']) {
    const val = refs[field]
    if (typeof val === 'string' && val.trim().length >= 3) return val.trim()
  }
  const arr = refs.codici_mandato_sdd
  if (Array.isArray(arr)) {
    const first = arr.find(v => typeof v === 'string' && v.trim().length >= 3)
    if (typeof first === 'string') return first.trim()
  }
  return null
}

/**
 * STRICT check if an invoice number matches a ref.
 * Uses the same logic as the edge function's parseInvoiceRef:
 * - "371/FE/24" matches "371/FE", "371/FE/24", "371/FE/2024"
 * - "371/FE/24" does NOT match "4371/FE" or "37/FE"
 * - "309" does NOT match "9" or "1309"
 */
function invoiceNumberMatchesRef(invoiceNumber: string, ref: string): boolean {
  if (!invoiceNumber || !ref) return false
  const invUp = invoiceNumber.toUpperCase().trim()
  const refUp = ref.toUpperCase().trim()

  // Parse the ref into structured parts (mirrors edge function parseInvoiceRef)
  const slashMatch = refUp.match(/^(\d+)\/(FE|PA|NC|NE|FA)\/(\d{2,4})$/i)
  if (slashMatch) {
    const num = slashMatch[1]
    const suffix = slashMatch[2]
    const yearStr = slashMatch[3]
    const fullYear = yearStr.length === 2 ? String(2000 + parseInt(yearStr)) : yearStr
    // Exact matches: "371/FE/24", "371/FE/2024", "371/FE"
    if (invUp === refUp) return true
    if (invUp === `${num}/${suffix}/${fullYear}`) return true
    if (invUp === `${num}/${suffix}`) return true
    return false
  }

  const noYearMatch = refUp.match(/^(\d+)\/(FE|PA|NC|NE|FA)$/i)
  if (noYearMatch) {
    const num = noYearMatch[1]
    const suffix = noYearMatch[2]
    // Exact: "371/FE" or invoice starts with "371/FE/"
    if (invUp === refUp) return true
    if (invUp.startsWith(`${num}/${suffix}/`)) return true
    return false
  }

  // Pure long numeric (e.g. SDD invoice "5250425719")
  if (/^\d{6,}$/.test(refUp)) {
    return invUp === refUp
  }

  // Short numeric ref (e.g. "309") — only match if invoice number starts with that + separator
  const refNumOnly = refUp.replace(/[^0-9]/g, '')
  if (/^\d+$/.test(refUp) && refNumOnly.length >= 3) {
    // "309" matches "309/FE", "309/FE/25", "309" exactly — but NOT "1309" or "3090"
    if (invUp === refUp) return true
    if (invUp.startsWith(refUp + '/')) return true
    return false
  }

  // Fallback: exact match only
  return invUp === refUp
}

/** Net amount = gross - commission. Used for ALL amount comparisons in reconciliation. */
function getTxNetAmount(tx: { amount: number; commission_amount?: number | null }): number {
  return Math.abs(Number(tx.amount)) - Math.abs(Number(tx.commission_amount || 0))
}

/* ─── main component ─────────────────────────── */

export default function RiconciliazionePage() {
  const { company } = useCompany()
  const companyId = company?.id || null
  const [searchParams, setSearchParams] = useSearchParams()

  // Tab state
  const [activeTab, setActiveTab] = useState<'suggestions' | 'assisted' | 'reconciled'>(
    (searchParams.get('tab') as 'suggestions' | 'assisted' | 'reconciled') || 'suggestions'
  )

  // Data
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([])
  const [unmatchedTxs, setUnmatchedTxs] = useState<UnmatchedTx[]>([])
  const [openInstallments, setOpenInstallments] = useState<OpenInstallment[]>([])
  const [reconciledRows, setReconciledRows] = useState<ReconciledRow[]>([])
  const [kpi, setKpi] = useState<KpiData>({ unmatched: 0, partial: 0, pendingSuggestions: 0, matched: 0, total: 0 })

  // UI state
  const [loading, setLoading] = useState(true)
  const { isRunning: generating, startOrStop: reconStartOrStop } = useAIJob('riconciliazione-auto', 'Riconciliazione Automatica')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [bulkConfirming, setBulkConfirming] = useState(false)

  // Assisted tab state
  const [selectedTxId, setSelectedTxId] = useState<string | null>(
    searchParams.get('tx') || null
  )
  const [assistedSearch, setAssistedSearch] = useState('')
  const [assistedPartialOnly, setAssistedPartialOnly] = useState(false)
  const [assistedSortByReconDate, setAssistedSortByReconDate] = useState<'asc' | 'desc' | null>(null)
  const [candidateSearch, setCandidateSearch] = useState('')
  const [candidateAiResult, setCandidateAiResult] = useState<InvoiceAiResult | null>(null)
  const [candidateAiSearching, setCandidateAiSearching] = useState(false)
  const [candidateAiInstallments, setCandidateAiInstallments] = useState<OpenInstallment[]>([])  // AI-fetched installments (not limited by loadOpenInstallments cap)

  // Reconciled tab state
  const [reconciledSearch, setReconciledSearch] = useState('')
  const [deletingReconId, setDeletingReconId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Reconciliation confirm dialog (amount difference)
  const [pendingConfirm, setPendingConfirm] = useState<{
    suggestion?: SuggestionRow
    txId?: string
    installment?: OpenInstallment
    txRemaining: number
    instRemaining: number
  } | null>(null)

  // Close difference dialog (Riconciliati tab)
  const [closingDiffId, setClosingDiffId] = useState<string | null>(null)
  const [closingReason, setClosingReason] = useState('commissione_bancaria')
  const [closingAmount, setClosingAmount] = useState('')
  const [closingInProgress, setClosingInProgress] = useState(false)

  // Residual management dialog (from Riconciliati tab)
  const [residualDialog, setResidualDialog] = useState<{
    reconRow: ReconciledRow
    remainder: number
    txId: string
    txDirection: string | null
  } | null>(null)

  // Post-reconciliation dialog (remainder after matching)
  const [postReconDialog, setPostReconDialog] = useState<{
    txId: string
    invoiceNumber: string | null
    reconcileAmount: number
    remainder: number            // residuo sul TX dopo riconciliazione
    commissionAmount: number     // commissione del TX (per pre-selezione)
  } | null>(null)

  // Detail popup (double-click)
  const [detailPopup, setDetailPopup] = useState<{ type: 'bank_tx' | 'invoice'; id: string } | null>(null)
  const [detailPopupData, setDetailPopupData] = useState<any>(null)
  const [detailPopupLoading, setDetailPopupLoading] = useState(false)

  // ─── load KPIs ──────────────────────────────
  const loadKpis = useCallback(async () => {
    if (!companyId) return
    const [
      { count: unmatched },
      { count: partial },
      { count: pendingSuggestions },
      { count: matched },
      { count: total },
    ] = await Promise.all([
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('reconciliation_status', 'unmatched'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('reconciliation_status', 'partial'),
      supabase.from('reconciliation_suggestions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('status', 'pending'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('reconciliation_status', 'matched'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),
    ])
    setKpi({
      unmatched: unmatched || 0,
      partial: partial || 0,
      pendingSuggestions: pendingSuggestions || 0,
      matched: matched || 0,
      total: total || 0,
    })
  }, [companyId])

  // ─── load suggestions ───────────────────────
  const loadSuggestions = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await supabase
      .from('reconciliation_suggestions')
      .select(`
        id, bank_transaction_id, installment_id, invoice_id,
        match_score, match_reason, proposed_by, rule_id, suggestion_data, status, created_at,
        bank_transaction:bank_transactions(id, date, amount, counterparty_name, description, transaction_type, direction, reconciliation_status, commission_amount, reconciled_amount, tx_nature, extracted_refs, raw_text),
        invoice:invoices(id, number, counterparty, total_amount, date, notes),
        installment:invoice_installments(id, installment_no, due_date, amount_due, paid_amount, status, direction)
      `)
      .eq('company_id', companyId)
      .eq('status', 'pending')
      .order('match_score', { ascending: false })
      .limit(200)

    if (error) {
      console.error('Error loading suggestions:', error)
      return
    }
    setSuggestions((data || []) as unknown as SuggestionRow[])
  }, [companyId])

  // ─── load unmatched transactions ────────────
  const loadUnmatched = useCallback(async () => {
    if (!companyId) return
    const { data } = await supabase
      .from('bank_transactions')
      .select('id, date, amount, counterparty_name, description, transaction_type, direction, raw_text, extraction_status, commission_amount, extracted_refs, reconciled_amount, reconciliation_status')
      .eq('company_id', companyId)
      .in('reconciliation_status', ['unmatched', 'partial'])
      .order('date', { ascending: false })
      .limit(500)
    if (data) setUnmatchedTxs(data as UnmatchedTx[])
  }, [companyId])

  // ─── load open installments ─────────────────
  const loadOpenInstallments = useCallback(async () => {
    if (!companyId) return
    const { data } = await supabase
      .from('invoice_installments')
      .select(`
        id, invoice_id, installment_no, due_date, amount_due, paid_amount, status, direction,
        invoice:invoices(number, counterparty, notes)
      `)
      .eq('company_id', companyId)
      .in('status', ['pending', 'overdue', 'partial'])
      .order('due_date', { ascending: true })
      .limit(1000)

    if (data) {
      setOpenInstallments(data.map((d: any) => ({
        id: d.id,
        invoice_id: d.invoice_id,
        installment_no: d.installment_no,
        due_date: d.due_date,
        amount_due: d.amount_due,
        paid_amount: d.paid_amount,
        status: d.status,
        direction: d.direction,
        invoice_number: d.invoice?.number || null,
        counterparty_name: d.invoice?.counterparty?.denom || null,
        invoice_notes: d.invoice?.notes || null,
        primary_contract_ref: null,
        contract_refs: [],
      })))
    }
  }, [companyId])

  // ─── load reconciled ───────────────────────
  const loadReconciled = useCallback(async () => {
    if (!companyId) return
    const { data, error } = await supabase
      .from('reconciliations')
      .select(`
        id, invoice_id, bank_transaction_id, match_type, confidence,
        match_reason, confirmed_at, created_at, reconciled_amount,
        bank_transaction:bank_transactions(id, date, amount, counterparty_name, description, transaction_type, direction, commission_amount, reconciled_amount),
        invoice:invoices(id, number, counterparty, total_amount, date, direction)
      `)
      .eq('company_id', companyId)
      .order('confirmed_at', { ascending: false, nullsFirst: false })
      .limit(500)

    if (error) {
      console.error('Error loading reconciled:', error)
      return
    }
    setReconciledRows((data || []) as unknown as ReconciledRow[])
  }, [companyId])

  // ─── initial load ───────────────────────────
  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    Promise.all([loadKpis(), loadSuggestions(), loadUnmatched(), loadOpenInstallments(), loadReconciled()])
      .finally(() => setLoading(false))
  }, [companyId, loadKpis, loadSuggestions, loadUnmatched, loadOpenInstallments, loadReconciled])

  // ─── detail popup loader ───────────────────
  useEffect(() => {
    if (!detailPopup) { setDetailPopupData(null); return }
    let cancelled = false
    setDetailPopupLoading(true)

    if (detailPopup.type === 'bank_tx') {
      supabase.from('bank_transactions').select('*').eq('id', detailPopup.id).single()
        .then(({ data, error }) => {
          if (cancelled) return
          if (error) console.error('Detail load error:', error.message)
          else setDetailPopupData(data)
          setDetailPopupLoading(false)
        })
    } else {
      supabase.from('invoices')
        .select('*, counterparty:counterparties(*), installments:invoice_installments(*)')
        .eq('id', detailPopup.id).single()
        .then(({ data, error }) => {
          if (cancelled) return
          if (error) console.error('Detail load error:', error.message)
          else setDetailPopupData(data)
          setDetailPopupLoading(false)
        })
    }

    return () => { cancelled = true }
  }, [detailPopup])

  // ─── generate suggestions ──────────────────
  const generateSuggestions = useCallback(() => {
    if (!companyId) return
    reconStartOrStop(async (signal) => {
      const token = await getValidAccessToken()
      if (signal.aborted) return
      const res = await fetch(`${SUPABASE_URL}/functions/v1/reconciliation-generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ company_id: companyId, batch_size: 100, engine_mode: 'contextual' }),
        signal,
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

      toast.success(`${data.new_suggestions} nuovi suggerimenti generati (${data.processed} movimenti analizzati)`)
      await Promise.all([loadKpis(), loadSuggestions()])
    })
  }, [companyId, reconStartOrStop, loadKpis, loadSuggestions])

  // ─── auto-close remainder (shared helper) ───
  const autoCloseRemainder = useCallback(async (txId: string, amount: number, reason: string) => {
    if (!companyId) return
    try {
      const { data: { user } } = await supabase.auth.getUser()

      // Fetch current TX state
      const { data: txData } = await supabase
        .from('bank_transactions')
        .select('reconciled_amount, amount, commission_amount')
        .eq('id', txId)
        .single()
      if (!txData) return

      const newReconciled = Number(txData.reconciled_amount || 0) + amount
      const txNet = Math.abs(Number(txData.amount)) - Math.abs(Number(txData.commission_amount || 0))
      const newStatus = newReconciled >= txNet - 0.01 ? 'matched' : 'partial'

      const { error: e1 } = await supabase.from('bank_transactions')
        .update({ reconciled_amount: newReconciled, reconciliation_status: newStatus })
        .eq('id', txId)
      if (e1) throw e1

      // Log with adjustment
      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        bank_transaction_id: txId,
        proposed_by: 'manual',
        accepted: true,
        user_id: user?.id,
        match_score: 100,
        match_reason: `Chiusura automatica: ${reason}`,
        adjustment_amount: amount,
        adjustment_reason: reason,
      })

      // Expire pending suggestions if fully matched
      if (newStatus === 'matched') {
        await supabase.from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('bank_transaction_id', txId)
          .eq('status', 'pending')

        // Remove from unmatched list
        setUnmatchedTxs(prev => prev.filter(t => t.id !== txId))
      }
    } catch (err: unknown) {
      console.error('autoCloseRemainder error:', errMsg(err))
    }
  }, [companyId])

  // ─── confirm suggestion (partial reconciliation aware + dialog for diff > 1€) ─
  const confirmSuggestion = useCallback(async (suggestion: SuggestionRow, overrideAmount?: number) => {
    if (!companyId) return
    setConfirmingId(suggestion.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const userId = user?.id
      const now = new Date().toISOString()
      const today = now.slice(0, 10)
      const tx = suggestion.bank_transaction
      const inst = suggestion.installment

      // Calculate remaining amounts (using NET = gross - commission)
      const txNetAmount = tx ? getTxNetAmount(tx) : 0
      const txRemaining = tx ? txNetAmount - Number(tx.reconciled_amount || 0) : 0
      const instRemaining = inst ? Number(inst.amount_due) - Number(inst.paid_amount || 0) : 0

      // If diff > 1€ and no override → show dialog instead of proceeding
      if (overrideAmount == null && inst && Math.abs(txRemaining - instRemaining) > 1) {
        setPendingConfirm({ suggestion, txRemaining, instRemaining })
        setConfirmingId(null)
        return
      }

      // Use override if provided, otherwise min of what's available
      const reconcileAmount = overrideAmount ?? (inst ? Math.min(txRemaining, instRemaining) : txRemaining)

      // Validation: if nothing left to reconcile, expire suggestion
      if (reconcileAmount < 0.01) {
        await supabase.from('reconciliation_suggestions')
          .update({ status: 'expired', resolved_at: now })
          .eq('id', suggestion.id)
        toast.error('Movimento o rata già completamente riconciliato')
        setSuggestions(prev => prev.filter(s => s.id !== suggestion.id))
        setConfirmingId(null)
        return
      }

      // 1. Mark suggestion as accepted
      const { error: e1 } = await supabase
        .from('reconciliation_suggestions')
        .update({ status: 'accepted', resolved_at: now, resolved_by: userId })
        .eq('id', suggestion.id)
      if (e1) throw e1

      // 2. Create reconciliation record (with amount + installment_id)
      const { error: e2 } = await supabase
        .from('reconciliations')
        .insert({
          company_id: companyId,
          invoice_id: suggestion.invoice_id!,
          bank_transaction_id: suggestion.bank_transaction_id,
          installment_id: suggestion.installment_id,
          reconciled_amount: reconcileAmount,
          match_type: toMatchType(suggestion.proposed_by),
          confidence: suggestion.match_score / 100,
          match_reason: suggestion.match_reason,
          confirmed_by: userId,
          confirmed_at: now,
        })
      if (e2) throw e2

      // 3. Update bank transaction: increment reconciled_amount, set status
      const newTxReconciled = Number(tx?.reconciled_amount || 0) + reconcileAmount
      const txFullyMatched = tx ? newTxReconciled >= txNetAmount - 0.01 : false
      const newTxStatus = txFullyMatched ? 'matched' : 'partial'
      // Build update payload — if tx was triaged as no_invoice, correct it
      const txUpdate: Record<string, any> = { reconciled_amount: newTxReconciled, reconciliation_status: newTxStatus }
      if (tx?.tx_nature === 'no_invoice') {
        txUpdate.tx_nature = 'invoice_payment'
        txUpdate.classification_status = 'pending' // reset classification since it's now reconciled
        txUpdate.classification_source = null
      }
      const { error: e3 } = await supabase
        .from('bank_transactions')
        .update(txUpdate)
        .eq('id', suggestion.bank_transaction_id)
      if (e3) throw e3

      // 4. Update installment paid_amount if installment match
      let instFullyPaid = false
      if (suggestion.installment_id && inst && tx) {
        const newPaid = Number(inst.paid_amount) + reconcileAmount
        instFullyPaid = newPaid >= Number(inst.amount_due) - 0.01
        const newInstStatus = instFullyPaid ? 'paid' : 'partial'
        const { error: e4 } = await supabase
          .from('invoice_installments')
          .update({
            paid_amount: newPaid,
            status: newInstStatus,
            last_payment_date: tx.date || today,
          })
          .eq('id', suggestion.installment_id)
        if (e4) throw e4
      }

      // 5. Log
      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        suggestion_id: suggestion.id,
        bank_transaction_id: suggestion.bank_transaction_id,
        installment_id: suggestion.installment_id,
        invoice_id: suggestion.invoice_id,
        proposed_by: suggestion.proposed_by,
        accepted: true,
        user_id: userId,
        match_score: suggestion.match_score,
        match_reason: suggestion.match_reason,
      })

      // 5b. RAG: create learning example + company memory (fire-and-forget)
      if (tx && suggestion.invoice_id) {
        const inv = suggestion.invoice
        const suggestionData = suggestion.suggestion_data || {}
        const invoiceContracts = Array.isArray(inv?.contract_refs) ? inv?.contract_refs : []
        const txContractRefs = uniqueStrings([
          ...(Array.isArray(suggestionData.tx_contract_refs) ? suggestionData.tx_contract_refs as string[] : []),
        ])
        const invoiceContractRefs = uniqueStrings([
          inv?.primary_contract_ref || null,
          ...invoiceContracts,
          ...(Array.isArray(suggestionData.invoice_contract_refs) ? suggestionData.invoice_contract_refs as string[] : []),
        ])
        createReconciliationExample(
          companyId,
          tx.description || '', tx.date || '', Number(tx.amount),
          inv?.number || '', inv?.date || '', Number(inv?.total_amount || 0),
          tx.id, suggestion.invoice_id, suggestion.installment_id || null,
          suggestion.match_score,
          {
            txNotes: tx.notes || null,
            invoiceNotes: inv?.notes || null,
            txContractRefs,
            invoiceContractRefs,
            counterpartyName: tx.counterparty_name || ((inv?.counterparty as Record<string, unknown> | null)?.denom as string | null) || null,
          },
        ).catch(err => console.warn('[confirmSuggestion] learning example error:', err))

        // Company memory: counterparty payment pattern
        const invCp = inv?.counterparty as Record<string, unknown> | null
        createMemoryFromReconciliation(
          companyId,
          (invCp?.id as string) || null,
          tx.counterparty_name || (invCp?.denom as string) || null,
          tx.description || '',
          inv?.number || null,
          Number(tx.amount),
          suggestion.match_score,
          {
            txNotes: tx.notes || null,
            invoiceNotes: inv?.notes || null,
            txContractRefs,
            invoiceContractRefs,
          },
        ).catch(err => console.warn('[confirmSuggestion] memory error:', err))
      }

      // 5c. Miglioria 3: Upsert reconciliation rule from confirmed match
      if (tx && suggestion.invoice_id && tx.counterparty_name) {
        const inv = suggestion.invoice
        const suggestionData = suggestion.suggestion_data || {}
        const invoiceContracts = Array.isArray(inv?.contract_refs) ? inv?.contract_refs : []
        const txContractRefs = uniqueStrings([
          ...extractClientContractRefs(tx.extracted_refs || null, tx.raw_text || null),
          ...(Array.isArray(suggestionData?.tx_contract_refs) ? suggestionData?.tx_contract_refs as string[] : []),
        ])
        const invoiceContractRefs = uniqueStrings([
          inv?.primary_contract_ref || null,
          ...invoiceContracts,
          ...(Array.isArray(suggestionData?.invoice_contract_refs) ? suggestionData?.invoice_contract_refs as string[] : []),
        ])
        const txInvoiceRefs = uniqueStrings([
          ...extractClientInvoiceRefs(tx.extracted_refs || null, tx.raw_text || null).map(normalizeComparableRef),
          ...(Array.isArray(suggestionData?.ref) ? (suggestionData.ref as string[]).map(normalizeComparableRef) : []),
          typeof suggestionData?.ref === 'string' ? normalizeComparableRef(String(suggestionData.ref)) : null,
        ])
        const mandateId = extractClientMandateId(tx.extracted_refs || null)
        const invoiceAfterTx = Boolean(suggestionData?.invoice_after_tx)
        const timingConfidence = typeof suggestionData?.timing_confidence === 'string' ? suggestionData.timing_confidence : null
        const ruleName = `${tx.counterparty_name} → ${inv?.number || 'fattura'}`
        const ruleData = {
          counterparty_pattern: tx.counterparty_name,
          counterparty_denorm: tx.counterparty_name || ((inv?.counterparty as Record<string, unknown> | null)?.denom as string | null) || null,
          transaction_type: tx.transaction_type || null,
          direction: tx.direction || null,
          amount_range: [Math.abs(Number(tx.amount)) * 0.85, Math.abs(Number(tx.amount)) * 1.15],
          contract_ref: txContractRefs[0] || invoiceContractRefs[0] || null,
          contract_refs: uniqueStrings([...txContractRefs, ...invoiceContractRefs]),
          invoice_ref_patterns: txInvoiceRefs,
          mandate_id: mandateId,
          amount_target: Math.abs(Number(tx.amount)),
          counterparty_similarity: suggestion.match_score >= 90 ? 'high' : suggestion.match_score >= 75 ? 'medium' : 'low',
          days_window: typeof suggestionData?.days_diff === 'number' ? Number(suggestionData.days_diff) : null,
          timing_confidence: timingConfidence,
          invoice_after_tx: invoiceAfterTx,
          level: suggestionData?.level || null,
          tx_description: tx.description || null,
          tx_notes: tx.notes || null,
          invoice_notes: inv?.notes || null,
        }
        supabase.from('reconciliation_rules').upsert({
          company_id: companyId,
          rule_name: ruleName.slice(0, 200),
          rule_type: 'counterparty_amount',
          pattern: ruleData,
          action: { match_invoice: true },
          rule_data: ruleData,
          confidence: Math.min(1, (suggestion.match_score / 100) * 0.75 + (suggestionData?.auto_match_eligible ? 0.25 : 0.15)),
        }, { onConflict: 'company_id,rule_name' }).then(({ error: ruleErr }) => {
          if (ruleErr) console.warn('[confirmSuggestion] rule upsert error:', ruleErr)
        })
      }

      // 6. Expire suggestions that are no longer viable
      // If TX fully matched → expire ALL pending suggestions for this TX
      if (txFullyMatched) {
        await supabase
          .from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('bank_transaction_id', suggestion.bank_transaction_id)
          .eq('status', 'pending')
      }
      // If installment fully paid → expire ALL pending suggestions for this installment
      if (instFullyPaid && suggestion.installment_id) {
        await supabase
          .from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('installment_id', suggestion.installment_id)
          .eq('status', 'pending')
      }

      toast.success(`Riconciliazione confermata (${fmtEur(reconcileAmount)})`)

      // Post-reconciliation remainder dialog
      if (!txFullyMatched && tx) {
        const remainder = txNetAmount - newTxReconciled
        const commission = Math.abs(Number(tx.commission_amount || 0))

        if (remainder > 0.10) {
          setPostReconDialog({
            txId: tx.id,
            invoiceNumber: suggestion.invoice?.number || suggestion.invoice_id || null,
            reconcileAmount,
            remainder,
            commissionAmount: commission,
          })
        } else if (remainder > 0.001) {
          // Auto-close rounding ≤ 0.10€
          await autoCloseRemainder(tx.id, remainder, 'arrotondamento')
        }
      }

      await Promise.all([loadKpis(), loadSuggestions(), loadUnmatched()])
    } catch (err: unknown) {
      const msg = errMsg(err)
      toast.error(`Errore conferma: ${msg}`)
    }
    setConfirmingId(null)
  }, [companyId, loadKpis, loadSuggestions, loadUnmatched, autoCloseRemainder])

  // ─── reject suggestion ─────────────────────
  const rejectSuggestion = useCallback(async (suggestion: SuggestionRow) => {
    if (!companyId) return
    setRejectingId(suggestion.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()

      const { error } = await supabase
        .from('reconciliation_suggestions')
        .update({ status: 'rejected', resolved_at: new Date().toISOString(), resolved_by: user?.id })
        .eq('id', suggestion.id)
      if (error) throw error

      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        suggestion_id: suggestion.id,
        bank_transaction_id: suggestion.bank_transaction_id,
        installment_id: suggestion.installment_id,
        invoice_id: suggestion.invoice_id,
        proposed_by: suggestion.proposed_by,
        accepted: false,
        user_id: user?.id,
        match_score: suggestion.match_score,
        match_reason: suggestion.match_reason,
      })

      // Miglioria 4: degrade rule confidence on reject
      if (suggestion.rule_id) {
        const { data: ruleRow, error: ruleLoadErr } = await supabase
          .from('reconciliation_rules')
          .select('confidence, reject_count')
          .eq('id', suggestion.rule_id)
          .single()
        if (ruleLoadErr) {
          console.warn('[rejectSuggestion] rule load error:', ruleLoadErr)
        } else {
          const currentConfidence = Number(ruleRow?.confidence || 0)
          const currentRejectCount = Number(ruleRow?.reject_count || 0)
          const hardReject = suggestion.proposed_by === 'rule' || suggestion.suggestion_data?.level === 'rule'
          const penalty = hardReject ? 0.2 : 0.12
          const newRejectCount = currentRejectCount + 1
          const newConfidence = Math.max(0, currentConfidence - penalty - Math.min(0.1, currentRejectCount * 0.03))
          const { error: ruleErr } = await supabase
            .from('reconciliation_rules')
            .update({
              confidence: newConfidence,
              reject_count: newRejectCount,
              updated_at: new Date().toISOString(),
            })
            .eq('id', suggestion.rule_id)
          if (ruleErr) console.warn('[rejectSuggestion] rule degrade error:', ruleErr)
        }
      }

      toast.success('Suggerimento rifiutato')
      setSuggestions(prev => prev.filter(s => s.id !== suggestion.id))
      await loadKpis()
    } catch (err: unknown) {
      const msg = errMsg(err)
      toast.error(`Errore rifiuto: ${msg}`)
    }
    setRejectingId(null)
  }, [companyId, loadKpis])

  // ─── bulk confirm high-confidence ──────────
  const bulkConfirmHigh = useCallback(async () => {
    // For groups with multiple alternatives, only confirm the best (highest score)
    const highConf = suggestions.filter(s =>
      Boolean(s.suggestion_data?.auto_match_eligible) ||
      (s.match_score >= 97 && s.suggestion_data?.review_required !== true && s.suggestion_data?.level !== 'cumulative')
    )
    if (!highConf.length) return
    setBulkConfirming(true)

    // Deduplicate: pick only the best suggestion per bank_transaction_id
    const bestPerTx = new Map<string, SuggestionRow>()
    for (const s of highConf) {
      const existing = bestPerTx.get(s.bank_transaction_id)
      if (!existing || s.match_score > existing.match_score) {
        bestPerTx.set(s.bank_transaction_id, s)
      }
    }

    let ok = 0
    let fail = 0
    for (const s of bestPerTx.values()) {
      try {
        await confirmSuggestion(s)
        ok++
      } catch {
        fail++
      }
    }
    toast.success(`Confermati ${ok} suggerimenti${fail ? `, ${fail} errori` : ''}`)
    setBulkConfirming(false)
    await Promise.all([loadKpis(), loadSuggestions()])
  }, [suggestions, confirmSuggestion, loadKpis, loadSuggestions])

  // ─── manual match (assisted tab) ───────────
  const manualMatch = useCallback(async (txId: string, installment: OpenInstallment, overrideAmount?: number) => {
    if (!companyId) return
    setConfirmingId(txId)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const tx = unmatchedTxs.find(t => t.id === txId)
      if (!tx) throw new Error('Transazione non trovata')

      // Calculate partial reconciliation amounts (using NET = gross - commission)
      const txAmount = getTxNetAmount(tx)
      const txReconciledAlready = Number(tx.reconciled_amount || 0)
      const txRemaining = txAmount - txReconciledAlready
      const instRemaining = Number(installment.amount_due) - Number(installment.paid_amount)

      // If diff > 1€ and no override → show dialog
      if (overrideAmount == null && Math.abs(txRemaining - instRemaining) > 1) {
        setPendingConfirm({ txId, installment, txRemaining, instRemaining })
        setConfirmingId(null)
        return
      }

      const reconcileAmount = overrideAmount ?? Math.min(txRemaining, instRemaining)

      if (reconcileAmount < 0.01) {
        toast.error('Importo insufficiente per riconciliare')
        setConfirmingId(null)
        return
      }

      const now = new Date().toISOString()

      // Create reconciliation (with amount + installment_id)
      const { error: e1 } = await supabase.from('reconciliations').insert({
        company_id: companyId,
        invoice_id: installment.invoice_id,
        bank_transaction_id: txId,
        installment_id: installment.id,
        reconciled_amount: reconcileAmount,
        match_type: 'manual',
        confidence: 1.0,
        match_reason: 'Abbinamento manuale',
        confirmed_by: user?.id,
        confirmed_at: now,
      })
      if (e1) throw e1

      // Update bank tx with reconciled_amount
      const newTxReconciled = txReconciledAlready + reconcileAmount
      const txFullyMatched = newTxReconciled >= txAmount - 0.01
      const { error: e2 } = await supabase
        .from('bank_transactions')
        .update({
          reconciled_amount: newTxReconciled,
          reconciliation_status: txFullyMatched ? 'matched' : 'partial',
        })
        .eq('id', txId)
      if (e2) throw e2

      // Update installment
      const newPaid = Number(installment.paid_amount) + reconcileAmount
      const newStatus = newPaid >= Number(installment.amount_due) - 0.01 ? 'paid' : 'partial'
      const { error: e3 } = await supabase
        .from('invoice_installments')
        .update({
          paid_amount: newPaid,
          status: newStatus,
          last_payment_date: tx.date || now.slice(0, 10),
        })
        .eq('id', installment.id)
      if (e3) throw e3

      // Log
      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        bank_transaction_id: txId,
        installment_id: installment.id,
        invoice_id: installment.invoice_id,
        proposed_by: 'manual',
        accepted: true,
        user_id: user?.id,
        match_score: 100,
        match_reason: 'Abbinamento manuale utente',
      })

      // RAG: create learning example for manual match (fire-and-forget)
      createReconciliationExample(
        companyId,
        tx.description || '', tx.date || '', Number(tx.amount),
        installment.invoice_number || '', '', Number(installment.amount_due),
        tx.id, installment.invoice_id, installment.id, 100,
        {
          txNotes: tx.notes || null,
          invoiceNotes: installment.invoice_notes || null,
          invoiceContractRefs: uniqueStrings([
            installment.primary_contract_ref || null,
            ...(Array.isArray(installment.contract_refs) ? installment.contract_refs : []),
          ]),
          counterpartyName: tx.counterparty_name || installment.counterparty_name || null,
        },
      ).catch(err => console.warn('[manualMatch] learning example error:', err))

      createMemoryFromReconciliation(
        companyId,
        null,
        tx.counterparty_name || installment.counterparty_name || null,
        tx.description || '',
        installment.invoice_number || null,
        Number(tx.amount),
        100,
        {
          txNotes: tx.notes || null,
          invoiceNotes: installment.invoice_notes || null,
          invoiceContractRefs: uniqueStrings([
            installment.primary_contract_ref || null,
            ...(Array.isArray(installment.contract_refs) ? installment.contract_refs : []),
          ]),
        },
      ).catch(err => console.warn('[manualMatch] memory error:', err))

      // Expire impossible suggestions for this TX or installment
      if (txFullyMatched) {
        await supabase.from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('bank_transaction_id', txId)
          .eq('status', 'pending')
      }
      if (newStatus === 'paid') {
        await supabase.from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('installment_id', installment.id)
          .eq('status', 'pending')
      }

      toast.success(`Riconciliazione manuale completata (${fmtEur(reconcileAmount)})`)
      if (txFullyMatched) {
        setUnmatchedTxs(prev => prev.filter(t => t.id !== txId))
      }
      setOpenInstallments(prev => prev.map(i =>
        i.id === installment.id ? { ...i, paid_amount: newPaid, status: newStatus } : i
      ).filter(i => i.status !== 'paid'))
      setSelectedTxId(null)

      // Post-reconciliation remainder dialog
      if (!txFullyMatched) {
        const remainder = txAmount - newTxReconciled  // txAmount is already net
        const commission = Math.abs(Number(tx.commission_amount || 0))

        if (remainder > 0.10) {
          setPostReconDialog({
            txId: tx.id,
            invoiceNumber: installment.invoice_number,
            reconcileAmount,
            remainder,
            commissionAmount: commission,
          })
        } else if (remainder > 0.001) {
          // Auto-close rounding ≤ 0.10€
          await autoCloseRemainder(tx.id, remainder, 'arrotondamento')
        }
      }

      await Promise.all([loadKpis(), loadUnmatched()])
    } catch (err: unknown) {
      const msg = errMsg(err)
      toast.error(`Errore: ${msg}`)
    }
    setConfirmingId(null)
  }, [companyId, unmatchedTxs, loadKpis, loadUnmatched, autoCloseRemainder])

  // ─── delete reconciliation (undo) ─────────
  const deleteReconciliation = useCallback(async (recon: ReconciledRow) => {
    if (!companyId) return
    setDeletingReconId(recon.id)
    try {
      // 1. Find the installment linked via reconciliation_log so we can reverse paid_amount
      const { data: logRows } = await supabase
        .from('reconciliation_log')
        .select('installment_id')
        .eq('bank_transaction_id', recon.bank_transaction_id)
        .eq('invoice_id', recon.invoice_id)
        .eq('accepted', true)
        .limit(1)

      const installmentId = logRows?.[0]?.installment_id

      // 2. Get the reconciled_amount from the reconciliation record (or fallback to TX amount)
      const { data: reconRecord } = await supabase
        .from('reconciliations')
        .select('reconciled_amount, installment_id')
        .eq('id', recon.id)
        .single()
      const reversalAmount = reconRecord?.reconciled_amount
        ? Number(reconRecord.reconciled_amount)
        : (recon.bank_transaction ? Math.abs(Number(recon.bank_transaction.amount)) : 0)
      const reconInstallmentId = reconRecord?.installment_id || installmentId

      // 3. Delete reconciliation row
      const { error: e1 } = await supabase
        .from('reconciliations')
        .delete()
        .eq('id', recon.id)
      if (e1) throw e1

      // 4. Smart reset: recalculate bank TX from remaining reconciliations + adjustments
      const { count: remainingReconCount } = await supabase
        .from('reconciliations')
        .select('*', { count: 'exact', head: true })
        .eq('bank_transaction_id', recon.bank_transaction_id)

      if ((remainingReconCount ?? 0) === 0) {
        // No reconciliations remain → full reset (also clears lingering auto-close adjustments)
        const { error: e2 } = await supabase
          .from('bank_transactions')
          .update({ reconciled_amount: 0, reconciliation_status: 'unmatched' })
          .eq('id', recon.bank_transaction_id)
        if (e2) throw e2
      } else {
        // Some reconciliations remain → recalculate from actual data
        const [{ data: remainingRecons }, { data: adjLogs }, { data: txData }] = await Promise.all([
          supabase.from('reconciliations').select('reconciled_amount').eq('bank_transaction_id', recon.bank_transaction_id),
          supabase.from('reconciliation_log').select('adjustment_amount').eq('bank_transaction_id', recon.bank_transaction_id).eq('accepted', true).not('adjustment_amount', 'is', null),
          supabase.from('bank_transactions').select('amount, commission_amount').eq('id', recon.bank_transaction_id).single(),
        ])
        const reconSum = (remainingRecons || []).reduce((s, r) => s + Number(r.reconciled_amount || 0), 0)
        const adjSum = (adjLogs || []).reduce((s, a) => s + Number(a.adjustment_amount || 0), 0)
        const newReconciled = Math.max(0, reconSum + adjSum)
        const txNet = txData ? Math.abs(Number(txData.amount)) - Math.abs(Number(txData.commission_amount || 0)) : 0
        const newStatus = newReconciled >= txNet - 0.01 ? 'matched' : newReconciled > 0.01 ? 'partial' : 'unmatched'
        const { error: e2 } = await supabase
          .from('bank_transactions')
          .update({ reconciled_amount: newReconciled, reconciliation_status: newStatus })
          .eq('id', recon.bank_transaction_id)
        if (e2) throw e2
      }

      // 5. Reverse installment paid_amount
      const resolvedInstId = reconInstallmentId
      if (resolvedInstId) {
        const { data: instData } = await supabase
          .from('invoice_installments')
          .select('paid_amount, amount_due')
          .eq('id', resolvedInstId)
          .single()
        if (instData) {
          const newPaid = Math.max(0, Number(instData.paid_amount) - reversalAmount)
          const newStatus = newPaid <= 0 ? 'pending' : newPaid >= Number(instData.amount_due) - 0.01 ? 'paid' : 'partial'
          await supabase
            .from('invoice_installments')
            .update({ paid_amount: newPaid, status: newStatus })
            .eq('id', resolvedInstId)
        }
      }

      // 5. Log the undo
      const { data: { user } } = await supabase.auth.getUser()
      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        bank_transaction_id: recon.bank_transaction_id,
        installment_id: installmentId || null,
        invoice_id: recon.invoice_id,
        proposed_by: 'manual',
        accepted: false,
        user_id: user?.id,
        match_score: (recon.confidence ?? 0) * 100,
        match_reason: 'Riconciliazione annullata manualmente',
      })

      toast.success('Riconciliazione eliminata')
      setReconciledRows(prev => prev.filter(r => r.id !== recon.id))
      setConfirmDeleteId(null)
      await Promise.all([loadKpis(), loadUnmatched(), loadOpenInstallments()])
    } catch (err: unknown) {
      const msg = errMsg(err)
      toast.error(`Errore eliminazione: ${msg}`)
    }
    setDeletingReconId(null)
  }, [companyId, loadKpis, loadUnmatched, loadOpenInstallments])

  // ─── handle confirm choice (from dialog) ───
  const handleConfirmChoice = useCallback(async (chosenAmount: number) => {
    if (!pendingConfirm) return
    if (pendingConfirm.suggestion) {
      await confirmSuggestion(pendingConfirm.suggestion, chosenAmount)
    } else if (pendingConfirm.txId && pendingConfirm.installment) {
      await manualMatch(pendingConfirm.txId, pendingConfirm.installment, chosenAmount)
    }
    setPendingConfirm(null)
  }, [pendingConfirm, confirmSuggestion, manualMatch])

  // ─── close difference (Riconciliati tab) ──
  const closeDifference = useCallback(async (reconRow: ReconciledRow, amount: number, reason: string) => {
    if (!companyId) return
    setClosingInProgress(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const tx = reconRow.bank_transaction
      if (!tx) throw new Error('Movimento non trovato')

      // 1. Update bank_transaction.reconciled_amount
      const newReconciled = Number(tx.reconciled_amount || 0) + amount
      const txNet = getTxNetAmount(tx)
      const newStatus = newReconciled >= txNet - 0.01 ? 'matched' : 'partial'
      const { error: e1 } = await supabase.from('bank_transactions')
        .update({ reconciled_amount: newReconciled, reconciliation_status: newStatus })
        .eq('id', reconRow.bank_transaction_id)
      if (e1) throw e1

      // 2. Log with adjustment
      await supabase.from('reconciliation_log').insert({
        company_id: companyId,
        bank_transaction_id: reconRow.bank_transaction_id,
        invoice_id: reconRow.invoice_id,
        proposed_by: 'manual',
        accepted: true,
        user_id: user?.id,
        match_score: 100,
        match_reason: `Chiusura differenza: ${reason}`,
        adjustment_amount: amount,
        adjustment_reason: reason,
      })

      // 3. If TX fully matched → expire pending suggestions
      if (newStatus === 'matched') {
        await supabase.from('reconciliation_suggestions')
          .update({ status: 'expired' })
          .eq('bank_transaction_id', reconRow.bank_transaction_id)
          .eq('status', 'pending')
      }

      const reasonLabels: Record<string, string> = {
        abbuono_attivo: 'Abbuono attivo',
        abbuono_passivo: 'Abbuono passivo',
        commissione_bancaria: 'Commissione bancaria',
        arrotondamento: 'Arrotondamento',
      }
      toast.success(`Differenza di ${fmtEur(amount)} chiusa come ${reasonLabels[reason] || reason}`)
      setClosingDiffId(null)
      setClosingAmount('')
      await Promise.all([loadKpis(), loadReconciled()])
    } catch (err: unknown) {
      const msg = errMsg(err)
      toast.error(`Errore chiusura differenza: ${msg}`)
    }
    setClosingInProgress(false)
  }, [companyId, loadKpis, loadReconciled])

  // ─── handle post-reconciliation action ──────
  const handlePostReconAction = useCallback(async (action: 'commission' | 'abbuono' | 'skip') => {
    if (!postReconDialog) return
    if (action === 'skip') {
      const txId = postReconDialog.txId
      setPostReconDialog(null)
      // Navigate to assisted tab and pre-select the partial TX for further matching
      await Promise.all([loadKpis(), loadSuggestions(), loadUnmatched(), loadOpenInstallments()])
      setActiveTab('assisted')
      setSelectedTxId(txId)
      setCandidateAiResult(null)
      setCandidateAiInstallments([])
      setCandidateSearch('')
      return
    }

    const reason = action === 'commission' ? 'commissione_bancaria' : 'abbuono_passivo'

    try {
      await autoCloseRemainder(postReconDialog.txId, postReconDialog.remainder, reason)
      setPostReconDialog(null)

      const reasonLabels: Record<string, string> = {
        commissione_bancaria: 'Commissione bancaria',
        abbuono_passivo: 'Abbuono',
      }
      toast.success(`Residuo di ${fmtEur(postReconDialog.remainder)} chiuso come ${reasonLabels[reason] || reason}`)
      await Promise.all([loadKpis(), loadSuggestions(), loadUnmatched()])
    } catch (err: unknown) {
      toast.error(`Errore chiusura residuo: ${errMsg(err)}`)
    }
  }, [postReconDialog, autoCloseRemainder, loadKpis, loadSuggestions, loadUnmatched, loadOpenInstallments])

  // ─── tab change handler ────────────────────
  const handleTabChange = (tab: string) => {
    const t = tab as 'suggestions' | 'assisted' | 'reconciled'
    setActiveTab(t)
    setSearchParams(prev => {
      const p = new URLSearchParams(prev)
      p.set('tab', t)
      return p
    })
  }

  // Lookup: bank_transaction_id → reconciliation info (for showing partial match history)
  const txReconHistory = useMemo(() => {
    const map = new Map<string, { invoiceNumber: string | null; amount: number; date: string }[]>()
    for (const r of reconciledRows) {
      const txId = r.bank_transaction_id
      if (!map.has(txId)) map.set(txId, [])
      const invNum = (r.invoice as any)?.number || null
      map.get(txId)!.push({
        invoiceNumber: invNum,
        amount: Number(r.reconciled_amount || 0),
        date: r.confirmed_at || r.created_at,
      })
    }
    return map
  }, [reconciledRows])

  // ─── filtered unmatched for assisted tab ───
  const partialCount = useMemo(() => unmatchedTxs.filter(tx => tx.reconciliation_status === 'partial').length, [unmatchedTxs])
  const filteredUnmatched = useMemo(() => {
    let list = unmatchedTxs
    if (assistedPartialOnly) {
      list = list.filter(tx => tx.reconciliation_status === 'partial')
    }
    if (assistedSearch.trim()) {
      const q = assistedSearch.toLowerCase()
      list = list.filter(tx =>
        (tx.counterparty_name || '').toLowerCase().includes(q) ||
        (tx.description || '').toLowerCase().includes(q) ||
        String(tx.amount).includes(q)
      )
    }
    // Sort by last reconciliation date when active
    if (assistedSortByReconDate && txReconHistory.size > 0) {
      list = [...list].sort((a, b) => {
        const aHistory = txReconHistory.get(a.id)
        const bHistory = txReconHistory.get(b.id)
        const aDate = aHistory?.reduce((latest, h) => h.date > latest ? h.date : latest, '') || ''
        const bDate = bHistory?.reduce((latest, h) => h.date > latest ? h.date : latest, '') || ''
        if (!aDate && !bDate) return 0
        if (!aDate) return 1
        if (!bDate) return -1
        return assistedSortByReconDate === 'asc' ? aDate.localeCompare(bDate) : bDate.localeCompare(aDate)
      })
    }
    return list
  }, [unmatchedTxs, assistedSearch, assistedPartialOnly, assistedSortByReconDate, txReconHistory])



  // ─── selected TX partial info (for residual banner) ───
  const selectedTxPartialInfo = useMemo(() => {
    if (!selectedTxId) return null
    const selTx = unmatchedTxs.find(t => t.id === selectedTxId)
    if (!selTx || selTx.reconciliation_status !== 'partial') return null
    const netAmt = Math.abs(Number(selTx.amount)) - Math.abs(Number(selTx.commission_amount || 0))
    const reconciled = Number(selTx.reconciled_amount || 0)
    return { netAmt, reconciled, residual: netAmt - reconciled }
  }, [selectedTxId, unmatchedTxs])

  // ─── AI search for candidates ────────────
  const handleCandidateAISearch = useCallback(async () => {
    if (!candidateSearch.trim() || !companyId) return
    setCandidateAiSearching(true)
    setCandidateAiResult(null)
    setCandidateAiInstallments([])
    try {
      const result = await askInvoiceAiSearch({
        query: candidateSearch,
        company_id: companyId,
      })
      console.log('[Riconciliazione AI] result:', JSON.stringify({
        query_type: result.query_type, total: result.total,
        explanation: result.explanation?.slice(0, 80),
        ids: result.ids,
      }))
      const ids = result.ids || []

      // Fetch installments for matched invoices directly (bypasses the 1000-row limit
      // of loadOpenInstallments which can miss invoices beyond the cap)
      if (ids.length > 0) {
        const { data: instData } = await supabase
          .from('invoice_installments')
          .select(`
            id, invoice_id, installment_no, due_date, amount_due, paid_amount, status, direction,
            invoice:invoices(number, counterparty, notes)
          `)
          .eq('company_id', companyId)
          .in('invoice_id', ids)
          .in('status', ['pending', 'overdue', 'partial'])
          .order('due_date', { ascending: true })
        if (instData) {
          setCandidateAiInstallments(instData.map((d: any) => ({
            id: d.id,
            invoice_id: d.invoice_id,
            installment_no: d.installment_no,
            due_date: d.due_date,
            amount_due: d.amount_due,
            paid_amount: d.paid_amount,
            status: d.status,
            direction: d.direction,
            invoice_number: d.invoice?.number || null,
            counterparty_name: d.invoice?.counterparty?.denom || null,
            invoice_notes: d.invoice?.notes || null,
            primary_contract_ref: null,
            contract_refs: [],
          })))
        }
      }

      setCandidateSearch('')
      setCandidateAiResult({
        text: result.explanation || `Trovate ${result.total} fatture`,
        isError: false,
        requestId: result.request_id,
        candidateIds: ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'],
        total: result.total,
      })
    } catch (e: any) {
      console.error('[Riconciliazione AI] error:', e)
      const errText = [
        e.message || 'Errore ricerca AI',
        e.hint ? `Suggerimento: ${e.hint}` : '',
      ].filter(Boolean).join(' — ')
      setCandidateAiResult({ text: errText, isError: true })
    }
    setCandidateAiSearching(false)
  }, [candidateSearch, companyId])

  // ─── candidates for selected tx ────────────
  const candidates = useMemo(() => {
    if (!selectedTxId) return []
    const tx = unmatchedTxs.find(t => t.id === selectedTxId)
    if (!tx) return []

    const txAmount = Number(tx.amount)
    const absAmount = getTxNetAmount(tx)  // netto: lordo - commissione

    // Direction filter: amount > 0 (entrata) → fattura attiva (direction='out')
    //                   amount < 0 (uscita)  → fattura passiva (direction='in')
    const expectedDirection = txAmount >= 0 ? 'out' : 'in'

    // Extract invoice refs for this TX (prioritization)
    const txInvoiceRefs = extractClientInvoiceRefs(tx.extracted_refs, tx.raw_text)

    // Counterparty name for prioritization (normalized lowercase)
    const txCounterparty = (tx.counterparty_name || '').toLowerCase().trim()

    // When AI search is active, use the dedicated AI-fetched installments
    // (loaded directly for matched invoice IDs, not subject to the 1000-row cap
    // of loadOpenInstallments which can miss invoices beyond the limit).
    // When AI is not active, use the pre-loaded openInstallments.
    const sourceInstallments = candidateAiResult?.candidateIds?.length
      ? candidateAiInstallments
      : openInstallments

    // Filter installments: remaining > 0 AND matching direction
    let filtered = sourceInstallments.filter(inst => {
      const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
      if (remaining <= 0) return false
      // Direction filter: only show invoices matching the expected direction
      if (inst.direction !== expectedDirection) return false
      return true
    })

    // Enrich with match data: ref match, counterparty match, amount similarity
    let enriched = filtered.map(inst => {
      const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
      const diff = Math.abs(absAmount - remaining)
      const ratio = absAmount > 0 ? diff / absAmount : 1

      // Check if this installment's invoice matches any extracted ref
      const refMatch = txInvoiceRefs.length > 0 && inst.invoice_number
        ? txInvoiceRefs.some(ref => invoiceNumberMatchesRef(inst.invoice_number!, ref))
        : false
      const matchedRef = refMatch && inst.invoice_number
        ? txInvoiceRefs.find(ref => invoiceNumberMatchesRef(inst.invoice_number!, ref)) || null
        : null

      // Counterparty match: same counterparty gets higher priority
      const instCounterparty = (inst.counterparty_name || '').toLowerCase().trim()
      const sameCounterparty = txCounterparty.length > 2 && instCounterparty.length > 2 &&
        (txCounterparty.includes(instCounterparty) || instCounterparty.includes(txCounterparty))

      // Priority: 0 = ref match, 1 = same counterparty, 2 = other
      const priority = refMatch ? 0 : sameCounterparty ? 1 : 2

      return {
        ...inst,
        _diff: diff,
        _ratio: ratio,
        _priority: priority,
        _refMatch: refMatch,
        _matchedRef: matchedRef,
        _sameCounterparty: sameCounterparty,
      }
    })
    // Sort: ref-matched first (0), then same counterparty (1), then others (2)
    // Within each group, sort by amount closeness
    .sort((a, b) => a._priority - b._priority || a._ratio - b._ratio)

    // Apply search filter
    if (candidateSearch.trim()) {
      const q = candidateSearch.toLowerCase()
      enriched = enriched.filter(inst =>
        (inst.counterparty_name || '').toLowerCase().includes(q) ||
        (inst.invoice_number || '').toLowerCase().includes(q)
      )
    }

    return enriched.slice(0, 50)
  }, [selectedTxId, unmatchedTxs, openInstallments, candidateSearch, candidateAiResult, candidateAiInstallments])

  // Filtered reconciled rows
  const filteredReconciled = useMemo(() => {
    if (!reconciledSearch.trim()) return reconciledRows
    const q = reconciledSearch.toLowerCase()
    return reconciledRows.filter(r => {
      const tx = r.bank_transaction
      const inv = r.invoice
      const cpName = inv?.counterparty && typeof inv.counterparty === 'object'
        ? ((inv.counterparty as any).denom || '').toLowerCase() : ''
      return (
        (tx?.counterparty_name || '').toLowerCase().includes(q) ||
        (tx?.description || '').toLowerCase().includes(q) ||
        (inv?.number || '').toLowerCase().includes(q) ||
        cpName.includes(q) ||
        String(tx?.amount || '').includes(q)
      )
    })
  }, [reconciledRows, reconciledSearch])

  // Percentage KPI
  const matchPct = kpi.total > 0 ? Math.round((kpi.matched / kpi.total) * 100) : 0
  const highConfCount = suggestions.filter(s => s.match_score >= 90).length

  // Group suggestions by bank_transaction_id for visual connector
  const groupedSuggestions = useMemo(() => {
    const groups: { txId: string; items: SuggestionRow[] }[] = []
    const seen = new Map<string, number>()
    for (const s of suggestions) {
      const txId = s.bank_transaction_id
      if (seen.has(txId)) {
        groups[seen.get(txId)!].items.push(s)
      } else {
        seen.set(txId, groups.length)
        groups.push({ txId, items: [s] })
      }
    }
    return groups
  }, [suggestions])

  const navigate = useNavigate()

  // ─── render ───────────────────────────────
  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-purple-500" />
        <span className="ml-2 text-sm text-gray-500">Caricamento riconciliazione...</span>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      {/* ──── Header ──── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Riconciliazione</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Abbina automaticamente movimenti bancari a fatture e rate</p>
        </div>
        <button
          onClick={generateSuggestions}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
            generating
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-purple-600 text-white hover:bg-purple-700'
          }`}
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {generating ? '⏹ Stop' : 'Genera suggerimenti'}
        </button>
      </div>

      {/* ──── KPI Cards ──── */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <KpiCard
          label="Da riconciliare"
          value={kpi.unmatched}
          icon={AlertTriangle}
          color="text-red-700"
          bg="bg-red-50"
          iconColor="text-red-500"
        />
        {kpi.partial > 0 && (
          <KpiCard
            label="Parziali"
            value={kpi.partial}
            icon={ArrowRightLeft}
            color="text-orange-700"
            bg="bg-orange-50"
            iconColor="text-orange-500"
            sub="riconciliati parzialmente"
          />
        )}
        <KpiCard
          label="Suggerimenti AI"
          value={kpi.pendingSuggestions}
          icon={Sparkles}
          color="text-purple-700"
          bg="bg-purple-50"
          iconColor="text-purple-500"
        />
        <KpiCard
          label="Riconciliati"
          value={kpi.matched}
          icon={CheckCircle2}
          color="text-emerald-700"
          bg="bg-emerald-50"
          iconColor="text-emerald-500"
        />
        <KpiCard
          label="Completamento"
          value={`${matchPct}%`}
          icon={Zap}
          color="text-blue-700"
          bg="bg-blue-50"
          iconColor="text-blue-500"
          sub={`${kpi.matched + kpi.partial} / ${kpi.total} movimenti`}
        />
      </div>

      {/* ──── Tabs ──── */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList>
          <TabsTrigger value="suggestions" className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Suggerimenti AI
            {kpi.pendingSuggestions > 0 && (
              <span className="ml-1 text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-semibold">
                {kpi.pendingSuggestions}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="assisted" className="gap-1.5">
            <ArrowRightLeft className="h-3.5 w-3.5" />
            Riconciliazione assistita
          </TabsTrigger>
          <TabsTrigger value="reconciled" className="gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Riconciliati
            {kpi.matched > 0 && (
              <span className="ml-1 text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-semibold">
                {kpi.matched}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* ──── Tab 1: Suggestions ──── */}
        <TabsContent value="suggestions" className="mt-4 space-y-3">
          {suggestions.length === 0 ? (
            <EmptyState
              icon={Link2}
              title="Nessun suggerimento in attesa"
              description={kpi.unmatched > 0
                ? `Hai ${kpi.unmatched} movimenti da riconciliare. Clicca "Genera suggerimenti" per avviare l'analisi AI.`
                : 'Tutti i movimenti sono stati riconciliati o non ci sono dati sufficienti per generare suggerimenti.'
              }
            />
          ) : (
            <>
              {/* Bulk confirm bar */}
              {highConfCount > 0 && (
                <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-emerald-600" />
                    <span className="text-sm text-emerald-800">
                      <strong>{highConfCount}</strong> suggerimenti ad alta confidenza (&ge;90%)
                    </span>
                  </div>
                  <button
                    onClick={bulkConfirmHigh}
                    disabled={bulkConfirming}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                  >
                    {bulkConfirming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    Conferma tutti
                  </button>
                </div>
              )}

              {/* Suggestion cards — grouped by bank transaction */}
              {groupedSuggestions.map(group => {
                // Check if this group is a cumulative ref-match (all items from invoice_ref level)
                const isRefGroup = group.items.length > 1 &&
                  group.items.every(s => s.suggestion_data?.level === 'invoice_ref')
                const tx0 = group.items[0]?.bank_transaction

                if (isRefGroup && tx0) {
                  // ── Cumulative invoice-ref card ──
                  const txDir = txDirection(tx0)
                  const absAmount = Math.abs(Number(tx0.amount))
                  const hasComm = tx0.commission_amount != null && Number(tx0.commission_amount) !== 0
                  const sign = txDir === 'in' ? '+' : '-'
                  const netAmt = hasComm ? absAmount - Math.abs(Number(tx0.commission_amount)) : absAmount
                  const totalInstRemaining = group.items.reduce((sum, s) => {
                    const ir = s.installment ? Number(s.installment.amount_due) - Number(s.installment.paid_amount) : 0
                    return sum + ir
                  }, 0)
                  const sumDiff = Math.abs(netAmt - totalInstRemaining)
                  const sumClose = netAmt > 0 ? sumDiff / netAmt < 0.05 : false

                  return (
                    <div key={group.txId} className="bg-white border-2 border-emerald-200 rounded-lg overflow-hidden">
                      {/* Header: TX info */}
                      <div className={`px-4 py-3 ${txDir === 'in' ? 'bg-emerald-50' : 'bg-red-50'} border-b border-emerald-200`}>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Landmark className="h-4 w-4 text-gray-500" />
                            <span className="text-sm font-semibold text-gray-800">{tx0.counterparty_name || 'N.D.'}</span>
                            <span className={`text-sm font-bold ${txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                              {sign}{fmtEur(hasComm ? netAmt : absAmount)}
                            </span>
                            {hasComm && <span className="text-[10px] text-gray-400">lordo {sign}{fmtEur(absAmount)}</span>}
                            <span className="text-[10px] text-gray-400">{fmtDate(tx0.date)}</span>
                            <button
                              onClick={() => navigate(`/banca?txId=${tx0.id}`)}
                              className="p-0.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                              title="Vai al movimento in Banca"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          </div>
                          <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded-full">
                            📌 {group.items.length} fatture citate nel testo
                          </span>
                        </div>
                      </div>

                      {/* Invoice list */}
                      <div className="divide-y">
                        {group.items.map(s => {
                          const inv = s.invoice
                          const inst = s.installment
                          const instRem = inst ? Number(inst.amount_due) - Number(inst.paid_amount) : 0
                          const invoiceDenom = inv?.counterparty && typeof inv.counterparty === 'object'
                            ? (inv.counterparty as any).denom || 'N.D.' : 'N.D.'

                          return (
                            <div key={s.id} className="px-4 py-2 flex items-center justify-between hover:bg-gray-50/50 transition-colors">
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="text-[10px] text-emerald-600">📌</span>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-gray-800 truncate">{invoiceDenom}</span>
                                    {inv?.number && (
                                      <span className="text-[10px] text-emerald-700 bg-emerald-50 px-1.5 py-0.5 rounded font-semibold">
                                        {inv.number}
                                      </span>
                                    )}
                                    {inst && (
                                      <span className="text-[10px] text-gray-400">Rata {inst.installment_no}</span>
                                    )}
                                    {inv && (
                                      <button
                                        onClick={() => navigate(`/fatture?invoiceId=${inv.id}`)}
                                        className="p-0.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                                        title="Vai alla fattura"
                                      >
                                        <ExternalLink className="h-2.5 w-2.5" />
                                      </button>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    {inst && <span className="text-[10px] text-gray-400">Scad. {fmtDate(inst.due_date)}</span>}
                                    <span className={`text-[10px] ${scoreBadge(s.match_score)} px-1 py-0.5 rounded`}>
                                      {s.match_score}%
                                    </span>
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 shrink-0">
                                <span className="text-xs font-semibold text-blue-700">{fmtEur(instRem)}</span>
                                <div className="flex items-center gap-1">
                                  <button
                                    onClick={() => rejectSuggestion(s)}
                                    disabled={rejectingId === s.id || confirmingId === s.id}
                                    className="p-1 rounded text-red-400 hover:bg-red-50 disabled:opacity-40 transition-colors"
                                    title="Rifiuta"
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={() => confirmSuggestion(s)}
                                    disabled={confirmingId === s.id || rejectingId === s.id}
                                    className="flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                                  >
                                    {confirmingId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                  </button>
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>

                      {/* Footer: totals comparison */}
                      <div className="px-4 py-2.5 bg-gray-50 border-t flex items-center justify-between">
                        <div className="flex items-center gap-4 text-xs">
                          <span className="text-gray-500">Totale fatture: <strong className="text-blue-700">{fmtEur(totalInstRemaining)}</strong></span>
                          <span className="text-gray-400">|</span>
                          <span className="text-gray-500">Importo movimento: <strong className={txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}>{fmtEur(netAmt)}</strong></span>
                          {sumClose ? (
                            <span className="text-[10px] text-emerald-600 font-medium bg-emerald-50 px-1.5 py-0.5 rounded">✅ Importi corrispondono</span>
                          ) : (
                            <span className="text-[10px] text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">Diff: {fmtEur(sumDiff)}</span>
                          )}
                        </div>
                        <button
                          onClick={async () => {
                            for (const s of group.items) {
                              try { await confirmSuggestion(s) } catch { /* continue */ }
                            }
                          }}
                          disabled={bulkConfirming}
                          className="flex items-center gap-1 px-3 py-1 text-[11px] font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                        >
                          <Check className="h-3 w-3" />
                          Conferma tutte ({group.items.length})
                        </button>
                      </div>
                    </div>
                  )
                }

                // ── Standard grouped rendering (alternatives or mixed levels) ──
                return (
                  <div key={group.txId} className={group.items.length > 1 ? 'space-y-2' : ''}>
                    {group.items.length > 1 && (
                      <div className="flex items-center gap-2 ml-3">
                        <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">
                          {group.items.length} alternative per lo stesso movimento
                        </span>
                      </div>
                    )}
                    <div className={group.items.length > 1 ? 'pl-3 border-l-2 border-blue-200 space-y-2' : ''}>
                      {group.items.map(s => (
                        <SuggestionCard
                          key={s.id}
                          suggestion={s}
                          onConfirm={() => confirmSuggestion(s)}
                          onReject={() => rejectSuggestion(s)}
                          confirming={confirmingId === s.id}
                          rejecting={rejectingId === s.id}
                          onBankTxDoubleClick={(txId) => setDetailPopup({ type: 'bank_tx', id: txId })}
                          onInvoiceDoubleClick={(invId) => setDetailPopup({ type: 'invoice', id: invId })}
                          onNavigateTx={(txId) => navigate(`/banca?txId=${txId}`)}
                          onNavigateInvoice={(invId) => navigate(`/fatture?invoiceId=${invId}`)}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </TabsContent>

        {/* ──── Tab 2: Assisted ──── */}
        <TabsContent value="assisted" className="mt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4" style={{ minHeight: 500 }}>
            {/* Left: Unmatched transactions */}
            <div className="border rounded-lg bg-white flex flex-col">
              <div className="px-3 py-2.5 border-b bg-gray-50/80 flex items-center gap-2">
                <Landmark className="h-4 w-4 text-gray-500" />
                <span className="text-sm font-semibold text-gray-700">Movimenti bancari</span>
                <span className="text-[10px] text-gray-400 ml-auto">{filteredUnmatched.length}</span>
              </div>
              <div className="px-3 py-2 border-b space-y-1.5">
                <div className="flex items-center gap-1.5">
                  <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                    <input
                      type="text"
                      value={assistedSearch}
                      onChange={e => setAssistedSearch(e.target.value)}
                      placeholder="Cerca controparte, descrizione..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-purple-400"
                    />
                  </div>
                  {partialCount > 0 && (
                    <button
                      onClick={() => setAssistedPartialOnly(f => !f)}
                      className={`px-2 py-1.5 text-[10px] font-semibold rounded-md border whitespace-nowrap transition-colors ${
                        assistedPartialOnly
                          ? 'bg-orange-100 text-orange-700 border-orange-300'
                          : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      Parziali ({partialCount})
                    </button>
                  )}
                  {assistedPartialOnly && partialCount > 0 && (
                    <button
                      onClick={() => setAssistedSortByReconDate(prev => prev === null ? 'asc' : prev === 'asc' ? 'desc' : null)}
                      className={`px-2 py-1.5 text-[10px] font-semibold rounded-md border whitespace-nowrap transition-colors ${
                        assistedSortByReconDate
                          ? 'bg-blue-100 text-blue-700 border-blue-300'
                          : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'
                      }`}
                      title={assistedSortByReconDate === 'asc' ? 'Meno recente prima' : assistedSortByReconDate === 'desc' ? 'Più recente prima' : 'Ordina per data riconciliazione'}
                    >
                      {assistedSortByReconDate === 'asc' ? '↑' : assistedSortByReconDate === 'desc' ? '↓' : '⇅'} Data ric.
                    </button>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {filteredUnmatched.length === 0 ? (
                  <div className="text-xs text-gray-400 text-center py-8">Nessun movimento non riconciliato</div>
                ) : filteredUnmatched.map(tx => {
                  const isSelected = selectedTxId === tx.id
                  const txAbs = Math.abs(Number(tx.amount))
                  const hasComm = tx.commission_amount != null && Number(tx.commission_amount) !== 0
                  const sign = tx.direction === 'in' ? '+' : '-'
                  const netAmt = hasComm ? txAbs - Math.abs(Number(tx.commission_amount)) : txAbs
                  const txRefs = extractClientInvoiceRefs(tx.extracted_refs, tx.raw_text)
                  const isPartial = tx.reconciliation_status === 'partial'
                  const txReconciledAmt = Number(tx.reconciled_amount || 0)
                  const txAvailable = netAmt - txReconciledAmt
                  return (
                    <button
                      key={tx.id}
                      onClick={() => { setSelectedTxId(isSelected ? null : tx.id); setCandidateAiResult(null); setCandidateAiInstallments([]); setCandidateSearch('') }}
                      onDoubleClick={() => setDetailPopup({ type: 'bank_tx', id: tx.id })}
                      title="Doppio click per dettaglio"
                      className={`w-full text-left px-3 py-2 border-b last:border-b-0 transition-colors ${
                        isSelected ? 'bg-purple-50 border-l-2 border-l-purple-500' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-1.5 h-1.5 rounded-full ${tx.direction === 'in' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                          <span className="text-xs font-medium text-gray-800 truncate">
                            {tx.counterparty_name || 'N.D.'}
                          </span>
                          {isPartial && (
                            <span className="text-[9px] font-medium text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded-full shrink-0">
                              Parziale
                            </span>
                          )}
                          {txRefs.length > 0 && (
                            <span className="text-[9px] text-emerald-700 bg-emerald-50 px-1 py-0.5 rounded shrink-0" title={`Rif. fatture: ${txRefs.join(', ')}`}>
                              📌{txRefs.length}
                            </span>
                          )}
                        </div>
                        <div className="text-right shrink-0 ml-2">
                          <span className={`text-xs font-semibold ${tx.direction === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                            {sign}{fmtEur(netAmt)}{hasComm && <span className="text-[9px] font-normal text-gray-400 ml-0.5">netto</span>}
                          </span>
                          {hasComm && (
                            <p className="text-[9px] text-gray-400">lordo {sign}{fmtEur(txAbs)}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 pl-3.5">
                        <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
                        {tx.description && (
                          <span className="text-[10px] text-gray-400 truncate">{tx.description}</span>
                        )}
                      </div>
                      {isPartial && (
                        <div className="mt-0.5 pl-3.5">
                          <p className="text-[10px] text-orange-600">
                            Residuo: {fmtEur(txAvailable)} — Riconciliato: {fmtEur(txReconciledAmt)} di {fmtEur(netAmt)}
                          </p>
                          {txReconHistory.get(tx.id)?.map((h, hi) => (
                            <p key={hi} className="text-[9px] text-gray-400">
                              {h.invoiceNumber ? `Fatt. ${h.invoiceNumber}` : 'Abbinato'}: {fmtEur(h.amount)} — {fmtDate(h.date)}
                            </p>
                          ))}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Right: Candidates */}
            <div className="border rounded-lg bg-white flex flex-col">
              <div className="px-3 py-2.5 border-b bg-gray-50/80 flex items-center gap-2">
                <FileText className="h-4 w-4 text-gray-500" />
                <span className="text-sm font-semibold text-gray-700">
                  {selectedTxId ? 'Candidati corrispondenti' : 'Seleziona un movimento'}
                </span>
                {selectedTxId && (
                  <span className="text-[10px] text-gray-400 ml-auto">{candidates.length} trovati</span>
                )}
              </div>

              {selectedTxPartialInfo && (
                <div className="px-3 py-2 border-b bg-amber-50">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full">Parziale</span>
                    <span className="text-xs text-amber-800">Residuo da abbinare: <span className="font-bold">{fmtEur(selectedTxPartialInfo.residual)}</span></span>
                    <span className="text-[10px] text-amber-600 ml-auto">Riconciliato: {fmtEur(selectedTxPartialInfo.reconciled)} di {fmtEur(selectedTxPartialInfo.netAmt)}</span>
                  </div>
                </div>
              )}
              {selectedTxId && (
                <div className="px-3 py-2 border-b space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1">
                      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                      <input
                        type="text"
                        value={candidateSearch}
                        onChange={e => { setCandidateSearch(e.target.value); if (candidateAiResult && !e.target.value.trim()) { setCandidateAiResult(null); setCandidateAiInstallments([]) } }}
                        onKeyDown={e => { if (e.key === 'Enter' && candidateSearch.trim()) handleCandidateAISearch() }}
                        placeholder="Cerca o Invio per AI ✨"
                        className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-purple-400"
                      />
                    </div>
                    <button
                      onClick={handleCandidateAISearch}
                      disabled={!candidateSearch.trim() || candidateAiSearching}
                      className={`px-2 py-1.5 text-xs font-semibold rounded-md border transition-all ${
                        candidateAiSearching
                          ? 'bg-violet-100 text-violet-600 border-violet-300 animate-pulse'
                          : candidateAiResult
                            ? 'bg-violet-600 text-white border-violet-600'
                            : 'bg-white text-violet-600 border-violet-300 hover:bg-violet-50 disabled:opacity-40 disabled:cursor-not-allowed'
                      }`}
                      title="Ricerca AI"
                    >
                      {candidateAiSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                  {/* AI result explanation bar */}
                  {candidateAiResult && (candidateAiResult.isError ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-red-50 border border-red-200 rounded-md">
                      <span className="text-[10px] text-red-600 flex-1">⚠ {candidateAiResult.text}</span>
                      <button onClick={() => { setCandidateAiResult(null); setCandidateAiInstallments([]) }} className="text-red-400 hover:text-red-600 text-xs font-bold">✕</button>
                    </div>
                  ) : candidateAiResult.text ? (
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-violet-50 border border-violet-200 rounded-md">
                      <span className="text-[10px] text-violet-700 flex-1">✨ {candidateAiResult.text} — <strong>{candidates.length}</strong> rate corrispondenti</span>
                      <button onClick={() => { setCandidateAiResult(null); setCandidateAiInstallments([]) }} className="text-violet-400 hover:text-violet-600 text-xs font-bold">✕</button>
                    </div>
                  ) : null)}
                </div>
              )}

              <div className="flex-1 overflow-y-auto">
                {!selectedTxId ? (
                  <div className="flex flex-col items-center justify-center h-full text-center px-6 py-12">
                    <ArrowRightLeft className="h-10 w-10 text-gray-300 mb-3" />
                    <p className="text-sm text-gray-400">Seleziona un movimento bancario a sinistra per vedere le rate e fatture corrispondenti</p>
                  </div>
                ) : candidates.length === 0 ? (
                  <div className="text-xs text-gray-400 text-center py-8">
                    Nessuna rata aperta corrispondente trovata
                  </div>
                ) : candidates.map((inst: any) => {
                  const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
                  const isRefMatch = inst._refMatch === true
                  const matchedRef = inst._matchedRef
                  const isSameCounterparty = inst._sameCounterparty === true

                  return (
                    <div
                      key={inst.id}
                      className={`px-3 py-2.5 border-b last:border-b-0 hover:bg-gray-50 transition-colors ${isRefMatch ? 'bg-emerald-50/50' : isSameCounterparty ? 'bg-blue-50/30' : ''}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {isRefMatch && (
                              <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                                <span>📌</span> Ref. nel movimento
                              </span>
                            )}
                            {!isRefMatch && isSameCounterparty && (
                              <span className="text-[10px] font-medium text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded">
                                Stessa controparte
                              </span>
                            )}
                            <span className="text-xs font-medium text-gray-800">
                              {inst.counterparty_name || 'N.D.'}
                            </span>
                            {inst.invoice_number && (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${isRefMatch ? 'text-emerald-700 bg-emerald-100 font-semibold' : 'text-blue-600 bg-blue-50'}`}>
                                {inst.invoice_number}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-gray-400">Scad. {fmtDate(inst.due_date)}</span>
                            <span className="text-[10px] text-gray-500">
                              Residuo: {fmtEur(remaining)}
                            </span>
                            {inst._ratio < 0.05 && (
                              <span className="text-[10px] text-emerald-600 font-medium">Importo coincidente</span>
                            )}
                            {inst._ratio >= 0.05 && inst._ratio < 0.15 && (
                              <span className="text-[10px] text-amber-600">Diff: {fmtEur(inst._diff)}</span>
                            )}
                          </div>
                        </div>
                        <button
                          onClick={() => manualMatch(selectedTxId!, inst)}
                          disabled={confirmingId === selectedTxId}
                          className="shrink-0 ml-2 flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                        >
                          {confirmingId === selectedTxId
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Link2 className="h-3 w-3" />
                          }
                          Abbina
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </TabsContent>

        {/* ──── Tab 3: Reconciled ──── */}
        <TabsContent value="reconciled" className="mt-4">
          {reconciledRows.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nessuna riconciliazione"
              description="Non ci sono ancora movimenti riconciliati. Accetta i suggerimenti AI o usa la riconciliazione assistita."
            />
          ) : (
            <div className="space-y-3">
              {/* Search bar */}
              <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input
                  type="text"
                  value={reconciledSearch}
                  onChange={e => setReconciledSearch(e.target.value)}
                  placeholder="Cerca per controparte, fattura, importo..."
                  className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-400"
                />
              </div>

              {/* Results count */}
              <p className="text-xs text-gray-400">
                {filteredReconciled.length} riconciliazion{filteredReconciled.length === 1 ? 'e' : 'i'}
                {reconciledSearch && ` su ${reconciledRows.length} totali`}
              </p>

              {/* Table */}
              <div className="border rounded-lg bg-white overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-[1fr_auto_1fr_80px_auto] gap-0 bg-gray-50 border-b px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  <div className="flex items-center gap-1.5">
                    <Landmark className="h-3 w-3" />
                    Movimento bancario
                  </div>
                  <div className="px-4" />
                  <div className="flex items-center gap-1.5">
                    <FileText className="h-3 w-3" />
                    Fattura
                  </div>
                  <div className="text-right">Differenza</div>
                  <div className="text-right">Azioni</div>
                </div>

                {/* Rows */}
                <div className="divide-y max-h-[60vh] overflow-y-auto">
                  {filteredReconciled.map(r => {
                    const tx = r.bank_transaction
                    const inv = r.invoice
                    if (!tx) return null

                    const txDir = txDirection(tx)
                    const absAmount = Math.abs(Number(tx.amount))
                    const hasComm = tx.commission_amount != null && Number(tx.commission_amount) !== 0
                    const sign = txDir === 'in' ? '+' : '-'
                    const netAmt = hasComm ? absAmount - Math.abs(Number(tx.commission_amount)) : absAmount
                    const invoiceDenom = inv?.counterparty && typeof inv.counterparty === 'object'
                      ? (inv.counterparty as any).denom || 'N.D.' : 'N.D.'
                    const isConfirmingDelete = confirmDeleteId === r.id
                    const isDeleting = deletingReconId === r.id

                    // Difference calculation: TX NET total vs what's been reconciled on the TX
                    const txTotalReconciled = Number(tx.reconciled_amount || 0)
                    const txRemainder = netAmt - txTotalReconciled
                    const txHasRemainder = txRemainder > 0.01
                    const isClosingThis = closingDiffId === r.id

                    return (
                      <div key={r.id}>
                        <div className="grid grid-cols-[1fr_auto_1fr_80px_auto] gap-0 px-4 py-3 hover:bg-gray-50/50 items-center transition-colors">
                          {/* Bank transaction */}
                          <div
                            className="cursor-pointer hover:opacity-80 min-w-0"
                            onDoubleClick={() => setDetailPopup({ type: 'bank_tx', id: tx.id })}
                            title="Doppio click per dettaglio"
                          >
                            <div className="flex items-center gap-2">
                              <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${txDir === 'in' ? 'bg-emerald-500' : 'bg-red-500'}`} />
                              <span className="text-xs font-medium text-gray-800 truncate">
                                {tx.counterparty_name || 'N.D.'}
                              </span>
                              <span className={`text-xs font-bold shrink-0 ${txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                                {sign}{fmtEur(netAmt)}
                                {hasComm && <span className="text-[9px] font-normal text-gray-400 ml-0.5">netto</span>}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 pl-3.5">
                              <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
                              {hasComm && (
                                <span className="text-[10px] text-gray-400">lordo {sign}{fmtEur(absAmount)} | comm. {fmtEur(Math.abs(Number(tx.commission_amount)))}</span>
                              )}
                              {tx.description && (
                                <span className="text-[10px] text-gray-400 truncate">{tx.description.slice(0, 60)}</span>
                              )}
                            </div>
                          </div>

                          {/* Arrow */}
                          <div className="px-3 flex flex-col items-center">
                            <Link2 className="h-4 w-4 text-emerald-500" />
                            <span className={`text-[9px] mt-0.5 px-1.5 py-0.5 rounded-full font-medium ${
                              r.match_type === 'auto' ? 'bg-blue-50 text-blue-600'
                              : r.match_type === 'manual' ? 'bg-gray-100 text-gray-600'
                              : 'bg-purple-50 text-purple-600'
                            }`}>
                              {r.match_type === 'auto' ? 'Auto' : r.match_type === 'manual' ? 'Manuale' : 'AI'}
                            </span>
                          </div>

                          {/* Invoice */}
                          <div
                            className="cursor-pointer hover:opacity-80 min-w-0"
                            onDoubleClick={() => inv && setDetailPopup({ type: 'invoice', id: inv.id })}
                            title="Doppio click per dettaglio"
                          >
                            {inv ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className="text-xs font-medium text-gray-800 truncate">{invoiceDenom}</span>
                                  {inv.number && (
                                    <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded shrink-0">
                                      {inv.number}
                                    </span>
                                  )}
                                  <span className="text-xs font-bold text-blue-700 shrink-0">
                                    {fmtEur(inv.total_amount)}
                                  </span>
                                </div>
                                <div className="flex items-center gap-2 mt-0.5">
                                  <span className="text-[10px] text-gray-400">{fmtDate(inv.date)}</span>
                                </div>
                              </>
                            ) : (
                              <span className="text-xs text-gray-400">Fattura non trovata</span>
                            )}
                          </div>

                          {/* Difference column */}
                          <div className="text-right">
                            {txHasRemainder ? (
                              <button
                                onClick={() => setResidualDialog({
                                  reconRow: r,
                                  remainder: txRemainder,
                                  txId: r.bank_transaction_id,
                                  txDirection: txDir,
                                })}
                                className="text-right group"
                                title="Gestisci residuo"
                              >
                                <span className={`text-xs font-bold group-hover:underline ${
                                  txRemainder < 5 ? 'text-emerald-600' :
                                  txRemainder <= 50 ? 'text-orange-600' :
                                  'text-red-600'
                                }`}>
                                  {fmtEur(txRemainder)}
                                </span>
                                <p className="text-[9px] text-gray-400">residuo</p>
                              </button>
                            ) : (
                              <span className="text-[10px] text-emerald-500 font-medium">✓</span>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            {isConfirmingDelete ? (
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => deleteReconciliation(r)}
                                  disabled={isDeleting}
                                  className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                                >
                                  {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                  Conferma
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(null)}
                                  disabled={isDeleting}
                                  className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ) : (
                              <>
                                {txHasRemainder && txRemainder <= 50 && (
                                  <button
                                    onClick={() => {
                                      setClosingDiffId(r.id)
                                      setClosingAmount(txRemainder.toFixed(2))
                                      setClosingReason('commissione_bancaria')
                                    }}
                                    className="p-1.5 rounded-md text-orange-400 hover:bg-orange-50 hover:text-orange-600 transition-colors"
                                    title="Chiudi differenza"
                                  >
                                    <CircleDollarSign className="h-4 w-4" />
                                  </button>
                                )}
                                <button
                                  onClick={() => setConfirmDeleteId(r.id)}
                                  className="p-1.5 rounded-md text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                                  title="Elimina riconciliazione"
                                >
                                  <Unlink className="h-4 w-4" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Close difference inline dialog */}
                        {isClosingThis && (
                          <div className="px-4 pb-3 pt-1 bg-orange-50/50 border-t border-orange-100">
                            <div className="flex items-center gap-3 flex-wrap">
                              <div className="flex items-center gap-1.5">
                                <label className="text-[10px] font-medium text-gray-600">Importo:</label>
                                <input
                                  type="number"
                                  step="0.01"
                                  value={closingAmount}
                                  onChange={e => setClosingAmount(e.target.value)}
                                  className="w-20 px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-orange-400"
                                />
                              </div>
                              <div className="flex items-center gap-1.5">
                                <label className="text-[10px] font-medium text-gray-600">Motivo:</label>
                                <select
                                  value={closingReason}
                                  onChange={e => setClosingReason(e.target.value)}
                                  className="px-2 py-1 text-xs border rounded focus:outline-none focus:ring-1 focus:ring-orange-400"
                                >
                                  <option value="commissione_bancaria">Commissione bancaria</option>
                                  <option value="abbuono_attivo">Abbuono attivo</option>
                                  <option value="abbuono_passivo">Abbuono passivo</option>
                                  <option value="arrotondamento">Arrotondamento</option>
                                </select>
                              </div>
                              <button
                                onClick={() => {
                                  const amt = parseFloat(closingAmount)
                                  if (isNaN(amt) || amt < 0.01) {
                                    toast.error('Importo non valido')
                                    return
                                  }
                                  closeDifference(r, amt, closingReason)
                                }}
                                disabled={closingInProgress}
                                className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
                              >
                                {closingInProgress ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                Chiudi
                              </button>
                              <button
                                onClick={() => setClosingDiffId(null)}
                                className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ──── Reconciliation confirm dialog (amount difference) ──── */}
      {pendingConfirm && (
        <ReconciliationConfirmDialog
          txRemaining={pendingConfirm.txRemaining}
          instRemaining={pendingConfirm.instRemaining}
          onChoice={handleConfirmChoice}
          onCancel={() => setPendingConfirm(null)}
        />
      )}

      {/* ──── Post-reconciliation remainder dialog ──── */}
      {postReconDialog && (
        <PostReconciliationDialog
          dialog={postReconDialog}
          onClose={() => setPostReconDialog(null)}
          onAction={handlePostReconAction}
        />
      )}

      {/* ──── Residual management dialog (from Riconciliati tab) ──── */}
      {residualDialog && (
        <ResidualManagementDialog
          dialog={residualDialog}
          openInstallments={openInstallments}
          onClose={() => setResidualDialog(null)}
          onCloseDifference={(reconRow, amount, reason) => {
            closeDifference(reconRow, amount, reason)
            setResidualDialog(null)
          }}
          onNavigateToAssisted={(txId) => {
            setResidualDialog(null)
            setActiveTab('assisted')
            setSelectedTxId(txId)
            setCandidateAiResult(null)
            setCandidateAiInstallments([])
            setCandidateSearch('')
          }}
        />
      )}

      {/* ──── Detail popup overlay ──── */}
      {detailPopup && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
          onClick={() => setDetailPopup(null)}
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-[420px] max-h-[85vh] overflow-hidden flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {detailPopupLoading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                <span className="ml-2 text-sm text-gray-500">Caricamento...</span>
              </div>
            ) : detailPopup.type === 'bank_tx' && detailPopupData ? (
              <BankTxDetail
                tx={detailPopupData}
                onClose={() => setDetailPopup(null)}
              />
            ) : detailPopup.type === 'invoice' && detailPopupData ? (
              <InvoiceDetailPopup
                invoice={detailPopupData}
                onClose={() => setDetailPopup(null)}
                onNavigate={(id) => navigate(`/fatture?invoiceId=${id}`)}
              />
            ) : (
              <div className="p-6 text-center text-sm text-gray-400">Dati non trovati</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Invoice Detail Popup ────────────────────── */

function InvoiceDetailPopup({ invoice, onClose, onNavigate }: { invoice: any; onClose: () => void; onNavigate?: (invoiceId: string) => void }) {
  const cp = invoice.counterparty
  const installments: any[] = invoice.installments || []
  const isAttivo = invoice.direction === 'attivo'

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Dettaglio fattura</span>
          {onNavigate && (
            <button
              onClick={() => onNavigate(invoice.id)}
              className="p-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="Vai alla fattura in Fatture"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className={`px-4 py-4 flex-shrink-0 ${isAttivo ? 'bg-emerald-50' : 'bg-red-50'}`}>
        <p className={`text-2xl font-bold ${isAttivo ? 'text-emerald-700' : 'text-red-700'}`}>
          {isAttivo ? '+' : '-'}{fmtEur(Math.abs(Number(invoice.total_amount || 0)))}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-gray-500">{fmtDate(invoice.date)}</span>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${isAttivo ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
            {isAttivo ? 'Vendita' : 'Acquisto'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {invoice.number && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Numero fattura</p>
            <p className="text-xs text-gray-800 mt-0.5">{invoice.number}</p>
          </div>
        )}
        {(cp?.denom || cp?.name) && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Controparte</p>
            <p className="text-xs text-gray-800 mt-0.5 font-medium">{cp.denom || cp.name}</p>
          </div>
        )}
        {(cp?.piva || cp?.vat_number) && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">P.IVA</p>
            <p className="text-xs text-gray-800 mt-0.5 font-mono">{cp.piva || cp.vat_number}</p>
          </div>
        )}
        {(cp?.cf || cp?.fiscal_code) && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Codice fiscale</p>
            <p className="text-xs text-gray-800 mt-0.5 font-mono">{cp.cf || cp.fiscal_code}</p>
          </div>
        )}
        {invoice.payment_method && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Metodo pagamento</p>
            <p className="text-xs text-gray-800 mt-0.5">{mpLabel(invoice.payment_method)}</p>
          </div>
        )}
        {invoice.payment_terms && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Condizioni pagamento</p>
            <p className="text-xs text-gray-800 mt-0.5">{tpLabel(invoice.payment_terms)}</p>
          </div>
        )}

        {/* Installments */}
        {installments.length > 0 && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1.5">Rate ({installments.length})</p>
            <div className="space-y-1.5">
              {installments
                .sort((a: any, b: any) => a.installment_no - b.installment_no)
                .map((inst: any) => {
                  const remaining = Number(inst.amount_due) - Number(inst.paid_amount || 0)
                  return (
                    <div key={inst.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded bg-gray-50">
                      <div className="flex items-center gap-2">
                        <span className="text-gray-600 font-medium">Rata {inst.installment_no}</span>
                        <span className="text-[10px] text-gray-400">{fmtDate(inst.due_date)}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          inst.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                          inst.status === 'overdue' ? 'bg-red-100 text-red-700' :
                          inst.status === 'partial' ? 'bg-amber-100 text-amber-700' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {inst.status === 'paid' ? 'Pagata' :
                           inst.status === 'overdue' ? 'Scaduta' :
                           inst.status === 'partial' ? 'Parziale' : 'In attesa'}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="font-semibold text-gray-800">{fmtEur(inst.amount_due)}</span>
                        {inst.status !== 'paid' && remaining !== Number(inst.amount_due) && (
                          <p className="text-[9px] text-gray-400">residuo {fmtEur(remaining)}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── KPI Card ───────────────────────────────── */

function KpiCard({ label, value, icon: Icon, color, bg, iconColor, sub }: {
  label: string
  value: number | string
  icon: any
  color: string
  bg: string
  iconColor: string
  sub?: string
}) {
  return (
    <div className={`${bg} border rounded-lg p-4`}>
      <div className="flex items-center justify-between">
        <p className={`text-xs font-medium ${color} uppercase tracking-wide`}>{label}</p>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <p className={`text-2xl font-bold mt-1.5 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}

/* ─── Reconciliation Confirm Dialog (amount difference) ─ */

function ReconciliationConfirmDialog({ txRemaining, instRemaining, onChoice, onCancel }: {
  txRemaining: number
  instRemaining: number
  onChoice: (amount: number) => void
  onCancel: () => void
}) {
  const diff = Math.abs(txRemaining - instRemaining)
  const txIsLarger = txRemaining > instRemaining

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]"
      onClick={onCancel}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-1">
          <AlertTriangle className="h-5 w-5 text-orange-500" />
          <h3 className="text-sm font-semibold text-gray-800">Differenza importi</h3>
        </div>

        <p className="text-xs text-gray-600">
          L'importo del movimento ({fmtEur(txRemaining)}) e della rata ({fmtEur(instRemaining)}) differiscono
          di <span className="font-bold text-orange-600">{fmtEur(diff)}</span>.
          Come vuoi procedere?
        </p>

        <div className="space-y-2">
          {/* Option 1: Full TX amount */}
          <button
            onClick={() => onChoice(txRemaining)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border-2 border-transparent bg-emerald-50 hover:border-emerald-400 transition-colors text-left group"
          >
            <div className="shrink-0 w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center group-hover:bg-emerald-200 transition-colors">
              <Landmark className="h-4 w-4 text-emerald-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800">Riconcilia importo intero del movimento</p>
              <p className="text-[10px] text-gray-500 mt-0.5">
                {fmtEur(txRemaining)} — {txIsLarger
                  ? 'Il movimento verrà chiuso completamente. La rata risulterà con un surplus.'
                  : 'Il movimento verrà chiuso. La rata avrà ancora un residuo da pagare.'}
              </p>
            </div>
            <span className="text-xs font-bold text-emerald-700 shrink-0">{fmtEur(txRemaining)}</span>
          </button>

          {/* Option 2: Installment amount */}
          <button
            onClick={() => onChoice(instRemaining)}
            className="w-full flex items-center gap-3 p-3 rounded-lg border-2 border-transparent bg-blue-50 hover:border-blue-400 transition-colors text-left group"
          >
            <div className="shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center group-hover:bg-blue-200 transition-colors">
              <FileText className="h-4 w-4 text-blue-600" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-800">Riconcilia solo importo rata</p>
              <p className="text-[10px] text-gray-500 mt-0.5">
                {fmtEur(instRemaining)} — La rata sarà completamente pagata.
                {txIsLarger ? ' Il movimento resterà parziale con residuo disponibile.' : ''}
              </p>
            </div>
            <span className="text-xs font-bold text-blue-700 shrink-0">{fmtEur(instRemaining)}</span>
          </button>

          {/* Cancel */}
          <button
            onClick={onCancel}
            className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-left"
          >
            <div className="shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
              <Ban className="h-4 w-4 text-gray-500" />
            </div>
            <p className="text-xs text-gray-600">Annulla — non riconciliare</p>
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Suggestion Card ────────────────────────── */

function SuggestionCard({ suggestion, onConfirm, onReject, confirming, rejecting, onBankTxDoubleClick, onInvoiceDoubleClick, onNavigateTx, onNavigateInvoice }: {
  suggestion: SuggestionRow
  onConfirm: () => void
  onReject: () => void
  confirming: boolean
  rejecting: boolean
  onBankTxDoubleClick?: (txId: string) => void
  onInvoiceDoubleClick?: (invoiceId: string) => void
  onNavigateTx?: (txId: string) => void
  onNavigateInvoice?: (invoiceId: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const tx = suggestion.bank_transaction
  const inv = suggestion.invoice
  const inst = suggestion.installment

  if (!tx) return null

  const txDir = txDirection(tx)
  const absAmount = Math.abs(Number(tx.amount))  // gross (for display)
  const netAmount = getTxNetAmount(tx)            // net = gross - commission (for calculations)
  const txReconciledAlready = Number(tx.reconciled_amount || 0)
  const txRemainingAmount = netAmount - txReconciledAlready
  const instRemaining = inst ? Number(inst.amount_due) - Number(inst.paid_amount) : null
  const invoiceDenom = inv?.counterparty && typeof inv.counterparty === 'object'
    ? (inv.counterparty as any).denom || 'N.D.'
    : 'N.D.'

  // Amount that would be reconciled if confirmed
  const wouldReconcile = inst && instRemaining != null ? Math.min(txRemainingAmount, instRemaining) : txRemainingAmount
  const amountDiff = inst && instRemaining != null ? Math.abs(txRemainingAmount - instRemaining) : 0

  return (
    <div className="bg-white border rounded-lg overflow-hidden hover:shadow-sm transition-shadow">
      <div className="flex items-stretch">
        {/* Score bar */}
        <div className={`w-1.5 shrink-0 ${
          suggestion.match_score >= 90 ? 'bg-emerald-500' :
          suggestion.match_score >= 75 ? 'bg-blue-500' :
          suggestion.match_score >= 60 ? 'bg-amber-500' : 'bg-gray-400'
        }`} />

        <div className="flex-1 p-3">
          {/* Top row: score + reason + actions */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${scoreBadge(suggestion.match_score)}`}>
                {suggestion.match_score}% {scoreLabel(suggestion.match_score)}
              </span>
              <span className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">
                {proposedByLabel(suggestion.proposed_by)}
              </span>
              {amountDiff > 0.01 && amountDiff <= 5 && (
                <span className="text-[10px] text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded">
                  diff {fmtEur(amountDiff)}
                </span>
              )}
              {amountDiff > 5 && (
                <span className="text-[10px] text-red-600 bg-red-50 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                  <AlertTriangle className="h-2.5 w-2.5" /> diff {fmtEur(amountDiff)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={onReject}
                disabled={rejecting || confirming}
                className="p-1.5 rounded-md text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
                title="Rifiuta"
              >
                {rejecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
              </button>
              <button
                onClick={onConfirm}
                disabled={confirming || rejecting}
                className="flex items-center gap-1 px-2.5 py-1 rounded-md text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                title={`Conferma riconciliazione (${fmtEur(wouldReconcile)})`}
              >
                {confirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Conferma
              </button>
            </div>
          </div>

          {/* Two-column: Bank tx ↔ Invoice/Installment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Bank transaction side */}
            <div
              className={`rounded-md p-2.5 cursor-pointer hover:ring-1 hover:ring-gray-300 transition-shadow ${txDir === 'in' ? 'bg-emerald-50/70' : 'bg-red-50/70'}`}
              onDoubleClick={() => onBankTxDoubleClick?.(tx.id)}
              title="Doppio click per dettaglio"
            >
              <div className="flex items-center gap-1.5 mb-1">
                <Landmark className="h-3 w-3 text-gray-500" />
                <span className="text-[10px] font-semibold uppercase text-gray-500">Movimento bancario</span>
                {onNavigateTx && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onNavigateTx(tx.id) }}
                    className="ml-auto p-0.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                    title="Vai al movimento in Banca"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
              {(() => {
                const hasComm = tx.commission_amount != null && Number(tx.commission_amount) !== 0
                const sign = txDir === 'in' ? '+' : '-'
                if (hasComm) {
                  const netAmt = absAmount - Math.abs(Number(tx.commission_amount))
                  return (
                    <>
                      <p className={`text-sm font-bold ${txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                        {sign}{fmtEur(netAmt)} <span className="text-[10px] font-normal text-gray-500">netto</span>
                      </p>
                      <p className="text-[10px] text-gray-400">lordo {sign}{fmtEur(absAmount)}</p>
                    </>
                  )
                }
                return (
                  <p className={`text-sm font-bold ${txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                    {sign}{fmtEur(absAmount)}
                  </p>
                )
              })()}
              <p className="text-xs text-gray-700 mt-0.5">{tx.counterparty_name || 'N.D.'}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${txTypeBadge(tx.transaction_type ?? undefined)}`}>
                  {txTypeLabel(tx.transaction_type ?? undefined)}
                </span>
              </div>
              {txReconciledAlready > 0.01 && (
                <p className="text-[10px] text-orange-600 mt-0.5">
                  Disponibile: {fmtEur(txRemainingAmount)} (di {fmtEur(netAmount)})
                </p>
              )}
            </div>

            {/* Invoice/Installment side */}
            <div
              className="rounded-md p-2.5 bg-blue-50/70 cursor-pointer hover:ring-1 hover:ring-blue-300 transition-shadow"
              onDoubleClick={() => inv && onInvoiceDoubleClick?.(inv.id)}
              title="Doppio click per dettaglio"
            >
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="h-3 w-3 text-gray-500" />
                <span className="text-[10px] font-semibold uppercase text-gray-500">
                  {inst ? 'Rata fattura' : 'Fattura'}
                </span>
                {onNavigateInvoice && inv && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onNavigateInvoice(inv.id) }}
                    className="ml-auto p-0.5 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                    title="Vai alla fattura in Fatture"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                )}
              </div>
              {inst ? (
                <>
                  <p className="text-sm font-bold text-blue-700">
                    {fmtEur(instRemaining)} <span className="text-[10px] font-normal text-gray-500">residuo</span>
                  </p>
                  <p className="text-xs text-gray-700 mt-0.5">
                    {inv?.number ? `Fatt. ${inv.number}` : 'N.D.'} &middot; Rata {inst.installment_no}
                  </p>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[10px] text-gray-400">Scad. {fmtDate(inst.due_date)}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                      inst.status === 'overdue' ? 'bg-red-100 text-red-700' :
                      inst.status === 'partial' ? 'bg-amber-100 text-amber-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {inst.status === 'overdue' ? 'Scaduta' : inst.status === 'partial' ? 'Parziale' : 'In attesa'}
                    </span>
                  </div>
                </>
              ) : inv ? (
                <>
                  <p className="text-sm font-bold text-blue-700">{fmtEur(inv.total_amount)}</p>
                  <p className="text-xs text-gray-700 mt-0.5">{invoiceDenom}</p>
                  <span className="text-[10px] text-gray-400">{inv.number || 'N.D.'} &middot; {fmtDate(inv.date)}</span>
                </>
              ) : (
                <p className="text-xs text-gray-400">Fattura non trovata</p>
              )}
            </div>
          </div>

          {/* Amount note (Miglioria 5) */}
          {typeof suggestion.suggestion_data?.amount_note === 'string' && (
            <div className="mt-1.5 inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">
              {String(suggestion.suggestion_data.amount_note)}
            </div>
          )}

          {/* Cumulative payment indicator (Miglioria 1) */}
          {suggestion.suggestion_data?.level === 'cumulative' && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-1.5 py-0.5">
              Pagamento cumulativo
            </div>
          )}

          {/* Rule-based match indicator (Miglioria 3) */}
          {suggestion.suggestion_data?.level === 'rule' && (
            <div className="mt-1 inline-flex items-center gap-1 text-[10px] bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5">
              Regola: {String(suggestion.suggestion_data.rule_name ?? 'appresa')}
            </div>
          )}

          {suggestion.suggestion_data?.contract_ref_match === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-violet-50 text-violet-700 border border-violet-200 rounded px-1.5 py-0.5">
              Contratto coerente
            </div>
          )}
          {suggestion.suggestion_data?.invoice_after_tx === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-rose-50 text-rose-700 border border-rose-200 rounded px-1.5 py-0.5">
              Fattura dopo il movimento
            </div>
          )}
          {suggestion.suggestion_data?.due_date_is_estimated === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-slate-50 text-slate-700 border border-slate-200 rounded px-1.5 py-0.5">
              Scadenza stimata
            </div>
          )}
          {suggestion.suggestion_data?.reranked_by_model === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-fuchsia-50 text-fuchsia-700 border border-fuchsia-200 rounded px-1.5 py-0.5">
              Reranked AI
            </div>
          )}
          {suggestion.suggestion_data?.global_winner === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded px-1.5 py-0.5">
              Miglior match globale
            </div>
          )}
          {suggestion.suggestion_data?.review_required === true && (
            <div className="mt-1 ml-1 inline-flex items-center gap-1 text-[10px] bg-amber-50 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">
              Review umana
            </div>
          )}

          {/* Match reason (expandable) */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-2 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {suggestion.match_reason}
          </button>
          {expanded && suggestion.suggestion_data != null && (
            <div className="mt-1.5 text-[10px] text-gray-400 bg-gray-50 rounded p-2 font-mono">
              {JSON.stringify(suggestion.suggestion_data, null, 2)}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Post-Reconciliation Dialog ─────────────── */

function PostReconciliationDialog({ dialog, onClose, onAction }: {
  dialog: { txId: string; invoiceNumber: string | null; reconcileAmount: number; remainder: number; commissionAmount: number }
  onClose: () => void
  onAction: (action: 'commission' | 'abbuono' | 'skip') => void
}) {
  // Check if remainder matches the commission amount (±0.10€)
  const commissionMatch = dialog.commissionAmount > 0 &&
    Math.abs(dialog.remainder - dialog.commissionAmount) < 0.10

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          <h3 className="text-sm font-semibold text-gray-800">Riconciliazione completata</h3>
        </div>

        <p className="text-xs text-gray-600">
          Movimento {fmtEur(dialog.reconcileAmount)} abbinato a Fatt. {dialog.invoiceNumber || 'N.D.'}
        </p>

        <div className="bg-orange-50 rounded-lg px-3 py-2">
          <p className="text-xs text-orange-700">
            Residuo sul movimento: <strong>{fmtEur(dialog.remainder)}</strong>
          </p>
          {commissionMatch && (
            <p className="text-[10px] text-orange-600 mt-0.5">
              (commissione bancaria rilevata: {fmtEur(dialog.commissionAmount)})
            </p>
          )}
        </div>

        {commissionMatch ? (
          // Single prominent button when commission matches remainder
          <div className="space-y-2">
            <button
              onClick={() => onAction('commission')}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
            >
              <CheckCircle2 className="h-4 w-4" />
              Chiudi come commissione ({fmtEur(dialog.remainder)})
            </button>
            <button
              onClick={() => onAction('skip')}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors"
            >
              <Search className="h-3.5 w-3.5" />
              Abbina altro — lascia parziale
            </button>
          </div>
        ) : (
          // Three options when no commission match
          <div className="space-y-2">
            <button
              onClick={() => onAction('commission')}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-orange-50 hover:border-orange-300 transition-colors text-left"
            >
              <div className="shrink-0 w-8 h-8 rounded-full bg-orange-100 flex items-center justify-center">
                <CircleDollarSign className="h-4 w-4 text-orange-600" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-800">Commissione bancaria</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Chiudi {fmtEur(dialog.remainder)} come costo bancario</p>
              </div>
            </button>
            <button
              onClick={() => onAction('abbuono')}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-blue-50 hover:border-blue-300 transition-colors text-left"
            >
              <div className="shrink-0 w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center">
                <FileText className="h-4 w-4 text-blue-600" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-800">Abbuono</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Chiudi {fmtEur(dialog.remainder)} come abbuono</p>
              </div>
            </button>
            <button
              onClick={() => onAction('skip')}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 transition-colors text-left"
            >
              <div className="shrink-0 w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                <Search className="h-4 w-4 text-gray-500" />
              </div>
              <div className="flex-1">
                <p className="text-xs font-medium text-gray-800">Abbina altro</p>
                <p className="text-[10px] text-gray-500 mt-0.5">Lascia il movimento parziale per abbinare un'altra rata</p>
              </div>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Residual management dialog (from Riconciliati tab) ─── */

function ResidualManagementDialog({
  dialog,
  openInstallments,
  onClose,
  onCloseDifference,
  onNavigateToAssisted,
}: {
  dialog: { reconRow: ReconciledRow; remainder: number; txId: string; txDirection: string | null }
  openInstallments: OpenInstallment[]
  onClose: () => void
  onCloseDifference: (reconRow: ReconciledRow, amount: number, reason: string) => void
  onNavigateToAssisted: (txId: string) => void
}) {
  const [mode, setMode] = useState<'match' | 'commission' | 'abbuono'>('match')
  const [search, setSearch] = useState('')

  const expectedInvDirection = dialog.txDirection === 'in' ? 'out' : 'in'
  const tx = dialog.reconRow.bank_transaction
  const inv = dialog.reconRow.invoice

  const candidates = useMemo(() => {
    let filtered = openInstallments
      .filter(inst => {
        const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
        return remaining > 0 && inst.direction === expectedInvDirection
      })
      .map(inst => {
        const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
        return { ...inst, _remaining: remaining, _diff: Math.abs(dialog.remainder - remaining) }
      })
      .sort((a, b) => a._diff - b._diff)

    if (search.trim()) {
      const q = search.toLowerCase()
      filtered = filtered.filter(inst =>
        (inst.counterparty_name || '').toLowerCase().includes(q) ||
        (inst.invoice_number || '').toLowerCase().includes(q)
      )
    }
    return filtered.slice(0, 30)
  }, [openInstallments, dialog.remainder, expectedInvDirection, search])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-5 py-4 border-b bg-amber-50/80">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-gray-800">Gestisci residuo</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {tx?.counterparty_name || 'Movimento'} &mdash; {inv?.number ? `Fatt. ${inv.number}` : 'Fattura'}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-lg font-bold text-amber-700">{fmtEur(dialog.remainder)}</span>
              <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
            </div>
          </div>
        </div>

        {/* Mode selector */}
        <div className="flex border-b">
          {([
            { key: 'match' as const, label: 'Abbina a fattura', icon: Link2 },
            { key: 'commission' as const, label: 'Commissione', icon: CircleDollarSign },
            { key: 'abbuono' as const, label: 'Abbuono', icon: Ban },
          ]).map(m => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-[11px] font-semibold border-b-2 transition-colors ${
                mode === m.key
                  ? 'border-amber-500 text-amber-700 bg-amber-50/50'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'
              }`}
            >
              <m.icon className="h-3.5 w-3.5" />
              {m.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {mode === 'match' && (
            <div>
              <div className="px-4 py-2.5 border-b">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Cerca controparte, numero fattura..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-amber-400"
                  />
                </div>
              </div>
              {candidates.length === 0 ? (
                <div className="text-center py-8 text-xs text-gray-400">Nessun candidato trovato</div>
              ) : (
                <div className="divide-y">
                  {candidates.map(inst => {
                    const diffPct = dialog.remainder > 0 ? (inst._diff / dialog.remainder) * 100 : 100
                    return (
                      <div key={inst.id} className="px-4 py-2.5 flex items-center gap-3 hover:bg-gray-50 transition-colors">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-800 truncate">{inst.counterparty_name || 'N.D.'}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {inst.invoice_number && <span className="text-[10px] text-blue-600 font-medium">#{inst.invoice_number}</span>}
                            <span className="text-[10px] text-gray-400">Scad. {fmtDate(inst.due_date)}</span>
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-xs font-bold text-gray-700">{fmtEur(inst._remaining)}</p>
                          <p className={`text-[9px] ${diffPct < 5 ? 'text-emerald-600' : diffPct < 15 ? 'text-orange-500' : 'text-gray-400'}`}>
                            {diffPct < 1 ? 'Coincide' : `Diff: ${fmtEur(inst._diff)}`}
                          </p>
                        </div>
                        <button
                          onClick={() => onNavigateToAssisted(dialog.txId)}
                          className="px-2.5 py-1 text-[10px] font-semibold rounded-md bg-purple-600 text-white hover:bg-purple-700 transition-colors shrink-0"
                        >
                          Abbina
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {mode === 'commission' && (
            <div className="px-5 py-8 text-center">
              <CircleDollarSign className="h-10 w-10 text-orange-400 mx-auto mb-3" />
              <p className="text-sm text-gray-700 mb-1">Chiudi come <strong>commissione bancaria</strong></p>
              <p className="text-xs text-gray-400 mb-4">Il residuo di {fmtEur(dialog.remainder)} verrà registrato come costo bancario</p>
              <button
                onClick={() => onCloseDifference(dialog.reconRow, dialog.remainder, 'commissione_bancaria')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
              >
                Conferma commissione
              </button>
            </div>
          )}

          {mode === 'abbuono' && (
            <div className="px-5 py-8 text-center">
              <Ban className="h-10 w-10 text-gray-400 mx-auto mb-3" />
              <p className="text-sm text-gray-700 mb-1">Chiudi come <strong>abbuono</strong></p>
              <p className="text-xs text-gray-400 mb-4">Il residuo di {fmtEur(dialog.remainder)} verrà chiuso come sconto/abbuono</p>
              <button
                onClick={() => onCloseDifference(dialog.reconRow, dialog.remainder, 'abbuono_passivo')}
                className="px-4 py-2 text-xs font-semibold rounded-lg bg-gray-600 text-white hover:bg-gray-700 transition-colors"
              >
                Conferma abbuono
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ─── Empty state ────────────────────────────── */

function EmptyState({ icon: Icon, title, description }: { icon: any; title: string; description: string }) {
  return (
    <div className="text-center py-12">
      <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-gray-100 mb-4">
        <Icon className="h-7 w-7 text-gray-400" />
      </div>
      <h3 className="text-sm font-semibold text-gray-700 mb-1">{title}</h3>
      <p className="text-xs text-gray-400 max-w-md mx-auto">{description}</p>
    </div>
  )
}
