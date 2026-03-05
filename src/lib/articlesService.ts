/**
 * Articles Service — CRUD, keyword matching, stats, assignment
 * Pattern follows counterpartyService.ts
 */
import { supabase } from '@/integrations/supabase/client'

/* ─── types ──────────────────────────────────── */

export interface Article {
  id: string
  company_id: string
  code: string
  name: string
  description: string | null
  unit: string
  category: string | null
  direction: string | null   // 'in' (vendita), 'out' (acquisto), 'both', null
  active: boolean
  keywords: string[]
  created_at: string
  updated_at: string
}

export interface ArticleCreate {
  code: string
  name: string
  description?: string | null
  unit?: string
  category?: string | null
  direction?: string | null
  active?: boolean
  keywords?: string[]
}

export interface ArticleUpdate {
  code?: string
  name?: string
  description?: string | null
  unit?: string
  category?: string | null
  direction?: string | null
  active?: boolean
  keywords?: string[]
}

export interface InvoiceLineArticle {
  id: string
  company_id: string
  invoice_line_id: string
  invoice_id: string
  article_id: string
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  vat_rate: number | null
  assigned_by: 'manual' | 'ai_auto' | 'ai_confirmed'
  confidence: number | null
  verified: boolean
  location: string | null
  period_from: string | null
  period_to: string | null
  notes: string | null
  created_at: string
}

export interface ArticleStats {
  total_quantity: number
  total_revenue: number
  avg_price: number
  line_count: number
}

export interface MatchResult {
  article: Article
  confidence: number
  matchedKeywords: string[]
  totalKeywords: number
}

export interface UnassignedLine {
  id: string               // invoice_line.id
  invoice_id: string
  line_number: number | null
  description: string | null
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  vat_rate: number | null
  article_code: string | null
  invoice_number: string | null
  invoice_date: string | null
  counterparty_name: string | null
  invoice_direction: string | null
}

export interface DashboardArticleRow {
  article_id: string
  code: string
  name: string
  unit: string
  total_quantity: number
  total_revenue: number
  avg_price: number
  line_count: number
}

export interface ArticleLineRow {
  id: string
  invoice_line_id: string
  invoice_id: string
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  vat_rate: number | null
  assigned_by: string
  confidence: number | null
  verified: boolean
  location: string | null
  created_at: string
  invoice_number: string | null
  invoice_date: string | null
  counterparty_name: string | null
}

export type ArticleFilters = {
  query?: string
  category?: string | null
  activeOnly?: boolean
}

/* ─── CRUD ───────────────────────────────────── */

export async function loadArticles(
  companyId: string,
  filters?: ArticleFilters,
): Promise<Article[]> {
  let q = supabase
    .from('articles')
    .select('*')
    .eq('company_id', companyId)
    .order('code', { ascending: true })

  if (filters?.activeOnly) q = q.eq('active', true)
  if (filters?.category) q = q.eq('category', filters.category)

  const { data, error } = await q
  if (error) throw error

  let results = (data || []) as Article[]

  // Client-side text search (code + name + keywords)
  if (filters?.query) {
    const lq = filters.query.toLowerCase()
    results = results.filter(a =>
      a.code.toLowerCase().includes(lq) ||
      a.name.toLowerCase().includes(lq) ||
      a.keywords.some(k => k.toLowerCase().includes(lq)),
    )
  }

  return results
}

export async function createArticle(
  companyId: string,
  data: ArticleCreate,
): Promise<Article> {
  const { data: row, error } = await supabase
    .from('articles')
    .insert({
      company_id: companyId,
      code: data.code.trim(),
      name: data.name.trim(),
      description: data.description || null,
      unit: data.unit || 't',
      category: data.category || null,
      direction: data.direction || null,
      active: data.active ?? true,
      keywords: data.keywords || [],
    })
    .select()
    .single()
  if (error) throw error
  return row as Article
}

export async function updateArticle(
  articleId: string,
  data: ArticleUpdate,
): Promise<void> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (data.code !== undefined) updates.code = data.code.trim()
  if (data.name !== undefined) updates.name = data.name.trim()
  if (data.description !== undefined) updates.description = data.description
  if (data.unit !== undefined) updates.unit = data.unit
  if (data.category !== undefined) updates.category = data.category
  if (data.direction !== undefined) updates.direction = data.direction
  if (data.active !== undefined) updates.active = data.active
  if (data.keywords !== undefined) updates.keywords = data.keywords

  const { error } = await supabase.from('articles').update(updates).eq('id', articleId)
  if (error) throw error
}

