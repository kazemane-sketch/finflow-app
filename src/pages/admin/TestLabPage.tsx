// src/pages/admin/TestLabPage.tsx
// Sandbox Test Lab — tests agents on uploaded XML invoices
// PRIVACY: Everything in useState, nothing saved to DB, no access to user data

import { useState, useEffect, useRef, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase, SUPABASE_URL } from '@/integrations/supabase/client'
import { processInvoiceFile, TIPO } from '@/lib/invoiceParser'
import type { ParsedInvoice } from '@/lib/invoiceParser'
import { toast } from 'sonner'
import {
  FlaskConical, Upload, X, Play, Loader2, Clock, ChevronDown,
  ChevronUp, Copy, RotateCcw, AlertTriangle, Info, Zap,
  FileText, Brain, Eye
} from 'lucide-react'

/* ─── Types ──────────────────────────── */
interface AgentResult {
  prompt_sent: string
  thinking: string
  raw_response: string
  parsed_result: ClassificationResult[]
  model_used: string
  thinking_level: string
  timing_ms: number
  prompt_tokens_est: number
  response_tokens_est: number
  estimated_cost_usd: number
  error?: string
}

interface ClassificationResult {
  line_id: string
  account_suggestion?: string
  account_section?: string
  category_suggestion?: string
  article_suggestion?: string | null
  cost_center_hint?: string | null
  confidence?: number
  reasoning?: string
  fiscal_flags?: FiscalFlags
  alerts?: Alert[]
}

interface FiscalFlags {
  deducibilita_pct?: number
  iva_detraibilita_pct?: number
  ritenuta_acconto?: { aliquota: number; base: string } | null
  reverse_charge?: boolean
  split_payment?: boolean
  bene_strumentale?: boolean
  note?: string | null
}

interface Alert {
  type: string
  severity: 'warning' | 'info'
  title: string
  description: string
  options?: string[]
}

interface TestResponse {
  agents: Record<string, AgentResult>
  knowledge_rules_used: { id: string; domain: string; title: string; priority: number }[]
  agent_rules_used: { title: string; sort_order: number }[]
}

/* ─── Sector options ─────────────────── */
const SECTORS = [
  { value: 'estrazione_cave', label: 'Estrazione cave' },
  { value: 'costruzioni', label: 'Costruzioni' },
  { value: 'trasporti', label: 'Trasporti' },
  { value: 'commercio', label: 'Commercio' },
  { value: 'ristorazione', label: 'Ristorazione' },
  { value: 'servizi_professionali', label: 'Servizi professionali' },
  { value: 'manifattura', label: 'Manifattura' },
  { value: 'agricoltura', label: 'Agricoltura' },
  { value: 'altro', label: 'Altro' },
]

const COUNTERPARTY_LEGAL_TYPES = [
  { value: '', label: 'Non specificato' },
  { value: 'srl', label: 'SRL' },
  { value: 'spa', label: 'SPA' },
  { value: 'persona_fisica', label: 'Persona fisica' },
  { value: 'studio_associato', label: 'Studio associato' },
  { value: 'pa', label: 'PA' },
  { value: 'altro', label: 'Altro' },
]

/* ─── Confidence badge ───────────────── */
function ConfBadge({ value }: { value: number }) {
  const cls =
    value >= 75 ? 'bg-green-100 text-green-700' :
    value >= 60 ? 'bg-amber-100 text-amber-700' :
    'bg-red-100 text-red-700'
  return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{value}%</span>
}

/* ─── Copyable text block ────────────── */
function CopyBlock({ label, icon, text }: { label: string; icon: React.ReactNode; text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    toast.success('Copiato negli appunti')
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-600 flex items-center gap-1">{icon} {label}</span>
        <button onClick={handleCopy} className="text-[10px] text-sky-600 hover:text-sky-800 flex items-center gap-0.5">
          <Copy className="h-3 w-3" /> {copied ? 'Copiato!' : 'Copia'}
        </button>
      </div>
      <pre className="font-mono text-[11px] bg-slate-50 rounded-lg p-3 max-h-96 overflow-y-auto whitespace-pre-wrap border text-slate-700">
        {text || '(vuoto)'}
      </pre>
    </div>
  )
}

