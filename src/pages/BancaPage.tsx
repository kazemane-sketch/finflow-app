// src/pages/BancaPage.tsx
import { useState, useEffect, useCallback, useRef, type MouseEvent } from 'react'
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
  updateBankAccountBalance,
  deleteBankTransactions, deleteAllBankTransactions, updateBankTransactionDirection,
  getBankEmbeddingHealth,
  type BankEmbeddingHealth,
  type BankImportStats, type BankParseProgress, type BankParseResult, type BankTransaction,
} from '@/lib/bankParser'
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/client'
import { getValidAccessToken, type AccessTokenError } from '@/lib/getValidAccessToken'

import BankTxDetail, {
  txTypeLabel as _txTypeLabel,
  txTypeBadge as _txTypeBadge,
  txDirection as _txDirection,
  txDirectionSourceLabel as _txDirectionSourceLabel,
  txDirectionConfidenceLabel as _txDirectionConfidenceLabel,
} from '@/components/BankTxDetail'

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

function txDirection(tx: any): 'in' | 'out' {
  if (tx?.direction === 'in' || tx?.direction === 'out') return tx.direction
  return Number(tx?.amount || 0) >= 0 ? 'in' : 'out'
}

function txDirectionSourceLabel(source?: string) {
  if (source === 'side_rule') return 'Regola DARE/AVERE'
  if (source === 'semantic_rule') return 'Regola semantica'
  if (source === 'manual') return 'Correzione manuale'
  return 'Fallback importo'
}

function txDirectionConfidenceLabel(conf?: number) {
  if (conf == null || Number.isNaN(Number(conf))) return '—'
  return `${Math.round(Number(conf) * 100)}%`
}

const invalidCounterpartyTokens = new Set([
  '',
  'n.d.',
  'n.d',
  'nd',
  'n/d',
  '(per',
  'per',
  'ordine e conto',
  'ordine',
  'conto',
  'bonifico',
  'filiale',
  'bic',
  'inf',
  'ri',
  'rif',
  'num',
  'tot',
  'importo',
])

function cleanCounterpartyCandidate(raw: string | null | undefined): string | null {
  if (!raw) return null
  let value = String(raw).trim()
  if (!value) return null
  value = value
    .replace(/^[\s(]*per\b/i, '')
    .replace(/^\(?\s*ordine\s+e\s+conto\)?/i, '')
    .replace(/^\s*a\s+favore\s+di\s+/i, '')
    .replace(/^\s*bonifico\s+a\s+vostro\s+favore\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!value || value.length < 3 || value.length > 120) return null

  const lower = value.toLowerCase()
  if (invalidCounterpartyTokens.has(lower)) return null
  const compact = lower.replace(/[^a-z0-9]/g, '')
  if (invalidCounterpartyTokens.has(compact)) return null

  const parts = lower.split(/\s+/).filter(Boolean)
  if (parts.length <= 2 && parts.every((p) => invalidCounterpartyTokens.has(p))) return null
  return value
}

function extractCounterpartyFromRawText(rawText: string | null | undefined): string | null {
  if (!rawText) return null
  const lines = String(rawText).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const sameLine = line.match(/ORDINE\s+E\s+CONTO\)\s*(.+)$/i)
    if (sameLine?.[1]) {
      const merged = [sameLine[1], lines[i + 1], lines[i + 2]].filter(Boolean).join(' ')
      const candidate = cleanCounterpartyCandidate(merged)
      if (candidate) return candidate
    }

    const favorLine = line.match(/A\s+FAVORE\s+DI\s+(.+)$/i)
    if (favorLine?.[1]) {
      const merged = [favorLine[1], lines[i + 1]].filter(Boolean).join(' ')
      const candidate = cleanCounterpartyCandidate(merged)
      if (candidate) return candidate
    }

    const markerLine = line.match(/(?:CRED|BEN|ORDINANTE|BENEFICIARIO)\s*:\s*(.+)$/i)
    if (markerLine?.[1]) {
      const candidate = cleanCounterpartyCandidate(markerLine[1])
      if (candidate) return candidate
    }
  }

  return null
}

