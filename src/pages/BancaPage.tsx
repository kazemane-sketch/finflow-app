// src/pages/BancaPage.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useCompany } from '@/hooks/useCompany'
import {
  Upload, Landmark, RefreshCw, TrendingUp, TrendingDown,
  Search, X, CheckCircle, AlertCircle, Info, ChevronRight,
  Building2, Trash2, AlertTriangle,
} from 'lucide-react'
import {
  parseBankPdf, saveBankTransactions, ensureBankAccount, createImportBatch,
  updateImportBatch, loadBankTransactions, loadBankAccounts, getClaudeApiKey,
  deleteBankTransactions, deleteAllBankTransactions,
  type BankParseProgress,
} from '@/lib/bankParser'

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

// ============================================================
// IMPORT PROGRESS
// ============================================================
function ImportProgress({ progress, txCount }: { progress: BankParseProgress; txCount: number }) {
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  const label = progress.phase === 'extracting' ? '📄 Lettura PDF...'
    : progress.phase === 'analyzing' ? '🤖 Analisi AI...'
    : progress.phase === 'saving' ? '💾 Salvataggio...'
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
function DeleteModal({
  mode, count, onConfirm, onCancel
}: {
  mode: 'selected' | 'all';
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
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
              {mode === 'all'
                ? 'Eliminare TUTTI i movimenti del conto?'
                : `Eliminare ${count} movement${count === 1 ? 'o' : 'i'} selezionat${count === 1 ? 'o' : 'i'}?`}
            </p>
          </div>
        </div>
        <p className="text-sm text-red-600 mb-5">⚠️ Questa azione è irreversibile.</p>
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={onCancel}>Annulla</Button>
          <Button variant="destructive" onClick={onConfirm}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            Elimina
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// TRANSACTION ROW
// ============================================================
function TxRow({ tx, selected, onClick, onDoubleClick }: { tx: any; selected: boolean; onClick: () => void; onDoubleClick?: () => void }) {
  const isIn = tx.amount > 0
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b border-gray-100 transition-all select-none
        ${selected
          ? 'bg-sky-50 border-l-[3px] border-l-sky-500'
          : 'hover:bg-gray-50 border-l-[3px] border-l-transparent'
        }`}
    >
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center
        ${isIn ? 'bg-emerald-100' : 'bg-red-100'}`}>
        {isIn
          ? <TrendingUp className="h-4 w-4 text-emerald-600" />
          : <TrendingDown className="h-4 w-4 text-red-600" />}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold text-gray-800 truncate">
          {tx.counterparty_name || tx.description?.substring(0, 60) || '—'}
        </p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-[10px] text-gray-400">{fmtDate(tx.date)}</span>
          {tx.invoice_ref && (
            <span className="text-[9px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">
              FAT {tx.invoice_ref}
            </span>
          )}
          {tx.commission_amount != null && tx.commission_amount !== 0 && (
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
        {tx.commission_amount != null && tx.commission_amount !== 0 && (
          <p className="text-[10px] text-gray-400">
            netto {fmtEur(tx.amount - Math.abs(tx.commission_amount))}
          </p>
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
  const netAmount = hasCommission ? tx.amount - Math.abs(tx.commission_amount) : tx.amount

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
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0">
        <span className="text-sm font-semibold">Dettaglio movimento</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Amount hero */}
      <div className={`px-4 py-4 flex-shrink-0 ${isIn ? 'bg-emerald-50' : 'bg-red-50'}`}>
        <p className={`text-2xl font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : ''}{fmtEur(tx.amount)}
        </p>
        {hasCommission && (
          <div className="mt-1.5 space-y-0.5">
            <p className="text-xs text-orange-600">Commissione: {fmtEur(tx.commission_amount)}</p>
            <p className="text-xs font-semibold text-gray-700">
              Importo netto (per matching): {fmtEur(netAmount)}
            </p>
          </div>
        )}
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-gray-500">{fmtDate(tx.date)}</span>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${txTypeBadge(tx.transaction_type)}`}>
            {txTypeLabel(tx.transaction_type)}
          </span>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        <Row l="Data valuta" v={tx.value_date ? fmtDate(tx.value_date) : null} />
        <Row l="Controparte" v={tx.counterparty_name} />
        <Row l="IBAN / Conto controparte" v={tx.counterparty_account} />
        <Row l="Saldo dopo" v={tx.balance != null ? fmtEur(tx.balance) : null} />
        <Row l="Descrizione" v={tx.description} />
        <Row l="Rif. fattura" v={tx.invoice_ref} />
        <Row l="ID flusso CBI" v={tx.cbi_flow_id} />
        <Row l="Filiale disponente" v={tx.branch} />
        <Row l="Codice categoria (CS)" v={tx.category_code} />
        <Row l="Riferimento" v={tx.reference} />
        <Row l="Stato riconciliazione" v={tx.reconciliation_status} />

        {tx.raw_text && tx.raw_text !== tx.description && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Testo originale completo</p>
            <p className="text-[10px] text-gray-500 font-mono bg-gray-50 p-2 rounded break-words whitespace-pre-wrap">{tx.raw_text}</p>
          </div>
        )}
      </div>
    </div>
  )
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
  const [selectedTx, setSelectedTx] = useState<any>(null)         // detail panel
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()) // multi-select
  const [query, setQuery] = useState('')
  const [dirFilter, setDirFilter] = useState<'all' | 'in' | 'out'>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [deleteModal, setDeleteModal] = useState<{ mode: 'selected' | 'all' } | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Import
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<BankParseProgress | null>(null)
  const [importTxCount, setImportTxCount] = useState(0)
  const [importResult, setImportResult] = useState<{ saved: number; duplicates: number; errors: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasApiKey = !!getClaudeApiKey()

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

  // Row click — toggle selection
  const handleRowClick = (tx: any) => {
    // Se già selezionato per detail → deseleziona
    if (selectedTx?.id === tx.id && selectedIds.size === 0) {
      setSelectedTx(null)
      return
    }
    // Se in modalità multi-select (selectedIds > 0) → aggiungi/rimuovi
    if (selectedIds.size > 0) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.has(tx.id) ? next.delete(tx.id) : next.add(tx.id)
        return next
      })
      return
    }
    // Altrimenti → apri detail
    setSelectedTx(tx)
  }

  // Long press / double click → entra in multi-select
  const handleRowDoubleClick = (tx: any) => {
    setSelectedTx(null)
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(tx.id) ? next.delete(tx.id) : next.add(tx.id)
      return next
    })
  }

  const clearSelection = () => {
    setSelectedIds(new Set())
    setSelectedTx(null)
  }

  // Delete
  const handleDelete = async () => {
    if (!deleteModal || !companyId) return
    setDeleting(true)
    try {
      if (deleteModal.mode === 'selected') {
        await deleteBankTransactions(Array.from(selectedIds))
        setSelectedIds(new Set())
        setSelectedTx(null)
      } else {
        await deleteAllBankTransactions(companyId)
        setSelectedTx(null)
      }
      await loadData()
    } catch (e: any) {
      alert('Errore eliminazione: ' + e.message)
    }
    setDeleting(false)
    setDeleteModal(null)
  }

  // Import
  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files?.length || !companyId) return
    const file = files[0]
    const apiKey = getClaudeApiKey()
    if (!apiKey) {
      alert('Configura la chiave API Claude in Impostazioni.')
      return
    }
    setImporting(true)
    setImportResult(null)
    setImportTxCount(0)
    let parsedCount = 0

    try {
      const parseResult = await parseBankPdf(file, apiKey, (p) => {
        setImportProgress(p)
        if (p.phase === 'done') parsedCount = parseInt(p.message.match(/\d+/)?.[0] || '0')
      })

      setImportTxCount(parseResult.transactions.length)

      if (parseResult.transactions.length === 0) {
        setImportResult({
          saved: 0, duplicates: 0,
          errors: ['Nessun movimento trovato.', ...parseResult.errors],
        })
        setImporting(false)
        return
      }

      const bankAccountId = await ensureBankAccount(companyId, {
        iban: parseResult.iban,
        bankName: parseResult.bankName || 'Monte dei Paschi',
        accountHolder: parseResult.accountHolder,
      })
      const batchId = await createImportBatch(companyId, file.name)

      setImportProgress({ phase: 'saving', current: 0, total: parseResult.transactions.length, message: 'Salvataggio...' })

      const saveResult = await saveBankTransactions(
        companyId, bankAccountId, parseResult.transactions, batchId,
        (cur, tot) => setImportProgress({ phase: 'saving', current: cur, total: tot, message: `Salvataggio ${cur}/${tot}...` })
      )

      await updateImportBatch(batchId, {
        total: parseResult.transactions.length,
        success: saveResult.saved,
        errors: saveResult.errors.length,
        error_details: saveResult.errors.length ? saveResult.errors : null,
      })

      setImportResult({ ...saveResult, errors: [...saveResult.errors, ...parseResult.errors] })
      await loadData()
    } catch (e: any) {
      setImportResult({ saved: 0, duplicates: 0, errors: [e.message] })
    }
    setImporting(false)
    if (fileRef.current) fileRef.current.value = ''
  }, [companyId, loadData])

  // Filters
  const filtered = transactions.filter(tx => {
    if (dirFilter === 'in' && tx.amount <= 0) return false
    if (dirFilter === 'out' && tx.amount >= 0) return false
    if (typeFilter !== 'all' && tx.transaction_type !== typeFilter) return false
    if (query) {
      const q = query.toLowerCase()
      return (tx.description?.toLowerCase().includes(q)) ||
        (tx.counterparty_name?.toLowerCase().includes(q)) ||
        (tx.invoice_ref?.toLowerCase().includes(q)) ||
        (tx.reference?.toLowerCase().includes(q))
    }
    return true
  })

  // KPIs
  const totalIn = transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const totalOut = transactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0)
  const latestBalance = transactions[0]?.balance

  const uniqueTypes = [...new Set(transactions.map(t => t.transaction_type).filter(Boolean))]

  const isMultiSelect = selectedIds.size > 0

  return (
    <div className="flex h-full overflow-hidden">
      {/* LEFT PANEL */}
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
                <Button
                  variant="outline" size="sm"
                  className="text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => setDeleteModal({ mode: 'all' })}
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Svuota tutto
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={loadData} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                Aggiorna
              </Button>
              <Button size="sm" onClick={() => fileRef.current?.click()}
                disabled={importing || !companyId || !hasApiKey}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Importa PDF
              </Button>
              <input ref={fileRef} type="file" accept=".pdf" className="hidden"
                onChange={e => handleImport(e.target.files)} />
            </div>
          </div>

          {/* API Key warning */}
          {!hasApiKey && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">
                Configura la <strong>chiave API Claude</strong> in{' '}
                <a href="/impostazioni" className="underline">Impostazioni</a> per abilitare l'import.
              </p>
            </div>
          )}

          {/* Multi-select toolbar */}
          {isMultiSelect && (
            <div className="flex items-center gap-3 p-3 bg-sky-50 border border-sky-200 rounded-lg">
              <span className="text-sm font-medium text-sky-800">
                {selectedIds.size} movimento/i selezionati
              </span>
              <Button variant="destructive" size="sm"
                onClick={() => setDeleteModal({ mode: 'selected' })}>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Elimina selezionati
              </Button>
              <Button variant="outline" size="sm" onClick={clearSelection}>
                Deseleziona tutto
              </Button>
            </div>
          )}

          {/* Hint multi-select */}
          {transactions.length > 0 && !isMultiSelect && (
            <p className="text-[11px] text-gray-400">
              💡 Clicca su un movimento per i dettagli · Doppio click per selezionare più movimenti da eliminare
            </p>
          )}

          {/* KPIs */}
          {transactions.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">Entrate</p>
                  <p className="text-lg font-bold text-emerald-700">{fmtEur(totalIn)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-[10px] text-muted-foreground uppercase">Uscite</p>
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

          {/* Import progress */}
          {importing && importProgress && (
            <ImportProgress progress={importProgress} txCount={importTxCount} />
          )}

          {/* Import result */}
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

          {/* Bank accounts */}
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

          {/* Filters */}
          {transactions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[180px]">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Cerca descrizione, controparte, fattura..."
                  className="w-full pl-8 pr-8 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500" />
                {query && <button className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600" onClick={() => setQuery('')}>
                  <X className="h-3.5 w-3.5" /></button>}
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
                {hasApiKey
                  ? <Button onClick={() => fileRef.current?.click()}>
                      <Upload className="h-4 w-4 mr-2" />Carica estratto conto PDF
                    </Button>
                  : <p className="text-sm text-amber-600 flex items-center justify-center gap-1.5">
                      <Info className="h-4 w-4" />
                      Prima configura la chiave API in <a href="/impostazioni" className="underline ml-1">Impostazioni</a>
                    </p>}
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
                      key={tx.id}
                      tx={tx}
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

      {/* DELETE MODAL */}
      {deleteModal && (
        <DeleteModal
          mode={deleteModal.mode}
          count={selectedIds.size}
          onConfirm={handleDelete}
          onCancel={() => !deleting && setDeleteModal(null)}
        />
      )}
    </div>
  )
}
