// src/pages/BancaPage.tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useCompany } from '@/hooks/useCompany'
import {
  Upload, Landmark, RefreshCw, TrendingUp, TrendingDown,
  Search, X, CheckCircle, AlertCircle, Info, ChevronRight, Building2
} from 'lucide-react'
import {
  parseBankPdf, saveBankTransactions, ensureBankAccount, createImportBatch,
  updateImportBatch, loadBankTransactions, loadBankAccounts, getClaudeApiKey,
  type BankParseProgress, type BankTransaction,
} from '@/lib/bankParser'

// ============================================================
// UTILS
// ============================================================
function fmtEur(n: number) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(n)
}

function fmtDate(d: string) {
  if (!d) return '—'
  const [y, m, dd] = d.split('-')
  return `${dd}/${m}/${y}`
}

function txTypeLabel(type?: string) {
  const map: Record<string, string> = {
    bonifico_in: 'Bonifico in entrata', bonifico_out: 'Bonifico in uscita',
    riba: 'RIBA', sdd: 'SDD/RID', pos: 'POS', prelievo: 'Prelievo ATM',
    commissione: 'Commissione', stipendio: 'Stipendio', f24: 'F24',
    altro: 'Altro',
  }
  return map[type || 'altro'] || type || 'Altro'
}

function txTypeColor(type?: string) {
  if (!type) return 'bg-gray-100 text-gray-600'
  if (type.includes('_in') || type === 'stipendio') return 'bg-emerald-100 text-emerald-700'
  if (type.includes('_out') || type === 'f24' || type === 'commissione') return 'bg-red-100 text-red-700'
  if (type === 'riba') return 'bg-blue-100 text-blue-700'
  if (type === 'sdd') return 'bg-purple-100 text-purple-700'
  if (type === 'pos') return 'bg-amber-100 text-amber-700'
  return 'bg-gray-100 text-gray-600'
}

// ============================================================
// IMPORT PROGRESS
// ============================================================
function ImportProgress({ progress, txCount }: { progress: BankParseProgress; txCount: number }) {
  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0
  return (
    <div className="bg-white border rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-gray-700">
          {progress.phase === 'rendering' ? '🖼️ Rendering PDF...' :
           progress.phase === 'analyzing' ? '🤖 Analisi AI in corso...' :
           '✅ Completato'}
        </span>
        <span className="text-xs text-gray-500">
          Pagina {progress.current}/{progress.total} — {pct}%
        </span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2 mb-2">
        <div
          className={`h-2 rounded-full transition-all duration-300 ${progress.phase === 'done' ? 'bg-emerald-500' : 'bg-sky-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-500">{progress.message}</p>
      {txCount > 0 && (
        <p className="text-xs text-emerald-700 mt-1 font-medium">✓ {txCount} movimenti trovati finora</p>
      )}
    </div>
  )
}

// ============================================================
// TRANSACTION ROW
// ============================================================
function TxRow({ tx, selected, onClick }: { tx: any; selected: boolean; onClick: () => void }) {
  const isIn = tx.amount > 0
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b border-gray-100 transition-all hover:bg-gray-50 ${selected ? 'bg-sky-50 border-l-4 border-l-sky-500' : ''}`}
      onClick={onClick}
    >
      {/* Amount indicator */}
      <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${isIn ? 'bg-emerald-100' : 'bg-red-100'}`}>
        {isIn ? <TrendingUp className="h-4 w-4 text-emerald-600" /> : <TrendingDown className="h-4 w-4 text-red-600" />}
      </div>

      {/* Main info */}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-gray-800 truncate">
          {tx.counterparty_name || tx.description?.substring(0, 60) || '—'}
        </p>
        <p className="text-[10px] text-gray-400 mt-0.5">
          {fmtDate(tx.date)}
          {tx.value_date && tx.value_date !== tx.date && ` · val. ${fmtDate(tx.value_date)}`}
        </p>
      </div>

      {/* Type badge */}
      <span className={`hidden sm:inline-flex text-[9px] font-medium px-1.5 py-0.5 rounded-full ${txTypeColor(tx.transaction_type)}`}>
        {txTypeLabel(tx.transaction_type)}
      </span>

      {/* Amount */}
      <span className={`text-sm font-bold flex-shrink-0 ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
        {isIn ? '+' : ''}{fmtEur(tx.amount)}
      </span>

      <ChevronRight className="h-3.5 w-3.5 text-gray-300 flex-shrink-0" />
    </div>
  )
}