function getTxTitle(tx: any): string {
  const cp = cleanCounterpartyCandidate(tx?.counterparty_name)
  if (cp) return cp

  const description = String(tx?.description || '').trim()
  if (description) {
    const firstLine = description.split('\n')[0].trim()
    if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
  }

  const rawCounterparty = extractCounterpartyFromRawText(tx?.raw_text)
  if (rawCounterparty) return rawCounterparty

  return '—'
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

function SummaryReviewModal({
  items,
  onToggle,
  onDiscardAll,
  onConfirm,
  onCancel,
  saving,
}: {
  items: Array<BankTransaction & { _id: string; include: boolean }>;
  onToggle: (id: string) => void;
  onDiscardAll: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const selectedCount = items.filter((it) => it.include).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl mx-4 max-h-[85vh] flex flex-col">
        <div className="px-5 py-4 border-b flex items-center justify-between">
          <div>
            <p className="font-semibold text-gray-900">Righe di riepilogo trovate</p>
            <p className="text-xs text-gray-500">
              Seleziona solo le righe da importare come transazione. Default: scarta tutte.
            </p>
          </div>
          <button onClick={onCancel} className="text-gray-400 hover:text-gray-600 p-1" disabled={saving}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {items.map((it) => (
            <label
              key={it._id}
              className="flex items-start gap-3 rounded-lg border border-gray-200 p-3 hover:bg-gray-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={it.include}
                onChange={() => onToggle(it._id)}
                className="mt-1"
                disabled={saving}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-gray-500">{fmtDate(it.date)}</span>
                  <span className="text-xs font-semibold text-gray-800">{fmtEur(it.amount)}</span>
                  {it.summary_reason && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                      {it.summary_reason}
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-800 mt-1 break-words">{it.description || it.raw_text || 'Riga summary'}</p>
              </div>
            </label>
          ))}
        </div>

        <div className="px-5 py-3 border-t bg-gray-50 flex items-center justify-between gap-3">
          <p className="text-xs text-gray-600">
            Selezionate: <span className="font-semibold">{selectedCount}</span> / {items.length}
          </p>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onDiscardAll} disabled={saving}>Scarta tutte</Button>
            <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>Annulla import</Button>
            <Button size="sm" onClick={onConfirm} disabled={saving}>
              {saving ? 'Salvataggio...' : 'Conferma selezione'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// TRANSACTION ROW
// ============================================================
function TxRow({ tx, selected, onClick, onDoubleClick }: {
  tx: any; selected: boolean; onClick: (e: MouseEvent<HTMLDivElement>) => void; onDoubleClick?: (e: MouseEvent<HTMLDivElement>) => void
}) {
  const direction = txDirection(tx)
  const isIn = direction === 'in'
  const rawAmount = Number(tx.amount || 0)
  const signedAmount = isIn ? Math.abs(rawAmount) : -Math.abs(rawAmount)
  const hasCommission = tx.commission_amount != null && tx.commission_amount !== 0
  // Importo netto: rimuovo la commissione (negativa) dall'importo → tx.amount - tx.commission_amount
  // Es: amount=-700.20, commission=-0.20 → netto = -700.20 - (-0.20) = -700.00
  const netAmount = hasCommission ? signedAmount - Number(tx.commission_amount || 0) : null

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
          {getTxTitle(tx)}
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
      {tx.direction_needs_review && (
        <span className="hidden md:inline-flex text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 flex-shrink-0">
          Da verificare
        </span>
      )}
      {tx.counterparty_needs_review && (
        <span className="hidden lg:inline-flex text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-orange-100 text-orange-700 flex-shrink-0">
          Controparte da verificare
        </span>
      )}
      <div className="text-right flex-shrink-0">
        <p className={`text-sm font-bold ${isIn ? 'text-emerald-700' : 'text-red-700'}`}>
          {isIn ? '+' : '-'}{fmtEur(Math.abs(signedAmount))}
        </p>
        {netAmount != null && (
          <p className="text-[10px] text-gray-400">netto {fmtEur(netAmount)}</p>
        )}
      </div>
    </div>
  )
}

// ============================================================
// DETAIL PANEL — uses shared BankTxDetail component
// ============================================================
// TxDetail is now imported from @/components/BankTxDetail

// ============================================================
// AI SEARCH
// ============================================================
type BankAiMode = 'analysis'

type BankAiSearchRequest = {
  query: string
  company_id: string
  direction?: 'all' | 'in' | 'out'
  date_from?: string | null
  date_to?: string | null
  limit?: number
}

type BankAiFilterSpec = {
  date_from?: string | null
  date_to?: string | null
  direction?: 'in' | 'out' | null
  transaction_types?: string[] | null
  counterparty_pattern?: string | null
  amount_min?: number | null
  amount_max?: number | null
}

type BankAiSearchResponse = {
  mode: BankAiMode | 'filter'
  answer?: string
  used_count?: number
  candidate_count?: number
  candidate_ids?: string[]
  filter?: BankAiFilterSpec
  model?: string
  request_id?: string
}

type BankAiErrorPayload = Error & {
  status?: number
  requestId?: string
  details?: string
  errorCode?: string
  hint?: string
}

function createBankAiError(message: string, extra?: Partial<BankAiErrorPayload>): BankAiErrorPayload {
  const err = new Error(message) as BankAiErrorPayload
  if (extra?.status != null) err.status = extra.status
  if (extra?.requestId) err.requestId = extra.requestId
  if (extra?.details) err.details = extra.details
  if (extra?.errorCode) err.errorCode = extra.errorCode
  if (extra?.hint) err.hint = extra.hint
  return err
}

async function parseResponsePayload(res: Response): Promise<{ payload: any; rawText: string }> {
  const rawText = await res.text().catch(() => '')
  if (!rawText) return { payload: {}, rawText: '' }
  try {
    return { payload: JSON.parse(rawText), rawText }
  } catch {
    return { payload: {}, rawText }
  }
}

function hasJwtAuthSignal(err?: Partial<BankAiErrorPayload> | null): boolean {
  const code = String(err?.errorCode || '').toUpperCase()
  if (/JWT|TOKEN|SESSION|BEARER/.test(code)) return true
  const details = `${String(err?.message || '')} ${String(err?.details || '')}`.toLowerCase()
  return /jwt|token|session|auth|invalid|expired/.test(details)
}

function shouldRetryBankAiAuth(err?: Partial<BankAiErrorPayload> | null): boolean {
  if (!err) return false
  if (err.status === 401) return true
  if (err.status !== 403) return false
  return hasJwtAuthSignal(err)
}

function normalizeCandidateIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => String(v || '').trim())
    .filter(Boolean)
}

async function invokeBankAiWithBearer(body: BankAiSearchRequest, accessToken: string): Promise<BankAiSearchResponse> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/bank-ai-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  const requestId = res.headers.get('x-request-id') || res.headers.get('sb-request-id') || undefined
  const { payload, rawText } = await parseResponsePayload(res)
  const errorCode = typeof payload?.error_code === 'string' ? payload.error_code : undefined
  const hint = typeof payload?.hint === 'string' ? payload.hint : undefined

  if (!res.ok) {
    const msg = String(payload?.error || payload?.message || rawText || `HTTP ${res.status}`).trim()
    const details = typeof payload?.details === 'string' ? payload.details.trim() : ''
    throw createBankAiError(msg || 'Errore funzione AI', {
      status: res.status,
      requestId,
      details: details || msg || undefined,
      errorCode,
      hint,
    })
  }

  if (payload?.error) {
    throw createBankAiError(String(payload.error), {
      status: res.status,
      requestId: String(payload?.request_id || requestId || ''),
      details: String(payload.error),
      errorCode,
      hint,
    })
  }

  const responseMode = payload?.mode === 'filter' ? 'filter' : 'analysis'

  return {
    mode: responseMode as BankAiSearchResponse['mode'],
    answer: typeof payload?.answer === 'string' ? payload.answer : undefined,
    used_count: Number(payload?.used_count || 0),
    candidate_count: Number(payload?.candidate_count || 0),
    candidate_ids: normalizeCandidateIds(payload?.candidate_ids ?? payload?.candidateIds),
    filter: payload?.filter && typeof payload.filter === 'object' ? payload.filter as BankAiFilterSpec : undefined,
    model: typeof payload?.model === 'string' ? payload.model : undefined,
    request_id: typeof payload?.request_id === 'string' ? payload.request_id : requestId,
  }
}

