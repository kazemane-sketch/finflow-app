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
  loadCategories, assignArticleToLine, loadLearnedRules,
  removeLineAssignment, recordAssignmentFeedback, batchRecordFeedback,
  loadClassificationCounts, markLineSkipped, markLinesSkippedBulk,
  deleteBulkSuggestions, saveBulkSuggestions, loadSavedSuggestions,
  loadClassifiedLines, loadSkippedLines, unskipLine,
  type Article, type ArticleCreate, type ArticleStats, type ArticleLineRow,
  type UnassignedLine, type MatchResult, type DashboardArticleRow,
  type ClassificationCounts, type BulkSuggestion,
  type ClassifiedLine, type SkippedLine,
  callArticleAiMatch, type AiMatchRequest,
} from '@/lib/articlesService'
import {
  matchWithLearnedRules, matchWithLearnedRulesAll, needsAiMatching,
  extractLocation, suggestKeywords,
} from '@/lib/articleMatching'
import { supabase } from '@/integrations/supabase/client'
import { fmtDate, fmtEur, fmtNum } from '@/lib/utils'
import { toast } from 'sonner'
import {
  Package, Plus, Search, Loader2, Trash2, Save, X, Check,
  XCircle, RefreshCw, Zap, BarChart3, Tag, ChevronRight,
  CheckCircle2, AlertTriangle, Sparkles, Filter, Eye, Ban, Brain,
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
  const [bulkProgress, setBulkProgress] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeProgress, setAnalyzeProgress] = useState('')
  const [confirmingLineId, setConfirmingLineId] = useState<string | null>(null)
  const [invoicePopup, setInvoicePopup] = useState<string | null>(null) // invoice_id for popup

  // ─ Assignment filters: matched section
  const [filterMatchArticle, setFilterMatchArticle] = useState('')     // article_id or ''
  const [filterMatchConfidence, setFilterMatchConfidence] = useState('') // '90','75','50','low',''

  // ─ Assignment filters: unmatched section
  const [filterUnmatchText, setFilterUnmatchText] = useState('')
  const [filterUnmatchCounterparty, setFilterUnmatchCounterparty] = useState('')

  // ─ Classification KPI counts
  const [kpiCounts, setKpiCounts] = useState<ClassificationCounts>({ total: 0, classified: 0, with_match: 0, skipped: 0, to_analyze: 0 })

  // ─ Skip loading state
  const [skippingIds, setSkippingIds] = useState<Set<string>>(new Set())
  const [bulkSkipping, setBulkSkipping] = useState(false)

  // ─ KPI clickable views
  type ActiveKpi = 'all' | 'with_match' | 'classified' | 'skipped' | 'to_analyze'
  const [activeKpi, setActiveKpi] = useState<ActiveKpi>('all')
  const [classifiedLines, setClassifiedLines] = useState<ClassifiedLine[]>([])
  const [skippedLines, setSkippedLines] = useState<SkippedLine[]>([])
  const [classifiedLoading, setClassifiedLoading] = useState(false)
  const [skippedLoading, setSkippedLoading] = useState(false)

  // ─ Article override (clickable badge → change suggested article)
  const [articleOverrides, setArticleOverrides] = useState<Map<string, Article>>(new Map())
  const [dropdownLineId, setDropdownLineId] = useState<string | null>(null)
  const [dropdownSearch, setDropdownSearch] = useState('')

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

  // ─── Assignment tab: analyze ALL lines (2-phase: deterministic + AI) ──────
  const analyzeUnassigned = useCallback(async () => {
    if (!companyId) return
    setAnalyzing(true)
    setAnalyzeProgress('Caricamento righe...')
    // Reset filters on new analysis
    setFilterMatchArticle('')
    setFilterMatchConfidence('')
    setFilterUnmatchText('')
    setFilterUnmatchCounterparty('')
    try {
      // Step 1: Clear old AI suggestions
      setAnalyzeProgress('Pulizia vecchi suggerimenti...')
      await deleteBulkSuggestions(companyId)

      // Step 2: Load articles, rules and ALL unassigned lines (paginated, no limit)
      const [arts, rules] = await Promise.all([
        loadArticles(companyId, { activeOnly: true }),
        loadLearnedRules(companyId),
      ])
      setArticles(arts)
      setAnalyzeProgress('Caricamento righe fattura...')
      const lines = await loadUnassignedLines(companyId, (loaded) => {
        setAnalyzeProgress(`Caricate ${loaded} righe...`)
      })
      setUnassignedLines(lines)

      // ── Phase 1: Deterministic matching ──────────
      setAnalyzeProgress(`Fase 1: Matching deterministico ${lines.length} righe...`)
      const results = new Map<string, MatchResult>()
      const bulkToSave: BulkSuggestion[] = []
      const aiCandidates: UnassignedLine[] = []

      let detMatches = 0
      const activeRules = rules.filter(r => r.confidence > 0.5)
      console.log(`[ArticoliPage] Analisi: ${lines.length} righe, ${arts.length} articoli, ${rules.length} regole (${activeRules.length} con confidence > 0.5)`)

      for (const line of lines) {
        if (!line.description) continue

        // Get ALL candidate matches for ambiguity detection
        const allMatches = matchWithLearnedRulesAll(line.description, arts, rules)

        if (needsAiMatching(allMatches)) {
          // Ambiguous or no match → send to AI
          aiCandidates.push(line)
        } else if (allMatches.length > 0) {
          // Clear deterministic match → use top-1
          const bestMatch = allMatches[0]
          results.set(line.id, bestMatch)
          bulkToSave.push({
            invoice_line_id: line.id,
            invoice_id: line.invoice_id,
            article_id: bestMatch.article.id,
            confidence: bestMatch.confidence,
          })
          detMatches++
        }
      }

      console.log(`[ArticoliPage] Fase 1: ${detMatches} match deterministici, ${aiCandidates.length} righe ambigue per AI`)

      // ── Phase 2: AI Haiku for ambiguous lines ────
      let aiMatched = 0
      if (aiCandidates.length > 0) {
        const AI_BATCH = 20
        for (let i = 0; i < aiCandidates.length; i += AI_BATCH) {
          const batch = aiCandidates.slice(i, i + AI_BATCH)
          setAnalyzeProgress(`Fase 2: Analisi AI ${Math.min(i + AI_BATCH, aiCandidates.length)}/${aiCandidates.length} righe ambigue...`)

          try {
            const aiResults = await callArticleAiMatch(
              companyId,
              batch.map(l => ({
                line_id: l.id,
                description: l.description || '',
                quantity: l.quantity,
                unit_price: l.unit_price,
                total_price: l.total_price,
                invoice_number: l.invoice_number,
                counterparty_name: l.counterparty_name,
              })),
            )

            for (const aiResult of aiResults) {
              if (!aiResult.article_id) continue
              const article = arts.find(a => a.id === aiResult.article_id)
              if (!article) continue

              results.set(aiResult.line_id, {
                article,
                confidence: aiResult.confidence,
                matchedKeywords: [],
                totalKeywords: article.keywords?.length || 0,
                source: 'ai',
                reasoning: aiResult.reasoning,
              })

              const candidateLine = aiCandidates.find(l => l.id === aiResult.line_id)
              if (candidateLine) {
                bulkToSave.push({
                  invoice_line_id: aiResult.line_id,
                  invoice_id: candidateLine.invoice_id,
                  article_id: article.id,
                  confidence: aiResult.confidence,
                })
              }
              aiMatched++
            }
          } catch (err) {
            console.error(`[ArticoliPage] AI batch error (${i}-${i + AI_BATCH}):`, err)
            // Continue with next batch
          }
        }
      }

      console.log(`[ArticoliPage] Fase 2: ${aiMatched} match AI su ${aiCandidates.length} righe ambigue`)

      // Step 3: Save suggestions to DB
      if (bulkToSave.length > 0) {
        setAnalyzeProgress(`Salvataggio ${bulkToSave.length} suggerimenti...`)
        await saveBulkSuggestions(companyId, bulkToSave)
      }

      setMatchResults(results)

      // Step 4: Refresh KPI counts from DB
      const counts = await loadClassificationCounts(companyId)
      setKpiCounts(counts)

      toast.success(`Analizzate ${lines.length} righe: ${detMatches} deterministici, ${aiMatched} AI`)
    } catch (err: any) {
      toast.error(`Errore analisi: ${err.message}`)
    }
    setAnalyzeProgress('')
    setAnalyzing(false)
  }, [companyId])

  // ─── Assignment: confirm single (with override support) ──
  const confirmAssignment = useCallback(async (line: UnassignedLine, match: MatchResult) => {
    if (!companyId) return
    setConfirmingLineId(line.id)
    try {
      // Check if user changed the suggested article
      const override = articleOverrides.get(line.id)
      const finalArticle = override || match.article
      const wasChanged = !!(override && override.id !== match.article.id)

      const location = extractLocation(line.description || '')
      await assignArticleToLine(
        companyId, line.id, line.invoice_id, finalArticle.id,
        { quantity: line.quantity, unit_price: line.unit_price, total_price: line.total_price, vat_rate: line.vat_rate },
        wasChanged ? 'manual' : 'ai_confirmed',
        wasChanged ? undefined : match.confidence,
        location,
      )

      if (wasChanged) {
        // Reject feedback on original suggestion's rule
        await recordAssignmentFeedback(companyId, match.article.id, line.description || '', false)
        // Accept feedback for the user-chosen article
        await recordAssignmentFeedback(companyId, finalArticle.id, line.description || '', true)
      } else {
        // Confirmed without changes → hit_count++ as before
        await recordAssignmentFeedback(companyId, match.article.id, line.description || '', true)
      }

      // Cleanup
      setUnassignedLines(prev => prev.filter(l => l.id !== line.id))
      matchResults.delete(line.id)
      setMatchResults(new Map(matchResults))
      setArticleOverrides(prev => { const next = new Map(prev); next.delete(line.id); return next })
      setKpiCounts(prev => ({
        ...prev,
        classified: prev.classified + 1,
        with_match: Math.max(0, prev.with_match - 1),
      }))
      toast.success(`Assegnato a ${finalArticle.code}`)
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
    setConfirmingLineId(null)
  }, [companyId, matchResults, articleOverrides])

  // ─── Assignment: reject single ──────────────
  const rejectAssignment = useCallback(async (lineId: string, match: MatchResult) => {
    if (!companyId) return
    try {
      const line = unassignedLines.find(l => l.id === lineId)
      if (line) await recordAssignmentFeedback(companyId, match.article.id, line.description || '', false)
      matchResults.delete(lineId)
      setMatchResults(new Map(matchResults))
      // Cleanup any override for this line
      setArticleOverrides(prev => { const next = new Map(prev); next.delete(lineId); return next })
    } catch (err: any) {
      console.error('Reject feedback error:', err)
    }
  }, [companyId, matchResults, unassignedLines])

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

  // Auto-load KPI counts + saved suggestions when assignment tab opens
  useEffect(() => {
    if (activeTab !== 'assignment' || !companyId) return
    let cancelled = false

    ;(async () => {
      try {
        // Load KPI counts
        const counts = await loadClassificationCounts(companyId)
        if (cancelled) return
        setKpiCounts(counts)

        // If we already have match results in memory (just ran analysis), skip loading from DB
        if (matchResults.size > 0) return

        // Load saved suggestions from DB
        const [saved, arts] = await Promise.all([
          loadSavedSuggestions(companyId),
          loadArticles(companyId, { activeOnly: true }),
        ])
        if (cancelled || saved.length === 0) {
          if (!cancelled) setArticles(arts)
          return
        }
        setArticles(arts)

        // Convert SavedSuggestion[] → UnassignedLine[] + Map<string, MatchResult>
        const lines: UnassignedLine[] = []
        const results = new Map<string, MatchResult>()
        for (const s of saved) {
          lines.push({
            id: s.invoice_line_id,
            invoice_id: s.invoice_id,
            line_number: s.line_number,
            description: s.line_description,
            quantity: s.quantity,
            unit_price: s.unit_price,
            total_price: s.total_price,
            vat_rate: s.vat_rate,
            article_code: s.article_code_xml,
            invoice_number: s.invoice_number,
            invoice_date: s.invoice_date,
            counterparty_name: s.counterparty_name,
            invoice_direction: s.invoice_direction,
          })
          const artObj = arts.find(a => a.id === s.article_id)
          if (artObj) {
            results.set(s.invoice_line_id, {
              article: artObj,
              confidence: s.confidence,
              matchedKeywords: [],
              totalKeywords: artObj.keywords.length,
              source: 'deterministic',
            })
          }
        }
        if (!cancelled) {
          setUnassignedLines(lines)
          setMatchResults(results)
        }
      } catch (err) {
        console.error('Auto-load suggestions error:', err)
      }
    })()

    return () => { cancelled = true }
  }, [activeTab, companyId]) // intentionally omit matchResults to avoid re-runs

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

  // ─── matched/unmatched base lists ───────────
  const matchedLines = useMemo(() => {
    return unassignedLines
      .filter(l => matchResults.has(l.id))
      .sort((a, b) => (matchResults.get(b.id)?.confidence || 0) - (matchResults.get(a.id)?.confidence || 0))
  }, [unassignedLines, matchResults])

  const unmatchedLines = useMemo(() => {
    return unassignedLines.filter(l => !matchResults.has(l.id))
  }, [unassignedLines, matchResults])

  // ─── unique articles from matches (for filter dropdown) ─
  const matchedArticles = useMemo(() => {
    const artMap = new Map<string, { id: string; code: string; name: string; count: number }>()
    for (const [, match] of matchResults) {
      const existing = artMap.get(match.article.id)
      if (existing) { existing.count++ }
      else { artMap.set(match.article.id, { id: match.article.id, code: match.article.code, name: match.article.name, count: 1 }) }
    }
    return [...artMap.values()].sort((a, b) => a.code.localeCompare(b.code))
  }, [matchResults])

  // ─── filtered matched lines ───────────────────
  const filteredMatchedLines = useMemo(() => {
    let filtered = matchedLines
    if (filterMatchArticle) {
      filtered = filtered.filter(l => matchResults.get(l.id)?.article.id === filterMatchArticle)
    }
    if (filterMatchConfidence) {
      filtered = filtered.filter(l => {
        const conf = matchResults.get(l.id)?.confidence || 0
        switch (filterMatchConfidence) {
          case '90': return conf >= 90
          case '75': return conf >= 75 && conf < 90
          case '50': return conf >= 50 && conf < 75
          case 'low': return conf < 50
          default: return true
        }
      })
    }
    return filtered
  }, [matchedLines, matchResults, filterMatchArticle, filterMatchConfidence])

  // ─── unique counterparties from unmatched ─────
  const unmatchedCounterparties = useMemo(() => {
    const cpMap = new Map<string, number>()
    for (const line of unmatchedLines) {
      const cp = line.counterparty_name || '(sconosciuto)'
      cpMap.set(cp, (cpMap.get(cp) || 0) + 1)
    }
    return [...cpMap.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
  }, [unmatchedLines])

  // ─── filtered unmatched lines ─────────────────
  const filteredUnmatchedLines = useMemo(() => {
    let filtered = unmatchedLines
    if (filterUnmatchText) {
      const q = filterUnmatchText.toLowerCase()
      filtered = filtered.filter(l => l.description?.toLowerCase().includes(q))
    }
    if (filterUnmatchCounterparty) {
      if (filterUnmatchCounterparty === '(sconosciuto)') {
        filtered = filtered.filter(l => !l.counterparty_name)
      } else {
        filtered = filtered.filter(l => l.counterparty_name === filterUnmatchCounterparty)
      }
    }
    return filtered
  }, [unmatchedLines, filterUnmatchText, filterUnmatchCounterparty])

  // ─── Assignment: confirm all FILTERED visible lines (BATCHED for performance) ─
  const confirmAllFiltered = useCallback(async () => {
    if (!companyId) return
    setAssignmentLoading(true)
    const total = filteredMatchedLines.length

    try {
      // ── Phase 1: Build bulk upsert rows for invoice_line_articles ──
      setBulkProgress(`Preparando ${total} righe...`)
      const upsertRows: any[] = []
      const feedbacks: { articleId: string; description: string; accepted: boolean }[] = []

      for (const line of filteredMatchedLines) {
        const match = matchResults.get(line.id)
        if (!match) continue
        const override = articleOverrides.get(line.id)
        const finalArticle = override || match.article
        const wasChanged = !!(override && override.id !== match.article.id)

        upsertRows.push({
          company_id: companyId,
          invoice_line_id: line.id,
          invoice_id: line.invoice_id,
          article_id: finalArticle.id,
          quantity: line.quantity ?? null,
          unit_price: line.unit_price ?? null,
          total_price: line.total_price ?? null,
          vat_rate: line.vat_rate ?? null,
          assigned_by: wasChanged ? 'manual' : 'ai_confirmed',
          confidence: wasChanged ? null : match.confidence ?? null,
          verified: true,
          location: extractLocation(line.description || '') ?? null,
        })

        // Collect feedback items (reject old + accept new if overridden)
        if (wasChanged) {
          feedbacks.push({ articleId: match.article.id, description: line.description || '', accepted: false })
          feedbacks.push({ articleId: finalArticle.id, description: line.description || '', accepted: true })
        } else {
          feedbacks.push({ articleId: match.article.id, description: line.description || '', accepted: true })
        }
      }

      // ── Phase 2: Bulk upsert (batch 200 at a time) ──
      setBulkProgress(`Salvando ${upsertRows.length} assegnamenti...`)
      let ok = 0, fail = 0
      for (let i = 0; i < upsertRows.length; i += 200) {
        const batch = upsertRows.slice(i, i + 200)
        const { error } = await supabase
          .from('invoice_line_articles')
          .upsert(batch, { onConflict: 'invoice_line_id' })
        if (error) {
          console.error('Bulk upsert batch error:', error)
          fail += batch.length
        } else {
          ok += batch.length
        }
        setBulkProgress(`Salvando: ${Math.min(i + 200, upsertRows.length)}/${upsertRows.length}...`)
      }

      // ── Phase 3: Batch feedback (update rules) ──
      setBulkProgress(`Aggiornando regole apprese...`)
      await batchRecordFeedback(companyId, feedbacks)

      // ── Done ──
      setBulkProgress(null)
      toast.success(`Confermati ${ok} assegnamenti${fail ? `, ${fail} errori` : ''}`)
      await analyzeUnassigned()
      setArticleOverrides(new Map())
    } catch (err: any) {
      console.error('Bulk confirm error:', err)
      toast.error(`Errore conferma bulk: ${err.message || 'sconosciuto'}`)
      setBulkProgress(null)
    } finally {
      setAssignmentLoading(false)
    }
  }, [companyId, filteredMatchedLines, matchResults, articleOverrides, analyzeUnassigned])

  // ─── Skip: single line ────────────────────────
  const skipLine = useCallback(async (lineId: string) => {
    setSkippingIds(prev => new Set([...prev, lineId]))
    try {
      await markLineSkipped(lineId)
      setUnassignedLines(prev => prev.filter(l => l.id !== lineId))
      matchResults.delete(lineId)
      setMatchResults(new Map(matchResults))
      setKpiCounts(prev => ({
        ...prev,
        skipped: prev.skipped + 1,
        to_analyze: Math.max(0, prev.to_analyze - 1),
      }))
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
    setSkippingIds(prev => { const next = new Set(prev); next.delete(lineId); return next })
  }, [matchResults])

  // ─── Skip: bulk filtered unmatched ─────────────
  const skipAllFiltered = useCallback(async () => {
    if (filteredUnmatchedLines.length === 0) return
    setBulkSkipping(true)
    const ids = filteredUnmatchedLines.map(l => l.id)
    try {
      await markLinesSkippedBulk(ids)
      const idsSet = new Set(ids)
      setUnassignedLines(prev => prev.filter(l => !idsSet.has(l.id)))
      setKpiCounts(prev => ({
        ...prev,
        skipped: prev.skipped + ids.length,
        to_analyze: Math.max(0, prev.to_analyze - ids.length),
      }))
      toast.success(`${ids.length} righe marcate come non classificabili`)
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
    setBulkSkipping(false)
  }, [filteredUnmatchedLines])

  // ─── KPI click: load classified/skipped data ─
  const handleKpiClick = useCallback(async (kpi: ActiveKpi) => {
    setActiveKpi(kpi)
    if (kpi === 'classified' && companyId && classifiedLines.length === 0) {
      setClassifiedLoading(true)
      try {
        const lines = await loadClassifiedLines(companyId)
        setClassifiedLines(lines)
      } catch (err) { console.error('Load classified error:', err) }
      setClassifiedLoading(false)
    }
    if (kpi === 'skipped' && companyId && skippedLines.length === 0) {
      setSkippedLoading(true)
      try {
        const lines = await loadSkippedLines(companyId)
        setSkippedLines(lines)
      } catch (err) { console.error('Load skipped error:', err) }
      setSkippedLoading(false)
    }
  }, [companyId, classifiedLines.length, skippedLines.length])

  // ─── Remove a confirmed classification ────────
  const handleRemoveClassification = useCallback(async (invoiceLineId: string) => {
    try {
      await removeLineAssignment(invoiceLineId)
      setClassifiedLines(prev => prev.filter(l => l.invoice_line_id !== invoiceLineId))
      setKpiCounts(prev => ({
        ...prev,
        classified: Math.max(0, prev.classified - 1),
        to_analyze: prev.to_analyze + 1,
      }))
      toast.success('Assegnazione rimossa')
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
  }, [])

  // ─── Unskip a skipped line ────────────────────
  const handleUnskipLine = useCallback(async (lineId: string) => {
    try {
      await unskipLine(lineId)
      setSkippedLines(prev => prev.filter(l => l.id !== lineId))
      setKpiCounts(prev => ({
        ...prev,
        skipped: Math.max(0, prev.skipped - 1),
        to_analyze: prev.to_analyze + 1,
      }))
      toast.success('Riga ripristinata')
    } catch (err: any) {
      toast.error(`Errore: ${err.message}`)
    }
  }, [])

  // ─── Inline article change (clickable badge) ─
  const changeLineArticle = useCallback((lineId: string, newArticle: Article) => {
    setArticleOverrides(prev => {
      const next = new Map(prev)
      next.set(lineId, newArticle)
      return next
    })
    setDropdownLineId(null)
    setDropdownSearch('')
  }, [])

  // ─── Close article dropdown on outside click ──
  useEffect(() => {
    if (!dropdownLineId) return
    const handler = () => { setDropdownLineId(null); setDropdownSearch('') }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [dropdownLineId])

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
              {analyzing ? (analyzeProgress || 'Analisi in corso...') : 'Analizza tutte le righe'}
            </Button>
          </div>

          {unassignedLines.length === 0 && !analyzing && kpiCounts.total === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <Tag className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-sm text-gray-500">Clicca "Analizza righe" per trovare le righe fattura non assegnate</p>
                <p className="text-xs text-gray-400 mt-1">Il matching confronta la descrizione della riga con le keywords degli articoli</p>
              </CardContent>
            </Card>
          ) : (
            <>
              {/* ── KPI Bar ── */}
              {kpiCounts.total > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <button onClick={() => handleKpiClick('all')}
                    className={`bg-gray-50 border rounded-lg px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${activeKpi === 'all' ? 'ring-2 ring-gray-400' : ''}`}>
                    <p className="text-[9px] text-gray-400 uppercase font-medium">Totale righe</p>
                    <p className="text-sm font-bold text-gray-800">{kpiCounts.total.toLocaleString('it-IT')}</p>
                  </button>
                  <button onClick={() => handleKpiClick('with_match')}
                    className={`bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${activeKpi === 'with_match' ? 'ring-2 ring-emerald-400' : ''}`}>
                    <p className="text-[9px] text-emerald-600 uppercase font-medium">Con match</p>
                    <p className="text-sm font-bold text-emerald-700">{kpiCounts.with_match.toLocaleString('it-IT')}</p>
                  </button>
                  <button onClick={() => handleKpiClick('classified')}
                    className={`bg-purple-50 border border-purple-200 rounded-lg px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${activeKpi === 'classified' ? 'ring-2 ring-purple-400' : ''}`}>
                    <p className="text-[9px] text-purple-600 uppercase font-medium">Classificate</p>
                    <p className="text-sm font-bold text-purple-700">{kpiCounts.classified.toLocaleString('it-IT')}</p>
                  </button>
                  <button onClick={() => handleKpiClick('skipped')}
                    className={`bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${activeKpi === 'skipped' ? 'ring-2 ring-orange-400' : ''}`}>
                    <p className="text-[9px] text-orange-600 uppercase font-medium">Non classificabili</p>
                    <p className="text-sm font-bold text-orange-700">{kpiCounts.skipped.toLocaleString('it-IT')}</p>
                  </button>
                  <button onClick={() => handleKpiClick('to_analyze')}
                    className={`bg-blue-50 border border-blue-200 rounded-lg px-3 py-2 text-left transition-all cursor-pointer hover:shadow-sm ${activeKpi === 'to_analyze' ? 'ring-2 ring-blue-400' : ''}`}>
                    <p className="text-[9px] text-blue-600 uppercase font-medium">Da analizzare</p>
                    <p className="text-sm font-bold text-blue-700">{kpiCounts.to_analyze.toLocaleString('it-IT')}</p>
                  </button>
                </div>
              )}

              {/* ════ Classified Lines Section (KPI click) ════ */}
              {(activeKpi === 'classified' || activeKpi === 'all') && activeKpi === 'classified' && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-purple-500" />
                      Righe classificate ({classifiedLines.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {classifiedLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-purple-500" />
                        <span className="ml-2 text-sm text-gray-500">Caricamento...</span>
                      </div>
                    ) : classifiedLines.length === 0 ? (
                      <p className="px-4 py-6 text-sm text-gray-400 text-center">Nessuna riga classificata</p>
                    ) : (
                      <div className="max-h-[50vh] overflow-y-auto divide-y">
                        {classifiedLines.slice(0, 200).map(line => (
                          <div key={line.invoice_line_id} className="px-4 py-2.5 hover:bg-gray-50/50 flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-mono font-bold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded">{line.article_code}</span>
                                <span className="text-[10px] text-gray-500">{line.article_name}</span>
                                <span className="text-[9px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded">{line.assigned_by === 'manual' ? 'manuale' : line.assigned_by === 'ai_confirmed' ? 'AI confermata' : 'AI'}</span>
                              </div>
                              <p className="text-[11px] text-gray-700 mt-1 line-clamp-1">{line.line_description || '—'}</p>
                              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                                <span>Fatt. {line.invoice_number || '—'}</span>
                                <span>{fmtDate(line.invoice_date)}</span>
                                <span>{line.counterparty_name || '—'}</span>
                                {line.total_price != null && <span className="font-semibold text-gray-600">{fmtEur(line.total_price)}</span>}
                              </div>
                            </div>
                            <button
                              onClick={() => handleRemoveClassification(line.invoice_line_id)}
                              className="p-1 rounded text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors shrink-0"
                              title="Rimuovi assegnazione"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        {classifiedLines.length > 200 && (
                          <p className="px-4 py-2 text-[10px] text-gray-400">...e altre {classifiedLines.length - 200} righe</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ════ Skipped Lines Section (KPI click) ════ */}
              {activeKpi === 'skipped' && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Ban className="h-4 w-4 text-orange-500" />
                      Righe non classificabili ({skippedLines.length})
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {skippedLoading ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-orange-500" />
                        <span className="ml-2 text-sm text-gray-500">Caricamento...</span>
                      </div>
                    ) : skippedLines.length === 0 ? (
                      <p className="px-4 py-6 text-sm text-gray-400 text-center">Nessuna riga skipped</p>
                    ) : (
                      <div className="max-h-[50vh] overflow-y-auto divide-y">
                        {skippedLines.slice(0, 200).map(line => (
                          <div key={line.id} className="px-4 py-2.5 hover:bg-gray-50/50 flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-gray-700 line-clamp-1">{line.line_description || '(vuoto)'}</p>
                              <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                                <span>Fatt. {line.invoice_number || '—'}</span>
                                <span>{fmtDate(line.invoice_date)}</span>
                                <span>{line.counterparty_name || '—'}</span>
                                {line.total_price != null && <span className="font-semibold text-gray-600">{fmtEur(line.total_price)}</span>}
                              </div>
                            </div>
                            <Button
                              onClick={() => handleUnskipLine(line.id)}
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] text-blue-600 border-blue-300 hover:bg-blue-50 shrink-0"
                            >
                              <RefreshCw className="h-3 w-3 mr-1" /> Ripristina
                            </Button>
                          </div>
                        ))}
                        {skippedLines.length > 200 && (
                          <p className="px-4 py-2 text-[10px] text-gray-400">...e altre {skippedLines.length - 200} righe</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* ════ Matched Lines Section ════ */}
              {(activeKpi === 'with_match' || activeKpi === 'all' || activeKpi === 'to_analyze') && matchedLines.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                      Righe con match ({matchedLines.length})
                      {(filterMatchArticle || filterMatchConfidence) && (
                        <span className="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-normal">
                          Visualizzate: {filteredMatchedLines.length} di {matchedLines.length}
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>

                  {/* Filter bar */}
                  <div className="px-4 pb-3 flex flex-wrap items-center gap-2 border-b">
                    <Filter className="h-3 w-3 text-gray-400 shrink-0" />

                    <select
                      value={filterMatchArticle}
                      onChange={e => setFilterMatchArticle(e.target.value)}
                      className="text-[11px] border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400 max-w-[200px]"
                    >
                      <option value="">Tutti gli articoli</option>
                      {matchedArticles.map(a => (
                        <option key={a.id} value={a.id}>{a.code} — {a.name} ({a.count})</option>
                      ))}
                    </select>

                    <select
                      value={filterMatchConfidence}
                      onChange={e => setFilterMatchConfidence(e.target.value)}
                      className="text-[11px] border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                    >
                      <option value="">Tutte le confidence</option>
                      <option value="90">≥ 90%</option>
                      <option value="75">75–89%</option>
                      <option value="50">50–74%</option>
                      <option value="low">&lt; 50%</option>
                    </select>

                    {(filterMatchArticle || filterMatchConfidence) && (
                      <button
                        onClick={() => { setFilterMatchArticle(''); setFilterMatchConfidence('') }}
                        className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                      >
                        <X className="h-3 w-3" /> Reset filtri
                      </button>
                    )}

                    <div className="ml-auto">
                      <Button
                        onClick={confirmAllFiltered}
                        disabled={assignmentLoading || filteredMatchedLines.length === 0}
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 h-7 text-xs"
                      >
                        {assignmentLoading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                        {bulkProgress || (filteredMatchedLines.length === matchedLines.length ? `Conferma tutti` : `Conferma ${filteredMatchedLines.length} filtrati`)}
                      </Button>
                    </div>
                  </div>

                  <CardContent className="p-0">
                    <div className="max-h-[50vh] overflow-y-auto divide-y">
                      {filteredMatchedLines.map(line => {
                        const match = matchResults.get(line.id)!
                        const isConfirming = confirmingLineId === line.id
                        const displayArticle = articleOverrides.get(line.id) || match.article
                        const isOverridden = articleOverrides.has(line.id) && articleOverrides.get(line.id)!.id !== match.article.id
                        return (
                          <div
                            key={line.id}
                            className="px-4 py-3 hover:bg-gray-50/50 transition-colors cursor-pointer"
                            onDoubleClick={() => setInvoicePopup(line.invoice_id)}
                            title="Doppio click per vedere la fattura"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-0.5 ${
                                    match.source === 'ai'
                                      ? 'bg-purple-100 text-purple-700'
                                      : match.confidence >= 90 ? 'bg-emerald-100 text-emerald-700'
                                      : match.confidence >= 75 ? 'bg-blue-100 text-blue-700'
                                      : 'bg-amber-100 text-amber-700'
                                  }`}>
                                    {match.source === 'ai' && <Brain className="h-3 w-3" />}
                                    {Math.round(match.confidence)}%
                                  </span>
                                  {/* Clickable article badge with inline dropdown */}
                                  <div className="relative">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setDropdownLineId(dropdownLineId === line.id ? null : line.id)
                                        setDropdownSearch('')
                                      }}
                                      className={`text-[11px] font-mono font-bold px-1.5 py-0.5 rounded cursor-pointer transition-colors inline-flex items-center gap-0.5 ${
                                        isOverridden
                                          ? 'bg-purple-100 text-purple-700 ring-1 ring-purple-300'
                                          : 'bg-orange-50 text-orange-700 hover:bg-orange-100'
                                      }`}
                                      title="Click per cambiare articolo"
                                    >
                                      {displayArticle.code} <ChevronRight className="h-3 w-3 rotate-90" />
                                    </button>
                                    {dropdownLineId === line.id && (
                                      <div
                                        className="absolute left-0 top-full mt-1 z-50 bg-white border rounded-lg shadow-xl w-[280px] max-h-[260px] overflow-hidden"
                                        onClick={e => e.stopPropagation()}
                                      >
                                        <div className="p-2 border-b">
                                          <input
                                            autoFocus
                                            value={dropdownSearch}
                                            onChange={e => setDropdownSearch(e.target.value)}
                                            placeholder="Cerca articolo..."
                                            className="w-full text-[11px] border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400"
                                            onClick={e => e.stopPropagation()}
                                          />
                                        </div>
                                        <div className="overflow-y-auto max-h-[210px]">
                                          {articles
                                            .filter(a => a.active)
                                            .filter(a => {
                                              if (!dropdownSearch) return true
                                              const q = dropdownSearch.toLowerCase()
                                              return a.code.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)
                                            })
                                            .map(a => (
                                              <button
                                                key={a.id}
                                                onClick={() => changeLineArticle(line.id, a)}
                                                className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-orange-50 transition-colors flex items-center gap-2 ${
                                                  a.id === displayArticle.id ? 'bg-orange-100 font-bold' : ''
                                                }`}
                                              >
                                                <span className="font-mono text-orange-700 shrink-0">{a.code}</span>
                                                <span className="text-gray-600 truncate">{a.name}</span>
                                                {a.id === match.article.id && (
                                                  <span className="text-[9px] text-gray-400 ml-auto shrink-0">(suggerito)</span>
                                                )}
                                              </button>
                                            ))
                                          }
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                  <span className="text-[10px] text-gray-500">
                                    {displayArticle.name}
                                    {isOverridden && <span className="text-purple-500 ml-1 font-medium">(modificato)</span>}
                                  </span>
                                </div>
                                <p className="text-[11px] text-gray-700 mt-1 line-clamp-2">{line.description}</p>
                                <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400">
                                  <span className="text-blue-500 hover:underline cursor-pointer" onClick={(e) => { e.stopPropagation(); setInvoicePopup(line.invoice_id) }}>
                                    Fatt. {line.invoice_number || '—'}
                                  </span>
                                  <span>{fmtDate(line.invoice_date)}</span>
                                  <span>{line.counterparty_name || '—'}</span>
                                  {line.quantity != null && <span className="font-mono">{fmtNum(line.quantity)} {UNIT_SHORT[displayArticle.unit] || displayArticle.unit}</span>}
                                  {line.total_price != null && <span className="font-semibold text-gray-600">{fmtEur(line.total_price)}</span>}
                                </div>
                                <div className="flex items-center gap-1 mt-1 flex-wrap">
                                  {match.source === 'ai' ? (
                                    <>
                                      <span className="text-[9px] text-purple-500 font-medium inline-flex items-center gap-0.5"><Brain className="h-2.5 w-2.5" /> Analisi AI</span>
                                      {match.reasoning && (
                                        <span className="text-[9px] text-gray-400 italic" title={match.reasoning}>
                                          — {match.reasoning.length > 80 ? match.reasoning.slice(0, 80) + '...' : match.reasoning}
                                        </span>
                                      )}
                                    </>
                                  ) : (
                                    <>
                                      <span className="text-[9px] text-gray-400">Keywords:</span>
                                      {match.matchedKeywords.map(kw => (
                                        <span key={kw} className="text-[9px] text-emerald-600 bg-emerald-50 px-1 py-0.5 rounded">{kw}</span>
                                      ))}
                                    </>
                                  )}
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

              {/* ════ Unmatched Lines Section ════ */}
              {(activeKpi === 'to_analyze' || activeKpi === 'all' || activeKpi === 'with_match') && unmatchedLines.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-gray-500">
                      <AlertTriangle className="h-4 w-4 text-gray-400" />
                      Senza match ({unmatchedLines.length})
                      {(filterUnmatchText || filterUnmatchCounterparty) && (
                        <span className="text-[10px] text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full font-normal">
                          Visualizzate: {filteredUnmatchedLines.length} di {unmatchedLines.length}
                        </span>
                      )}
                    </CardTitle>
                  </CardHeader>

                  {/* Filter bar + bulk skip */}
                  <div className="px-4 pb-3 flex flex-wrap items-center gap-2 border-b">
                    <Filter className="h-3 w-3 text-gray-400 shrink-0" />

                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-400" />
                      <input
                        value={filterUnmatchText}
                        onChange={e => setFilterUnmatchText(e.target.value)}
                        placeholder="Cerca descrizione..."
                        className="text-[11px] border rounded pl-6 pr-2 py-1 w-[180px] focus:outline-none focus:ring-1 focus:ring-orange-400"
                      />
                    </div>

                    <select
                      value={filterUnmatchCounterparty}
                      onChange={e => setFilterUnmatchCounterparty(e.target.value)}
                      className="text-[11px] border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-orange-400 max-w-[220px]"
                    >
                      <option value="">Tutte le controparti</option>
                      {unmatchedCounterparties.map(cp => (
                        <option key={cp.name} value={cp.name}>{cp.name} ({cp.count})</option>
                      ))}
                    </select>

                    {(filterUnmatchText || filterUnmatchCounterparty) && (
                      <button
                        onClick={() => { setFilterUnmatchText(''); setFilterUnmatchCounterparty('') }}
                        className="text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-0.5"
                      >
                        <X className="h-3 w-3" /> Reset
                      </button>
                    )}

                    <div className="ml-auto">
                      <Button
                        onClick={skipAllFiltered}
                        disabled={bulkSkipping || filteredUnmatchedLines.length === 0}
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs text-orange-700 border-orange-300 hover:bg-orange-50"
                      >
                        {bulkSkipping ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <Ban className="h-3 w-3 mr-1" />}
                        Segna {filteredUnmatchedLines.length === unmatchedLines.length
                          ? `tutti (${unmatchedLines.length})`
                          : `${filteredUnmatchedLines.length} filtrati`} non classificabili
                      </Button>
                    </div>
                  </div>

                  <CardContent className="p-0">
                    <div className="max-h-[40vh] overflow-y-auto divide-y">
                      {filteredUnmatchedLines.slice(0, 200).map(line => (
                        <div
                          key={line.id}
                          className="px-4 py-2 text-[11px] hover:bg-gray-50 flex items-center gap-2"
                          onDoubleClick={() => setInvoicePopup(line.invoice_id)}
                          title="Doppio click per vedere la fattura"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="text-gray-600 line-clamp-1">{line.description || '(vuoto)'}</p>
                            <div className="flex items-center gap-3 mt-0.5 text-[10px] text-gray-400">
                              <span className="text-blue-500 hover:underline cursor-pointer" onClick={(e) => { e.stopPropagation(); setInvoicePopup(line.invoice_id) }}>
                                Fatt. {line.invoice_number || '—'}
                              </span>
                              <span>{fmtDate(line.invoice_date)}</span>
                              <span>{line.counterparty_name || '—'}</span>
                              {line.total_price != null && <span>{fmtEur(line.total_price)}</span>}
                            </div>
                          </div>
                          <button
                            onClick={() => skipLine(line.id)}
                            disabled={skippingIds.has(line.id)}
                            className="p-1 rounded text-orange-400 hover:bg-orange-50 hover:text-orange-600 transition-colors shrink-0"
                            title="Non classificabile"
                          >
                            {skippingIds.has(line.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      ))}
                      {filteredUnmatchedLines.length > 200 && (
                        <p className="px-4 py-2 text-[10px] text-gray-400">
                          ...e altre {filteredUnmatchedLines.length - 200} righe (usa i filtri per restringere)
                        </p>
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

      {/* Invoice detail popup (double-click from assignment tab) */}
      {invoicePopup && (
        <InvoiceDetailPopup invoiceId={invoicePopup} onClose={() => setInvoicePopup(null)} />
      )}
    </div>
  )
}

/* ─── Invoice Detail Popup ───────────────────── */

function InvoiceDetailPopup({ invoiceId, onClose }: {
  invoiceId: string; onClose: () => void
}) {
  const [invoice, setInvoice] = useState<any>(null)
  const [lines, setLines] = useState<any[]>([])
  const [installments, setInstallments] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const [{ data: inv }, { data: ll }, { data: inst }] = await Promise.all([
          supabase.from('invoices').select('*').eq('id', invoiceId).single(),
          supabase.from('invoice_lines').select('*').eq('invoice_id', invoiceId).order('line_number'),
          supabase.from('invoice_installments').select('*').eq('invoice_id', invoiceId).order('due_date'),
        ])
        if (cancelled) return
        setInvoice(inv)
        setLines(ll || [])
        setInstallments(inst || [])
      } catch (err) {
        console.error('Invoice load error:', err)
      }
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [invoiceId])

  const cp = invoice?.counterparty as any
  const cpName = cp?.denom || cp?.denominazione || '—'
  const direction = invoice?.direction === 'out' ? 'Attiva (Emessa)' : 'Passiva (Ricevuta)'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-hidden mx-4"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 bg-gray-50 border-b">
          <div className="flex items-center gap-3">
            <Eye className="h-4 w-4 text-blue-500" />
            <h3 className="font-semibold text-gray-900">
              {loading ? 'Caricamento...' : `Fattura ${invoice?.number || '—'}`}
            </h3>
            {invoice && (
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                invoice.direction === 'out' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'
              }`}>{direction}</span>
            )}
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-md transition-colors">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : invoice ? (
          <div className="overflow-y-auto max-h-[calc(85vh-56px)]">
            {/* Invoice summary */}
            <div className="px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-3 border-b bg-gray-50/50">
              <div>
                <p className="text-[10px] text-gray-400 uppercase">Numero</p>
                <p className="text-sm font-semibold text-gray-800">{invoice.number}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase">Data</p>
                <p className="text-sm font-semibold text-gray-800">{fmtDate(invoice.date)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase">Controparte</p>
                <p className="text-sm font-semibold text-gray-800 truncate">{cpName}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase">Importo totale</p>
                <p className="text-sm font-bold text-emerald-700">{fmtEur(invoice.total_amount)}</p>
              </div>
            </div>

            {/* Lines table */}
            <div className="px-5 py-3">
              <h4 className="text-xs font-semibold text-gray-700 mb-2">Righe ({lines.length})</h4>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-[11px]">
                  <thead className="bg-gray-50">
                    <tr className="border-b">
                      <th className="text-left px-3 py-2 font-medium text-gray-500 w-8">#</th>
                      <th className="text-left px-3 py-2 font-medium text-gray-500">Descrizione</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">Qtà</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">P.Unit</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">Totale</th>
                      <th className="text-right px-3 py-2 font-medium text-gray-500">IVA</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((l, i) => (
                      <tr key={l.id} className="hover:bg-gray-50/50">
                        <td className="px-3 py-1.5 text-gray-400">{l.line_number || i + 1}</td>
                        <td className="px-3 py-1.5 text-gray-800 max-w-[300px]">
                          <p className="line-clamp-2">{l.description || '—'}</p>
                        </td>
                        <td className="px-3 py-1.5 text-right font-mono">{l.quantity != null ? fmtNum(l.quantity) : '—'}</td>
                        <td className="px-3 py-1.5 text-right">{l.unit_price != null ? fmtEur(l.unit_price) : '—'}</td>
                        <td className="px-3 py-1.5 text-right font-semibold">{l.total_price != null ? fmtEur(l.total_price) : '—'}</td>
                        <td className="px-3 py-1.5 text-right text-gray-500">{l.vat_rate != null ? `${l.vat_rate}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Installments */}
            {installments.length > 0 && (
              <div className="px-5 py-3 border-t">
                <h4 className="text-xs font-semibold text-gray-700 mb-2">Scadenze ({installments.length})</h4>
                <div className="flex flex-wrap gap-2">
                  {installments.map(inst => (
                    <div key={inst.id} className="flex items-center gap-2 bg-gray-50 border rounded-lg px-3 py-1.5 text-[11px]">
                      <span className="text-gray-500">{fmtDate(inst.due_date)}</span>
                      <span className="font-semibold text-gray-800">{fmtEur(inst.amount)}</span>
                      {inst.paid && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-12 text-center text-sm text-gray-400">Fattura non trovata</div>
        )}
      </div>
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