/* ═══════════════════════════════════════ */
export default function TestLabPage() {
  // Section 1: File upload
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<ParsedInvoice | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Section 2: Context
  const [testContext, setTestContext] = useState({
    company_ateco: '08.11.00',
    company_sector: 'estrazione_cave',
    company_name: 'Test Company',
    counterparty_ateco: '',
    counterparty_legal_type: '',
  })
  const [direction, setDirection] = useState<'in' | 'out'>('in')

  // Section 3: Loading
  const [loading, setLoading] = useState(false)
  const [loadingAgent, setLoadingAgent] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)

  // Section 4: Results
  const [results, setResults] = useState<TestResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<string>('commercialista')

  // Details toggle per agent
  const [showDetails, setShowDetails] = useState<Record<string, boolean>>({})

  // Live timer
  useEffect(() => {
    if (!loading) return
    const start = Date.now()
    const interval = setInterval(() => setElapsedMs(Date.now() - start), 100)
    return () => clearInterval(interval)
  }, [loading])

  // Drag/drop handlers
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleFileDrop = useCallback(async (f: File) => {
    setFile(f)
    setResults(null)
    setError(null)
    setParseError(null)
    setParsed(null)
    try {
      const parseResults = await processInvoiceFile(f)
      const ok = parseResults.find((r: any) => !r.err && r.data)
      if (!ok) throw new Error((parseResults[0] as any)?.err || 'Parsing XML fallito')
      setParsed((ok as any).data)
      // Determine direction: if cedente P.IVA != our test context, it's a received (passive) invoice
      setDirection('in')
    } catch (e: any) {
      setParseError(e.message)
    }
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer.files?.[0]
    if (f) handleFileDrop(f)
  }, [handleFileDrop])

  const handleFileInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) handleFileDrop(f)
  }, [handleFileDrop])

  // Run agent
  const runAgent = async (agentType: 'commercialista' | 'consulente' | 'both') => {
    if (!parsed) return
    setLoading(true)
    setLoadingAgent(agentType === 'both' ? 'commercialista' : agentType)
    setResults(null)
    setError(null)
    setElapsedMs(0)

    const body = parsed.bodies?.[0]
    if (!body) { setError('Nessun body nella fattura'); setLoading(false); return }

    const lines = body.linee.map((l, i) => ({
      line_id: `test-${i + 1}`,
      description: l.descrizione || '',
      quantity: parseFloat(l.quantita) || 1,
      unit_price: parseFloat(l.prezzoUnitario) || 0,
      total_price: parseFloat(l.prezzoTotale) || 0,
      vat_rate: parseFloat(l.aliquotaIVA) || 0,
      vat_nature: l.natura || '',
    }))

    const cp = direction === 'in' ? parsed.ced : parsed.ces

    const { data: { session } } = await supabase.auth.getSession()
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-test-classify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          agent_type: agentType,
          test_context: testContext,
          invoice_data: {
            direction,
            doc_type: body.tipo || 'TD01',
            counterparty_name: cp?.denom || '',
            counterparty_vat: cp?.piva || '',
            counterparty_ateco: testContext.counterparty_ateco,
            counterparty_legal_type: testContext.counterparty_legal_type,
            total_amount: parseFloat(body.totale) || 0,
            notes: body.causali?.join(' | ') || '',
          },
          lines,
        }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
      const data: TestResponse = await res.json()
      setResults(data)
      // Set active tab to first available agent
      const agents = Object.keys(data.agents)
      if (agents.length > 0) setActiveTab(agents[0])
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
    setLoadingAgent(null)
  }

  // Reset all
  const handleReset = () => {
    setFile(null)
    setParsed(null)
    setParseError(null)
    setResults(null)
    setError(null)
    setLoading(false)
    setLoadingAgent(null)
    setShowDetails({})
    setTestContext(c => ({ ...c, counterparty_ateco: '', counterparty_legal_type: '' }))
    if (fileRef.current) fileRef.current.value = ''
  }

  // Helpers
  const body0 = parsed?.bodies?.[0]
  const cp = parsed ? (direction === 'in' ? parsed.ced : parsed.ces) : null

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FlaskConical className="h-6 w-6 text-purple-600" /> Test Lab
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Sandbox isolata — testa gli agent su fatture XML senza accedere a dati utente
          </p>
        </div>
        {(file || parsed || results) && (
          <Button variant="outline" size="sm" onClick={handleReset}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
        )}
      </div>

      {/* ─── Section 1: Upload ─────────────── */}
      {!parsed && !parseError && (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          className="border-2 border-dashed rounded-xl p-12 text-center cursor-pointer transition-colors hover:border-purple-400 hover:bg-purple-50/30 border-slate-300"
        >
          <Upload className="h-10 w-10 text-slate-400 mx-auto mb-3" />
          <p className="text-sm font-medium text-slate-700">
            Trascina una fattura XML o P7M qui
          </p>
          <p className="text-xs text-slate-400 mt-1">oppure clicca per sfogliare</p>
          <input
            ref={fileRef}
            type="file"
            accept=".xml,.p7m"
            className="hidden"
            onChange={handleFileInput}
          />
        </div>
      )}

      {parseError && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Errore parsing fattura</p>
            <p className="text-xs text-red-600 mt-1">{parseError}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={handleReset}>
              Riprova
            </Button>
          </div>
        </div>
      )}

      {/* ─── Section 2: Parsed data + context ── */}
      {parsed && body0 && (
        <>
          {/* Invoice data card */}
          <div className="border rounded-lg bg-white p-4 space-y-4">
            <div className="flex items-center gap-2 mb-1">
              <FileText className="h-4 w-4 text-slate-500" />
              <h2 className="text-sm font-bold text-slate-800">Dati fattura estratti</h2>
              <span className="text-[10px] text-slate-400 ml-auto">{file?.name}</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <span className="text-slate-400">Tipo doc</span>
                <p className="font-medium">{body0.tipo} — {TIPO[body0.tipo] || '?'}</p>
              </div>
              <div>
                <span className="text-slate-400">Direzione</span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <button
                    onClick={() => setDirection('in')}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${direction === 'in' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >
                    Passiva
                  </button>
                  <button
                    onClick={() => setDirection('out')}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${direction === 'out' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                  >
                    Attiva
                  </button>
                </div>
              </div>
              <div>
                <span className="text-slate-400">Controparte</span>
                <p className="font-medium">{cp?.denom || '—'}</p>
                <p className="text-[10px] text-slate-400">{cp?.piva || ''}</p>
              </div>
              <div>
                <span className="text-slate-400">Totale</span>
                <p className="font-medium">€ {parseFloat(body0.totale).toLocaleString('it-IT', { minimumFractionDigits: 2 })}</p>
                <p className="text-[10px] text-slate-400">{body0.data}</p>
              </div>
            </div>

            {/* Lines table */}
            {body0.linee.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 text-left text-slate-500">
                    <tr>
                      <th className="px-2 py-1.5 w-8">#</th>
                      <th className="px-2 py-1.5">Descrizione</th>
                      <th className="px-2 py-1.5 w-16 text-right">Qtà</th>
                      <th className="px-2 py-1.5 w-20 text-right">Prezzo un.</th>
                      <th className="px-2 py-1.5 w-16 text-right">IVA%</th>
                      <th className="px-2 py-1.5 w-16">Natura</th>
                      <th className="px-2 py-1.5 w-20 text-right">Totale</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {body0.linee.map((l, i) => (
                      <tr key={i} className="hover:bg-slate-50/50">
                        <td className="px-2 py-1.5 text-slate-400">{l.numero || i + 1}</td>
                        <td className="px-2 py-1.5 text-slate-800 max-w-xs truncate" title={l.descrizione}>{l.descrizione}</td>
                        <td className="px-2 py-1.5 text-right">{l.quantita || '—'}</td>
                        <td className="px-2 py-1.5 text-right">{l.prezzoUnitario || '—'}</td>
                        <td className="px-2 py-1.5 text-right">{l.aliquotaIVA || '0'}</td>
                        <td className="px-2 py-1.5 text-slate-500">{l.natura || '—'}</td>
                        <td className="px-2 py-1.5 text-right font-medium">{parseFloat(l.prezzoTotale || '0').toLocaleString('it-IT', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Test context card */}
          <div className="border rounded-lg bg-white p-4 space-y-3">
            <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
              <Zap className="h-4 w-4 text-amber-500" /> Contesto di test
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Codice ATECO</Label>
                <Input
                  value={testContext.company_ateco}
                  onChange={e => setTestContext(c => ({ ...c, company_ateco: e.target.value }))}
                  className="mt-1 h-8 text-sm"
                  placeholder="08.11.00"
                />
              </div>
              <div>
                <Label className="text-xs">Settore</Label>
                <select
                  value={testContext.company_sector}
                  onChange={e => setTestContext(c => ({ ...c, company_sector: e.target.value }))}
                  className="mt-1 w-full h-8 border rounded-md px-2 text-sm"
                >
                  {SECTORS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs">Nome azienda test</Label>
                <Input
                  value={testContext.company_name}
                  onChange={e => setTestContext(c => ({ ...c, company_name: e.target.value }))}
                  className="mt-1 h-8 text-sm"
                  placeholder="Test Company"
                />
              </div>
              <div>
                <Label className="text-xs">ATECO controparte</Label>
                <Input
                  value={testContext.counterparty_ateco}
                  onChange={e => setTestContext(c => ({ ...c, counterparty_ateco: e.target.value }))}
                  className="mt-1 h-8 text-sm"
                  placeholder="es. 69.10.00 (lascia vuoto se non rilevante)"
                />
              </div>
              <div>
                <Label className="text-xs">Tipo legale controparte</Label>
                <select
                  value={testContext.counterparty_legal_type}
                  onChange={e => setTestContext(c => ({ ...c, counterparty_legal_type: e.target.value }))}
                  className="mt-1 w-full h-8 border rounded-md px-2 text-sm"
                >
                  {COUNTERPARTY_LEGAL_TYPES.map(type => (
                    <option key={type.value || 'unspecified'} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Action buttons */}
          {!loading && (
            <div className="flex flex-wrap gap-3">
              <Button onClick={() => runAgent('commercialista')} className="bg-blue-600 hover:bg-blue-700">
                <Play className="h-3.5 w-3.5 mr-1.5" /> Commercialista
              </Button>
              <Button variant="outline" onClick={() => runAgent('consulente')}>
                <Play className="h-3.5 w-3.5 mr-1.5" /> Consulente AI
              </Button>
              <Button onClick={() => runAgent('both')} className="bg-purple-600 hover:bg-purple-700">
                <Play className="h-3.5 w-3.5 mr-1.5" /> Entrambi (chain)
              </Button>
            </div>
          )}
        </>
      )}

      {/* ─── Section 3: Loading ────────────── */}
      {loading && (
        <div className="border rounded-lg bg-white p-8 text-center space-y-3">
          <Loader2 className="h-8 w-8 animate-spin text-purple-500 mx-auto" />
          <p className="text-sm font-medium text-slate-700">
            Agent <span className="text-purple-600 font-bold">{loadingAgent}</span> in esecuzione...
          </p>
          <div className="flex items-center justify-center gap-1.5 text-xs text-slate-400">
            <Clock className="h-3.5 w-3.5" />
            {(elapsedMs / 1000).toFixed(1)}s
          </div>
        </div>
      )}

      {/* ─── Section 4: Results ────────────── */}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-800">Errore esecuzione</p>
            <p className="text-xs text-red-600 mt-1 break-all">{error}</p>
          </div>
        </div>
      )}

      {results && (
        <div className="space-y-4">
          {/* Tab bar if multiple agents */}
          {Object.keys(results.agents).length > 1 && (
            <div className="flex border-b">
              {Object.keys(results.agents).map(key => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors capitalize ${
                    activeTab === key
                      ? 'border-purple-600 text-purple-700'
                      : 'border-transparent text-slate-500 hover:text-slate-700'
                  }`}
                >
                  {key === 'commercialista' ? '📊 Commercialista' : '💼 Consulente AI'}
                </button>
              ))}
            </div>
          )}

          {/* Active agent results */}
          {(() => {
            const agent = results.agents[activeTab]
            if (!agent) return null
            if (agent.error) return (
              <div className="bg-red-50 rounded-lg p-4 text-sm text-red-700">{agent.error}</div>
            )
            const isConsulente = activeTab === 'consulente'

            return (
              <div className="space-y-4">
                {/* 4a. Classification table */}
                <div className="border rounded-lg bg-white overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 border-b flex items-center gap-2">
                    <Brain className="h-4 w-4 text-purple-500" />
                    <h3 className="text-sm font-bold text-slate-800">
                      {isConsulente ? 'Consulenza fiscale' : 'Classificazione'}
                    </h3>
                    <span className="text-[10px] text-slate-400 ml-auto">
                      {agent.parsed_result?.length || 0} righe
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead className="bg-slate-50/50 text-left text-slate-500">
                        <tr>
                          <th className="px-3 py-2 w-8">#</th>
                          <th className="px-3 py-2">Descrizione</th>
                          {!isConsulente && (
                            <>
                              <th className="px-3 py-2">Conto suggerito</th>
                              <th className="px-3 py-2 w-28">Sezione</th>
                              <th className="px-3 py-2">Categoria</th>
                            </>
                          )}
                          {isConsulente && (
                            <>
                              <th className="px-3 py-2">Deducibilità</th>
                              <th className="px-3 py-2">IVA detr.</th>
                              <th className="px-3 py-2">Flags</th>
                            </>
                          )}
                          <th className="px-3 py-2 w-14 text-center">Conf.</th>
                          <th className="px-3 py-2">Reasoning</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {(agent.parsed_result || []).map((r, i) => {
                          const line = body0?.linee.find((_, idx) => `test-${idx + 1}` === r.line_id)
                          return (
                            <tr key={r.line_id} className="hover:bg-slate-50/50">
                              <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                              <td className="px-3 py-2 text-slate-800 max-w-[200px] truncate" title={line?.descrizione}>
                                {(line?.descrizione || '').slice(0, 40)}{(line?.descrizione || '').length > 40 ? '...' : ''}
                              </td>
                              {!isConsulente && (
                                <>
                                  <td className="px-3 py-2 font-medium text-slate-800">{r.account_suggestion || '—'}</td>
                                  <td className="px-3 py-2">
                                    {r.account_section && (
                                      <span className="text-[9px] bg-slate-100 text-slate-600 px-1 py-0.5 rounded">
                                        {r.account_section}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3 py-2 text-slate-600">{r.category_suggestion || '—'}</td>
                                </>
                              )}
                              {isConsulente && (
                                <>
                                  <td className="px-3 py-2 font-medium">
                                    {r.fiscal_flags?.deducibilita_pct != null ? `${r.fiscal_flags.deducibilita_pct}%` : '—'}
                                  </td>
                                  <td className="px-3 py-2 font-medium">
                                    {r.fiscal_flags?.iva_detraibilita_pct != null ? `${r.fiscal_flags.iva_detraibilita_pct}%` : '—'}
                                  </td>
                                  <td className="px-3 py-2">
                                    <div className="flex flex-wrap gap-0.5">
                                      {r.fiscal_flags?.reverse_charge && <span className="text-[9px] bg-orange-100 text-orange-700 px-1 rounded">RC</span>}
                                      {r.fiscal_flags?.split_payment && <span className="text-[9px] bg-orange-100 text-orange-700 px-1 rounded">Split</span>}
                                      {r.fiscal_flags?.bene_strumentale && <span className="text-[9px] bg-sky-100 text-sky-700 px-1 rounded">B.Strum.</span>}
                                      {r.fiscal_flags?.ritenuta_acconto && <span className="text-[9px] bg-red-100 text-red-700 px-1 rounded">Rit.{r.fiscal_flags.ritenuta_acconto.aliquota}%</span>}
                                    </div>
                                  </td>
                                </>
                              )}
                              <td className="px-3 py-2 text-center">
                                <ConfBadge value={r.confidence ?? 0} />
                              </td>
                              <td className="px-3 py-2 text-[10px] text-slate-500 max-w-[250px]">
                                {r.reasoning || '—'}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Fiscal flags for commercialista rows */}
                  {!isConsulente && (agent.parsed_result || []).some(r => r.fiscal_flags) && (
                    <div className="px-4 py-2.5 border-t bg-amber-50/50 space-y-1">
                      <p className="text-[10px] font-semibold text-amber-700 mb-1">🏛 Indicazioni fiscali</p>
                      {(agent.parsed_result || []).filter(r => r.fiscal_flags).map(r => (
                        <div key={r.line_id} className="text-[10px] text-amber-800 flex flex-wrap gap-2">
                          <span className="font-medium">{r.line_id}:</span>
                          <span>Deduc. {r.fiscal_flags?.deducibilita_pct ?? '?'}%</span>
                          <span>IVA detr. {r.fiscal_flags?.iva_detraibilita_pct ?? '?'}%</span>
                          {r.fiscal_flags?.reverse_charge && <span className="text-orange-700">Reverse Charge</span>}
                          {r.fiscal_flags?.split_payment && <span className="text-orange-700">Split Payment</span>}
                          {r.fiscal_flags?.bene_strumentale && <span className="text-sky-700">Bene strumentale</span>}
                          {r.fiscal_flags?.ritenuta_acconto && <span className="text-red-700">Ritenuta {r.fiscal_flags.ritenuta_acconto.aliquota}%</span>}
                          {r.fiscal_flags?.note && <span className="italic">{r.fiscal_flags.note}</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 4b. Alerts (consulente) */}
                {isConsulente && (agent.parsed_result || []).some(r => r.alerts?.length) && (
                  <div className="space-y-2">
                    <h3 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-500" /> Alert fiscali
                    </h3>
                    {(agent.parsed_result || []).flatMap((r) =>
                      (r.alerts || []).map((a, ai) => (
                        <div key={`${r.line_id}-${ai}`} className={`border rounded-lg p-3 ${a.severity === 'warning' ? 'bg-amber-50 border-amber-200' : 'bg-blue-50 border-blue-200'}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${a.severity === 'warning' ? 'bg-amber-200 text-amber-800' : 'bg-blue-200 text-blue-800'}`}>
                              {a.severity === 'warning' ? '⚠ Warning' : 'ℹ Info'}
                            </span>
                            <span className="text-xs text-slate-400">Riga {r.line_id}</span>
                          </div>
                          <p className="text-sm font-semibold text-slate-800">{a.title}</p>
                          <p className="text-xs text-slate-600 mt-0.5">{a.description}</p>
                          {a.options && a.options.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">
                              {a.options.map((opt, oi) => (
                                <span key={oi} className="text-[10px] bg-white border rounded px-1.5 py-0.5 text-slate-600">{opt}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* 4c. Technical details (collapsible) */}
                <div className="border rounded-lg bg-white">
                  <button
                    onClick={() => setShowDetails(d => ({ ...d, [activeTab]: !d[activeTab] }))}
                    className="w-full px-4 py-3 flex items-center justify-between hover:bg-slate-50/50 transition-colors"
                  >
                    <span className="text-sm font-medium text-slate-700 flex items-center gap-2">
                      <Eye className="h-4 w-4 text-slate-400" /> Dettagli tecnici
                    </span>
                    {showDetails[activeTab]
                      ? <ChevronUp className="h-4 w-4 text-slate-400" />
                      : <ChevronDown className="h-4 w-4 text-slate-400" />
                    }
                  </button>
                  {showDetails[activeTab] && (
                    <div className="px-4 pb-4 border-t space-y-4">
                      {/* Stats row */}
                      <div className="flex flex-wrap gap-4 py-3 text-xs text-slate-600">
                        <span>⏱ <strong>{agent.timing_ms}</strong>ms</span>
                        <span>🎯 <strong>{agent.model_used}</strong></span>
                        <span>💭 thinking: <strong>{agent.thinking_level}</strong></span>
                        <span>📊 ~<strong>{agent.prompt_tokens_est}</strong> in / ~<strong>{agent.response_tokens_est}</strong> out</span>
                        <span>💰 ~<strong>${agent.estimated_cost_usd?.toFixed(4)}</strong></span>
                        <span>📚 <strong>{results.knowledge_rules_used?.length || 0}</strong> regole KB</span>
                        <span>📜 <strong>{results.agent_rules_used?.length || 0}</strong> agent rules</span>
                      </div>

                      {/* KB rules used */}
                      {results.knowledge_rules_used?.length > 0 && (
                        <div>
                          <p className="text-[10px] font-semibold text-slate-500 mb-1">Regole KB caricate nella prompt:</p>
                          <div className="flex flex-wrap gap-1">
                            {results.knowledge_rules_used.map(r => (
                              <span key={r.id} className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded border border-purple-200">
                                [{r.domain}] {r.title} (P{r.priority})
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      <CopyBlock label="Prompt inviata" icon={<Copy className="h-3 w-3" />} text={agent.prompt_sent} />
                      <CopyBlock
                        label="Thinking AI"
                        icon={<Brain className="h-3 w-3" />}
                        text={agent.thinking || '(Nessun thinking)'}
                      />
                      <CopyBlock label="Risposta grezza" icon={<FileText className="h-3 w-3" />} text={agent.raw_response} />
                    </div>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
