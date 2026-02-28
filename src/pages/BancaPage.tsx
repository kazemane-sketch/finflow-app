// src/pages/BancaPage.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useCompany } from '@/hooks/useCompany'
import {
  Upload, Landmark, RefreshCw, TrendingUp, TrendingDown,
  Search, X, CheckCircle, AlertCircle, Info,
  Building2, Trash2, AlertTriangle, Sparkles, CalendarDays,
} from 'lucide-react'
import {
  parseBankPdf, saveBankTransactions, ensureBankAccount, createImportBatch,
  updateImportBatch, loadBankTransactions, loadBankAccounts, getClaudeApiKey,
  deleteBankTransactions, deleteAllBankTransactions,
  type BankParseProgress,
} from '@/lib/bankParser'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'

// ============================================================
// UTILS
// ============================================================
function fmtEur(n: number | null | undefined) {
  if (n == null) return '—'
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n)
}
function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const [y, m, dd] = d.split('-')
  return `${dd}/${m}/${y}`
}
function txTypeLabel(type?: string) {
  const map: Record<string, string> = {
    bonifico_in: 'Bonifico entrata', bonifico_out: 'Bonifico uscita',
    riba: 'RIBA', sdd: 'SDD/RID', pos: 'POS', prelievo: 'Prelievo ATM',
    commissione: 'Commissione/Spese', stipendio: 'Stipendio', f24: 'F24', altro: 'Altro',
  }
  return map[type || 'altro'] || type || 'Altro'
}
function txTypeBadge(type?: string) {
  if (!type) return 'bg-gray-100 text-gray-600'
  if (type === 'bonifico_in' || type === 'stipendio') return 'bg-emerald-100 text-emerald-700'
  if (type === 'bonifico_out' || type === 'f24' || type === 'commissione') return 'bg-red-100 text-red-700'
  if (type === 'riba') return 'bg-blue-100 text-blue-700'
  if (type === 'sdd') return 'bg-purple-100 text-purple-700'
  if (type === 'pos') return 'bg-amber-100 text-amber-700'
  if (type === 'prelievo') return 'bg-orange-100 text-orange-700'
  return 'bg-gray-100 text-gray-600'
}
function isoDate(d: Date) {
  return d.toISOString().split('T')[0]
}

