import { useState, useEffect, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Link2, CheckCircle2, XCircle, Sparkles, RefreshCw, ChevronRight,
  ArrowRightLeft, Loader2, AlertTriangle, Search, FileText, Landmark,
  ChevronDown, X, Check, Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { useCompany } from '@/hooks/useCompany'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'
import { fmtDate, fmtEur } from '@/lib/utils'
import { txTypeLabel, txTypeBadge, txDirection } from '@/components/BankTxDetail'

/* ─── types ──────────────────────────────────── */

interface SuggestionRow {
  id: string
  bank_transaction_id: string
  installment_id: string | null
  invoice_id: string | null
  match_score: number
  match_reason: string
  proposed_by: string
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
  } | null
  invoice: {
    id: string
    number: string | null
    counterparty: Record<string, unknown> | null
    total_amount: number | null
    date: string | null
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
  raw_text: string | null
  extraction_status: string | null
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
}

interface KpiData {
  unmatched: number
  pendingSuggestions: number
  matched: number
  total: number
}

/* ─── helpers ────────────────────────────────── */

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

/* ─── main component ─────────────────────────── */

export default function RiconciliazionePage() {
  const { company } = useCompany()
  const companyId = company?.id || null
  const [searchParams, setSearchParams] = useSearchParams()

  // Tab state
  const [activeTab, setActiveTab] = useState<'suggestions' | 'assisted'>(
    (searchParams.get('tab') as 'suggestions' | 'assisted') || 'suggestions'
  )

  // Data
  const [suggestions, setSuggestions] = useState<SuggestionRow[]>([])
  const [unmatchedTxs, setUnmatchedTxs] = useState<UnmatchedTx[]>([])
  const [openInstallments, setOpenInstallments] = useState<OpenInstallment[]>([])
  const [kpi, setKpi] = useState<KpiData>({ unmatched: 0, pendingSuggestions: 0, matched: 0, total: 0 })

  // UI state
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [rejectingId, setRejectingId] = useState<string | null>(null)
  const [bulkConfirming, setBulkConfirming] = useState(false)

  // Assisted tab state
  const [selectedTxId, setSelectedTxId] = useState<string | null>(
    searchParams.get('tx') || null
  )
  const [assistedSearch, setAssistedSearch] = useState('')
  const [candidateSearch, setCandidateSearch] = useState('')

  // ─── load KPIs ──────────────────────────────
  const loadKpis = useCallback(async () => {
    if (!companyId) return
    const [
      { count: unmatched },
      { count: pendingSuggestions },
      { count: matched },
      { count: total },
    ] = await Promise.all([
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('reconciliation_status', 'unmatched'),
      supabase.from('reconciliation_suggestions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('status', 'pending'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('reconciliation_status', 'matched'),
      supabase.from('bank_transactions').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId),
    ])
    setKpi({
      unmatched: unmatched || 0,
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
        match_score, match_reason, proposed_by, suggestion_data, status, created_at,
        bank_transaction:bank_transactions(id, date, amount, counterparty_name, description, transaction_type, direction, reconciliation_status),
        invoice:invoices(id, number, counterparty, total_amount, date),
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
      .select('id, date, amount, counterparty_name, description, transaction_type, direction, raw_text, extraction_status')
      .eq('company_id', companyId)
      .eq('reconciliation_status', 'unmatched')
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
        invoice:invoices(number, counterparty)
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
      })))
    }
  }, [companyId])

  // ─── initial load ───────────────────────────
  useEffect(() => {
    if (!companyId) return
    setLoading(true)
    Promise.all([loadKpis(), loadSuggestions(), loadUnmatched(), loadOpenInstallments()])
      .finally(() => setLoading(false))
  }, [companyId, loadKpis, loadSuggestions, loadUnmatched, loadOpenInstallments])

  // ─── generate suggestions ──────────────────
  const generateSuggestions = useCallback(async () => {
    if (!companyId || generating) return
    setGenerating(true)
    try {
      const token = await getValidAccessToken()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/reconciliation-generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ company_id: companyId, batch_size: 100 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

      toast.success(`${data.new_suggestions} nuovi suggerimenti generati (${data.processed} movimenti analizzati)`)
      await Promise.all([loadKpis(), loadSuggestions()])
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Errore generazione: ${msg}`)
    }
    setGenerating(false)
  }, [companyId, generating, loadKpis, loadSuggestions])

  // ─── confirm suggestion ────────────────────
  const confirmSuggestion = useCallback(async (suggestion: SuggestionRow) => {
    if (!companyId) return
    setConfirmingId(suggestion.id)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const userId = user?.id

      // 1. Mark suggestion as accepted
      const { error: e1 } = await supabase
        .from('reconciliation_suggestions')
        .update({ status: 'accepted', resolved_at: new Date().toISOString(), resolved_by: userId })
        .eq('id', suggestion.id)
      if (e1) throw e1

      // 2. Create reconciliation record
      const { error: e2 } = await supabase
        .from('reconciliations')
        .insert({
          company_id: companyId,
          invoice_id: suggestion.invoice_id!,
          bank_transaction_id: suggestion.bank_transaction_id,
          match_type: suggestion.proposed_by,
          confidence: suggestion.match_score / 100,
          match_reason: suggestion.match_reason,
          confirmed_by: userId,
          confirmed_at: new Date().toISOString(),
        })
      if (e2) throw e2

      // 3. Update bank transaction status
      const { error: e3 } = await supabase
        .from('bank_transactions')
        .update({ reconciliation_status: 'matched' })
        .eq('id', suggestion.bank_transaction_id)
      if (e3) throw e3

      // 4. Update installment paid_amount if installment match
      if (suggestion.installment_id && suggestion.installment && suggestion.bank_transaction) {
        const txAmount = Math.abs(Number(suggestion.bank_transaction.amount))
        const newPaid = Number(suggestion.installment.paid_amount) + txAmount
        const newStatus = newPaid >= Number(suggestion.installment.amount_due) ? 'paid' : 'partial'
        const { error: e4 } = await supabase
          .from('invoice_installments')
          .update({
            paid_amount: newPaid,
            status: newStatus,
            last_payment_date: suggestion.bank_transaction.date || new Date().toISOString().slice(0, 10),
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

      // 6. Expire other pending suggestions for same bank transaction
      await supabase
        .from('reconciliation_suggestions')
        .update({ status: 'expired' })
        .eq('bank_transaction_id', suggestion.bank_transaction_id)
        .eq('status', 'pending')
        .neq('id', suggestion.id)

      toast.success('Riconciliazione confermata')
      setSuggestions(prev => prev.filter(s => s.bank_transaction_id !== suggestion.bank_transaction_id))
      await loadKpis()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Errore conferma: ${msg}`)
    }
    setConfirmingId(null)
  }, [companyId, loadKpis])

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

      toast.success('Suggerimento rifiutato')
      setSuggestions(prev => prev.filter(s => s.id !== suggestion.id))
      await loadKpis()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Errore rifiuto: ${msg}`)
    }
    setRejectingId(null)
  }, [companyId, loadKpis])

  // ─── bulk confirm high-confidence ──────────
  const bulkConfirmHigh = useCallback(async () => {
    const highConf = suggestions.filter(s => s.match_score >= 90)
    if (!highConf.length) return
    setBulkConfirming(true)
    let ok = 0
    let fail = 0
    for (const s of highConf) {
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
  const manualMatch = useCallback(async (txId: string, installment: OpenInstallment) => {
    if (!companyId) return
    setConfirmingId(txId)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      const tx = unmatchedTxs.find(t => t.id === txId)
      if (!tx) throw new Error('Transazione non trovata')

      // Create reconciliation
      const { error: e1 } = await supabase.from('reconciliations').insert({
        company_id: companyId,
        invoice_id: installment.invoice_id,
        bank_transaction_id: txId,
        match_type: 'manual',
        confidence: 1.0,
        match_reason: 'Abbinamento manuale',
        confirmed_by: user?.id,
        confirmed_at: new Date().toISOString(),
      })
      if (e1) throw e1

      // Update bank tx
      const { error: e2 } = await supabase
        .from('bank_transactions')
        .update({ reconciliation_status: 'matched' })
        .eq('id', txId)
      if (e2) throw e2

      // Update installment
      const txAmount = Math.abs(Number(tx.amount))
      const newPaid = Number(installment.paid_amount) + txAmount
      const newStatus = newPaid >= Number(installment.amount_due) ? 'paid' : 'partial'
      const { error: e3 } = await supabase
        .from('invoice_installments')
        .update({
          paid_amount: newPaid,
          status: newStatus,
          last_payment_date: tx.date || new Date().toISOString().slice(0, 10),
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

      toast.success('Riconciliazione manuale completata')
      setUnmatchedTxs(prev => prev.filter(t => t.id !== txId))
      setOpenInstallments(prev => prev.map(i =>
        i.id === installment.id ? { ...i, paid_amount: newPaid, status: newStatus } : i
      ).filter(i => i.status !== 'paid'))
      setSelectedTxId(null)
      await loadKpis()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Errore: ${msg}`)
    }
    setConfirmingId(null)
  }, [companyId, unmatchedTxs, loadKpis])

  // ─── tab change handler ────────────────────
  const handleTabChange = (tab: string) => {
    const t = tab as 'suggestions' | 'assisted'
    setActiveTab(t)
    setSearchParams(prev => {
      const p = new URLSearchParams(prev)
      p.set('tab', t)
      return p
    })
  }

  // ─── filtered unmatched for assisted tab ───
  const filteredUnmatched = useMemo(() => {
    if (!assistedSearch.trim()) return unmatchedTxs
    const q = assistedSearch.toLowerCase()
    return unmatchedTxs.filter(tx =>
      (tx.counterparty_name || '').toLowerCase().includes(q) ||
      (tx.description || '').toLowerCase().includes(q) ||
      String(tx.amount).includes(q)
    )
  }, [unmatchedTxs, assistedSearch])

  // ─── candidates for selected tx ────────────
  const candidates = useMemo(() => {
    if (!selectedTxId) return []
    const tx = unmatchedTxs.find(t => t.id === selectedTxId)
    if (!tx) return []

    const absAmount = Math.abs(Number(tx.amount))
    const txDir = txDirection(tx)

    // Filter installments by direction match and amount proximity
    let filtered = openInstallments.filter(inst => {
      // Direction: bank in → invoice out (payment received), bank out → invoice in (payment made)
      // Actually: bank_in matches receivable installments (direction=attivo), bank_out matches payable (direction=passivo)
      const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
      if (remaining <= 0) return false
      return true
    })

    // Sort by amount similarity
    filtered = filtered.map(inst => {
      const remaining = Number(inst.amount_due) - Number(inst.paid_amount)
      const diff = Math.abs(absAmount - remaining)
      const ratio = absAmount > 0 ? diff / absAmount : 1
      return { ...inst, _diff: diff, _ratio: ratio }
    }).sort((a, b) => a._ratio - b._ratio)

    // Apply search filter
    if (candidateSearch.trim()) {
      const q = candidateSearch.toLowerCase()
      filtered = filtered.filter(inst =>
        (inst.counterparty_name || '').toLowerCase().includes(q) ||
        (inst.invoice_number || '').toLowerCase().includes(q)
      )
    }

    return filtered.slice(0, 50)
  }, [selectedTxId, unmatchedTxs, openInstallments, candidateSearch])

  // Percentage KPI
  const matchPct = kpi.total > 0 ? Math.round((kpi.matched / kpi.total) * 100) : 0
  const highConfCount = suggestions.filter(s => s.match_score >= 90).length

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
          disabled={generating}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-colors"
        >
          {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {generating ? 'Analisi in corso...' : 'Genera suggerimenti'}
        </button>
      </div>

      {/* ──── KPI Cards ──── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Da riconciliare"
          value={kpi.unmatched}
          icon={AlertTriangle}
          color="text-red-700"
          bg="bg-red-50"
          iconColor="text-red-500"
        />
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
          icon={ArrowRightLeft}
          color="text-blue-700"
          bg="bg-blue-50"
          iconColor="text-blue-500"
          sub={`${kpi.matched} / ${kpi.total} movimenti`}
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

              {/* Suggestion cards */}
              {suggestions.map(s => (
                <SuggestionCard
                  key={s.id}
                  suggestion={s}
                  onConfirm={() => confirmSuggestion(s)}
                  onReject={() => rejectSuggestion(s)}
                  confirming={confirmingId === s.id}
                  rejecting={rejectingId === s.id}
                />
              ))}
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
              <div className="px-3 py-2 border-b">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                  <input
                    type="text"
                    value={assistedSearch}
                    onChange={e => setAssistedSearch(e.target.value)}
                    placeholder="Cerca controparte, descrizione..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-purple-400"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {filteredUnmatched.length === 0 ? (
                  <div className="text-xs text-gray-400 text-center py-8">Nessun movimento non riconciliato</div>
                ) : filteredUnmatched.map(tx => {
                  const dir = directionIcon(tx.direction)
                  const isSelected = selectedTxId === tx.id
                  return (
                    <button
                      key={tx.id}
                      onClick={() => setSelectedTxId(isSelected ? null : tx.id)}
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
                        </div>
                        <span className={`text-xs font-semibold shrink-0 ml-2 ${tx.direction === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                          {tx.direction === 'in' ? '+' : '-'}{fmtEur(Math.abs(Number(tx.amount)))}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5 pl-3.5">
                        <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
                        {tx.description && (
                          <span className="text-[10px] text-gray-400 truncate">{tx.description}</span>
                        )}
                      </div>
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

              {selectedTxId && (
                <div className="px-3 py-2 border-b">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                    <input
                      type="text"
                      value={candidateSearch}
                      onChange={e => setCandidateSearch(e.target.value)}
                      placeholder="Filtra per controparte, fattura..."
                      className="w-full pl-8 pr-3 py-1.5 text-xs border rounded-md focus:outline-none focus:ring-1 focus:ring-purple-400"
                    />
                  </div>
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
                  const tx = unmatchedTxs.find(t => t.id === selectedTxId)
                  const txAbs = tx ? Math.abs(Number(tx.amount)) : 0
                  const diff = Math.abs(txAbs - remaining)
                  const ratio = txAbs > 0 ? diff / txAbs : 1

                  return (
                    <div
                      key={inst.id}
                      className="px-3 py-2.5 border-b last:border-b-0 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-gray-800">
                              {inst.counterparty_name || 'N.D.'}
                            </span>
                            {inst.invoice_number && (
                              <span className="text-[10px] text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                                {inst.invoice_number}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="text-[10px] text-gray-400">Scad. {fmtDate(inst.due_date)}</span>
                            <span className="text-[10px] text-gray-500">
                              Residuo: {fmtEur(remaining)}
                            </span>
                            {ratio < 0.05 && (
                              <span className="text-[10px] text-emerald-600 font-medium">Importo coincidente</span>
                            )}
                            {ratio >= 0.05 && ratio < 0.15 && (
                              <span className="text-[10px] text-amber-600">Diff: {fmtEur(diff)}</span>
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
      </Tabs>
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

/* ─── Suggestion Card ────────────────────────── */

function SuggestionCard({ suggestion, onConfirm, onReject, confirming, rejecting }: {
  suggestion: SuggestionRow
  onConfirm: () => void
  onReject: () => void
  confirming: boolean
  rejecting: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const tx = suggestion.bank_transaction
  const inv = suggestion.invoice
  const inst = suggestion.installment

  if (!tx) return null

  const txDir = txDirection(tx)
  const absAmount = Math.abs(Number(tx.amount))
  const instRemaining = inst ? Number(inst.amount_due) - Number(inst.paid_amount) : null
  const invoiceDenom = inv?.counterparty && typeof inv.counterparty === 'object'
    ? (inv.counterparty as any).denom || 'N.D.'
    : 'N.D.'

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
                title="Conferma riconciliazione"
              >
                {confirming ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Conferma
              </button>
            </div>
          </div>

          {/* Two-column: Bank tx ↔ Invoice/Installment */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Bank transaction side */}
            <div className={`rounded-md p-2.5 ${txDir === 'in' ? 'bg-emerald-50/70' : 'bg-red-50/70'}`}>
              <div className="flex items-center gap-1.5 mb-1">
                <Landmark className="h-3 w-3 text-gray-500" />
                <span className="text-[10px] font-semibold uppercase text-gray-500">Movimento bancario</span>
              </div>
              <p className={`text-sm font-bold ${txDir === 'in' ? 'text-emerald-700' : 'text-red-700'}`}>
                {txDir === 'in' ? '+' : '-'}{fmtEur(absAmount)}
              </p>
              <p className="text-xs text-gray-700 mt-0.5">{tx.counterparty_name || 'N.D.'}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${txTypeBadge(tx.transaction_type ?? undefined)}`}>
                  {txTypeLabel(tx.transaction_type ?? undefined)}
                </span>
              </div>
            </div>

            {/* Invoice/Installment side */}
            <div className="rounded-md p-2.5 bg-blue-50/70">
              <div className="flex items-center gap-1.5 mb-1">
                <FileText className="h-3 w-3 text-gray-500" />
                <span className="text-[10px] font-semibold uppercase text-gray-500">
                  {inst ? 'Rata fattura' : 'Fattura'}
                </span>
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

          {/* Match reason (expandable) */}
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 mt-2 text-[10px] text-gray-400 hover:text-gray-600 transition-colors"
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            {suggestion.match_reason}
          </button>
          {expanded && suggestion.suggestion_data && (
            <div className="mt-1.5 text-[10px] text-gray-400 bg-gray-50 rounded p-2 font-mono">
              {JSON.stringify(suggestion.suggestion_data, null, 2)}
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
