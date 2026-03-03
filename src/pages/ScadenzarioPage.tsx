import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CalendarClock, Receipt, ArrowDownLeft, ArrowUpRight, Search, Filter, Landmark, PencilLine, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { useCompany } from '@/hooks/useCompany'
import { supabase } from '@/integrations/supabase/client'
import { fmtDate, fmtEur } from '@/lib/utils'
import {
  buildAging,
  listScadenzarioRows,
  settleInstallment,
  rebuildInstallmentsFull,
  touchOverdueInstallments,
  type AgingResult,
  type InstallmentStatus,
  type ScadenzarioFilters,
  type ScadenzarioRow,
} from '@/lib/scadenzario'

type SettleUiMode = 'bank' | 'manual' | 'nc'

interface BankCandidate {
  id: string
  date: string
  amount: number
  description: string | null
  counterparty_name: string | null
  transaction_type: string | null
  reconciliation_status: string | null
  score: number
}

interface BankSearchInfo {
  total_company: number
  same_direction: number
  in_date_window: number
  in_amount_tolerance: number
  target_amount: number
  tolerance_pct: number
  window_days: number
}

interface BankCandidatesResult {
  candidates: BankCandidate[]
  searchInfo: BankSearchInfo
}

interface NcCandidate {
  id: string
  reference: string
  due_date: string
  remaining_credit: number
}

const STATUS_OPTIONS: Array<{ value: InstallmentStatus; label: string }> = [
  { value: 'pending', label: 'Da incassare/pagare' },
  { value: 'overdue', label: 'Scaduto' },
  { value: 'partial', label: 'Parziale' },
  { value: 'paid', label: 'Pagato/Incassato' },
]

const PERIOD_OPTIONS: Array<{ value: ScadenzarioFilters['periodPreset']; label: string }> = [
  { value: 'all', label: 'Tutto periodo' },
  { value: 'next_7', label: 'Prossimi 7 giorni' },
  { value: 'next_30', label: 'Prossimi 30 giorni' },
  { value: 'next_90', label: 'Prossimi 90 giorni' },
  { value: 'this_month', label: 'Questo mese' },
  { value: 'next_month', label: 'Prossimo mese' },
  { value: 'custom', label: 'Range personalizzato' },
]

function rowGroup(dueDate: string, today: string): 'overdue' | 'today' | 'future' {
  if (dueDate < today) return 'overdue'
  if (dueDate === today) return 'today'
  return 'future'
}

function rowGroupLabel(group: 'overdue' | 'today' | 'future'): string {
  if (group === 'overdue') return 'Scadute'
  if (group === 'today') return 'Oggi'
  return 'Future'
}

function rowStatusBadge(status: InstallmentStatus): string {
  if (status === 'overdue') return 'bg-red-100 text-red-700'
  if (status === 'paid') return 'bg-emerald-100 text-emerald-700'
  if (status === 'partial') return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-700'
}

function rowTypeBadge(type: ScadenzarioRow['type']): string {
  if (type === 'incasso') return 'bg-emerald-100 text-emerald-700'
  if (type === 'pagamento') return 'bg-red-100 text-red-700'
  return 'bg-amber-100 text-amber-700'
}

function rowTypeLabel(type: ScadenzarioRow['type']): string {
  if (type === 'incasso') return 'Incasso'
  if (type === 'pagamento') return 'Pagamento'
  return 'IVA'
}

function rowTypeIcon(type: ScadenzarioRow['type']) {
  if (type === 'incasso') return <ArrowDownLeft className="h-3.5 w-3.5" />
  if (type === 'pagamento') return <ArrowUpRight className="h-3.5 w-3.5" />
  return <Receipt className="h-3.5 w-3.5" />
}

function sortArrow(currentBy: string, currentDir: 'asc' | 'desc', thisBy: string): string {
  if (currentBy !== thisBy) return ''
  return currentDir === 'asc' ? ' ↑' : ' ↓'
}

function buildReminderText(row: ScadenzarioRow): string {
  return [
    `Gentile ${row.counterparty_name},`,
    '',
    `ti ricordiamo la scadenza di ${row.reference} del ${fmtDate(row.due_date)} per un importo residuo di ${fmtEur(row.remaining_amount)}.`,
    'Ti chiediamo gentilmente di procedere al saldo quanto prima e di inviarci conferma.',
    '',
    'Grazie,',
    'FinFlow',
  ].join('\n')
}

function moneyColor(type: ScadenzarioRow['type']): string {
  return type === 'incasso' ? 'text-emerald-700' : 'text-red-700'
}

function round2(v: number): number {
  return Math.round(Number(v || 0) * 100) / 100
}

function isApproxEqual(a: number, b: number, epsilon = 0.01): boolean {
  return Math.abs(round2(a) - round2(b)) <= epsilon
}

function addDays(isoDate: string, delta: number): string {
  const d = new Date(`${isoDate}T00:00:00`)
  d.setDate(d.getDate() + delta)
  return d.toISOString().slice(0, 10)
}

