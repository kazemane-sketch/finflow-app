import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useCompany } from '@/hooks/useCompany'
import {
  loadArticles, createArticle, updateArticle, deleteArticle,
  loadArticleStats, loadArticleLines, loadUnassignedLines, loadDashboardStats,
  loadCategories, matchLineToArticle, extractLocation, assignArticleToLine,
  removeLineAssignment, recordAssignmentFeedback, suggestKeywords,
  type Article, type ArticleCreate, type ArticleStats, type ArticleLineRow,
  type UnassignedLine, type MatchResult, type DashboardArticleRow,
} from '@/lib/articlesService'
import { supabase } from '@/integrations/supabase/client'
import { fmtDate, fmtEur, fmtNum } from '@/lib/utils'
import { toast } from 'sonner'
import {
  Package, Plus, Search, Loader2, Trash2, Save, X, Check,
  XCircle, RefreshCw, Zap, BarChart3, Tag, ChevronRight,
  CheckCircle2, AlertTriangle, Sparkles, Filter,
} from 'lucide-react'
import {
  ResponsiveContainer, BarChart, CartesianGrid, XAxis, YAxis,
  Tooltip, Bar, Legend,
} from 'recharts'

/* ─── constants ──────────────────────────────── */

const UNIT_OPTIONS = [
  { value: 't', label: 'Tonnellate (t)' },
  { value: 'kg', label: 'Chilogrammi (kg)' },
  { value: 'm3', label: 'Metri cubi (m³)' },
  { value: 'pz', label: 'Pezzi (pz)' },
  { value: 'ore', label: 'Ore' },
  { value: 'forfait', label: 'Forfait' },
]

const DIRECTION_OPTIONS = [
  { value: '', label: 'Non specificato' },
  { value: 'in', label: 'Vendita (attivo)' },
  { value: 'out', label: 'Acquisto (passivo)' },
  { value: 'both', label: 'Entrambi' },
]

const DIRECTION_BADGE: Record<string, string> = {
  in: 'bg-emerald-100 text-emerald-800',
  out: 'bg-red-100 text-red-800',
  both: 'bg-violet-100 text-violet-800',
}

const DIRECTION_LABEL: Record<string, string> = {
  in: 'Vendita',
  out: 'Acquisto',
  both: 'Entrambi',
}

const UNIT_SHORT: Record<string, string> = {
  t: 't', kg: 'kg', m3: 'm³', pz: 'pz', ore: 'h', forfait: 'ff',
}

/* ─── main component ─────────────────────────── */