// ============================================================
// IMPORT PROGRESS
// ============================================================
function ImportProgress({ progress, txCount }: { progress: BankParseProgress; txCount: number }) {
  const [animPct, setAnimPct] = useState(0)
  const animRef = useRef<any>(null)

  useEffect(() => {
    clearInterval(animRef.current)
    if (progress.phase === 'uploading') {
      setAnimPct(5)
    } else if (progress.phase === 'analyzing' || progress.phase === 'waiting') {
      setAnimPct(8)
      animRef.current = setInterval(() => {
        setAnimPct(prev => {
          if (prev >= 88) { clearInterval(animRef.current); return 88 }
          const step = prev < 40 ? 1.2 : prev < 70 ? 0.6 : 0.2
          return prev + step
        })
      }, 800)
    } else if (progress.phase === 'saving') {
      setAnimPct(93)
    } else if (progress.phase === 'done') {
      setAnimPct(100)
    }
    return () => clearInterval(animRef.current)
  }, [progress.phase])

  const pct = Math.round(animPct)
  const label = progress.phase === 'uploading' ? '📤 Caricamento PDF...'
    : progress.phase === 'analyzing' ? '🤖 Gemini sta analizzando...'
    : progress.phase === 'waiting' ? '⏳ Attendo...'
    : progress.phase === 'saving' ? '💾 Salvataggio movimenti...'
    : '✅ Completato'

  return (
    <div className="bg-white border rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">{label}</span>
        <span className="text-xs text-gray-500">{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
        <div className={`h-2 rounded-full transition-all duration-300 ${progress.phase === 'done' ? 'bg-emerald-500' : 'bg-sky-500'}`}
          style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-gray-500">{progress.message}</p>
      {txCount > 0 && <p className="text-xs text-emerald-700 mt-1 font-medium">✓ {txCount} movimenti trovati</p>}
    </div>
  )
}

// ============================================================
// DELETE CONFIRM MODAL
// ============================================================
function DeleteModal({ mode, count, onConfirm, onCancel }: {
  mode: 'selected' | 'all'; count: number; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100">
            <AlertTriangle className="h-5 w-5 text-red-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">Conferma eliminazione</p>
            <p className="text-sm text-gray-500">
              {mode === 'all' ? 'Eliminare TUTTI i movimenti del conto?' : `Eliminare ${count} movimento/i selezionato/i?`}
            </p>
          </div>
        </div>
        <p className="text-sm text-red-600 mb-5">⚠️ Questa azione è irreversibile.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel}>Annulla</Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />Elimina
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// TRANSACTION ROW
// ============================================================
function TxRow({ tx, selected, onClick, onDoubleClick }: {
  tx: any; selected: boolean; onClick: () => void; onDoubleClick?: () => void
}) {
  const isIn = tx.amount > 0
  const hasCommission = tx.commission_amount != null && tx.commission_amount !== 0
  // Importo netto: rimuovo la commissione (negativa) dall'importo → tx.amount - tx.commission_amount
  // Es: amount=-700.20, commission=-0.20 → netto = -700.20 - (-0.20) = -700.00
  const netAmount = hasCommission ? tx.amount - tx.commission_amount : null

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gray-100 transition-all select-none
        ${selected ? 'bg-sky-50 border-l-[3px] border-l-sky-500' : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'}`}
    >
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isIn ? 'bg-emerald-100' : 'bg-red-100'}`}>
        {isIn ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-gray-800 truncate">
          {tx.counterparty_name || tx.description?.substring(0, 60) || '—'}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
          {tx.invoice_ref && (
            <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">FAT {tx.invoice_ref}</span>
          )}
          {hasCommission && (
            <span className="text-[9px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded font-medium">
              comm. {fmtEur(tx.commission_amount)}
            </span>
          )}
        </div>
      </div>
      <span className={`hidden sm:inline-flex text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${txTypeBadge(tx.transaction_type)}`}>
        {txTypeLabel(tx.transaction_type)}
      </span>
      <div className="text-right flex-shrink-0">
        <p className={`text-sm font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : ''}{fmtEur(tx.amount)}
        </p>
        {netAmount != null && (
          <p className="text-[10px] text-gray-400">netto {fmtEur(netAmount)}</p>
        )}
      </div>
    </div>
  )
}

// ============================================================
// DETAIL PANEL
// ============================================================
function TxDetail({ tx, onClose }: { tx: any; onClose: () => void }) {
  if (!tx) return null
  const isIn = tx.amount > 0
  const hasCommission = tx.commission_amount != null && tx.commission_amount !== 0
  // Importo netto corretto: toglie la commissione dall'importo totale
  // commission è negativo → amount - commission = amount + abs(commission)
  const netAmount = hasCommission ? tx.amount - tx.commission_amount : tx.amount

  const Row = ({ l, v, mono }: { l: string; v?: any; mono?: boolean }) => {
    if (v == null || v === '' || v === '—') return null
    return (
      <div>
        <p className="text-[10px] text-gray-400 uppercase tracking-wide">{l}</p>
        <p className={`text-xs text-gray-800 mt-0.5 break-words ${mono ? 'font-mono bg-gray-50 p-1.5 rounded text-[10px]' : ''}`}>{v}</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <span className="text-sm font-semibold">Dettaglio movimento</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className={`px-4 py-4 flex-shrink-0 ${isIn ? 'bg-emerald-50' : 'bg-red-50'}`}>
        <p className={`text-2xl font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : ''}{fmtEur(tx.amount)}
        </p>
        {hasCommission && (
          <div className="mt-1.5 space-y-0.5">
            <p className="text-xs text-orange-600">Commissione: {fmtEur(tx.commission_amount)}</p>
            <p className="text-xs font-semibold text-gray-700">Importo netto: {fmtEur(netAmount)}</p>
          </div>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-gray-500">{fmtDate(tx.date)}</span>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${txTypeBadge(tx.transaction_type)}`}>
            {txTypeLabel(tx.transaction_type)}
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <Row l="Data accredito" v={tx.date ? fmtDate(tx.date) : null} />
        <Row l="Data valuta" v={tx.value_date ? fmtDate(tx.value_date) : null} />
        <Row l="Controparte" v={tx.counterparty_name} />
        <Row l="IBAN / Conto controparte" v={tx.counterparty_account} />
        <Row l="Saldo dopo" v={tx.balance != null ? fmtEur(tx.balance) : null} />
        <Row l="Descrizione" v={tx.description} />
        <Row l="Rif. fattura" v={tx.invoice_ref} />
        <Row l="ID flusso CBI" v={tx.cbi_flow_id} />
        <Row l="Filiale disponente" v={tx.branch} />
        <Row l="Riferimento" v={tx.reference} />
        <Row l="Stato riconciliazione" v={tx.reconciliation_status} />
      </div>
    </div>
  )
}

// ============================================================
// AI SEARCH
// ============================================================
async function askClaudeOnTransactions(query: string, transactions: any[]): Promise<string> {
  const response = await fetch(`${SUPABASE_URL}/functions/v1/bank-ai-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ query, transactions }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Errore server ${response.status}`)
  }
  const data = await response.json()
  return data.answer || 'Nessuna risposta'
}