export async function deleteArticle(articleId: string): Promise<void> {
  const { error } = await supabase.from('articles').delete().eq('id', articleId)
  if (error) throw error
}

/* ─── Article Stats ──────────────────────────── */

export async function loadArticleStats(
  articleId: string,
  companyId: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<ArticleStats> {
  // Using a manual query approach: load line articles + join invoice dates client-side
  let q = supabase
    .from('invoice_line_articles')
    .select('quantity, total_price, invoice_id')
    .eq('article_id', articleId)
    .eq('company_id', companyId)
    .eq('verified', true)

  const { data: lines, error } = await q
  if (error) throw error
  if (!lines || lines.length === 0) {
    return { total_quantity: 0, total_revenue: 0, avg_price: 0, line_count: 0 }
  }

  // If date filter is set, we need to filter by invoice date
  let filtered = lines
  if (dateFrom || dateTo) {
    const invoiceIds = [...new Set(lines.map(l => l.invoice_id))]
    let iq = supabase.from('invoices').select('id, date').in('id', invoiceIds)
    if (dateFrom) iq = iq.gte('date', dateFrom)
    if (dateTo) iq = iq.lte('date', dateTo)
    const { data: invoices } = await iq
    const validIds = new Set((invoices || []).map(i => i.id))
    filtered = lines.filter(l => validIds.has(l.invoice_id))
  }

  const totalQty = filtered.reduce((s, l) => s + Number(l.quantity || 0), 0)
  const totalRev = filtered.reduce((s, l) => s + Number(l.total_price || 0), 0)

  return {
    total_quantity: totalQty,
    total_revenue: totalRev,
    avg_price: totalQty > 0 ? totalRev / totalQty : 0,
    line_count: filtered.length,
  }
}

/* ─── Article Lines (associated invoice lines) ─ */

export async function loadArticleLines(
  articleId: string,
  companyId: string,
  verifiedOnly?: boolean,
): Promise<ArticleLineRow[]> {
  let q = supabase
    .from('invoice_line_articles')
    .select(`
      id, invoice_line_id, invoice_id,
      quantity, unit_price, total_price, vat_rate,
      assigned_by, confidence, verified, location, created_at,
      invoice:invoices(number, date, counterparty)
    `)
    .eq('article_id', articleId)
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (verifiedOnly) q = q.eq('verified', true)

  const { data, error } = await q
  if (error) throw error

  return (data || []).map((d: any) => ({
    id: d.id,
    invoice_line_id: d.invoice_line_id,
    invoice_id: d.invoice_id,
    quantity: d.quantity,
    unit_price: d.unit_price,
    total_price: d.total_price,
    vat_rate: d.vat_rate,
    assigned_by: d.assigned_by,
    confidence: d.confidence,
    verified: d.verified,
    location: d.location,
    created_at: d.created_at,
    invoice_number: d.invoice?.number || null,
    invoice_date: d.invoice?.date || null,
    counterparty_name:
      d.invoice?.counterparty && typeof d.invoice.counterparty === 'object'
        ? (d.invoice.counterparty as any).denom || null
        : null,
  }))
}

/* ─── Matching logic (deterministic, NO AI) ──── */

/**
 * Match a line description against all articles using keyword matching.
 * Returns the best match above threshold, or null.
 */
export function matchLineToArticle(
  lineDescription: string,
  articles: Article[],
): MatchResult | null {
  if (!lineDescription) return null
  const desc = lineDescription.toUpperCase()

  let bestMatch: MatchResult | null = null

  for (const article of articles) {
    const keywords = article.keywords || []
    if (keywords.length === 0 || !article.active) continue

    const matchedKeywords = keywords.filter(kw => desc.includes(kw.toUpperCase()))
    if (matchedKeywords.length === 0) continue

    const matchRatio = matchedKeywords.length / keywords.length
    const confidence = Math.min(matchRatio * 100, 98)

    if (!bestMatch || confidence > bestMatch.confidence) {
      bestMatch = {
        article,
        confidence,
        matchedKeywords,
        totalKeywords: keywords.length,
      }
    }
  }

  return bestMatch
}

/**
 * Extract location/site from invoice line description.
 * Common patterns in CAVECO invoices.
 */
export function extractLocation(description: string): string | null {
  if (!description) return null
  const patterns: RegExp[] = [
    /Cava\s+([\w\s]+?)\s*\(([A-Z]{2})\)/i,           // "Cava Serle (BS)"
    /Cava\s+([\w\s]+?)\s*[–\-]/i,                     // "Cava Ponte Lucano –"
    /Stabilimento\s+(?:di\s+)?([\w]+)/i,               // "Stabilimento di Guidonia"
    /([\w]+)\s*\((BS|RM|VC|VT|PG|AN)\)/i,             // "Paitone (BS)"
  ]

  for (const pattern of patterns) {
    const match = description.match(pattern)
    if (match) {
      // If the pattern has a province group, include it
      if (match[2]) return `${match[1].trim()} (${match[2]})`
      return match[1].trim()
    }
  }
  return null
}

/**
 * Suggest keywords from an article name.
 * Splits name into words, filters out short/common words, lowercases.
 */
export function suggestKeywords(name: string): string[] {
  if (!name) return []
  const stopWords = new Set([
    'di', 'da', 'a', 'in', 'per', 'con', 'su', 'e', 'il', 'la', 'lo', 'i', 'le', 'gli',
    'un', 'una', 'del', 'della', 'dello', 'dei', 'delle', 'degli', 'al', 'alla', 'allo',
    'mm', 'mt', 'kg', 'nr', 'pz', 'lt',
  ])

  return name
    .split(/[\s\-–,;.()\/]+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length >= 2 && !stopWords.has(w))
}

/* ─── Assignment ─────────────────────────────── */

export async function loadUnassignedLines(
  companyId: string,
  limit = 500,
): Promise<UnassignedLine[]> {
  // Get invoice line IDs already assigned
  const { data: assigned } = await supabase
    .from('invoice_line_articles')
    .select('invoice_line_id')
    .eq('company_id', companyId)

  const assignedIds = new Set((assigned || []).map(a => a.invoice_line_id))

  // Load invoice lines with invoice context
  const { data: lines, error } = await supabase
    .from('invoice_lines')
    .select(`
      id, invoice_id, line_number, description, quantity, unit_price, total_price, vat_rate, article_code,
      invoice:invoices!inner(number, date, direction, company_id, counterparty)
    `)
    .eq('invoice.company_id', companyId)
    .order('invoice_id', { ascending: false })
    .limit(2000)

  if (error) throw error

  const unassigned = (lines || [])
    .filter((l: any) => !assignedIds.has(l.id))
    .map((l: any) => ({
      id: l.id,
      invoice_id: l.invoice_id,
      line_number: l.line_number,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      total_price: l.total_price,
      vat_rate: l.vat_rate,
      article_code: l.article_code,
      invoice_number: l.invoice?.number || null,
      invoice_date: l.invoice?.date || null,
      counterparty_name:
        l.invoice?.counterparty && typeof l.invoice.counterparty === 'object'
          ? (l.invoice.counterparty as any).denom || null
          : null,
      invoice_direction: l.invoice?.direction || null,
    }))

  return unassigned.slice(0, limit)
}

export interface AssignLineData {
  quantity?: number | null
  unit_price?: number | null
  total_price?: number | null
  vat_rate?: number | null
}

export async function assignArticleToLine(
  companyId: string,
  invoiceLineId: string,
  invoiceId: string,
  articleId: string,
  lineData: AssignLineData,
  assignedBy: 'manual' | 'ai_auto' | 'ai_confirmed',
  confidence?: number,
  location?: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('invoice_line_articles')
    .upsert({
      company_id: companyId,
      invoice_line_id: invoiceLineId,
      invoice_id: invoiceId,
      article_id: articleId,
      quantity: lineData.quantity ?? null,
      unit_price: lineData.unit_price ?? null,
      total_price: lineData.total_price ?? null,
      vat_rate: lineData.vat_rate ?? null,
      assigned_by: assignedBy,
      confidence: confidence ?? null,
      verified: assignedBy === 'manual' || assignedBy === 'ai_confirmed',
      location: location ?? null,
    }, { onConflict: 'invoice_line_id' })

  if (error) throw error
}

export async function removeLineAssignment(invoiceLineId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_line_articles')
    .delete()
    .eq('invoice_line_id', invoiceLineId)
  if (error) throw error
}

/* ─── Feedback loop (rules) ──────────────────── */

export async function recordAssignmentFeedback(
  companyId: string,
  articleId: string,
  description: string,
  accepted: boolean,
): Promise<void> {
  // Build a pattern from the description keywords
  const keywords = description
    .toUpperCase()
    .split(/[\s\-–,;.()\/]+/)
    .filter(w => w.length >= 3)
    .slice(0, 8)

  if (keywords.length === 0) return

  const patternFilter = { description_contains: keywords }

  // Check if a rule already exists for this article + similar pattern
  const { data: existing } = await supabase
    .from('article_assignment_rules')
    .select('id, hit_count, reject_count, confidence')
    .eq('company_id', companyId)
    .eq('article_id', articleId)
    .limit(10)

  // Simple matching: find rule with overlapping keywords
  const matchingRule = (existing || []).find((r: any) => {
    // Can't easily compare JSONB patterns client-side, so just check first match
    return true // Take the first rule for this article
  })

  if (matchingRule && existing && existing.length > 0) {
    const rule = existing[0] as any
    if (accepted) {
      await supabase
        .from('article_assignment_rules')
        .update({
          hit_count: (rule.hit_count || 0) + 1,
          confidence: Math.min(0.98, (rule.confidence || 0.6) + 0.05),
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', rule.id)
    } else {
      const newRejectCount = (rule.reject_count || 0) + 1
      const newConfidence = Math.max(0, (rule.confidence || 0.6) - 0.15)
      if (newConfidence < 0.20) {
        // Remove rule if confidence too low
        await supabase.from('article_assignment_rules').delete().eq('id', rule.id)
      } else {
        await supabase
          .from('article_assignment_rules')
          .update({
            reject_count: newRejectCount,
            confidence: newConfidence,
            updated_at: new Date().toISOString(),
          })
          .eq('id', rule.id)
      }
    }
  } else if (accepted) {
    // Create new learned rule
    await supabase.from('article_assignment_rules').insert({
      company_id: companyId,
      article_id: articleId,
      pattern: patternFilter,
      confidence: 0.6,
      source: 'learned',
    })
  }
}

/* ─── Dashboard Stats ────────────────────────── */

export async function loadDashboardStats(
  companyId: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<DashboardArticleRow[]> {
  // Load all verified line articles
  const { data: lines, error: e1 } = await supabase
    .from('invoice_line_articles')
    .select('article_id, quantity, total_price, invoice_id')
    .eq('company_id', companyId)
    .eq('verified', true)

  if (e1) throw e1
  if (!lines || lines.length === 0) return []

  // If date filter, load matching invoices
  let validInvoiceIds: Set<string> | null = null
  if (dateFrom || dateTo) {
    const invoiceIds = [...new Set(lines.map(l => l.invoice_id))]
    let iq = supabase.from('invoices').select('id, date').in('id', invoiceIds)
    if (dateFrom) iq = iq.gte('date', dateFrom)
    if (dateTo) iq = iq.lte('date', dateTo)
    const { data: invoices } = await iq
    validInvoiceIds = new Set((invoices || []).map(i => i.id))
  }

  // Load articles for names
  const { data: articles } = await supabase
    .from('articles')
    .select('id, code, name, unit')
    .eq('company_id', companyId)

  const articleMap = new Map((articles || []).map(a => [a.id, a]))

  // Aggregate by article
  const agg = new Map<string, { qty: number; rev: number; count: number }>()
  for (const l of lines) {
    if (validInvoiceIds && !validInvoiceIds.has(l.invoice_id)) continue
    const prev = agg.get(l.article_id) || { qty: 0, rev: 0, count: 0 }
    prev.qty += Number(l.quantity || 0)
    prev.rev += Number(l.total_price || 0)
    prev.count++
    agg.set(l.article_id, prev)
  }

  const results: DashboardArticleRow[] = []
  for (const [artId, stats] of agg) {
    const art = articleMap.get(artId)
    if (!art) continue
    results.push({
      article_id: artId,
      code: art.code,
      name: art.name,
      unit: art.unit,
      total_quantity: stats.qty,
      total_revenue: stats.rev,
      avg_price: stats.qty > 0 ? stats.rev / stats.qty : 0,
      line_count: stats.count,
    })
  }

  return results.sort((a, b) => b.total_revenue - a.total_revenue)
}

/* ─── Categories helper ──────────────────────── */

export async function loadCategories(companyId: string): Promise<string[]> {
  const { data } = await supabase
    .from('articles')
    .select('category')
    .eq('company_id', companyId)
    .not('category', 'is', null)

  const cats = new Set<string>()
  for (const row of data || []) {
    if (row.category) cats.add(row.category)
  }
  return [...cats].sort()
}