function daysDiffAbs(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00`).getTime()
  const to = new Date(`${toIso}T00:00:00`).getTime()
  return Math.abs(Math.round((to - from) / (24 * 60 * 60 * 1000)))
}

export default function ScadenzarioPage() {
  const { company } = useCompany()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const [activeTab, setActiveTab] = useState<'all' | 'incassi' | 'pagamenti' | 'iva'>('all')
  const [periodPreset, setPeriodPreset] = useState<ScadenzarioFilters['periodPreset']>('next_30')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [statusFilters, setStatusFilters] = useState<Set<InstallmentStatus>>(new Set(['pending', 'overdue', 'partial']))
  const [counterpartyId, setCounterpartyId] = useState<string>('')
  const [query, setQuery] = useState('')
  const [invoiceFocusId, setInvoiceFocusId] = useState<string>('')
  const [sortBy, setSortBy] = useState<ScadenzarioFilters['sortBy']>('due_date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfillRunning, setBackfillRunning] = useState(false)
  const [health, setHealth] = useState<{ invoicesCount: number; installmentsCount: number } | null>(null)
  const [rows, setRows] = useState<ScadenzarioRow[]>([])
  const [aging, setAging] = useState<AgingResult | null>(null)
  const [showAging, setShowAging] = useState(true)

  const [counterparties, setCounterparties] = useState<Array<{ id: string; name: string; email: string | null }>>([])

  const [paymentModal, setPaymentModal] = useState<{
    open: boolean
    row: ScadenzarioRow | null
    settleMode: SettleUiMode
    paymentDate: string
    amount: string
    bankCandidates: BankCandidate[]
    bankSearchInfo: BankSearchInfo | null
    ncCandidates: NcCandidate[]
    loadingCandidates: boolean
    selectedBankTxId: string | null
    saving: boolean
    error: string | null
  }>({
    open: false,
    row: null,
    settleMode: 'manual',
    paymentDate: new Date().toISOString().slice(0, 10),
    amount: '0',
    bankCandidates: [],
    bankSearchInfo: null,
    ncCandidates: [],
    loadingCandidates: false,
    selectedBankTxId: null,
    saving: false,
    error: null,
  })

  const [reminderModal, setReminderModal] = useState<{
    open: boolean
    row: ScadenzarioRow | null
    text: string
  }>({
    open: false,
    row: null,
    text: '',
  })

  const counterpartyMap = useMemo(
    () => new Map(counterparties.map((cp) => [cp.id, cp])),
    [counterparties],
  )

  useEffect(() => {
    const tab = String(searchParams.get('tab') || '').toLowerCase()
    if (tab === 'tutte') setActiveTab('all')
    if (tab === 'all') setActiveTab('all')
    if (tab === 'incassi') setActiveTab('incassi')
    if (tab === 'pagamenti') setActiveTab('pagamenti')
    if (tab === 'iva') setActiveTab('iva')

    const period = String(searchParams.get('period') || '').toLowerCase()
    if (period === 'next_7') setPeriodPreset('next_7')
    if (period === 'next_30') setPeriodPreset('next_30')
    if (period === 'next_90') setPeriodPreset('next_90')
    if (period === 'this_month') setPeriodPreset('this_month')
    if (period === 'next_month') setPeriodPreset('next_month')
    if (period === 'custom') setPeriodPreset('custom')
    if (period === 'all') setPeriodPreset('all')

    const q = String(searchParams.get('query') || '')
    setQuery(q)

    const cp = String(searchParams.get('counterpartyId') || '')
    setCounterpartyId(cp)

    const invId = String(searchParams.get('invoiceId') || '')
    setInvoiceFocusId(invId)

    const statusParam = String(searchParams.get('status') || '').toLowerCase()
    if (statusParam === 'all') {
      setStatusFilters(new Set(['pending', 'overdue', 'partial', 'paid']))
    } else if (statusParam) {
      const parsed = statusParam
        .split(',')
        .map((s) => s.trim())
        .filter((s): s is InstallmentStatus => ['pending', 'overdue', 'partial', 'paid'].includes(s))
      if (parsed.length > 0) setStatusFilters(new Set(parsed))
    }
  }, [searchParams])

  const filters = useMemo<ScadenzarioFilters>(() => ({
    mode: activeTab,
    periodPreset,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    statuses: Array.from(statusFilters),
    counterpartyId: counterpartyId || null,
    query,
    sortBy,
    sortDir,
  }), [activeTab, periodPreset, dateFrom, dateTo, statusFilters, counterpartyId, query, sortBy, sortDir])

  const loadCounterparties = useCallback(async () => {
    if (!company?.id) return
    const { data, error: cpErr } = await supabase
      .from('counterparties')
      .select('id, name, email')
      .eq('company_id', company.id)
      .order('name', { ascending: true })

    if (cpErr) throw new Error(cpErr.message)
    setCounterparties((data || []) as Array<{ id: string; name: string; email: string | null }>)
  }, [company?.id])

  const loadBankCandidates = useCallback(async (row: ScadenzarioRow, targetAmount: number): Promise<BankCandidatesResult> => {
    if (!company?.id || row.kind !== 'installment') {
      return {
        candidates: [],
        searchInfo: {
          total_company: 0,
          same_direction: 0,
          in_date_window: 0,
          in_amount_tolerance: 0,
          target_amount: 0,
          tolerance_pct: 0.1,
          window_days: 60,
        },
      }
    }

    const amountTarget = Math.max(round2(targetAmount), 0)
    const tolerancePct = 0.1
    const windowDays = 60
    const dateFrom = addDays(row.due_date, -windowDays)
    const dateTo = addDays(row.due_date, windowDays)
    const isIncasso = row.type === 'incasso'

    const sameDirectionCountQuery = isIncasso
      ? supabase
        .from('bank_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .gt('amount', 0)
      : supabase
        .from('bank_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .lt('amount', 0)

    const windowQuery = isIncasso
      ? supabase
        .from('bank_transactions')
        .select('id, date, amount, description, counterparty_name, transaction_type, reconciliation_status, raw_text', { count: 'exact' })
        .eq('company_id', company.id)
        .gt('amount', 0)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date', { ascending: false })
        .limit(1000)
      : supabase
        .from('bank_transactions')
        .select('id, date, amount, description, counterparty_name, transaction_type, reconciliation_status, raw_text', { count: 'exact' })
        .eq('company_id', company.id)
        .lt('amount', 0)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('date', { ascending: false })
        .limit(1000)

    console.info('[Scadenzario][BankMatch] query', {
      company_id: company.id,
      installment_id: row.id,
      row_type: row.type,
      due_date: row.due_date,
      target_amount: amountTarget,
      tolerance_pct: tolerancePct,
      window_days: windowDays,
      date_from: dateFrom,
      date_to: dateTo,
      amount_sign: isIncasso ? '> 0' : '< 0',
      note: 'No counterparty-text filter and no reconciliation_status filter',
    })

    const [totalCountRes, sameDirectionRes, windowRes] = await Promise.all([
      supabase
        .from('bank_transactions')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', company.id),
      sameDirectionCountQuery,
      windowQuery,
    ])

    if (totalCountRes.error) throw new Error(totalCountRes.error.message)
    if (sameDirectionRes.error) throw new Error(sameDirectionRes.error.message)
    if (windowRes.error) throw new Error(windowRes.error.message)

    const rawRows = (windowRes.data || []) as Array<{
      id: string
      date: string
      amount: number
      description: string | null
      counterparty_name: string | null
      transaction_type: string | null
      reconciliation_status: string | null
      raw_text: string | null
    }>

    const scored = rawRows
      .map((tx) => {
        const txAbs = Math.abs(Number(tx.amount || 0))
        if (txAbs <= 0) return null

        const amountDeltaPct = amountTarget > 0 ? Math.abs(txAbs - amountTarget) / amountTarget : 1
        if (amountTarget > 0.01 && amountDeltaPct > tolerancePct) return null

        const dateDistance = daysDiffAbs(tx.date, row.due_date)
        if (dateDistance > windowDays) return null

        const amountScore = amountTarget > 0.01 ? Math.max(0, 1 - amountDeltaPct) : 0
        const dateScore = Math.max(0, 1 - dateDistance / windowDays)
        const score = round2(amountScore * 70 + dateScore * 30)

        return {
          id: tx.id,
          date: tx.date,
          amount: txAbs,
          description: tx.description,
          counterparty_name: tx.counterparty_name,
          transaction_type: tx.transaction_type,
          reconciliation_status: tx.reconciliation_status,
          score,
        } as BankCandidate
      })
      .filter(Boolean) as BankCandidate[]

    const candidates = scored
      .sort((a, b) => b.score - a.score || a.date.localeCompare(b.date))
      .slice(0, 25)

    const searchInfo: BankSearchInfo = {
      total_company: Number(totalCountRes.count || 0),
      same_direction: Number(sameDirectionRes.count || 0),
      in_date_window: Number(windowRes.count || 0),
      in_amount_tolerance: scored.length,
      target_amount: amountTarget,
      tolerance_pct: tolerancePct,
      window_days: windowDays,
    }

    console.info('[Scadenzario][BankMatch] result', {
      ...searchInfo,
      candidates_count: candidates.length,
      candidate_sample: candidates.slice(0, 5),
    })

    return { candidates, searchInfo }
  }, [company?.id])

  const refreshBankCandidates = useCallback(async (row: ScadenzarioRow, targetAmount: number) => {
    const amountTarget = Math.max(round2(targetAmount), 0)
    setPaymentModal((prev) => ({
      ...prev,
      loadingCandidates: true,
      error: null,
      bankSearchInfo: null,
    }))

    if (!company?.id) {
      setPaymentModal((prev) => ({ ...prev, loadingCandidates: false }))
      return
    }

    if (amountTarget <= 0.01) {
      const sameDirectionQuery = row.type === 'incasso'
        ? supabase
          .from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id)
          .gt('amount', 0)
        : supabase
          .from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id)
          .lt('amount', 0)

      const [totalRes, sameDirectionRes] = await Promise.all([
        supabase
          .from('bank_transactions')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id),
        sameDirectionQuery,
      ])

      if (totalRes.error || sameDirectionRes.error) {
        setPaymentModal((prev) => ({
          ...prev,
          loadingCandidates: false,
          error: totalRes.error?.message || sameDirectionRes.error?.message || 'Errore caricamento movimenti banca',
        }))
        return
      }

      setPaymentModal((prev) => ({
        ...prev,
        loadingCandidates: false,
        bankCandidates: [],
        selectedBankTxId: null,
        bankSearchInfo: {
          total_company: Number(totalRes.count || 0),
          same_direction: Number(sameDirectionRes.count || 0),
          in_date_window: 0,
          in_amount_tolerance: 0,
          target_amount: amountTarget,
          tolerance_pct: 0.1,
          window_days: 60,
        },
      }))
      return
    }

    try {
      const result = await loadBankCandidates(row, amountTarget)
      const first = result.candidates[0] || null
      setPaymentModal((prev) => {
        if (!prev.open || prev.row?.id !== row.id) return prev
        return {
          ...prev,
          loadingCandidates: false,
          bankCandidates: result.candidates,
          bankSearchInfo: result.searchInfo,
          selectedBankTxId: first?.id || null,
          paymentDate: first?.date || prev.paymentDate,
          amount: first ? String(round2(Math.abs(first.amount))) : prev.amount,
        }
      })
    } catch (e: any) {
      setPaymentModal((prev) => ({
        ...prev,
        loadingCandidates: false,
        error: e.message || 'Errore caricamento movimenti banca',
      }))
    }
  }, [company?.id, loadBankCandidates])

  const loadNcCandidates = useCallback(async (counterpartyKey: string | null): Promise<NcCandidate[]> => {
    if (!company?.id || !counterpartyKey) return []

    const { data, error: ncErr } = await supabase
      .from('invoice_installments')
      .select('id, due_date, amount_due, paid_amount, invoice:invoices(number)')
      .eq('company_id', company.id)
      .eq('direction', 'in')
      .eq('counterparty_id', counterpartyKey)
      .eq('is_credit_note', true)
      .in('status', ['pending', 'overdue', 'partial'])
      .order('due_date', { ascending: true })
      .limit(50)

    if (ncErr) throw new Error(ncErr.message)

    const first = <T,>(v: T | T[] | null | undefined): T | null => {
      if (!v) return null
      return Array.isArray(v) ? (v[0] || null) : v
    }

    return ((data || []) as Array<{
      id: string
      due_date: string
      amount_due: number
      paid_amount: number
      invoice?: { number: string | null } | Array<{ number: string | null }> | null
    }>)
      .map((row) => {
        const remainingCredit = round2(Math.max(Math.abs(Number(row.amount_due || 0)) - Number(row.paid_amount || 0), 0))
        if (remainingCredit <= 0.01) return null
        const invoice = first(row.invoice)
        return {
          id: row.id,
          reference: `NC ${invoice?.number || row.id.slice(0, 8)}`,
          due_date: row.due_date,
          remaining_credit: remainingCredit,
        } as NcCandidate
      })
      .filter(Boolean) as NcCandidate[]
  }, [company?.id])

  const loadRows = useCallback(async () => {
    if (!company?.id) {
      setRows([])
      setAging(null)
      setHealth(null)
      return
    }

    setLoading(true)
    setError(null)

    try {
      await touchOverdueInstallments(company.id)
      const [installmentsCountRes, invoicesCountRes] = await Promise.all([
        supabase
          .from('invoice_installments')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id),
        supabase
          .from('invoices')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', company.id),
      ])

      if (installmentsCountRes.error) throw new Error(installmentsCountRes.error.message)
      if (invoicesCountRes.error) throw new Error(invoicesCountRes.error.message)
      setHealth({
        invoicesCount: Number(invoicesCountRes.count || 0),
        installmentsCount: Number(installmentsCountRes.count || 0),
      })

      const scadenzarioRows = await listScadenzarioRows(company.id, filters)
      const rowsWithFocus = invoiceFocusId
        ? scadenzarioRows.filter((row) => row.invoice_id === invoiceFocusId)
        : scadenzarioRows
      setRows(rowsWithFocus)

      if (activeTab === 'incassi' || activeTab === 'pagamenti') {
        const nextAging = await buildAging(company.id, activeTab, {
          query,
          counterpartyId: counterpartyId || null,
        })
        setAging(nextAging)
      } else {
        setAging(null)
      }
    } catch (e: any) {
      setError(e.message || 'Errore caricamento scadenzario')
    } finally {
      setLoading(false)
    }
  }, [company?.id, filters, activeTab, query, counterpartyId, invoiceFocusId])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  useEffect(() => {
    loadCounterparties()
  }, [loadCounterparties])

  const runInstallmentBackfill = useCallback(async () => {
    if (!company?.id) return
    setBackfillRunning(true)
    setError(null)
    try {
      await rebuildInstallmentsFull(company.id)
      toast.success('Backfill rate completato')
      await loadRows()
    } catch (e: any) {
      setError(e.message || 'Errore backfill rate storico')
    } finally {
      setBackfillRunning(false)
    }
  }, [company?.id, loadRows])

  const toggleStatusFilter = (status: InstallmentStatus) => {
    setStatusFilters((prev) => {
      const next = new Set(prev)
      if (next.has(status)) next.delete(status)
      else next.add(status)
      return next
    })
  }

  const clearFilters = () => {
    setPeriodPreset('next_30')
    setDateFrom('')
    setDateTo('')
    setStatusFilters(new Set(['pending', 'overdue', 'partial']))
    setCounterpartyId('')
    setQuery('')
    setInvoiceFocusId('')
    setSortBy('due_date')
    setSortDir('asc')
  }

  const today = new Date().toISOString().slice(0, 10)

  const openPaymentModal = async (row: ScadenzarioRow) => {
    const netSuggested = round2(Math.max(row.nc_net_amount || Math.max(row.remaining_amount, 0), 0))
    const isZeroNetCase = row.type === 'pagamento' && !row.is_credit_note && row.nc_available_amount > 0.01 && netSuggested <= 0.01
    const defaultMode: SettleUiMode = isZeroNetCase ? 'nc' : 'bank'

    setPaymentModal({
      open: true,
      row,
      settleMode: defaultMode,
      paymentDate: today,
      amount: String(isZeroNetCase ? 0 : (row.remaining_amount || row.amount || 0)),
      bankCandidates: [],
      bankSearchInfo: null,
      ncCandidates: [],
      loadingCandidates: defaultMode === 'bank',
      selectedBankTxId: null,
      saving: false,
      error: null,
    })

    if (row.type === 'pagamento' && !row.is_credit_note && row.counterparty_id) {
      try {
        const ncCandidates = await loadNcCandidates(row.counterparty_id)
        setPaymentModal((prev) => {
          if (!prev.open || prev.row?.id !== row.id) return prev
          return { ...prev, ncCandidates }
        })
      } catch (e: any) {
        setPaymentModal((prev) => ({
          ...prev,
          error: prev.error || e.message || 'Errore caricamento note di credito',
        }))
      }
    }

    if (defaultMode === 'bank') {
      await refreshBankCandidates(row, Math.max(row.nc_net_amount || row.remaining_amount, 0))
    }
  }

  const submitPayment = async () => {
    if (!paymentModal.row || paymentModal.row.kind !== 'installment') return
    if (!company?.id) return

    const row = paymentModal.row
    const remaining = round2(Math.max(row.remaining_amount, 0))
    const netSuggested = round2(Math.max(row.nc_net_amount || remaining, 0))
    const hasNcHint = row.type === 'pagamento' && !row.is_credit_note && (row.nc_available_amount || 0) > 0
    const isZeroNetCase = hasNcHint && netSuggested <= 0.01

    let cashAmount = 0
    let paymentDate = paymentModal.paymentDate

    if (paymentModal.settleMode === 'bank') {
      const selected = paymentModal.bankCandidates.find((tx) => tx.id === paymentModal.selectedBankTxId)
      if (!selected) {
        setPaymentModal((prev) => ({ ...prev, error: 'Seleziona un movimento banca candidato' }))
        return
      }
      cashAmount = round2(Math.abs(selected.amount))
      paymentDate = selected.date
    } else if (paymentModal.settleMode === 'manual') {
      const amount = Number(paymentModal.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        setPaymentModal((prev) => ({ ...prev, error: 'Importo pagamento non valido' }))
        return
      }
      cashAmount = round2(amount)
    } else {
      if (!hasNcHint) {
        setPaymentModal((prev) => ({ ...prev, error: 'Nessuna nota di credito disponibile per compensazione' }))
        return
      }
      if (!isZeroNetCase) {
        setPaymentModal((prev) => ({ ...prev, error: `NC insufficiente: residuo cassa richiesto ${fmtEur(netSuggested)}` }))
        return
      }
      cashAmount = 0
    }

    const mode: 'cash' | 'net' = paymentModal.settleMode === 'nc'
      ? 'net'
      : (hasNcHint && isApproxEqual(cashAmount, netSuggested) ? 'net' : 'cash')

    setPaymentModal((prev) => ({ ...prev, saving: true, error: null }))
    try {
      const result = await settleInstallment({
        companyId: company.id,
        installmentId: row.id,
        paymentDate,
        cashAmount,
        mode,
      })

      if (paymentModal.settleMode === 'bank' && row.invoice_id && paymentModal.selectedBankTxId) {
        const { data: authData } = await supabase.auth.getUser()
        const userId = authData?.user?.id || null

        const { data: existingRec, error: existingRecErr } = await supabase
          .from('reconciliations')
          .select('id')
          .eq('company_id', company.id)
          .eq('invoice_id', row.invoice_id)
          .eq('bank_transaction_id', paymentModal.selectedBankTxId)
          .limit(1)

        if (existingRecErr) throw new Error(existingRecErr.message)

        if (!existingRec || existingRec.length === 0) {
          const { error: recErr } = await supabase
            .from('reconciliations')
            .insert({
              company_id: company.id,
              invoice_id: row.invoice_id,
              bank_transaction_id: paymentModal.selectedBankTxId,
              match_type: 'manual',
              confidence: 0.95,
              match_reason: 'scadenzario_bank_match',
              confirmed_by: userId,
              confirmed_at: new Date().toISOString(),
            })
          if (recErr) throw new Error(recErr.message)
        }

        await supabase
          .from('bank_transactions')
          .update({ reconciliation_status: 'matched' })
          .eq('company_id', company.id)
          .eq('id', paymentModal.selectedBankTxId)

        await supabase
          .from('invoices')
          .update({ reconciliation_status: 'matched' })
          .eq('company_id', company.id)
          .eq('id', row.invoice_id)
      }

      if (result.mode === 'net') {
        toast.success(`Compensazione NC applicata: usato ${fmtEur(result.credit_used)} · cassa ${fmtEur(result.cash_paid)} · credito residuo ${fmtEur(result.credit_residual)}`)
      } else {
        toast.success(`${row.type === 'incasso' ? 'Incasso' : 'Pagamento'} registrato`)
      }

      setPaymentModal({
        open: false,
        row: null,
        settleMode: 'manual',
        paymentDate: today,
        amount: '0',
        bankCandidates: [],
        bankSearchInfo: null,
        ncCandidates: [],
        loadingCandidates: false,
        selectedBankTxId: null,
        saving: false,
        error: null,
      })
      await loadRows()
    } catch (e: any) {
      setPaymentModal((prev) => ({ ...prev, saving: false, error: e.message || 'Errore registrazione pagamento' }))
    }
  }

  const switchPaymentMode = async (nextMode: SettleUiMode) => {
    if (!paymentModal.row) return

    const row = paymentModal.row
    const netSuggested = round2(Math.max(row.nc_net_amount || Math.max(row.remaining_amount, 0), 0))
    const fallbackAmount = round2(Math.max(row.remaining_amount || row.amount || 0, 0))

    setPaymentModal((prev) => ({
      ...prev,
      settleMode: nextMode,
      error: null,
      amount: nextMode === 'nc' ? '0' : nextMode === 'manual' ? String(fallbackAmount) : prev.amount,
    }))

    if (nextMode !== 'bank') return
    await refreshBankCandidates(row, Math.max(netSuggested, 0))
  }

  const openReminder = (row: ScadenzarioRow) => {
    setReminderModal({
      open: true,
      row,
      text: buildReminderText(row),
    })
  }

  const copyReminder = async () => {
    if (!reminderModal.text) return
    try {
      await navigator.clipboard.writeText(reminderModal.text)
    } catch {
      // fallback silent: user can still copy manually
    }
  }

  const openReminderMail = () => {
    if (!reminderModal.row) return
    const cp = reminderModal.row.counterparty_id ? counterpartyMap.get(reminderModal.row.counterparty_id) : null
    const subject = encodeURIComponent(`Sollecito pagamento ${reminderModal.row.reference}`)
    const body = encodeURIComponent(reminderModal.text)
    const to = encodeURIComponent(cp?.email || '')
    window.open(`mailto:${to}?subject=${subject}&body=${body}`, '_blank')
  }

  const onSort = (column: NonNullable<ScadenzarioFilters['sortBy']>) => {
    if (sortBy === column) {
      setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortBy(column)
    setSortDir('asc')
  }

  const groupedRows = useMemo(() => {
    const out: Array<{ key: string; row: ScadenzarioRow; separator?: string }> = []
    let prevGroup: 'overdue' | 'today' | 'future' | null = null

    for (const row of rows) {
      const group = rowGroup(row.due_date, today)
      const separator = sortBy === 'due_date' && group !== prevGroup ? rowGroupLabel(group) : undefined
      out.push({ key: `${row.kind}-${row.id}`, row, separator })
      prevGroup = group
    }

    return out
  }, [rows, today, sortBy])

  const summary = useMemo(() => {
    const horizon = new Date(`${today}T00:00:00`)
    horizon.setDate(horizon.getDate() + 30)
    const horizonIso = horizon.toISOString().slice(0, 10)

    let within30Incassi = 0
    let within30Pagamenti = 0
    let overdueIncassi = 0
    let overduePagamenti = 0
    let totalIncassiOpen = 0
    let totalPagamentiOpen = 0
    let ncAvailable = 0

    let ivaDue30 = 0
    let ivaCredit30 = 0
    let ivaOverdueDue = 0
    let ivaNetOpen = 0

    for (const row of rows) {
      const rem = round2(row.remaining_amount)
      if (Math.abs(rem) <= 0.01) continue

      const dueDate = row.due_date
      const isWithin30 = dueDate >= today && dueDate <= horizonIso
      const isOverdue = dueDate < today

      if (row.type === 'incasso') {
        totalIncassiOpen = round2(totalIncassiOpen + rem)
        if (isWithin30) within30Incassi = round2(within30Incassi + rem)
        if (isOverdue) overdueIncassi = round2(overdueIncassi + rem)
        continue
      }

      if (row.type === 'pagamento') {
        totalPagamentiOpen = round2(totalPagamentiOpen + rem)
        if (isWithin30) within30Pagamenti = round2(within30Pagamenti + rem)
        if (isOverdue) overduePagamenti = round2(overduePagamenti + rem)
        if (row.is_credit_note) ncAvailable = round2(ncAvailable + Math.abs(Math.min(rem, 0)))
        continue
      }

      // IVA rows (positive = debito, negative = credito)
      ivaNetOpen = round2(ivaNetOpen + rem)
      if (isWithin30) {
        if (rem > 0) ivaDue30 = round2(ivaDue30 + rem)
        else ivaCredit30 = round2(ivaCredit30 + Math.abs(rem))
      }
      if (isOverdue && rem > 0) ivaOverdueDue = round2(ivaOverdueDue + rem)
    }

    return {
      within30Incassi: Math.max(within30Incassi, 0),
      within30PagamentiNet: Math.max(round2(within30Pagamenti + ivaDue30 - ivaCredit30), 0),
      overdueIncassi: Math.max(overdueIncassi, 0),
      overduePagamenti: Math.max(overduePagamenti, 0),
      totalIncassiOpen: round2(totalIncassiOpen),
      totalPagamentiOpenNet: Math.max(round2(totalPagamentiOpen + ivaNetOpen), 0),
      ncAvailable: Math.max(ncAvailable, 0),
      ivaDue30: Math.max(ivaDue30, 0),
      ivaCredit30: Math.max(ivaCredit30, 0),
      ivaOverdueDue: Math.max(ivaOverdueDue, 0),
      ivaNetOpen: round2(ivaNetOpen),
    }
  }, [rows, today])

  const widgetCards = useMemo(() => {
    if (activeTab === 'incassi') {
      return [
        { label: 'Da incassare (30gg)', value: summary.within30Incassi, valueClass: 'text-emerald-800', labelClass: 'text-emerald-700' },
        { label: 'Scaduto clienti', value: summary.overdueIncassi, valueClass: 'text-amber-800', labelClass: 'text-amber-700' },
        { label: 'Totale aperto clienti', value: summary.totalIncassiOpen, valueClass: 'text-sky-800', labelClass: 'text-sky-700' },
        { label: 'NC clienti aperte', value: 0, valueClass: 'text-indigo-800', labelClass: 'text-indigo-700' },
      ] as const
    }

    if (activeTab === 'pagamenti') {
      return [
        { label: 'Da pagare (30gg)', value: summary.within30PagamentiNet, valueClass: 'text-red-800', labelClass: 'text-red-700' },
        { label: 'Scaduto fornitori', value: summary.overduePagamenti, valueClass: 'text-orange-800', labelClass: 'text-orange-700' },
        { label: 'NC disponibili', value: summary.ncAvailable, valueClass: 'text-indigo-800', labelClass: 'text-indigo-700' },
        { label: 'Netto uscite aperte', value: summary.totalPagamentiOpenNet, valueClass: 'text-rose-800', labelClass: 'text-rose-700' },
      ] as const
    }

    if (activeTab === 'iva') {
      return [
        { label: 'IVA da versare (30gg)', value: summary.ivaDue30, valueClass: 'text-red-800', labelClass: 'text-red-700' },
        { label: 'IVA a credito (30gg)', value: summary.ivaCredit30, valueClass: 'text-emerald-800', labelClass: 'text-emerald-700' },
        { label: 'IVA scaduta', value: summary.ivaOverdueDue, valueClass: 'text-amber-800', labelClass: 'text-amber-700' },
        { label: 'Saldo IVA aperto', value: summary.ivaNetOpen, valueClass: summary.ivaNetOpen >= 0 ? 'text-orange-800' : 'text-emerald-800', labelClass: 'text-orange-700' },
      ] as const
    }

    return [
      { label: 'Da incassare (30gg)', value: summary.within30Incassi, valueClass: 'text-emerald-800', labelClass: 'text-emerald-700' },
      { label: 'Da pagare (30gg)', value: summary.within30PagamentiNet, valueClass: 'text-red-800', labelClass: 'text-red-700' },
      { label: 'Scaduto clienti', value: summary.overdueIncassi, valueClass: 'text-amber-800', labelClass: 'text-amber-700' },
      { label: 'Scaduto fornitori', value: summary.overduePagamenti, valueClass: 'text-orange-800', labelClass: 'text-orange-700' },
    ] as const
  }, [activeTab, summary])

  const canShowAging = activeTab === 'incassi' || activeTab === 'pagamenti'
  const paymentPreview = useMemo(() => {
    const row = paymentModal.row
    if (!row) return null

    const remaining = round2(Math.max(row.remaining_amount, 0))
    const ncAvailable = round2(Math.max(row.nc_available_amount || 0, 0))
    const canNet = row.kind === 'installment' && row.type === 'pagamento' && !row.is_credit_note && ncAvailable > 0.01
    const net = canNet ? round2(Math.max(remaining - ncAvailable, 0)) : remaining
    const residual = canNet ? round2(Math.max(ncAvailable - remaining, 0)) : 0

    return {
      canNet,
      remaining,
      ncAvailable,
      net,
      residual,
      isZeroNetCase: canNet && net <= 0.01,
    }
  }, [paymentModal.row])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Scadenzario</h1>
        <p className="text-muted-foreground text-sm mt-1">Entrate/Uscite aziendali: rate fatture e liquidazioni IVA</p>
      </div>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {health && health.invoicesCount > 0 && health.installmentsCount === 0 && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>Backfill rate necessario: trovate {health.invoicesCount} fatture ma 0 rate nello scadenzario.</span>
          <Button size="sm" variant="outline" disabled={backfillRunning} onClick={runInstallmentBackfill}>
            {backfillRunning ? 'Rigenerazione...' : 'Rigenera rate storico'}
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {widgetCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="p-4">
              <p className={`text-xs uppercase ${card.labelClass}`}>{card.label}</p>
              <p className={`text-2xl font-bold mt-1 ${card.valueClass}`}>{fmtEur(card.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarClock className="h-4 w-4" /> Timeline scadenze
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'all' | 'incassi' | 'pagamenti' | 'iva')}>
            <TabsList>
              <TabsTrigger value="all">Tutte</TabsTrigger>
              <TabsTrigger value="incassi">Incassi</TabsTrigger>
              <TabsTrigger value="pagamenti">Pagamenti</TabsTrigger>
              <TabsTrigger value="iva">IVA</TabsTrigger>
            </TabsList>
            <TabsContent value={activeTab} className="mt-4 space-y-4">
              <div className="border rounded-lg p-3 bg-gray-50/50 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                  <div>
                    <Label className="text-xs">Periodo</Label>
                    <select
                      value={periodPreset}
                      onChange={(e) => setPeriodPreset(e.target.value as ScadenzarioFilters['periodPreset'])}
                      className="w-full mt-1 border rounded-md px-2 py-2 text-sm"
                    >
                      {PERIOD_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Stato</Label>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {STATUS_OPTIONS.map((option) => {
                        const selected = statusFilters.has(option.value)
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => toggleStatusFilter(option.value)}
                            className={`px-2 py-1 text-[11px] rounded-md border ${selected ? 'bg-sky-100 border-sky-300 text-sky-700' : 'bg-white border-gray-200 text-gray-600'}`}
                          >
                            {option.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div>
                    <Label className="text-xs">Controparte</Label>
                    <select
                      value={counterpartyId}
                      onChange={(e) => setCounterpartyId(e.target.value)}
                      className="w-full mt-1 border rounded-md px-2 py-2 text-sm"
                    >
                      <option value="">Tutte</option>
                      {counterparties.map((cp) => (
                        <option key={cp.id} value={cp.id}>{cp.name}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <Label className="text-xs">Cerca</Label>
                    <div className="mt-1 relative">
                      <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Numero fattura o controparte"
                        className="pl-7"
                      />
                    </div>
                  </div>

                  <div className="flex items-end">
                    <Button variant="outline" className="w-full" onClick={clearFilters}>
                      <Filter className="h-3.5 w-3.5 mr-1.5" /> Reset filtri
                    </Button>
                  </div>
                </div>

                {periodPreset === 'custom' && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Dal</Label>
                      <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1" />
                    </div>
                    <div>
                      <Label className="text-xs">Al</Label>
                      <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1" />
                    </div>
                  </div>
                )}
              </div>

              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('due_date')}>Data scadenza{sortArrow(sortBy || '', sortDir, 'due_date')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('type')}>Tipo{sortArrow(sortBy || '', sortDir, 'type')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('counterparty')}>Controparte{sortArrow(sortBy || '', sortDir, 'counterparty')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('reference')}>Riferimento{sortArrow(sortBy || '', sortDir, 'reference')}</th>
                      <th className="text-left px-3 py-2">Rata</th>
                      <th className="text-right px-3 py-2 cursor-pointer" onClick={() => onSort('amount')}>Importo{sortArrow(sortBy || '', sortDir, 'amount')}</th>
                      <th className="text-left px-3 py-2 cursor-pointer" onClick={() => onSort('status')}>Stato{sortArrow(sortBy || '', sortDir, 'status')}</th>
                      <th className="text-right px-3 py-2 cursor-pointer" onClick={() => onSort('days')}>Giorni{sortArrow(sortBy || '', sortDir, 'days')}</th>
                      <th className="text-right px-3 py-2">Azioni</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Caricamento scadenze...</td>
                      </tr>
                    ) : groupedRows.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="px-3 py-8 text-center text-muted-foreground">Nessuna scadenza trovata con i filtri correnti.</td>
                      </tr>
                    ) : (
                      groupedRows.map(({ key, row, separator }) => {
                        const isToday = row.due_date === today
                        const isOverdue = row.status === 'overdue' && row.remaining_amount > 0

                        return (
                          <Fragment key={key}>
                            {separator && (
                              <tr>
                                <td colSpan={9} className="px-3 py-2 text-xs font-semibold uppercase text-gray-500 bg-gray-100/70 border-y">
                                  {separator}
                                </td>
                              </tr>
                            )}
                            <tr
                              onDoubleClick={() => navigate(row.reference_link)}
                              className={`border-t cursor-pointer ${isOverdue ? 'bg-red-50/60' : isToday ? 'bg-amber-50/70' : ''}`}
                            >
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  <span>{fmtDate(row.due_date)}</span>
                                  {row.is_estimated && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700" title="Scadenza stimata">
                                      stimata
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-1.5">
                                  <span className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full font-medium ${rowTypeBadge(row.type)}`}>
                                    {rowTypeIcon(row.type)}
                                    {rowTypeLabel(row.type)}
                                  </span>
                                  {row.is_credit_note && (
                                    <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-indigo-100 text-indigo-700">
                                      NC
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                {row.counterparty_link ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      navigate(row.counterparty_link || '/controparti')
                                    }}
                                    className="text-left text-blue-700 hover:underline"
                                  >
                                    {row.counterparty_name}
                                  </button>
                                ) : (
                                  <span className="text-gray-500">{row.counterparty_name}</span>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    navigate(row.reference_link)
                                  }}
                                  className="text-left hover:underline"
                                >
                                  {row.reference}
                                </button>
                              </td>
                              <td className="px-3 py-2 text-gray-600">{row.installment_label || ''}</td>
                              <td className={`px-3 py-2 text-right font-semibold ${moneyColor(row.type)}`}>
                                <div>{fmtEur(row.amount)}</div>
                                {row.kind === 'installment' && row.type === 'pagamento' && !row.is_credit_note && row.nc_available_amount > 0.01 && (
                                  <div className="mt-1 text-[11px] font-normal text-indigo-700">
                                    NC disponibili {fmtEur(row.nc_available_amount)} · Netto {fmtEur(row.nc_net_amount)}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2">
                                <span className={`text-[11px] px-2 py-1 rounded-full font-medium ${rowStatusBadge(row.status)}`}>
                                  {row.status_label}
                                </span>
                              </td>
                              <td className={`px-3 py-2 text-right font-medium ${row.days > 0 ? 'text-red-700' : row.days < 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                                {row.days > 0 ? `+${row.days}` : row.days}
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-2">
                                  {row.kind === 'installment' && row.status !== 'paid' && !row.is_credit_note && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openPaymentModal(row)
                                      }}
                                    >
                                      {row.type === 'incasso' ? 'Segna incassato' : 'Segna pagato'}
                                    </Button>
                                  )}
                                  {row.kind === 'installment' && row.type === 'incasso' && row.status === 'overdue' && !row.is_credit_note && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        openReminder(row)
                                      }}
                                    >
                                      Sollecita
                                    </Button>
                                  )}
                                  {row.kind === 'vat' && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        navigate(row.reference_link)
                                      }}
                                    >
                                      Apri IVA
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          </Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {canShowAging && aging && (
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-base">
                        {activeTab === 'incassi' ? 'Analisi crediti per anzianita' : 'Analisi debiti per anzianita'}
                      </CardTitle>
                      <Button variant="outline" size="sm" onClick={() => setShowAging((v) => !v)}>
                        {showAging ? 'Nascondi' : 'Mostra'}
                      </Button>
                    </div>
                  </CardHeader>
                  {showAging && (
                    <CardContent className="space-y-3">
                      <div className="overflow-x-auto border rounded-lg">
                        <table className="w-full text-sm">
                          <thead className="bg-gray-50">
                            <tr>
                              <th className="text-left px-3 py-2">{activeTab === 'incassi' ? 'Cliente' : 'Fornitore'}</th>
                              <th className="text-right px-3 py-2">Totale</th>
                              <th className="text-right px-3 py-2">Corrente</th>
                              <th className="text-right px-3 py-2">1-30 gg</th>
                              <th className="text-right px-3 py-2">31-60 gg</th>
                              <th className="text-right px-3 py-2">61-90 gg</th>
                              <th className="text-right px-3 py-2">90+ gg</th>
                            </tr>
                          </thead>
                          <tbody>
                            {aging.rows.length === 0 ? (
                              <tr>
                                <td colSpan={7} className="px-3 py-6 text-center text-muted-foreground">Nessun dato aging disponibile.</td>
                              </tr>
                            ) : (
                              aging.rows.map((row) => (
                                <tr key={`${row.counterparty_id || row.counterparty_name}`} className="border-t">
                                  <td className="px-3 py-2">
                                    {row.counterparty_id ? (
                                      <button
                                        type="button"
                                        onClick={() => navigate(`/controparti?counterpartyId=${row.counterparty_id}`)}
                                        className="text-blue-700 hover:underline"
                                      >
                                        {row.counterparty_name}
                                      </button>
                                    ) : (
                                      <span>{row.counterparty_name}</span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-right font-semibold">{fmtEur(row.total)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.current)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_1_30)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_31_60)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_61_90)}</td>
                                  <td className="px-3 py-2 text-right">{fmtEur(row.bucket_90_plus)}</td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>

                      <div className="text-sm text-gray-700">
                        KPI {activeTab === 'incassi' ? 'DSO' : 'DPO'} stimato: <span className="font-semibold">{aging.kpi_days.toLocaleString('it-IT', { maximumFractionDigits: 1 })} giorni</span>
                      </div>
                    </CardContent>
                  )}
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {paymentModal.open && paymentModal.row && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPaymentModal((prev) => ({ ...prev, open: false }))}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-2xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">{paymentModal.row.type === 'incasso' ? 'Registra incasso' : 'Registra pagamento'}</h3>
            <div className="grid grid-cols-2 gap-2 text-xs bg-gray-50 border rounded-md px-3 py-2 mb-3">
              <div><span className="text-gray-500">Controparte:</span> <span className="font-medium">{paymentModal.row.counterparty_name}</span></div>
              <div><span className="text-gray-500">Riferimento:</span> <span className="font-medium">{paymentModal.row.reference}</span></div>
              <div><span className="text-gray-500">Importo rata:</span> <span className="font-medium">{fmtEur(paymentModal.row.amount)}</span></div>
              <div><span className="text-gray-500">Scadenza:</span> <span className="font-medium">{fmtDate(paymentModal.row.due_date)}</span></div>
            </div>

            <p className="text-sm text-gray-600 mb-4">Residuo da saldare: {fmtEur(paymentModal.row.remaining_amount)}</p>

            <div className="space-y-3">
              {paymentPreview?.canNet && (
                <div className="text-xs rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-2 text-indigo-800">
                  NC disponibile {fmtEur(paymentPreview.ncAvailable)} · Netto da saldare {fmtEur(paymentPreview.net)}
                  {paymentPreview.residual > 0.01 && (
                    <span> · Credito residuo dopo compensazione {fmtEur(paymentPreview.residual)}</span>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={paymentModal.settleMode === 'bank' ? 'default' : 'outline'}
                  onClick={() => switchPaymentMode('bank')}
                >
                  <Landmark className="h-3.5 w-3.5 mr-1.5" /> Da conto banca
                </Button>
                <Button
                  size="sm"
                  variant={paymentModal.settleMode === 'manual' ? 'default' : 'outline'}
                  onClick={() => switchPaymentMode('manual')}
                >
                  <PencilLine className="h-3.5 w-3.5 mr-1.5" /> Manuale
                </Button>
                {paymentPreview?.canNet && (
                  <Button
                    size="sm"
                    variant={paymentModal.settleMode === 'nc' ? 'default' : 'outline'}
                    onClick={() => switchPaymentMode('nc')}
                  >
                    <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Compensa NC
                  </Button>
                )}
              </div>

              {paymentModal.settleMode === 'bank' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Movimenti banca candidati (±10% importo, ±60 giorni)</Label>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        if (!paymentModal.row) return
                        await refreshBankCandidates(
                          paymentModal.row,
                          Math.max(paymentModal.row.nc_net_amount || paymentModal.row.remaining_amount, 0),
                        )
                      }}
                    >
                      Aggiorna candidati
                    </Button>
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {paymentModal.loadingCandidates
                      ? 'Ricerca movimenti bancari in corso...'
                      : paymentModal.bankSearchInfo
                        ? `Cercando tra ${paymentModal.bankSearchInfo.total_company.toLocaleString('it-IT')} movimenti banca aziendali`
                        : 'Nessuna diagnostica disponibile'}
                  </div>
                  {paymentModal.loadingCandidates ? (
                    <div className="text-xs text-gray-500 border rounded-md px-3 py-2">Caricamento candidati...</div>
                  ) : paymentModal.bankCandidates.length === 0 ? (
                    <div className="text-xs text-gray-500 border rounded-md px-3 py-2 space-y-1">
                      <div>Nessun movimento candidato trovato. Usa modalità Manuale o Compensa NC.</div>
                      {paymentModal.bankSearchInfo && (
                        <div>
                          Disponibili: {paymentModal.bankSearchInfo.total_company.toLocaleString('it-IT')} totali ·{' '}
                          {paymentModal.bankSearchInfo.same_direction.toLocaleString('it-IT')} stessa direzione ·{' '}
                          {paymentModal.bankSearchInfo.in_date_window.toLocaleString('it-IT')} in finestra ±{paymentModal.bankSearchInfo.window_days}gg ·{' '}
                          {paymentModal.bankSearchInfo.in_amount_tolerance.toLocaleString('it-IT')} entro ±{Math.round(paymentModal.bankSearchInfo.tolerance_pct * 100)}%.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="max-h-56 overflow-y-auto border rounded-md divide-y">
                      {paymentModal.bankCandidates.map((tx) => {
                        const selected = paymentModal.selectedBankTxId === tx.id
                        return (
                          <button
                            type="button"
                            key={tx.id}
                            onClick={() => setPaymentModal((prev) => ({
                              ...prev,
                              selectedBankTxId: tx.id,
                              paymentDate: tx.date,
                              amount: String(round2(Math.abs(tx.amount))),
                            }))}
                            className={`w-full text-left px-3 py-2 text-xs ${selected ? 'bg-sky-50' : 'hover:bg-gray-50'}`}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium">{fmtDate(tx.date)} · {fmtEur(Math.abs(tx.amount))}</span>
                              <span className="text-[10px] text-sky-700">score {tx.score}</span>
                            </div>
                            <div className="text-gray-600 truncate">{tx.counterparty_name || tx.description || 'Movimento banca'}</div>
                            <div className="text-[10px] text-gray-500">{tx.transaction_type || 'n/d'} · {tx.reconciliation_status || 'n/d'}</div>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}

              {paymentModal.settleMode === 'manual' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">Data</Label>
                    <Input
                      type="date"
                      value={paymentModal.paymentDate}
                      onChange={(e) => setPaymentModal((prev) => ({ ...prev, paymentDate: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Importo</Label>
                    <Input
                      type="number"
                      step="0.01"
                      min={0}
                      value={paymentModal.amount}
                      onChange={(e) => setPaymentModal((prev) => ({ ...prev, amount: e.target.value }))}
                      className="mt-1"
                    />
                  </div>
                </div>
              )}

              {paymentModal.settleMode === 'nc' && (
                <div className="space-y-2">
                  <div className="text-xs border rounded-md px-3 py-2 bg-indigo-50 text-indigo-800">
                    Compensazione senza movimento banca.
                    {paymentPreview?.isZeroNetCase
                      ? ` Netto da saldare ${fmtEur(0)}.`
                      : ` NC non sufficiente: residuo cassa richiesto ${fmtEur(paymentPreview?.net || 0)}.`}
                  </div>
                  {paymentModal.ncCandidates.length > 0 && (
                    <div className="border rounded-md max-h-44 overflow-y-auto divide-y">
                      {paymentModal.ncCandidates.map((nc) => (
                        <div key={nc.id} className="px-3 py-2 text-xs flex items-center justify-between gap-2">
                          <span>{nc.reference} · {fmtDate(nc.due_date)}</span>
                          <span className="font-medium text-indigo-700">{fmtEur(nc.remaining_credit)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {paymentModal.error && <p className="text-xs text-red-600">{paymentModal.error}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPaymentModal((prev) => ({ ...prev, open: false }))}>Annulla</Button>
              <Button onClick={submitPayment} disabled={paymentModal.saving}>
                {paymentModal.saving
                  ? 'Salvataggio...'
                  : paymentModal.settleMode === 'bank'
                    ? 'Conferma e abbina movimento'
                    : paymentModal.settleMode === 'nc'
                      ? 'Compensa con NC'
                      : (paymentModal.row.type === 'incasso' ? 'Segna incassato' : 'Segna pagato')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {reminderModal.open && reminderModal.row && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setReminderModal({ open: false, row: null, text: '' })}>
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-2xl w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-3">Sollecito pagamento</h3>
            <p className="text-sm text-gray-600 mb-2">{reminderModal.row.reference} - {reminderModal.row.counterparty_name}</p>
            <textarea
              value={reminderModal.text}
              onChange={(e) => setReminderModal((prev) => ({ ...prev, text: e.target.value }))}
              className="w-full min-h-[220px] border rounded-md px-3 py-2 text-sm"
            />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={copyReminder}>Copia testo</Button>
              <Button variant="outline" onClick={openReminderMail}>Apri in email</Button>
              <Button onClick={() => setReminderModal({ open: false, row: null, text: '' })}>Chiudi</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