// ============================================================
// MAIN PAGE
// ============================================================
export default function BancaPage() {
  const { company } = useCompany()
  const companyId = company?.id || null

  const [transactions, setTransactions] = useState<any[]>([])
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedTx, setSelectedTx] = useState<any>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [dirFilter, setDirFilter] = useState<'all' | 'in' | 'out'>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [deleteModal, setDeleteModal] = useState<{ mode: 'selected' | 'all' } | null>(null)
  const [deleting, setDeleting] = useState(false)

  // AI search (usa query come input unificato)
  const [aiResult, setAiResult] = useState<string | null>(null)
  const [aiLoading, setAiLoading] = useState(false)

  // Import
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<BankParseProgress | null>(null)
  const [importTxCount, setImportTxCount] = useState(0)
  const [importResult, setImportResult] = useState<{ saved: number; duplicates: number; errors: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)


  const loadData = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [txs, accs] = await Promise.all([loadBankTransactions(companyId), loadBankAccounts(companyId)])
      setTransactions(txs)
      setBankAccounts(accs)
    } catch (e: any) { console.error(e) }
    setLoading(false)
  }, [companyId])

  useEffect(() => { loadData() }, [loadData])

  // Quick date filters
  const setQuickDate = (type: string) => {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    // Helper: first day of month
    const firstDay = (year: number, month: number) => new Date(year, month, 1)
    // Helper: last day of month
    const lastDay = (year: number, month: number) => new Date(year, month + 1, 0)
    switch (type) {
      case 'this_month':
        setDateFrom(isoDate(firstDay(y, m)))
        setDateTo(isoDate(lastDay(y, m)))
        break
      case 'last_month': {
        const lm = m === 0 ? 11 : m - 1
        const ly = m === 0 ? y - 1 : y
        setDateFrom(isoDate(firstDay(ly, lm)))
        setDateTo(isoDate(lastDay(ly, lm)))
        break
      }
      case 'last_3': {
        const sm = ((m - 2) + 12) % 12
        const sy = m < 2 ? y - 1 : y
        setDateFrom(isoDate(firstDay(sy, sm)))
        setDateTo(isoDate(lastDay(y, m)))
        break
      }
      default:
        setDateFrom('')
        setDateTo('')
    }
  }

  const handleRowClick = (tx: any) => {
    if (selectedTx?.id === tx.id && selectedIds.size === 0) { setSelectedTx(null); return }
    if (selectedIds.size > 0) {
      setSelectedIds(prev => { const n = new Set(prev); n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id); return n })
      return
    }
    setSelectedTx(tx)
  }

  const handleRowDoubleClick = (tx: any) => {
    setSelectedTx(null)
    setSelectedIds(prev => { const n = new Set(prev); n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id); return n })
  }

  const clearSelection = () => { setSelectedIds(new Set()); setSelectedTx(null) }

  const handleDelete = async () => {
    if (!deleteModal || !companyId) return
    setDeleting(true)
    try {
      if (deleteModal.mode === 'selected') {
        await deleteBankTransactions(Array.from(selectedIds))
        setSelectedIds(new Set()); setSelectedTx(null)
      } else {
        await deleteAllBankTransactions(companyId); setSelectedTx(null)
      }
      await loadData()
    } catch (e: any) { alert('Errore eliminazione: ' + e.message) }
    setDeleting(false); setDeleteModal(null)
  }

  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files?.length || !companyId) return
    const file = files[0]
    const apiKey = getClaudeApiKey()
    if (!apiKey) { alert('Configura la chiave API Claude in Impostazioni.'); return }
    setImporting(true); setImportResult(null); setImportTxCount(0)

    try {
      const parseResult = await parseBankPdf(file, apiKey, (p) => { setImportProgress(p) })
      setImportTxCount(parseResult.transactions.length)

      if (parseResult.transactions.length === 0) {
        const errs = parseResult.errors.length > 0
          ? parseResult.errors
          : ['Nessun movimento trovato.']
        setImportResult({ saved: 0, duplicates: 0, errors: errs })
        setImporting(false); return
      }

      const bankAccountId = await ensureBankAccount(companyId, { iban: undefined, bankName: 'Monte dei Paschi', accountHolder: undefined })
      const batchId = await createImportBatch(companyId, file.name)
      setImportProgress({ phase: 'saving', current: 0, total: parseResult.transactions.length, message: 'Salvataggio...' })

      const saveResult = await saveBankTransactions(
        companyId, bankAccountId, parseResult.transactions, batchId,
        (cur, tot) => setImportProgress({ phase: 'saving', current: cur, total: tot, message: `Salvataggio ${cur}/${tot}...` })
      )
      await updateImportBatch(batchId, {
        total: parseResult.transactions.length, success: saveResult.saved,
        errors: saveResult.errors.length, error_details: saveResult.errors.length ? saveResult.errors : null,
      })
      setImportResult({ ...saveResult, errors: [...saveResult.errors, ...parseResult.errors] })
      await loadData()
    } catch (e: any) { setImportResult({ saved: 0, duplicates: 0, errors: [e.message] }) }
    setImporting(false)
    if (fileRef.current) fileRef.current.value = ''
  }, [companyId, loadData])

  // Filters (defined before handleAiSearch so it can reference it)
  const filtered = transactions.filter(tx => {
    if (dirFilter === 'in' && tx.amount <= 0) return false
    if (dirFilter === 'out' && tx.amount >= 0) return false
    if (typeFilter !== 'all' && tx.transaction_type !== typeFilter) return false
    if (dateFrom && tx.date < dateFrom) return false
    if (dateTo && tx.date > dateTo) return false
    if (query) {
      const q = query.toLowerCase()
      return (tx.description?.toLowerCase().includes(q)) ||
        (tx.counterparty_name?.toLowerCase().includes(q)) ||
        (tx.invoice_ref?.toLowerCase().includes(q)) ||
        (tx.reference?.toLowerCase().includes(q))
    }
    return true
  })

  const handleAiSearch = async () => {
    if (!query.trim()) return
    setAiLoading(true); setAiResult(null)
    try {
      const result = await askClaudeOnTransactions(query, filtered)
      setAiResult(result)
    } catch (e: any) {
      if (e.message.includes('401') || e.message.includes('authentication')) {
        setAiResult('⚠️ Chiave API Claude non valida. Vai in Impostazioni e inserisci la chiave sk-ant-...')
      } else {
        setAiResult('Errore: ' + e.message)
      }
    }
    setAiLoading(false)
  }

  // KPI su dati filtrati
  const totalIn = filtered.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const totalOut = filtered.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
  const latestBalance = transactions[0]?.balance
  const uniqueTypes = [...new Set(transactions.map(t => t.transaction_type).filter(Boolean))]
  const isMultiSelect = selectedIds.size > 0
  const hasDateFilter = !!(dateFrom || dateTo)

  return (
    <div className="flex h-full overflow-hidden">
      <div className="flex flex-col flex-1 overflow-hidden min-w-0">
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Banca</h1>
              <p className="text-muted-foreground text-sm">Movimenti bancari e estratti conto</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {transactions.length > 0 && (
                <Button variant="outline" size="sm" className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => setDeleteModal({ mode: 'all' })}>
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />Svuota tutto
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />Aggiorna
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()} disabled={importing || !companyId}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />Importa PDF
              </Button>
              <input ref={fileRef} type="file" accept=".pdf" className="hidden" onChange={e => handleImport(e.target.files)} />
            </div>
          </div>



          {isMultiSelect && (
            <div className="flex items-center gap-3 p-3 bg-sky-50 border border-sky-200 rounded-lg">
              <span className="text-sm font-medium text-sky-800">{selectedIds.size} movimento/i selezionati</span>
              <Button variant="destructive" size="sm" onClick={() => setDeleteModal({ mode: 'selected' })}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />Elimina selezionati
              </Button>
              <Button variant="outline" size="sm" onClick={clearSelection}>Deseleziona tutto</Button>
            </div>
          )}

          {transactions.length > 0 && !isMultiSelect && (
            <p className="text-[11px] text-gray-400">
              💡 Clicca su un movimento per i dettagli · Doppio click per selezionare più movimenti da eliminare
            </p>
          )}

          {/* KPI aggiornati con filtri */}
          {transactions.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Entrate{hasDateFilter ? ' (periodo)' : ''}
                  </p>
                  <p className="text-lg font-bold text-emerald-700">{fmtEur(totalIn)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">
                    Uscite{hasDateFilter ? ' (periodo)' : ''}
                  </p>
                  <p className="text-lg font-bold text-red-700">{fmtEur(totalOut)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">Ultimo saldo</p>
                  <p className="text-lg font-bold">{latestBalance != null ? fmtEur(latestBalance) : '—'}</p>
                </CardContent>
              </Card>
            </div>
          )}

          {importing && importProgress && <ImportProgress progress={importProgress} txCount={importTxCount} />}

          {importResult && !importing && (
            <div className={`flex items-start gap-3 p-3 rounded-lg border ${
              importResult.errors.filter(e => !e.startsWith('Batch')).length > 0 && importResult.saved === 0
                ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
              {importResult.saved > 0
                ? <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                : <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {importResult.saved > 0 ? `✓ ${importResult.saved} movimenti importati` : 'Import fallito'}
                  {importResult.duplicates > 0 && ` · ${importResult.duplicates} duplicati ignorati`}
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="text-xs text-red-700 mt-1 space-y-0.5">
                    {importResult.errors.slice(0, 4).map((e, i) => <li key={i}>• {e}</li>)}
                    {importResult.errors.length > 4 && <li>...e altri {importResult.errors.length - 4} errori</li>}
                  </ul>
                )}
              </div>
              <button className="text-gray-400 hover:text-gray-600 flex-shrink-0" onClick={() => setImportResult(null)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          )}

          {bankAccounts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {bankAccounts.map(acc => (
                <div key={acc.id} className="flex items-center gap-2 px-3 py-1.5 bg-slate-100 rounded-lg">
                  <Building2 className="h-3.5 w-3.5 text-slate-500" />
                  <span className="text-xs font-medium text-slate-700">{acc.name}</span>
                  {acc.iban && <span className="text-[10px] text-slate-400 font-mono">{acc.iban}</span>}
                </div>
              ))}
            </div>
          )}

          {/* FILTERS */}
          {transactions.length > 0 && (
            <div className="space-y-2">
              {/* Barra unificata: digita = filtro, Invio = AI */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  {aiLoading
                    ? <RefreshCw className="absolute left-2.5 top-2 h-3.5 w-3.5 text-purple-400 animate-spin" />
                    : <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />}
                  <input
                    value={query}
                    onChange={e => { setQuery(e.target.value); setAiResult(null) }}
                    onKeyDown={e => e.key === 'Enter' && handleAiSearch()}
                    placeholder="Cerca... · Premi Invio per ricerca AI 🤖"
                    className={`w-full pl-8 pr-8 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 ${
                      aiResult ? 'border-purple-300 focus:ring-purple-400 bg-purple-50' : 'border-gray-200 focus:ring-sky-500'
                    }`}
                  />
                  {query && <button className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600" onClick={() => { setQuery(''); setAiResult(null) }}><X className="h-3.5 w-3.5" /></button>}
                </div>
                {(['all', 'in', 'out'] as const).map(d => (
                  <button key={d} onClick={() => setDirFilter(d)}
                    className={`px-2.5 py-1.5 text-xs rounded-md font-medium border transition-all ${
                      dirFilter === d ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    {d === 'all' ? 'Tutti' : d === 'in' ? '↑ Entrate' : '↓ Uscite'}
                  </button>
                ))}
                {uniqueTypes.length > 1 && (
                  <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)}
                    className="px-2.5 py-1.5 text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-sky-500">
                    <option value="all">Tutti i tipi</option>
                    {uniqueTypes.map(t => <option key={t} value={t}>{txTypeLabel(t)}</option>)}
                  </select>
                )}
              </div>

              {/* Date filters compatti */}
              <div className="flex flex-wrap items-center gap-2">
                <CalendarDays className="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
                <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500" />
                <span className="text-xs text-gray-400">→</span>
                <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                  className="px-2 py-1 text-xs border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500" />
                {[
                  { label: 'Questo mese', v: 'this_month' },
                  { label: 'Mese scorso', v: 'last_month' },
                  { label: '3 mesi', v: 'last_3' },
                  { label: 'Tutto', v: 'all' },
                ].map(q => (
                  <button key={q.v} onClick={() => setQuickDate(q.v)}
                    className="px-2.5 py-1 text-xs rounded-md border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition-all">
                    {q.label}
                  </button>
                ))}
                {hasDateFilter && (
                  <button onClick={() => setQuickDate('all')} className="text-xs text-sky-600 hover:underline">
                    ✕ Reset date
                  </button>
                )}
              </div>

              {/* AI result */}
              {aiResult && (
                <div className="flex items-start gap-2 p-3 bg-purple-50 border border-purple-100 rounded-lg">
                  <Sparkles className="h-3.5 w-3.5 text-purple-500 flex-shrink-0 mt-0.5" />
                  <p className="flex-1 text-xs text-purple-900 whitespace-pre-wrap">{aiResult}</p>
                  <button onClick={() => setAiResult(null)} className="text-purple-300 hover:text-purple-500 flex-shrink-0">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Transactions list */}
          {transactions.length === 0 && !loading && !importing ? (
            <Card>
              <CardContent className="p-10 text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
                  <Landmark className="h-8 w-8 text-primary" />
                </div>
                <h3 className="text-lg font-semibold mb-2">Nessun movimento bancario</h3>
                <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
                  Carica il PDF dell'estratto conto MPS per importare automaticamente i movimenti.
                </p>
                <Button onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-2" />Carica estratto conto PDF
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="py-2.5 px-4 border-b">
                <CardTitle className="text-sm font-semibold">
                  Movimenti ({filtered.length}{filtered.length !== transactions.length ? ` di ${transactions.length}` : ''})
                </CardTitle>
              </CardHeader>
              <div className="divide-y divide-gray-50 max-h-[calc(100vh-420px)] overflow-y-auto">
                {filtered.length === 0
                  ? <p className="text-sm text-gray-400 text-center py-10">Nessun risultato</p>
                  : filtered.map(tx => (
                    <TxRow
                      key={tx.id} tx={tx}
                      selected={selectedIds.has(tx.id) || (!isMultiSelect && selectedTx?.id === tx.id)}
                      onClick={() => handleRowClick(tx)}
                      onDoubleClick={() => handleRowDoubleClick(tx)}
                    />
                  ))}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* RIGHT DETAIL PANEL */}
      {selectedTx && !isMultiSelect && (
        <div className="hidden lg:block w-72 xl:w-80 flex-shrink-0 overflow-hidden border-l h-full">
          <TxDetail tx={selectedTx} onClose={() => setSelectedTx(null)} />
        </div>
      )}

      {deleteModal && (
        <DeleteModal mode={deleteModal.mode} count={selectedIds.size}
          onConfirm={handleDelete} onCancel={() => !deleting && setDeleteModal(null)} />
      )}
    </div>
  )
}