export default function ArticoliPage() {
  const { company } = useCompany()
  const companyId = company?.id || null
  const [searchParams] = useSearchParams()

  // ─ Tab state
  const [activeTab, setActiveTab] = useState<'articles' | 'assignment' | 'dashboard'>(
    (searchParams.get('tab') as any) || 'articles',
  )

  // ─ Article list state
  const [articles, setArticles] = useState<Article[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [filterCategory, setFilterCategory] = useState<string>('')
  const [filterActive, setFilterActive] = useState(true)

  // ─ Selected article detail
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ArticleCreate & { id?: string }>({ code: '', name: '' })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // ─ Article stats & lines
  const [articleStats, setArticleStats] = useState<ArticleStats | null>(null)
  const [articleLines, setArticleLines] = useState<ArticleLineRow[]>([])
  const [statsLoading, setStatsLoading] = useState(false)

  // ─ New article modal
  const [showNewForm, setShowNewForm] = useState(false)
  const [newKeywordInput, setNewKeywordInput] = useState('')

  // ─ Assignment tab state
  const [unassignedLines, setUnassignedLines] = useState<UnassignedLine[]>([])
  const [matchResults, setMatchResults] = useState<Map<string, MatchResult>>(new Map())
  const [assignmentLoading, setAssignmentLoading] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [confirmingLineId, setConfirmingLineId] = useState<string | null>(null)

  // ─ Dashboard state
  const [dashboardData, setDashboardData] = useState<DashboardArticleRow[]>([])
  const [dashboardLoading, setDashboardLoading] = useState(false)
  const [dashYear, setDashYear] = useState(new Date().getFullYear())
  const [totalAssigned, setTotalAssigned] = useState(0)
  const [totalLines, setTotalLines] = useState(0)

  // ─── load articles ──────────────────────────
  const reload = useCallback(async () => {
    if (!companyId) return
    setLoading(true)
    try {
      const [arts, cats] = await Promise.all([
        loadArticles(companyId, { activeOnly: filterActive, category: filterCategory || undefined }),
        loadCategories(companyId),
      ])
      setArticles(arts)
      setCategories(cats)
    } catch (err: any) {
      toast.error(`Errore caricamento: ${err.message}`)
    }
    setLoading(false)
  }, [companyId, filterActive, filterCategory])

  useEffect(() => { reload() }, [reload])

  // ─── load detail when selection changes ─────
  useEffect(() => {
    if (!selectedId || !companyId) {
      setArticleStats(null)
      setArticleLines([])
      return
    }
    const art = articles.find(a => a.id === selectedId)
    if (art) {
      setDraft({
        id: art.id,
        code: art.code,
        name: art.name,
        description: art.description,
        unit: art.unit,
        category: art.category,
        direction: art.direction,
        active: art.active,
        keywords: [...art.keywords],
      })
    }

    setStatsLoading(true)
    Promise.all([
      loadArticleStats(selectedId, companyId),
      loadArticleLines(selectedId, companyId),
    ]).then(([stats, lines]) => {
      setArticleStats(stats)
      setArticleLines(lines)
    }).catch(err => {
      console.error('Stats load error:', err)
    }).finally(() => setStatsLoading(false))
  }, [selectedId, companyId, articles])

  // ─── filtered articles ──────────────────────
  const filteredArticles = useMemo(() => {
    if (!searchQuery.trim()) return articles
    const q = searchQuery.toLowerCase()
    return articles.filter(a =>
      a.code.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.keywords.some(k => k.toLowerCase().includes(q)),
    )
  }, [articles, searchQuery])

  // ─── save article ───────────────────────────
  const handleSave = useCallback(async () => {
    if (!companyId || !draft.code.trim() || !draft.name.trim()) {
      toast.error('Codice e nome sono obbligatori')
      return
    }
    setSaving(true)
    try {
      if (draft.id) {
        await updateArticle(draft.id, draft)
        toast.success('Articolo aggiornato')
      } else {
        const created = await createArticle(companyId, draft)
        toast.success(`Articolo ${created.code} creato`)
        setSelectedId(created.id)
        setShowNewForm(false)
      }
      await reload()
    } catch (err: any) {
      toast.error(`Errore salvataggio: ${err.message}`)
    }
    setSaving(false)
  }, [companyId, draft, reload])

  // ─── delete article ─────────────────────────
  const handleDelete = useCallback(async () => {
    if (!selectedId) return
    setDeleting(true)
    try {
      await deleteArticle(selectedId)
      toast.success('Articolo eliminato')
      setSelectedId(null)
      setConfirmDeleteId(null)
      await reload()
    } catch (err: any) {
      toast.error(`Errore eliminazione: ${err.message}`)
    }
    setDeleting(false)
  }, [selectedId, reload])

  // ─── keyword management ─────────────────────
  const addKeyword = useCallback((kw: string) => {
    const k = kw.toLowerCase().trim()
    if (!k || (draft.keywords || []).includes(k)) return
    setDraft(prev => ({ ...prev, keywords: [...(prev.keywords || []), k] }))
  }, [draft.keywords])

  const removeKeyword = useCallback((kw: string) => {
    setDraft(prev => ({
      ...prev,
      keywords: (prev.keywords || []).filter(k => k !== kw),
    }))
  }, [])

  const autoSuggestKeywords = useCallback(() => {
    if (!draft.name) return
    const suggested = suggestKeywords(draft.name)
    const existing = new Set(draft.keywords || [])
    const newKws = suggested.filter(k => !existing.has(k))
    if (newKws.length > 0) {
      setDraft(prev => ({
        ...prev,
        keywords: [...(prev.keywords || []), ...newKws],
      }))
      toast.success(`${newKws.length} keywords suggerite aggiunte`)
    } else {
      toast.info('Nessuna nuova keyword da suggerire')
    }
  }, [draft.name, draft.keywords])

  // ─── Assignment tab: analyze ────────────────
  const analyzeUnassigned = useCallback(async () => {
    if (!companyId) return
    setAnalyzing(true)
    try {
      const [lines, arts] = await Promise.all([
        loadUnassignedLines(companyId, 500),
        loadArticles(companyId, { activeOnly: true }),
      ])
      setUnassignedLines(lines)

      // Run matching for each line
      const results = new Map<string, MatchResult>()
      for (const line of lines) {
        if (!line.description) continue
        const match = matchLineToArticle(line.description, arts)
        if (match) results.set(line.id, match)
      }
      setMatchResults(results)
      toast.success(`Analizzate ${lines.length} righe, ${results.size} con match`)
    } catch (err: any) {
      toast.error(`Errore analisi: ${err.message}`)
    }
    setAnalyzing(false)
  }, [companyId])

  // ─── Assignment: confirm single ─────────────
  const confirmAssignment = useCallback(async (line: UnassignedLine, match: MatchResult) => {
    if (!companyId) return
    setConfirmingLineId(line.id)
    try {
      const location = extractLocation(line.description || '')
      await assignArticleToLine(
        companyId, line.id, line.invoice_id, match.article.id,
        { quantity: line.quantity, unit_price: line.unit_price, total_price: line.total_price, vat_rate: line.vat_rate },
        'ai_confirmed', match.confidence, location,
      )
      await recordAssignmentFeedback(companyId, match.article.id, line.description || '', true)
      setUnassignedLines(prev => prev.filter(l => l.id !== line.id))
      matchResults.delete(line.id)
      setMatchResults(new Map(matchResults))
      toast.success(`Assegnato a ${match.article.code}`)
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
    setConfirmingLineId(null)
  }, [companyId, matchResults])

  // ─── Assignment: reject single ──────────────
  const rejectAssignment = useCallback(async (lineId: string, match: MatchResult) => {
    if (!companyId) return
    try {
      const line = unassignedLines.find(l => l.id === lineId)
      if (line) await recordAssignmentFeedback(companyId, match.article.id, line.description || '', false)
      matchResults.delete(lineId)
      setMatchResults(new Map(matchResults))
    } catch (err: any) {
      console.error('Reject feedback error:', err)
    }
  }, [companyId, matchResults, unassignedLines])

  // ─── Assignment: confirm all high confidence ─
  const confirmAllHigh = useCallback(async () => {
    if (!companyId) return
    setAssignmentLoading(true)
    let ok = 0, fail = 0
    for (const [lineId, match] of matchResults) {
      if (match.confidence < 75) continue
      const line = unassignedLines.find(l => l.id === lineId)
      if (!line) continue
      try {
        const location = extractLocation(line.description || '')
        await assignArticleToLine(
          companyId, line.id, line.invoice_id, match.article.id,
          { quantity: line.quantity, unit_price: line.unit_price, total_price: line.total_price, vat_rate: line.vat_rate },
          'ai_confirmed', match.confidence, location,
        )
        await recordAssignmentFeedback(companyId, match.article.id, line.description || '', true)
        ok++
      } catch {
        fail++
      }
    }
    toast.success(`Confermati ${ok} assegnamenti${fail ? `, ${fail} errori` : ''}`)
    // Refresh
    await analyzeUnassigned()
    setAssignmentLoading(false)
  }, [companyId, matchResults, unassignedLines, analyzeUnassigned])

  // ─── Dashboard: load ────────────────────────
  const loadDashboard = useCallback(async () => {
    if (!companyId) return
    setDashboardLoading(true)
    try {
      const dateFrom = `${dashYear}-01-01`
      const dateTo = `${dashYear}-12-31`
      const data = await loadDashboardStats(companyId, dateFrom, dateTo)
      setDashboardData(data)

      // Count totals for KPI
      const { count: assigned } = await supabase
        .from('invoice_line_articles')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('verified', true)
      const { count: total } = await supabase
        .from('invoice_lines')
        .select('id, invoice:invoices!inner(company_id)', { count: 'exact', head: true })
        .eq('invoice.company_id', companyId)
      setTotalAssigned(assigned || 0)
      setTotalLines(total || 0)
    } catch (err: any) {
      toast.error(`Errore dashboard: ${err.message}`)
    }
    setDashboardLoading(false)
  }, [companyId, dashYear])

  useEffect(() => {
    if (activeTab === 'dashboard') loadDashboard()
  }, [activeTab, loadDashboard])

  // ─── chart data ─────────────────────────────
  const chartData = useMemo(() => {
    return dashboardData.map(d => ({
      name: d.code,
      quantita: Math.round(d.total_quantity),
      fatturato: Math.round(d.total_revenue),
    }))
  }, [dashboardData])

  const dashTotals = useMemo(() => {
    const qty = dashboardData.reduce((s, d) => s + d.total_quantity, 0)
    const rev = dashboardData.reduce((s, d) => s + d.total_revenue, 0)
    const count = dashboardData.reduce((s, d) => s + d.line_count, 0)
    return { qty, rev, avg: qty > 0 ? rev / qty : 0, count }
  }, [dashboardData])

  // ─── matched lines for assignment tab ───────
  const matchedLines = useMemo(() => {
    return unassignedLines
      .filter(l => matchResults.has(l.id))
      .sort((a, b) => (matchResults.get(b.id)?.confidence || 0) - (matchResults.get(a.id)?.confidence || 0))
  }, [unassignedLines, matchResults])

  const unmatchedLines = useMemo(() => {
    return unassignedLines.filter(l => !matchResults.has(l.id))
  }, [unassignedLines, matchResults])

  const highConfCount = useMemo(() => {
    return [...matchResults.values()].filter(m => m.confidence >= 75).length
  }, [matchResults])

  // ─── render ─────────────────────────────────
  if (loading && articles.length === 0) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
        <span className="ml-2 text-sm text-gray-500">Caricamento articoli...</span>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Articoli</h1>
        <p className="text-muted-foreground text-sm mt-0.5">
          Gestisci articoli e assegna le righe fattura per analytics di produzione
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={v => setActiveTab(v as any)}>
        <TabsList>
          <TabsTrigger value="articles" className="gap-1.5">
            <Package className="h-3.5 w-3.5" />
            Articoli
            {articles.length > 0 && (
              <span className="ml-1 text-[10px] bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded-full font-semibold">
                {articles.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="assignment" className="gap-1.5">
            <Sparkles className="h-3.5 w-3.5" />
            Assegnazione
          </TabsTrigger>
          <TabsTrigger value="dashboard" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            Dashboard
          </TabsTrigger>
        </TabsList>

        {/* ════════ TAB 1: ARTICLES CRUD ════════ */}
        <TabsContent value="articles" className="mt-4">
          <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
            {/* ── Left: Article List ── */}
            <Card className="h-[calc(100vh-240px)] flex flex-col">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="h-4 w-4 text-orange-500" />
                  Lista articoli
                  <Button
                    size="sm"
                    className="ml-auto h-7 text-xs bg-orange-600 hover:bg-orange-700"
                    onClick={() => {
                      setSelectedId(null)
                      setDraft({ code: '', name: '', unit: 't', keywords: [], active: true })
                      setShowNewForm(true)
                    }}
                  >
                    <Plus className="h-3 w-3 mr-1" /> Nuovo
                  </Button>
                </CardTitle>
              </CardHeader>

              <div className="px-4 pb-3 space-y-2">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
                  <Input
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Cerca codice, nome, keyword..."
                    className="pl-8 h-8 text-xs"
                  />
                </div>
                {/* Filters */}
                <div className="flex items-center gap-2">
                  <select
                    value={filterCategory}
                    onChange={e => setFilterCategory(e.target.value)}
                    className="text-xs border rounded px-2 py-1 flex-1 focus:outline-none focus:ring-1 focus:ring-orange-400"
                  >
                    <option value="">Tutte le categorie</option>
                    {categories.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <label className="flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={filterActive}
                      onChange={e => setFilterActive(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                    Solo attivi
                  </label>
                  <button
                    onClick={reload}
                    className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                    title="Ricarica"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Article list */}
              <CardContent className="flex-1 overflow-y-auto p-0">
                {filteredArticles.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-8">Nessun articolo trovato</p>
                ) : (
                  filteredArticles.map(art => {
                    const isSelected = selectedId === art.id
                    return (
                      <button
                        key={art.id}
                        onClick={() => {
                          setSelectedId(isSelected ? null : art.id)
                          setShowNewForm(false)
                        }}
                        className={`w-full text-left px-4 py-2.5 border-b last:border-b-0 transition-colors ${
                          isSelected ? 'bg-orange-50 border-l-2 border-l-orange-500' : 'hover:bg-gray-50'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[11px] font-mono font-bold text-orange-700 bg-orange-50 px-1.5 py-0.5 rounded shrink-0">
                              {art.code}
                            </span>
                            <span className="text-xs font-medium text-gray-800 truncate">{art.name}</span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0 ml-2">
                            <span className="text-[9px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded">
                              {UNIT_SHORT[art.unit] || art.unit}
                            </span>
                            {art.direction && (
                              <span className={`text-[9px] px-1.5 py-0.5 rounded ${DIRECTION_BADGE[art.direction] || 'bg-gray-100 text-gray-600'}`}>
                                {DIRECTION_LABEL[art.direction] || art.direction}
                              </span>
                            )}
                          </div>
                        </div>
                        {art.category && (
                          <p className="text-[10px] text-gray-400 mt-0.5 pl-0.5">{art.category}</p>
                        )}
                        {art.keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {art.keywords.slice(0, 4).map(k => (
                              <span key={k} className="text-[9px] text-orange-600 bg-orange-50 px-1 py-0.5 rounded">{k}</span>
                            ))}
                            {art.keywords.length > 4 && (
                              <span className="text-[9px] text-gray-400">+{art.keywords.length - 4}</span>
                            )}
                          </div>
                        )}
                      </button>
                    )
                  })
                )}
              </CardContent>
            </Card>

            {/* ── Right: Detail / New Form ── */}
            <div className="space-y-4">
              {!selectedId && !showNewForm ? (
                <Card>
                  <CardContent className="py-16 text-center">
                    <Package className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm text-gray-400">Seleziona un articolo dalla lista o crea un nuovo articolo</p>
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      {showNewForm && !draft.id ? 'Nuovo articolo' : `Dettaglio ${draft.code}`}
                      {!draft.active && draft.id && (
                        <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full">Disattivato</span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Form fields */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <Label className="text-xs">Codice *</Label>
                        <Input
                          value={draft.code}
                          onChange={e => setDraft(prev => ({ ...prev, code: e.target.value.toUpperCase() }))}
                          placeholder="es. CAL-070"
                          className="h-8 text-xs font-mono"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Nome *</Label>
                        <Input
                          value={draft.name}
                          onChange={e => setDraft(prev => ({ ...prev, name: e.target.value }))}
                          placeholder="es. Calcare Frantumato 0-70 mm"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div className="sm:col-span-2">
                        <Label className="text-xs">Descrizione</Label>
                        <Input
                          value={draft.description || ''}
                          onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                          placeholder="Descrizione estesa opzionale"
                          className="h-8 text-xs"
                        />
                      </div>
                      <div>
                        <Label className="text-xs">Unità di misura</Label>
                        <select
                          value={draft.unit || 't'}
                          onChange={e => setDraft(prev => ({ ...prev, unit: e.target.value }))}
                          className="w-full h-8 text-xs border rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-orange-400"
                        >
                          {UNIT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <Label className="text-xs">Categoria</Label>
                        <Input
                          value={draft.category || ''}
                          onChange={e => setDraft(prev => ({ ...prev, category: e.target.value }))}
                          placeholder="es. Fornitura calcare"
                          className="h-8 text-xs"
                          list="category-suggestions"
                        />
                        <datalist id="category-suggestions">
                          {categories.map(c => <option key={c} value={c} />)}
                        </datalist>
                      </div>
                      <div>
                        <Label className="text-xs">Direzione</Label>
                        <select
                          value={draft.direction || ''}
                          onChange={e => setDraft(prev => ({ ...prev, direction: e.target.value || null }))}
                          className="w-full h-8 text-xs border rounded-md px-2 focus:outline-none focus:ring-1 focus:ring-orange-400"
                        >
                          {DIRECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="flex items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                          <input
                            type="checkbox"
                            checked={draft.active ?? true}
                            onChange={e => setDraft(prev => ({ ...prev, active: e.target.checked }))}
                            className="rounded border-gray-300"
                          />
                          Attivo
                        </label>
                      </div>
                    </div>

                    {/* Keywords */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <Label className="text-xs">Keywords per matching</Label>
                        <button
                          onClick={autoSuggestKeywords}
                          className="text-[10px] text-orange-600 hover:text-orange-800 flex items-center gap-0.5 transition-colors"
                        >
                          <Sparkles className="h-3 w-3" /> Suggerisci dal nome
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5 min-h-[32px] p-2 bg-gray-50 rounded-md border">
                        {(draft.keywords || []).map(kw => (
                          <span
                            key={kw}
                            className="inline-flex items-center gap-0.5 text-[11px] bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full"
                          >
                            {kw}
                            <button onClick={() => removeKeyword(kw)} className="hover:text-red-600 ml-0.5">
                              <X className="h-2.5 w-2.5" />
                            </button>
                          </span>
                        ))}
                        <input
                          value={newKeywordInput}
                          onChange={e => setNewKeywordInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' || e.key === ',') {
                              e.preventDefault()
                              addKeyword(newKeywordInput)
                              setNewKeywordInput('')
                            }
                          }}
                          placeholder="Aggiungi keyword..."
                          className="flex-1 min-w-[100px] text-[11px] bg-transparent outline-none placeholder:text-gray-400"
                        />
                      </div>
                      <p className="text-[9px] text-gray-400 mt-1">Premi Invio o virgola per aggiungere</p>
                    </div>

                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-2">
                      <Button
                        onClick={handleSave}
                        disabled={saving || !draft.code.trim() || !draft.name.trim()}
                        size="sm"
                        className="bg-orange-600 hover:bg-orange-700"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                        Salva
                      </Button>
                      {draft.id && (
                        confirmDeleteId === draft.id ? (
                          <div className="flex items-center gap-1">
                            <Button
                              onClick={handleDelete}
                              disabled={deleting}
                              size="sm"
                              variant="destructive"
                              className="text-xs"
                            >
                              {deleting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Trash2 className="h-3 w-3 mr-1" />}
                              Conferma
                            </Button>
                            <Button
                              onClick={() => setConfirmDeleteId(null)}
                              size="sm"
                              variant="outline"
                              className="text-xs"
                            >
                              Annulla
                            </Button>
                          </div>
                        ) : (
                          <Button
                            onClick={() => setConfirmDeleteId(draft.id!)}
                            size="sm"
                            variant="outline"
                            className="text-xs text-red-600 hover:bg-red-50"
                          >
                            <Trash2 className="h-3 w-3 mr-1" /> Elimina
                          </Button>
                        )
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Stats & Lines (only when editing existing) */}
              {selectedId && draft.id && (
                <>
                  {/* Stats card */}
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <BarChart3 className="h-3.5 w-3.5 text-orange-500" />
                        Statistiche
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      {statsLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
                        </div>
                      ) : articleStats ? (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase">Quantità</p>
                            <p className="text-sm font-bold text-gray-800">
                              {fmtNum(articleStats.total_quantity)} {UNIT_SHORT[draft.unit || 't'] || draft.unit}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase">Fatturato</p>
                            <p className="text-sm font-bold text-emerald-700">{fmtEur(articleStats.total_revenue)}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase">Prezzo medio</p>
                            <p className="text-sm font-bold text-blue-700">
                              {fmtEur(articleStats.avg_price)}/{UNIT_SHORT[draft.unit || 't'] || draft.unit}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] text-gray-400 uppercase">Righe</p>
                            <p className="text-sm font-bold text-gray-800">{articleStats.line_count}</p>
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400">Nessuna riga assegnata</p>
                      )}
                    </CardContent>
                  </Card>

                  {/* Associated lines */}
                  {articleLines.length > 0 && (
                    <Card>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">Righe fattura associate ({articleLines.length})</CardTitle>
                      </CardHeader>
                      <CardContent className="p-0">
                        <div className="max-h-[300px] overflow-y-auto">
                          <table className="w-full text-[11px]">
                            <thead className="bg-gray-50 sticky top-0">
                              <tr className="border-b">
                                <th className="text-left px-3 py-2 font-medium text-gray-500">Fattura</th>
                                <th className="text-left px-3 py-2 font-medium text-gray-500">Data</th>
                                <th className="text-left px-3 py-2 font-medium text-gray-500">Controparte</th>
                                <th className="text-right px-3 py-2 font-medium text-gray-500">Qtà</th>
                                <th className="text-right px-3 py-2 font-medium text-gray-500">P.Unit</th>
                                <th className="text-right px-3 py-2 font-medium text-gray-500">Totale</th>
                                <th className="text-center px-3 py-2 font-medium text-gray-500">Stato</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y">
                              {articleLines.map(line => (
                                <tr key={line.id} className="hover:bg-gray-50/50">
                                  <td className="px-3 py-1.5 text-blue-600">{line.invoice_number || '—'}</td>
                                  <td className="px-3 py-1.5 text-gray-500">{fmtDate(line.invoice_date)}</td>
                                  <td className="px-3 py-1.5 text-gray-800 truncate max-w-[120px]">{line.counterparty_name || '—'}</td>
                                  <td className="px-3 py-1.5 text-right font-mono">{fmtNum(line.quantity)}</td>
                                  <td className="px-3 py-1.5 text-right">{fmtEur(line.unit_price)}</td>
                                  <td className="px-3 py-1.5 text-right font-semibold">{fmtEur(line.total_price)}</td>
                                  <td className="px-3 py-1.5 text-center">
                                    {line.verified ? (
                                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 inline" />
                                    ) : (
                                      <Sparkles className="h-3.5 w-3.5 text-purple-500 inline" />
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ════════ TAB 2: ASSIGNMENT ════════ */}
        <TabsContent value="assignment" className="mt-4 space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold">Assegnazione righe fattura</h2>
              <p className="text-xs text-gray-400 mt-0.5">Analizza le righe non assegnate e abbinale agli articoli con matching keywords</p>
            </div>
            <Button
              onClick={analyzeUnassigned}
              disabled={analyzing}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {analyzing ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Sparkles className="h-4 w-4 mr-1.5" />}
              {analyzing ? 'Analisi in corso...' : 'Analizza righe'}
            </Button>
          </div>

          {unassignedLines.length === 0 && !analyzing ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Tag className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">Clicca "Analizza righe" per trovare le righe fattura non assegnate</p>
                <p className="text-xs text-gray-400 mt-1">Il matching confronta la descrizione della riga con le keywords degli articoli</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Bulk confirm bar */}
              {highConfCount > 0 && (
                <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Zap className="h-4 w-4 text-emerald-600" />
                    <span className="text-sm text-emerald-800">
                      <strong>{highConfCount}</strong> righe con match &ge;75%
                    </span>
                  </div>
                  <Button
                    onClick={confirmAllHigh}
                    disabled={assignmentLoading}
                    size="sm"
                    className="bg-emerald-600 hover:bg-emerald-700"
                  >
                    {assignmentLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                    Conferma tutti
                  </Button>
                </div>
              )}

              {/* Summary */}
              <div className="flex items-center gap-4 text-xs text-gray-500">
                <span>{unassignedLines.length} righe non assegnate</span>
                <span className="text-emerald-600 font-medium">{matchedLines.length} con match</span>
                <span className="text-gray-400">{unmatchedLines.length} senza match</span>
              </div>

              {/* Matched lines */}
              {matchedLines.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      Righe con match ({matchedLines.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[50vh] overflow-y-auto divide-y">
                      {matchedLines.map(line => {
                        const match = matchResults.get(line.id)!
                        const isConfirming = confirmingLineId === line.id
                        return (
                          <div key={line.id} className="px-4 py-3 hover:bg-gray-50/50 transition-colors">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                                    match.confidence >= 90 ? 'bg-emerald-100 text-emerald-700'
                                    : match.confidence >= 75 ? 'bg-blue-100 text-blue-700'
                                    : 'bg-amber-100 text-amber-700'
                                  }`}>
                                    {Math.round(match.confidence)}%
                                  </span>
                                  <span className="text-[11px] font-mono font-bold text-orange-700 bg-orange-50 px-1.5 py-0.5 rounded">
                                    {match.article.code}
                                  </span>
                                  <span className="text-[10px] text-gray-500">{match.article.name}</span>
                                </div>
                                <p className="text-[11px] text-gray-700 mt-1 line-clamp-2">{line.description}</p>
                                <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
                                  <span>Fatt. {line.invoice_number || '—'}</span>
                                  <span>{fmtDate(line.invoice_date)}</span>
                                  <span>{line.counterparty_name || '—'}</span>
                                  {line.quantity != null && <span className="font-mono">{fmtNum(line.quantity)} {UNIT_SHORT[match.article.unit] || match.article.unit}</span>}
                                  {line.total_price != null && <span className="font-semibold text-gray-600">{fmtEur(line.total_price)}</span>}
                                </div>
                                <div className="flex items-center gap-1 mt-1">
                                  <span className="text-[9px] text-gray-400">Keywords:</span>
                                  {match.matchedKeywords.map(kw => (
                                    <span key={kw} className="text-[9px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded">{kw}</span>
                                  ))}
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  onClick={() => rejectAssignment(line.id, match)}
                                  className="p-1.5 rounded text-red-400 hover:bg-red-50 transition-colors"
                                  title="Rifiuta"
                                >
                                  <XCircle className="h-4 w-4" />
                                </button>
                                <button
                                  onClick={() => confirmAssignment(line, match)}
                                  disabled={isConfirming}
                                  className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                                >
                                  {isConfirming ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                                  Conferma
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Unmatched lines */}
              {unmatchedLines.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-gray-500">
                      <AlertTriangle className="h-4 w-4 text-gray-400" />
                      Senza match ({unmatchedLines.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="max-h-[30vh] overflow-y-auto divide-y">
                      {unmatchedLines.slice(0, 50).map(line => (
                        <div key={line.id} className="px-4 py-2 text-[11px]">
                          <p className="text-gray-600 line-clamp-1">{line.description || '(vuoto)'}</p>
                          <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                            <span>Fatt. {line.invoice_number || '—'}</span>
                            <span>{fmtDate(line.invoice_date)}</span>
                            <span>{line.counterparty_name || '—'}</span>
                            {line.total_price != null && <span>{fmtEur(line.total_price)}</span>}
                          </div>
                        </div>
                      ))}
                      {unmatchedLines.length > 50 && (
                        <p className="px-4 py-2 text-[10px] text-gray-400">...e altre {unmatchedLines.length - 50} righe</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* ════════ TAB 3: DASHBOARD ════════ */}
        <TabsContent value="dashboard" className="mt-4 space-y-4">
          {/* Year filter */}
          <div className="flex items-center gap-3">
            <Label className="text-xs text-gray-500">Periodo:</Label>
            <select
              value={dashYear}
              onChange={e => setDashYear(Number(e.target.value))}
              className="text-xs border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400"
            >
              {[2026, 2025, 2024, 2023].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
            <button
              onClick={loadDashboard}
              disabled={dashboardLoading}
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${dashboardLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <KpiCard
              label="Tot. Quantità"
              value={`${fmtNum(dashTotals.qty)} t`}
              icon={Package}
              bg="bg-orange-50"
              color="text-orange-700"
              iconColor="text-orange-500"
            />
            <KpiCard
              label="Tot. Fatturato"
              value={fmtEur(dashTotals.rev)}
              icon={BarChart3}
              bg="bg-emerald-50"
              color="text-emerald-700"
              iconColor="text-emerald-500"
            />
            <KpiCard
              label="Prezzo Medio"
              value={`${fmtEur(dashTotals.avg)}/t`}
              icon={Tag}
              bg="bg-blue-50"
              color="text-blue-700"
              iconColor="text-blue-500"
            />
            <KpiCard
              label="Righe Assegnate"
              value={`${totalAssigned} / ${totalLines}`}
              icon={CheckCircle2}
              bg="bg-purple-50"
              color="text-purple-700"
              iconColor="text-purple-500"
              sub={totalLines > 0 ? `${Math.round((totalAssigned / totalLines) * 100)}% completamento` : undefined}
            />
          </div>

          {dashboardLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-orange-500" />
              <span className="ml-2 text-sm text-gray-500">Caricamento dashboard...</span>
            </div>
          ) : dashboardData.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <BarChart3 className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-400">Nessun dato per il periodo selezionato</p>
                <p className="text-xs text-gray-400 mt-1">Assegna le righe fattura agli articoli per vedere le statistiche</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Summary table */}
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Riepilogo per articolo</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50">
                      <tr className="border-b">
                        <th className="text-left px-4 py-2.5 font-medium text-gray-500">Articolo</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-500">Quantità</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-500">Fatturato</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-500">P. Medio</th>
                        <th className="text-right px-4 py-2.5 font-medium text-gray-500">Righe</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {dashboardData.map(row => (
                        <tr key={row.article_id} className="hover:bg-gray-50/50">
                          <td className="px-4 py-2">
                            <div className="flex items-center gap-2">
                              <span className="font-mono font-bold text-orange-700 text-[11px] bg-orange-50 px-1.5 py-0.5 rounded">{row.code}</span>
                              <span className="text-gray-800">{row.name}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono">{fmtNum(row.total_quantity)} {UNIT_SHORT[row.unit] || row.unit}</td>
                          <td className="px-4 py-2 text-right font-semibold text-emerald-700">{fmtEur(row.total_revenue)}</td>
                          <td className="px-4 py-2 text-right text-blue-700">{fmtEur(row.avg_price)}/{UNIT_SHORT[row.unit] || row.unit}</td>
                          <td className="px-4 py-2 text-right text-gray-500">{row.line_count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardContent>
              </Card>

              {/* Chart */}
              {chartData.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Fatturato per articolo</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                        <YAxis
                          tick={{ fontSize: 10 }}
                          tickFormatter={(v: number) => v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)}
                        />
                        <Tooltip
                          formatter={(value: number, name: string) => [
                            name === 'fatturato' ? fmtEur(value) : fmtNum(value),
                            name === 'fatturato' ? 'Fatturato' : 'Quantità',
                          ]}
                        />
                        <Legend />
                        <Bar dataKey="fatturato" name="Fatturato (€)" fill="#f97316" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}

/* ─── KPI Card ───────────────────────────────── */

function KpiCard({ label, value, icon: Icon, color, bg, iconColor, sub }: {
  label: string; value: string; icon: any; color: string; bg: string; iconColor: string; sub?: string
}) {
  return (
    <div className={`${bg} border rounded-lg p-4`}>
      <div className="flex items-center justify-between">
        <p className={`text-[10px] font-medium ${color} uppercase tracking-wide`}>{label}</p>
        <Icon className={`h-4 w-4 ${iconColor}`} />
      </div>
      <p className={`text-lg font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-[10px] text-gray-500 mt-0.5">{sub}</p>}
    </div>
  )
}