// ============================================================
// TX DETAIL PANEL
// ============================================================
function TxDetail({ tx, onClose }: { tx: any; onClose: () => void }) {
  if (!tx) return null
  const isIn = tx.amount > 0
  return (
    <div className="h-full flex flex-col bg-white border-l">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <span className="text-sm font-semibold text-gray-800">Dettaglio movimento</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Amount hero */}
      <div className={`px-4 py-5 ${isIn ? 'bg-emerald-50' : 'bg-red-50'}`}>
        <p className={`text-3xl font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : ''}{fmtEur(tx.amount)}
        </p>
        <p className="text-sm text-gray-500 mt-1">{fmtDate(tx.date)}</p>
        <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full mt-2 ${txTypeColor(tx.transaction_type)}`}>
          {txTypeLabel(tx.transaction_type)}
        </span>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {[
          { l: 'Controparte', v: tx.counterparty_name },
          { l: 'Data valuta', v: tx.value_date ? fmtDate(tx.value_date) : null },
          { l: 'Saldo dopo', v: tx.balance != null ? fmtEur(tx.balance) : null },
          { l: 'Descrizione', v: tx.description },
          { l: 'Rif. fattura', v: tx.invoice_ref },
          { l: 'Riferimento', v: tx.reference },
          { l: 'Stato riconciliazione', v: tx.reconciliation_status },
        ].filter(r => r.v).map(r => (
          <div key={r.l}>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">{r.l}</p>
            <p className="text-xs text-gray-800 mt-0.5 break-words">{r.v}</p>
          </div>
        ))}

        {tx.raw_text && tx.raw_text !== tx.description && (
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">Testo originale</p>
            <p className="text-[10px] text-gray-500 mt-0.5 break-words font-mono bg-gray-50 p-2 rounded">{tx.raw_text}</p>
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

  // State
  const [transactions, setTransactions] = useState<any[]>([])
  const [bankAccounts, setBankAccounts] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedTx, setSelectedTx] = useState<any>(null)
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [dirFilter, setDirFilter] = useState<'all' | 'in' | 'out'>('all')

  // Import state
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<BankParseProgress | null>(null)
  const [importTxCount, setImportTxCount] = useState(0)
  const [importResult, setImportResult] = useState<{ saved: number; duplicates: number; errors: string[] } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasApiKey = !!getClaudeApiKey()

  // Load transactions
  const loadTx = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [txs, accs] = await Promise.all([
        loadBankTransactions(companyId),
        loadBankAccounts(companyId),
      ])
      setTransactions(txs)
      setBankAccounts(accs)
    } catch (e: any) {
      console.error(e)
    }
    setLoading(false)
  }, [companyId])

  useEffect(() => { loadTx() }, [loadTx])

  // Import handler
  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files?.length || !companyId) return
    const file = files[0]

    const apiKey = getClaudeApiKey()
    if (!apiKey) {
      alert('Configura la chiave API Claude in Impostazioni prima di importare.')
      return
    }

    setImporting(true)
    setImportResult(null)
    setImportTxCount(0)

    try {
      // Parse PDF
      let parsedTxs: BankTransaction[] = []
      const parseResult = await parseBankPdf(file, apiKey, (p) => {
        setImportProgress(p)
        setImportTxCount(parsedTxs.length)
      })
      parsedTxs = parseResult.transactions

      setImportTxCount(parsedTxs.length)

      if (parsedTxs.length === 0) {
        setImportResult({ saved: 0, duplicates: 0, errors: ['Nessun movimento trovato nel PDF. Verifica che sia un estratto conto leggibile.', ...parseResult.errors] })
        setImporting(false)
        return
      }

      // Ensure bank account
      const bankAccountId = await ensureBankAccount(companyId, {
        iban: parseResult.iban,
        bankName: parseResult.bankName || 'Monte dei Paschi',
        accountHolder: parseResult.accountHolder,
      })

      // Create import batch
      const batchId = await createImportBatch(companyId, file.name)

      // Save transactions
      const saveResult = await saveBankTransactions(
        companyId, bankAccountId, parsedTxs, batchId,
        (cur, tot) => setImportProgress({ phase: 'done', current: cur, total: tot, message: `Salvataggio ${cur}/${tot}...` })
      )

      // Update batch
      await updateImportBatch(batchId, {
        total: parsedTxs.length,
        success: saveResult.saved,
        errors: saveResult.errors.length,
        error_details: saveResult.errors.length ? saveResult.errors : null,
      })

      setImportResult(saveResult)
      await loadTx()

    } catch (e: any) {
      setImportResult({ saved: 0, duplicates: 0, errors: [e.message] })
    }

    setImporting(false)
  }, [companyId, loadTx])

  // Filter
  const filtered = transactions.filter(tx => {
    if (dirFilter === 'in' && tx.amount <= 0) return false
    if (dirFilter === 'out' && tx.amount >= 0) return false
    if (typeFilter !== 'all' && tx.transaction_type !== typeFilter) return false
    if (query) {
      const q = query.toLowerCase()
      return (tx.description?.toLowerCase().includes(q)) ||
        (tx.counterparty_name?.toLowerCase().includes(q)) ||
        (tx.invoice_ref?.toLowerCase().includes(q))
    }
    return true
  })

  // KPIs
  const totalIn = transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0)
  const totalOut = transactions.filter(t => t.amount < 0).reduce((s, t) => s + t.amount, 0)
  const latestBalance = transactions[0]?.balance

  return (
    <div className="flex h-full overflow-hidden">
      {/* LEFT PANEL */}
      <div className="flex flex-col flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-4">

          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">Banca</h1>
              <p className="text-muted-foreground text-sm mt-0.5">Movimenti bancari e estratti conto</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadTx} disabled={loading}>
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
                Aggiorna
              </Button>
              <Button
                size="sm"
                onClick={() => fileRef.current?.click()}
                disabled={importing || !companyId || !hasApiKey}
              >
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                Importa PDF
              </Button>
              <input
                ref={fileRef} type="file" accept=".pdf" className="hidden"
                onChange={e => handleImport(e.target.files)}
              />
            </div>
          </div>

          {/* API Key warning */}
          {!hasApiKey && (
            <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
              <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-amber-800">
                Configura la <strong>chiave API Claude</strong> in <a href="/impostazioni" className="underline">Impostazioni</a> per abilitare l'import degli estratti conto.
              </p>
            </div>
          )}

          {/* KPIs */}
          {transactions.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Entrate totali</p>
                  <p className="text-xl font-bold text-emerald-700 mt-1">{fmtEur(totalIn)}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Uscite totali</p>
                  <p className="text-xl font-bold text-red-700 mt-1">{fmtEur(Math.abs(totalOut))}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-4">
                  <p className="text-xs text-muted-foreground">Ultimo saldo</p>
                  <p className="text-xl font-bold mt-1">{latestBalance != null ? fmtEur(latestBalance) : '—'}</p>
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
            <div className={`flex items-start gap-3 p-3 rounded-lg border ${importResult.errors.length > 0 && importResult.saved === 0 ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
              {importResult.saved > 0
                ? <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />
                : <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />}
              <div>
                <p className="text-sm font-medium">
                  {importResult.saved > 0 ? `✓ ${importResult.saved} movimenti importati` : 'Import fallito'}
                  {importResult.duplicates > 0 && ` · ${importResult.duplicates} duplicati ignorati`}
                </p>
                {importResult.errors.length > 0 && (
                  <ul className="text-xs text-red-700 mt-1 space-y-0.5">
                    {importResult.errors.slice(0, 3).map((e, i) => <li key={i}>• {e}</li>)}
                    {importResult.errors.length > 3 && <li>...e altri {importResult.errors.length - 3} errori</li>}
                  </ul>
                )}
              </div>
              <button className="ml-auto text-gray-400 hover:text-gray-600" onClick={() => setImportResult(null)}>
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
                  {acc.iban && <span className="text-[10px] text-slate-400">{acc.iban}</span>}
                </div>
              ))}
            </div>
          )}

          {/* Filters + search */}
          {transactions.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-gray-400" />
                <input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Cerca descrizione, controparte..."
                  className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-sky-500"
                />
                {query && <button className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600" onClick={() => setQuery('')}><X className="h-3.5 w-3.5" /></button>}
              </div>

              {/* Dir filter */}
              {(['all', 'in', 'out'] as const).map(d => (
                <button
                  key={d}
                  onClick={() => setDirFilter(d)}
                  className={`px-3 py-1.5 text-xs rounded-md font-medium border transition-all ${dirFilter === d ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}
                >
                  {d === 'all' ? 'Tutti' : d === 'in' ? '↑ Entrate' : '↓ Uscite'}
                </button>
              ))}
            </div>
          )}

          {/* Transactions list */}
          {transactions.length === 0 && !loading && !importing ? (
            <Card>
              <CardContent className="p-8">
                <div className="text-center">
                  <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 mb-4">
                    <Landmark className="h-8 w-8 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">Nessun movimento bancario</h3>
                  <p className="text-sm text-muted-foreground mb-4 max-w-md mx-auto">
                    Carica il PDF dell'estratto conto (Monte dei Paschi o altra banca) per importare automaticamente i movimenti con AI.
                  </p>
                  {hasApiKey ? (
                    <Button onClick={() => fileRef.current?.click()}>
                      <Upload className="h-4 w-4 mr-2" />
                      Carica estratto conto PDF
                    </Button>
                  ) : (
                    <div className="flex items-center justify-center gap-2 text-amber-600 text-sm">
                      <Info className="h-4 w-4" />
                      Prima configura la chiave API in <a href="/impostazioni" className="underline ml-1">Impostazioni</a>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="py-3 px-4 border-b">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">
                    Movimenti ({filtered.length}{filtered.length !== transactions.length ? ` di ${transactions.length}` : ''})
                  </CardTitle>
                </div>
              </CardHeader>
              <div className="divide-y divide-gray-100 max-h-[calc(100vh-380px)] overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-8">Nessun risultato</p>
                ) : (
                  filtered.map(tx => (
                    <TxRow
                      key={tx.id}
                      tx={tx}
                      selected={selectedTx?.id === tx.id}
                      onClick={() => setSelectedTx(selectedTx?.id === tx.id ? null : tx)}
                    />
                  ))
                )}
              </div>
            </Card>
          )}
        </div>
      </div>

      {/* RIGHT DETAIL PANEL */}
      {selectedTx && (
        <div className="hidden lg:block w-72 xl:w-80 flex-shrink-0 overflow-hidden border-l">
          <TxDetail tx={selectedTx} onClose={() => setSelectedTx(null)} />
        </div>
      )}
    </div>
  )
}