async function askBankAiSearch(body: BankAiSearchRequest): Promise<BankAiSearchResponse> {
  let firstToken: string
  try {
    firstToken = await getValidAccessToken()
  } catch (e: any) {
    const authErr = e as AccessTokenError
    throw createBankAiError(authErr?.message || 'Sessione assente: effettua nuovamente il login.', {
      status: authErr?.status ?? 401,
      errorCode: authErr?.errorCode || 'AUTH_SESSION_MISSING',
      hint: authErr?.hint || 'Rifai login e riprova.',
    })
  }

  try {
    return await invokeBankAiWithBearer(body, firstToken)
  } catch (e: any) {
    const parsed = e as BankAiErrorPayload
    const shouldRetryAuth = shouldRetryBankAiAuth(parsed)
    if (!shouldRetryAuth) throw parsed

    let refreshedToken: string
    try {
      refreshedToken = await getValidAccessToken({ forceRefresh: true })
    } catch (eRefresh: any) {
      const authErr = eRefresh as AccessTokenError
      throw createBankAiError(parsed?.message || authErr?.message || 'Sessione non valida o scaduta.', {
        status: authErr?.status ?? parsed?.status ?? 401,
        requestId: parsed?.requestId,
        details: parsed?.details,
        errorCode: authErr?.errorCode || parsed?.errorCode || 'AUTH_REFRESH_FAILED',
        hint: authErr?.hint || 'Sessione scaduta. Effettua nuovamente il login e riprova.',
      })
    }

    try {
      return await invokeBankAiWithBearer(body, refreshedToken)
    } catch (e2: any) {
      const parsedSecond = e2 as BankAiErrorPayload
      const isAuthFailure = (parsedSecond?.status === 401 || parsedSecond?.status === 403) && hasJwtAuthSignal(parsedSecond)
      if (isAuthFailure) {
        throw createBankAiError(parsedSecond.message || 'Sessione non valida o scaduta.', {
          status: parsedSecond.status,
          requestId: parsedSecond.requestId,
          details: parsedSecond.details,
          errorCode: parsedSecond.errorCode || 'AUTH_INVALID_JWT',
          hint: parsedSecond.hint || 'Sessione non valida: esegui nuovamente il login.',
        })
      }
      throw parsedSecond
    }
  }
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
  const [dirFilter, setDirFilter] = useState<'all' | 'in' | 'out' | 'review'>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [dateFrom, setDateFrom] = useState<string>('')
  const [dateTo, setDateTo] = useState<string>('')
  const [deleteModal, setDeleteModal] = useState<{ mode: 'selected' | 'all' } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [directionEditMode, setDirectionEditMode] = useState(false)
  const [directionDraft, setDirectionDraft] = useState<'in' | 'out'>('in')
  const [directionSaving, setDirectionSaving] = useState(false)

  // AI search
  const [aiResult, setAiResult] = useState<{ text: string; mode: BankAiMode; isError: boolean; requestId?: string; candidateIds?: string[] } | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const [embeddingHealth, setEmbeddingHealth] = useState<BankEmbeddingHealth | null>(null)

  // Import
  const [importing, setImporting] = useState(false)
  const [importProgress, setImportProgress] = useState<BankParseProgress | null>(null)
  const [importTxCount, setImportTxCount] = useState(0)
  const [importResult, setImportResult] = useState<{
    saved: number;
    duplicates: number;
    dedup_db_count: number;
    errors: string[];
    warnings: string[];
    stats: BankImportStats;
  } | null>(null)
  const [summaryReview, setSummaryReview] = useState<{
    items: Array<BankTransaction & { _id: string; include: boolean }>;
    parseResult: BankParseResult;
    bankAccountId: string;
    filename: string;
  } | null>(null)
  const [summaryConfirming, setSummaryConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshEmbeddingHealth = useCallback(async () => {
    if (!companyId) return null
    try {
      const health = await getBankEmbeddingHealth(companyId)
      setEmbeddingHealth(health)
      return health
    } catch (e: any) {
      console.warn('[Bank Embedding] health unavailable', e?.message || e)
      return null
    }
  }, [companyId])

  const loadData = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [txs, accs] = await Promise.all([loadBankTransactions(companyId), loadBankAccounts(companyId)])
      setTransactions(txs)
      setBankAccounts(accs)
    } catch (e: any) { console.error(e) }
    setLoading(false)
    void refreshEmbeddingHealth()
  }, [companyId, refreshEmbeddingHealth])

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

  const handleRowClick = (tx: any, e: MouseEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      setSelectedTx(null)
      setDirectionEditMode(false)
      setSelectedIds(prev => {
        const n = new Set(prev)
        n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id)
        return n
      })
      return
    }

    if (selectedTx?.id === tx.id && selectedIds.size === 0) {
      setSelectedTx(null)
      setDirectionEditMode(false)
      return
    }
    if (selectedIds.size > 0) {
      setSelectedIds(prev => {
        const n = new Set(prev)
        n.has(tx.id) ? n.delete(tx.id) : n.add(tx.id)
        return n
      })
      return
    }
    setSelectedTx(tx)
    setDirectionDraft(txDirection(tx))
    setDirectionEditMode(false)
  }

  const handleRowDoubleClick = (tx: any) => {
    setSelectedIds(new Set())
    setSelectedTx(tx)
    setDirectionDraft(txDirection(tx))
    setDirectionEditMode(true)
  }

  const clearSelection = () => { setSelectedIds(new Set()); setSelectedTx(null); setDirectionEditMode(false) }

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

  const handleSaveDirection = async () => {
    if (!selectedTx?.id || !companyId) return
    setDirectionSaving(true)
    try {
      await updateBankTransactionDirection(companyId, selectedTx.id, directionDraft)
      const updatedAt = new Date().toISOString()
      setTransactions(prev => prev.map(tx => {
        if (tx.id !== selectedTx.id) return tx
        const amountAbs = Math.abs(Number(tx.amount || 0))
        const signedAmount = directionDraft === 'in' ? amountAbs : -amountAbs
        return {
          ...tx,
          amount: signedAmount,
          direction: directionDraft,
          direction_source: 'manual',
          direction_confidence: 1,
          direction_needs_review: false,
          direction_reason: 'Correzione manuale utente',
          direction_updated_at: updatedAt,
        }
      }))
      setSelectedTx((prev: any) => {
        if (!prev) return prev
        const amountAbs = Math.abs(Number(prev.amount || 0))
        const signedAmount = directionDraft === 'in' ? amountAbs : -amountAbs
        return {
          ...prev,
          amount: signedAmount,
          direction: directionDraft,
          direction_source: 'manual',
          direction_confidence: 1,
          direction_needs_review: false,
          direction_reason: 'Correzione manuale utente',
          direction_updated_at: updatedAt,
        }
      })
      setDirectionEditMode(false)
    } catch (e: any) {
      alert('Errore aggiornamento direzione: ' + e.message)
    }
    setDirectionSaving(false)
  }

  const finalizeImport = useCallback(async (
    filename: string,
    parseResult: BankParseResult,
    bankAccountId: string,
    selectedSummaryRows: BankTransaction[]
  ) => {
    if (!companyId) return

    const warnings = [...(parseResult.warnings || [])]
    const txToSave = [...parseResult.transactions, ...selectedSummaryRows]
    const batchId = await createImportBatch(companyId, filename)

    if (txToSave.length === 0) {
      const errs = parseResult.errors.length > 0
        ? parseResult.errors
        : ['Nessun movimento trovato.']
      const finalStats: BankImportStats = {
        ...parseResult.stats,
        dedup_db_count: 0,
        saved_count: 0,
      }
      await updateImportBatch(batchId, {
        total: 0,
        success: 0,
        errors: errs.length,
        error_details: {
          stats: finalStats,
          failed_chunks: parseResult.failedChunks || [],
          warnings,
          errors: errs,
          summary_candidates_count: parseResult.summaryCandidates.length,
          summary_selected_count: selectedSummaryRows.length,
        },
      })
      setImportResult({ saved: 0, duplicates: 0, dedup_db_count: 0, errors: errs, warnings, stats: finalStats })
      return
    }

    setImportProgress({ phase: 'saving', current: 0, total: txToSave.length, message: 'Salvataggio...' })
    const saveResult = await saveBankTransactions(
      companyId,
      bankAccountId,
      txToSave,
      batchId,
      (cur, tot) => setImportProgress({ phase: 'saving', current: cur, total: tot, message: `Salvataggio ${cur}/${tot}...` })
    )

    if (parseResult.statement?.closingBalance != null) {
      try {
        await updateBankAccountBalance(
          bankAccountId,
          Number(parseResult.statement.closingBalance),
          parseResult.statement.closingDate,
        )
      } catch (err: any) {
        warnings.push(`Saldo finale non aggiornato: ${err?.message || 'errore sconosciuto'}`)
      }
    }

    const finalStats: BankImportStats = {
      ...parseResult.stats,
      dedup_db_count: saveResult.dedup_db_count,
      saved_count: saveResult.saved,
    }
    const mergedErrors = [...saveResult.errors, ...parseResult.errors]
    await updateImportBatch(batchId, {
      total: txToSave.length,
      success: saveResult.saved,
      errors: mergedErrors.length,
      error_details: {
        stats: finalStats,
        failed_chunks: parseResult.failedChunks || [],
        warnings,
        errors: mergedErrors,
        summary_candidates_count: parseResult.summaryCandidates.length,
        summary_selected_count: selectedSummaryRows.length,
        statement: parseResult.statement || null,
      },
    })

    setImportResult({
      ...saveResult,
      errors: mergedErrors,
      warnings,
      stats: finalStats,
    })
    await loadData()
  }, [companyId, loadData])

  const handleSummaryConfirm = useCallback(async () => {
    if (!summaryReview) return
    setSummaryConfirming(true)
    setImporting(true)
    try {
      const selectedSummaryRows = summaryReview.items
        .filter((it) => it.include)
        .map(({ _id, include, ...tx }) => tx)

      await finalizeImport(
        summaryReview.filename,
        summaryReview.parseResult,
        summaryReview.bankAccountId,
        selectedSummaryRows,
      )
      setSummaryReview(null)
    } catch (e: any) {
      const emptyStats: BankImportStats = {
        raw_parsed_count: 0,
        dropped_missing_required_count: 0,
        dedup_edge_count: 0,
        dedup_client_count: 0,
        dedup_db_count: 0,
        saved_count: 0,
        failed_chunks_count: 0,
        warnings_count: 0,
        side_rule_count: 0,
        semantic_override_count: 0,
        unknown_side_count: 0,
        qc_fail_count: 0,
        summary_candidates_count: 0,
        llm_description_attempted_count: 0,
        llm_description_resolved_count: 0,
        counterparty_unknown_count: 0,
        counterparty_llm_attempted_count: 0,
        counterparty_llm_resolved_count: 0,
        counterparty_review_count: 0,
        llm_batch_fail_count: 0,
        raw_integrity_suspect_count: 0,
        raw_overlap_resolved_count: 0,
        raw_overlap_failed_count: 0,
      }
      setImportResult({ saved: 0, duplicates: 0, dedup_db_count: 0, errors: [e.message], warnings: [], stats: emptyStats })
    } finally {
      setSummaryConfirming(false)
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [finalizeImport, summaryReview])

  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files?.length || !companyId) return
    const file = files[0]
    const apiKey = getClaudeApiKey()
    if (!apiKey) { alert('Configura la chiave API Claude in Impostazioni.'); return }
    setImporting(true)
    setImportResult(null)
    setImportTxCount(0)
    setSummaryReview(null)

    try {
      const parseResult = await parseBankPdf(file, apiKey, companyId, (p) => { setImportProgress(p) })
      setImportTxCount(parseResult.transactions.length)

      const bankAccountId = await ensureBankAccount(companyId, { iban: undefined, bankName: 'Monte dei Paschi', accountHolder: undefined })

      if (parseResult.summaryCandidates.length > 0) {
        const items = parseResult.summaryCandidates.map((tx, idx) => ({
          ...tx,
          _id: `summary-${idx}-${tx.date}-${tx.amount}`,
          include: false,
        }))
        setSummaryReview({
          items,
          parseResult,
          bankAccountId,
          filename: file.name,
        })
        setImporting(false)
        return
      }

      await finalizeImport(file.name, parseResult, bankAccountId, [])
    } catch (e: any) {
      const emptyStats: BankImportStats = {
        raw_parsed_count: 0,
        dropped_missing_required_count: 0,
        dedup_edge_count: 0,
        dedup_client_count: 0,
        dedup_db_count: 0,
        saved_count: 0,
        failed_chunks_count: 0,
        warnings_count: 0,
        side_rule_count: 0,
        semantic_override_count: 0,
        unknown_side_count: 0,
        qc_fail_count: 0,
        summary_candidates_count: 0,
        llm_description_attempted_count: 0,
        llm_description_resolved_count: 0,
        counterparty_unknown_count: 0,
        counterparty_llm_attempted_count: 0,
        counterparty_llm_resolved_count: 0,
        counterparty_review_count: 0,
        llm_batch_fail_count: 0,
        raw_integrity_suspect_count: 0,
        raw_overlap_resolved_count: 0,
        raw_overlap_failed_count: 0,
      }
      setImportResult({ saved: 0, duplicates: 0, dedup_db_count: 0, errors: [e.message], warnings: [], stats: emptyStats })
    }
    setImporting(false)
    if (fileRef.current) fileRef.current.value = ''
  }, [companyId, finalizeImport])

  // Filters — AI candidateIds have absolute priority
  const filtered = transactions.filter(tx => {
    if (aiResult?.candidateIds?.length) {
      return aiResult.candidateIds.includes(tx.id)
    }

    const direction = txDirection(tx)
    if (dirFilter === 'in' && direction !== 'in') return false
    if (dirFilter === 'out' && direction !== 'out') return false
    if (dirFilter === 'review' && !tx.direction_needs_review && !tx.counterparty_needs_review) return false
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
    if (!companyId) {
      setAiResult({ text: 'Azienda non selezionata.', mode: 'analysis', isError: true })
      return
    }
    if (transactions.length === 0) {
      setAiResult({ text: "Nessun movimento disponibile per l'analisi AI.", mode: 'analysis', isError: true })
      return
    }
    setAiLoading(true); setAiResult(null)
    try {
      const payload: BankAiSearchRequest = {
        query,
        company_id: companyId,
        direction: dirFilter === 'in' || dirFilter === 'out' ? dirFilter : 'all',
        date_from: dateFrom || null,
        date_to: dateTo || null,
        limit: 50,
      }

      const result = await askBankAiSearch(payload)

      console.log('[Banca AI] raw result:', JSON.stringify({ mode: result.mode, hasFilter: !!result.filter, filter: result.filter, answer: result.answer?.slice(0, 80) }))

      // Filter mode: AI returned structured filter params → apply locally
      // Check both mode === 'filter' and presence of filter object (defensive)
      const isFilterMode = (result.mode === 'filter' || !!result.filter) && result.filter
      if (isFilterMode) {
        console.log('[Banca AI] filter mode:', result.filter)
        const f = result.filter!
        if (f.date_from) setDateFrom(f.date_from)
        if (f.date_to) setDateTo(f.date_to)
        if (f.direction === 'in' || f.direction === 'out') setDirFilter(f.direction)
        // Clear text query — AI has converted it to structured filters;
        // leaving it would cause the text filter to exclude all transactions
        setQuery('')
        // Show AI answer without candidateIds (let regular filters work)
        setAiResult({
          text: result.answer || 'Filtri applicati.',
          mode: 'analysis',
          isError: false,
          requestId: result.request_id,
          candidateIds: [], // empty = use regular filters
        })
      } else {
        // Analysis mode: use candidateIds as before
        console.log('AI result candidate_ids:', result.candidate_ids)
        const scopeLine = `\n\nScope AI: ${Number(result.candidate_count || 0)} candidati · ${(result.candidate_ids || []).length} pertinenti` +
          ` · mode: ${result.mode || 'n/d'}` +
          `${result.model ? ` · modello: ${result.model}` : ''}` +
          `${result.request_id ? ` · request: ${result.request_id}` : ''}`
        setAiResult({
          text: `${result.answer || 'Nessuna risposta AI.'}${scopeLine}`,
          mode: 'analysis',
          isError: false,
          requestId: result.request_id,
          candidateIds: result.candidate_ids || [],
        })
      }
    } catch (e: any) {
      const err = e as BankAiErrorPayload
      const reason = String(err?.message || 'Errore AI non disponibile').trim()
      const statusLine = err?.status ? `HTTP ${err.status}` : 'HTTP n.d.'
      const codeLine = err?.errorCode ? `\nCodice: ${err.errorCode}` : ''
      const reqLine = err?.requestId ? ` · request: ${err.requestId}` : ''
      const hintLine = err?.hint ? `\nSuggerimento: ${err.hint}` : ''
      console.error('[Banca AI] bank-ai-search failed', {
        company_id: companyId,
        operation: 'bank-ai-search',
        error_code: err?.errorCode,
        code: statusLine,
        details: reason,
        request_id: err?.requestId,
      })
      setAiResult({
        text: `Errore ricerca AI remota.\n${statusLine}${reqLine}${codeLine}\nDettaglio: ${reason}${hintLine}\nUsa "Riprova" per rilanciare la richiesta.`,
        mode: 'analysis',
        isError: true,
        requestId: err?.requestId,
      })

    }
    setAiLoading(false)
  }

  // KPI su dati filtrati
  const totalIn = filtered
    .filter(t => txDirection(t) === 'in')
    .reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
  const totalOut = filtered
    .filter(t => txDirection(t) === 'out')
    .reduce((s, t) => s + Math.abs(Number(t.amount || 0)), 0)
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
              💡 Clicca su un movimento per i dettagli · Doppio click per correzione direzione · Ctrl/Cmd+click per selezione multipla
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
              importResult.saved === 0 && importResult.errors.length > 0
                ? 'bg-red-50 border-red-200'
                : (importResult.warnings.length > 0 || importResult.stats.warnings_count > 0 || importResult.stats.failed_chunks_count > 0)
                  ? 'bg-amber-50 border-amber-200'
                  : 'bg-emerald-50 border-emerald-200'
            }`}>
              {importResult.saved === 0 && importResult.errors.length > 0
                ? <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
                : (importResult.warnings.length > 0 || importResult.stats.warnings_count > 0 || importResult.stats.failed_chunks_count > 0)
                  ? <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  : <CheckCircle className="h-4 w-4 text-emerald-600 flex-shrink-0 mt-0.5" />}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">
                  {importResult.saved > 0 ? `✓ ${importResult.saved} movimenti importati` : 'Import fallito'}
                  {importResult.dedup_db_count > 0 && ` · ${importResult.dedup_db_count} duplicati DB ignorati`}
                </p>
                <div className="text-xs text-gray-600 mt-1">
                  Estratti: {importResult.stats.raw_parsed_count} ·
                  Scartati (campi obbligatori): {importResult.stats.dropped_missing_required_count} ·
                  Deduplica edge/client: {importResult.stats.dedup_edge_count + importResult.stats.dedup_client_count} ·
                  Deduplica DB: {importResult.stats.dedup_db_count} ·
                  Salvati: {importResult.stats.saved_count}
                </div>
                {(importResult.stats.side_rule_count > 0 ||
                  importResult.stats.semantic_override_count > 0 ||
                  importResult.stats.unknown_side_count > 0 ||
                  importResult.stats.qc_fail_count > 0) && (
                  <div className="text-xs text-gray-600 mt-1">
                    Side-rule: {importResult.stats.side_rule_count} ·
                    Override semantico: {importResult.stats.semantic_override_count} ·
                    Unknown side: {importResult.stats.unknown_side_count} ·
                    QC fail: {importResult.stats.qc_fail_count} ·
                    Summary candidati: {importResult.stats.summary_candidates_count}
                  </div>
                )}
                {(importResult.stats.llm_description_attempted_count > 0 ||
                  importResult.stats.llm_description_resolved_count > 0 ||
                  importResult.stats.counterparty_unknown_count > 0 ||
                  importResult.stats.counterparty_llm_attempted_count > 0 ||
                  importResult.stats.counterparty_llm_resolved_count > 0 ||
                  importResult.stats.counterparty_review_count > 0 ||
                  importResult.stats.llm_batch_fail_count > 0) && (
                  <div className="text-xs text-gray-600 mt-1">
                    Descr. LLM tentate: {importResult.stats.llm_description_attempted_count} ·
                    Descr. LLM risolte: {importResult.stats.llm_description_resolved_count} ·
                    Controparte unknown: {importResult.stats.counterparty_unknown_count} ·
                    LLM tentati: {importResult.stats.counterparty_llm_attempted_count} ·
                    LLM risolti: {importResult.stats.counterparty_llm_resolved_count} ·
                    Da verificare: {importResult.stats.counterparty_review_count} ·
                    LLM batch fail: {importResult.stats.llm_batch_fail_count}
                  </div>
                )}
                {(importResult.stats.raw_integrity_suspect_count > 0 ||
                  importResult.stats.raw_overlap_resolved_count > 0 ||
                  importResult.stats.raw_overlap_failed_count > 0) && (
                  <div className="text-xs text-gray-600 mt-1">
                    Raw suspect: {importResult.stats.raw_integrity_suspect_count} ·
                    Overlap risolti: {importResult.stats.raw_overlap_resolved_count} ·
                    Overlap falliti: {importResult.stats.raw_overlap_failed_count}
                  </div>
                )}
                {(importResult.stats.failed_chunks_count > 0 || importResult.stats.warnings_count > 0) && (
                  <div className="text-xs text-amber-700 mt-1">
                    Chunk falliti: {importResult.stats.failed_chunks_count} · Warning: {importResult.stats.warnings_count}
                  </div>
                )}
                {importResult.warnings.length > 0 && (
                  <ul className="text-xs text-amber-700 mt-1 space-y-0.5">
                    {importResult.warnings.slice(0, 4).map((w, i) => <li key={`w-${i}`}>• {w}</li>)}
                    {importResult.warnings.length > 4 && <li>...e altri {importResult.warnings.length - 4} warning</li>}
                  </ul>
                )}
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

          {embeddingHealth && (
            <div className="text-xs text-slate-500">
              Indicizzazione AI: pronti {embeddingHealth.ready_rows}/{embeddingHealth.total_rows}
              {embeddingHealth.pending_rows > 0 ? ` · pending ${embeddingHealth.pending_rows}` : ''}
              {embeddingHealth.processing_rows > 0 ? ` · processing ${embeddingHealth.processing_rows}` : ''}
              {embeddingHealth.error_rows > 0 ? ` · error ${embeddingHealth.error_rows}` : ''}
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
                      aiResult ? (aiResult.isError ? 'border-red-300 focus:ring-red-400 bg-red-50' : 'border-purple-300 focus:ring-purple-400 bg-purple-50') : 'border-gray-200 focus:ring-sky-500'
                    }`}
                  />
                  {query && <button className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600" onClick={() => { setQuery(''); setAiResult(null) }}><X className="h-3.5 w-3.5" /></button>}
                </div>
                {(['all', 'in', 'out', 'review'] as const).map(d => (
                  <button key={d} onClick={() => setDirFilter(d)}
                    className={`px-2.5 py-1.5 text-xs rounded-md font-medium border transition-all ${
                      dirFilter === d ? 'bg-sky-600 text-white border-sky-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                    {d === 'all' ? 'Tutti' : d === 'in' ? '↑ Entrate' : d === 'out' ? '↓ Uscite' : 'Da verificare'}
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
                <div className={`flex items-start gap-2 p-3 rounded-lg border ${
                  aiResult.isError ? 'bg-red-50 border-red-200' : 'bg-purple-50 border-purple-100'
                }`}>
                  <Sparkles className={`h-3.5 w-3.5 flex-shrink-0 mt-0.5 ${aiResult.isError ? 'text-red-500' : 'text-purple-500'}`} />
                  <p className={`flex-1 text-xs whitespace-pre-wrap ${aiResult.isError ? 'text-red-900' : 'text-purple-900'}`}>{aiResult.text}</p>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {aiResult.isError && (
                      <Button variant="outline" size="sm" onClick={handleAiSearch} disabled={aiLoading}>
                        {aiLoading ? 'Riprovo...' : 'Riprova'}
                      </Button>
                    )}
                    <button
                      onClick={() => setAiResult(null)}
                      className={`${aiResult.isError ? 'text-red-300 hover:text-red-500' : 'text-purple-300 hover:text-purple-500'} flex-shrink-0`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
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
                      onClick={(e) => handleRowClick(tx, e)}
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
          <BankTxDetail
            tx={selectedTx}
            onClose={() => { setSelectedTx(null); setDirectionEditMode(false) }}
            editable
            directionEditMode={directionEditMode}
            directionDraft={directionDraft}
            directionSaving={directionSaving}
            onDirectionDraftChange={setDirectionDraft}
            onDirectionSave={handleSaveDirection}
            onEnableDirectionEdit={() => {
              setDirectionDraft(txDirection(selectedTx))
              setDirectionEditMode(true)
            }}
          />
        </div>
      )}

      {summaryReview && (
        <SummaryReviewModal
          items={summaryReview.items}
          onToggle={(id) => {
            if (summaryConfirming) return
            setSummaryReview((prev) => {
              if (!prev) return prev
              return {
                ...prev,
                items: prev.items.map((it) => it._id === id ? { ...it, include: !it.include } : it),
              }
            })
          }}
          onDiscardAll={() => {
            if (summaryConfirming) return
            setSummaryReview((prev) => {
              if (!prev) return prev
              return { ...prev, items: prev.items.map((it) => ({ ...it, include: false })) }
            })
          }}
          onConfirm={handleSummaryConfirm}
          onCancel={() => {
            if (summaryConfirming) return
            setSummaryReview(null)
            setImporting(false)
            if (fileRef.current) fileRef.current.value = ''
          }}
          saving={summaryConfirming}
        />
      )}

      {deleteModal && (
        <DeleteModal mode={deleteModal.mode} count={selectedIds.size}
          onConfirm={handleDelete} onCancel={() => !deleting && setDeleteModal(null)} />
      )}
    </div>
  )
}
