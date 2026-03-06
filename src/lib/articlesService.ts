/**
 * Articles Service — CRUD, stats, assignment, feedback loop
 * Pattern follows counterpartyService.ts
 *
 * NOTE: Pure matching functions (matchLineToArticle, matchWithLearnedRules,
 * extractLocation, suggestKeywords) live in articleMatching.ts.
 * They are re-exported here for backward compatibility.
 */
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { createArticleExample } from '@/lib/learningService'

// Re-export matching functions from the shared utility
export {
  matchLineToArticle,
  matchWithLearnedRules,
  matchWithLearnedRulesAll,
  needsAiMatching,
  extractLocation,
  suggestKeywords,
  type LearnedRule,
  type AiMatchDecision,
} from '@/lib/articleMatching'

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
  source: 'deterministic' | 'ai'
  reasoning?: string
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

/* ─── Learned Rules: load from DB ─────────────── */

import type { LearnedRule } from '@/lib/articleMatching'

/**
 * Load all learned rules for a company from article_assignment_rules.
 * Pre-load these before calling matchWithLearnedRules().
 */
export async function loadLearnedRules(companyId: string): Promise<LearnedRule[]> {
  const { data, error } = await supabase
    .from('article_assignment_rules')
    .select('id, article_id, pattern, confidence, hit_count, reject_count, source')
    .eq('company_id', companyId)

  if (error) throw error
  return (data || []) as LearnedRule[]
}

/* ─── Classification Counts ──────────────────── */

export interface ClassificationCounts {
  total: number
  classified: number   // verified=true (confirmed assignments)
  with_match: number   // verified=false (AI suggestions)
  skipped: number
  to_analyze: number   // total - classified - with_match - skipped
}

/**
 * Load classification counts for the KPI bar.
 * - total: all invoice lines for this company
 * - classified: lines with verified=true in invoice_line_articles (confirmed)
 * - with_match: lines with verified=false in invoice_line_articles (AI suggestions)
 * - skipped: lines with classification_status = 'skipped'
 * - to_analyze: derived = total - classified - with_match - skipped
 */
export async function loadClassificationCounts(companyId: string): Promise<ClassificationCounts> {
  const [{ count: total }, { count: classified }, { count: with_match }, { count: skipped }] = await Promise.all([
    supabase
      .from('invoice_lines')
      .select('id, invoice:invoices!inner(company_id)', { count: 'exact', head: true })
      .eq('invoice.company_id', companyId),
    supabase
      .from('invoice_line_articles')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('verified', true),
    supabase
      .from('invoice_line_articles')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('verified', false),
    supabase
      .from('invoice_lines')
      .select('id, invoice:invoices!inner(company_id)', { count: 'exact', head: true })
      .eq('invoice.company_id', companyId)
      .eq('classification_status', 'skipped'),
  ])
  const t = total || 0
  const c = classified || 0
  const m = with_match || 0
  const s = skipped || 0
  return { total: t, classified: c, with_match: m, skipped: s, to_analyze: Math.max(0, t - c - m - s) }
}

/* ─── Skip (non-classificabile) ──────────────── */

/**
 * Mark a single invoice line as 'skipped' (non-classificabile).
 */
export async function markLineSkipped(lineId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_lines')
    .update({ classification_status: 'skipped' } as any)
    .eq('id', lineId)
  if (error) throw error
}

/**
 * Mark multiple invoice lines as 'skipped' in bulk.
 * Batches by 100 to stay within Supabase .in() limits.
 */
export async function markLinesSkippedBulk(lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return
  const BATCH = 100
  for (let i = 0; i < lineIds.length; i += BATCH) {
    const batch = lineIds.slice(i, i + BATCH)
    const { error } = await supabase
      .from('invoice_lines')
      .update({ classification_status: 'skipped' } as any)
      .in('id', batch)
    if (error) throw error
  }
}

/* ─── Assignment ─────────────────────────────── */

/**
 * Load ALL unassigned invoice lines (no LIMIT, no direction filter).
 * Paginates in batches of 1000 to bypass Supabase row limit.
 * Excludes lines already assigned AND lines marked as 'skipped'.
 * Returns lines from both active and passive invoices.
 *
 * @param onProgress optional callback for UI progress (loaded so far)
 */
export async function loadUnassignedLines(
  companyId: string,
  onProgress?: (loaded: number) => void,
): Promise<UnassignedLine[]> {
  // Step 1: Get all already-assigned invoice_line_ids (paginated)
  const assignedIds = new Set<string>()
  const BATCH = 1000
  let assignedPage = 0
  while (true) {
    const { data } = await supabase
      .from('invoice_line_articles')
      .select('invoice_line_id')
      .eq('company_id', companyId)
      .range(assignedPage * BATCH, (assignedPage + 1) * BATCH - 1)
    if (!data || data.length === 0) break
    for (const row of data) assignedIds.add(row.invoice_line_id)
    if (data.length < BATCH) break
    assignedPage++
  }

  // Step 2: Load ALL invoice lines (paginated, exclude 'skipped')
  let allLines: any[] = []
  let page = 0
  while (true) {
    const from = page * BATCH
    const to = from + BATCH - 1
    const { data, error } = await supabase
      .from('invoice_lines')
      .select(`
        id, invoice_id, line_number, description, quantity, unit_price, total_price, vat_rate, article_code,
        classification_status,
        invoice:invoices!inner(number, date, direction, company_id, counterparty)
      `)
      .eq('invoice.company_id', companyId)
      .neq('classification_status', 'skipped')
      .order('invoice_id', { ascending: false })
      .range(from, to)

    if (error) throw error
    if (!data || data.length === 0) break
    allLines = allLines.concat(data)
    onProgress?.(allLines.length)
    if (data.length < BATCH) break
    page++
  }

  // Step 3: Filter out already-assigned and map to UnassignedLine
  return allLines
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

/** Stop words to exclude from keyword extraction (Italian prepositions, articles, etc.) */
const STOP_WORDS = new Set([
  'DI','IN','DA','DEL','DELLA','DELLE','DEGLI','AL','ALLA','ALLE',
  'IL','LA','LE','LO','GLI','UN','UNA','PER','CON','SU','TRA','FRA',
  'VIA','INF','SUP','PRESSO','NELLA','NELLE','NEL','SONO','COME','CHE',
  'NON','KM','NR','CEP','ORD','ORDINE',
])

/**
 * Extract significant keywords from a description.
 * Filters out stop words, short words (≤3 chars), and pure numbers.
 * Returns max 5 uppercase keywords.
 */
export function extractSignificantKeywords(description: string): string[] {
  return description
    .toUpperCase()
    .replace(/['']/g, ' ')
    .split(/[\s.,\-–()/]+/)
    .filter(w => w.length > 3)
    .filter(w => !STOP_WORDS.has(w))
    .filter(w => !/^\d+$/.test(w))
    .slice(0, 5)
}

/**
 * Record feedback for an article assignment.
 *
 * Behavior:
 * - ACCEPTED: find existing rule matching ≥50% of keywords → update hit_count++,
 *   confidence += 0.05. If no rule found, create a new learned rule.
 * - REJECTED: find existing rule → reject_count++, confidence -= 0.15.
 *   Delete rule if confidence drops below 0.20.
 *
 * Pattern matching: a rule "matches" if ≥50% of its stored keywords
 * overlap with the description's keywords (case-insensitive).
 */
export async function recordAssignmentFeedback(
  companyId: string,
  articleId: string,
  description: string,
  accepted: boolean,
): Promise<void> {
  // Build significant keywords from description (filter out stop words, short words, numbers)
  const descKeywords = extractSignificantKeywords(description)

  if (descKeywords.length === 0) return

  // Load existing rules for this article
  const { data: existing } = await supabase
    .from('article_assignment_rules')
    .select('id, pattern, hit_count, reject_count, confidence')
    .eq('company_id', companyId)
    .eq('article_id', articleId)

  // Find rule with highest keyword overlap (≥50% of rule's keywords must be in description)
  let bestRule: any = null
  let bestOverlap = 0

  for (const rule of existing || []) {
    const ruleKeywords: string[] = (rule.pattern as any)?.description_contains || []
    if (ruleKeywords.length === 0) continue

    const overlap = ruleKeywords.filter(kw => descKeywords.includes(kw.toUpperCase())).length
    const overlapRatio = overlap / ruleKeywords.length

    if (overlapRatio >= 0.5 && overlap > bestOverlap) {
      bestRule = rule
      bestOverlap = overlap
    }
  }

  if (bestRule) {
    if (accepted) {
      await supabase
        .from('article_assignment_rules')
        .update({
          hit_count: (bestRule.hit_count || 0) + 1,
          confidence: Math.min(0.98, (bestRule.confidence || 0.6) + 0.05),
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', bestRule.id)
    } else {
      const newRejectCount = (bestRule.reject_count || 0) + 1
      const newConfidence = Math.max(0, (bestRule.confidence || 0.6) - 0.15)
      if (newConfidence < 0.20) {
        // Remove rule if confidence drops too low
        await supabase.from('article_assignment_rules').delete().eq('id', bestRule.id)
      } else {
        await supabase
          .from('article_assignment_rules')
          .update({
            reject_count: newRejectCount,
            confidence: newConfidence,
            updated_at: new Date().toISOString(),
          })
          .eq('id', bestRule.id)
      }
    }
  } else if (accepted) {
    // No matching rule found — create a new learned rule
    await supabase.from('article_assignment_rules').insert({
      company_id: companyId,
      article_id: articleId,
      pattern: { description_contains: descKeywords },
      confidence: 0.6,
      source: 'learned',
    })
  }

  // RAG: create learning example for accepted assignments (fire-and-forget)
  if (accepted) {
    const { data: artData } = await supabase
      .from('articles').select('code, name').eq('id', articleId).single()
    if (artData) {
      createArticleExample(companyId, description, null, null,
        artData.code, artData.name, articleId, null,
      ).catch(err => console.warn('[recordAssignmentFeedback] learning example error:', err))
    }
  }
}

/* ─── Batch feedback (bulk confirm perf optimization) ─── */

interface FeedbackItem {
  articleId: string
  description: string
  accepted: boolean
}

/**
 * Batch version of recordAssignmentFeedback.
 * Instead of N × (SELECT + UPDATE) per line, does:
 *   1× SELECT all rules → in-memory matching → M updates + K inserts
 *
 * For 137 lines matching ~10 rules: 1 SELECT + ~10 UPDATE + 1 INSERT = ~12 DB calls
 * vs 137 SELECT + 137 UPDATE = 274 DB calls.
 */
export async function batchRecordFeedback(
  companyId: string,
  feedbacks: FeedbackItem[],
): Promise<void> {
  if (feedbacks.length === 0) return

  // 1. Load ALL rules for this company once
  const { data: allRules } = await supabase
    .from('article_assignment_rules')
    .select('id, article_id, pattern, hit_count, reject_count, confidence')
    .eq('company_id', companyId)

  const rules = allRules || []

  // 2. In-memory: accumulate deltas per rule + collect new rules
  const ruleDelta = new Map<string, { hits: number; rejects: number; currentHits: number; currentRejects: number; currentConf: number }>()
  // Track new rules needed: key = articleId|kw_key
  const newRuleMap = new Map<string, { articleId: string; keywords: string[]; hits: number }>()

  for (const fb of feedbacks) {
    const descKeywords = extractSignificantKeywords(fb.description)
    if (descKeywords.length === 0) continue

    // Find matching rule for this article
    const articleRules = rules.filter(r => r.article_id === fb.articleId)
    let bestRule: typeof rules[0] | null = null
    let bestOverlap = 0

    for (const rule of articleRules) {
      const ruleKeywords: string[] = (rule.pattern as any)?.description_contains || []
      if (ruleKeywords.length === 0) continue
      const overlap = ruleKeywords.filter(kw => descKeywords.includes(kw.toUpperCase())).length
      const overlapRatio = overlap / ruleKeywords.length
      if (overlapRatio >= 0.5 && overlap > bestOverlap) {
        bestRule = rule
        bestOverlap = overlap
      }
    }

    if (bestRule) {
      const existing = ruleDelta.get(bestRule.id) || {
        hits: 0, rejects: 0,
        currentHits: bestRule.hit_count || 0,
        currentRejects: bestRule.reject_count || 0,
        currentConf: bestRule.confidence || 0.6,
      }
      if (fb.accepted) existing.hits++
      else existing.rejects++
      ruleDelta.set(bestRule.id, existing)
    } else if (fb.accepted) {
      // No rule found → accumulate for new rule creation
      const kwKey = `${fb.articleId}|${descKeywords.join('|')}`
      const existing = newRuleMap.get(kwKey)
      if (existing) {
        existing.hits++
      } else {
        newRuleMap.set(kwKey, { articleId: fb.articleId, keywords: descKeywords, hits: 1 })
      }
    }
  }

  // 3. Batch updates: one UPDATE per modified rule
  const updatePromises: PromiseLike<any>[] = []
  for (const [ruleId, delta] of ruleDelta) {
    const newHits = delta.currentHits + delta.hits
    const newRejects = delta.currentRejects + delta.rejects
    const confChange = (delta.hits * 0.05) - (delta.rejects * 0.15)
    const newConf = Math.max(0, Math.min(0.98, delta.currentConf + confChange))

    if (newConf < 0.20) {
      updatePromises.push(
        supabase.from('article_assignment_rules').delete().eq('id', ruleId).then()
      )
    } else {
      updatePromises.push(
        supabase.from('article_assignment_rules').update({
          hit_count: newHits,
          reject_count: newRejects,
          confidence: newConf,
          last_used_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('id', ruleId).then()
      )
    }
  }
  // Run rule updates in parallel (typically ~10 rules)
  if (updatePromises.length > 0) await Promise.all(updatePromises)

  // 4. Bulk insert new rules
  const newRules = [...newRuleMap.values()].map(nr => ({
    company_id: companyId,
    article_id: nr.articleId,
    pattern: { description_contains: nr.keywords },
    confidence: Math.min(0.6 + (nr.hits - 1) * 0.05, 0.95),
    source: 'learned',
    hit_count: nr.hits,
  }))
  if (newRules.length > 0) {
    await supabase.from('article_assignment_rules').insert(newRules)
  }

  // RAG: create learning examples for all accepted feedbacks (fire-and-forget)
  const acceptedFbs = feedbacks.filter(fb => fb.accepted)
  if (acceptedFbs.length > 0) {
    try {
      const articleIds = [...new Set(acceptedFbs.map(fb => fb.articleId))]
      const { data: arts } = await supabase
        .from('articles').select('id, code, name').in('id', articleIds)
      const artMap = new Map((arts || []).map(a => [a.id, a]))

      for (const fb of acceptedFbs) {
        const art = artMap.get(fb.articleId)
        if (!art) continue
        createArticleExample(companyId, fb.description, null, null,
          art.code, art.name, fb.articleId, null,
        ).catch(() => { /* silent */ })
      }
    } catch (err) {
      console.warn('[batchRecordFeedback] learning examples error:', err)
    }
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

/* ─── Bulk Suggestions (persist AI analysis) ──── */

export interface BulkSuggestion {
  invoice_line_id: string
  invoice_id: string
  article_id: string
  confidence: number
}

export interface SavedSuggestion {
  invoice_line_id: string
  invoice_id: string
  article_id: string
  confidence: number
  article_code: string
  article_name: string
  article_unit: string
  article_keywords: string[]
  line_description: string | null
  line_number: number | null
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  vat_rate: number | null
  article_code_xml: string | null
  invoice_number: string | null
  invoice_date: string | null
  counterparty_name: string | null
  invoice_direction: string | null
}

/**
 * Delete all unverified (AI) suggestions for a company.
 * Called before re-running analysis to clear stale results.
 */
export async function deleteBulkSuggestions(companyId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_line_articles')
    .delete()
    .eq('company_id', companyId)
    .eq('verified', false)
  if (error) throw error
}

/**
 * Save bulk AI suggestions to DB.
 * Uses upsert with ignoreDuplicates to avoid overwriting verified=true records.
 * Batches by 500 to stay within Supabase limits.
 */
export async function saveBulkSuggestions(
  companyId: string,
  suggestions: BulkSuggestion[],
): Promise<void> {
  if (suggestions.length === 0) return
  const BATCH = 500
  for (let i = 0; i < suggestions.length; i += BATCH) {
    const batch = suggestions.slice(i, i + BATCH).map(s => ({
      company_id: companyId,
      invoice_line_id: s.invoice_line_id,
      invoice_id: s.invoice_id,
      article_id: s.article_id,
      assigned_by: 'ai_auto' as const,
      confidence: s.confidence,
      verified: false,
    }))
    const { error } = await supabase
      .from('invoice_line_articles')
      .upsert(batch, { onConflict: 'invoice_line_id', ignoreDuplicates: true })
    if (error) throw error
  }
}

/**
 * Load saved AI suggestions (verified=false) for a company.
 * Returns enriched data with article info + invoice line details.
 * Paginated in batches of 1000.
 */
export async function loadSavedSuggestions(companyId: string): Promise<SavedSuggestion[]> {
  const BATCH = 1000
  let all: SavedSuggestion[] = []
  let page = 0

  while (true) {
    const from = page * BATCH
    const to = from + BATCH - 1
    const { data, error } = await supabase
      .from('invoice_line_articles')
      .select(`
        invoice_line_id, invoice_id, article_id, confidence,
        article:articles!inner(code, name, unit, keywords),
        line:invoice_lines!inner(description, line_number, quantity, unit_price, total_price, vat_rate, article_code),
        invoice:invoices!inner(number, date, direction, counterparty)
      `)
      .eq('company_id', companyId)
      .eq('verified', false)
      .range(from, to)

    if (error) throw error
    if (!data || data.length === 0) break

    for (const row of data as any[]) {
      all.push({
        invoice_line_id: row.invoice_line_id,
        invoice_id: row.invoice_id,
        article_id: row.article_id,
        confidence: row.confidence,
        article_code: row.article?.code || '',
        article_name: row.article?.name || '',
        article_unit: row.article?.unit || 't',
        article_keywords: row.article?.keywords || [],
        line_description: row.line?.description || null,
        line_number: row.line?.line_number ?? null,
        quantity: row.line?.quantity ?? null,
        unit_price: row.line?.unit_price ?? null,
        total_price: row.line?.total_price ?? null,
        vat_rate: row.line?.vat_rate ?? null,
        article_code_xml: row.line?.article_code || null,
        invoice_number: row.invoice?.number || null,
        invoice_date: row.invoice?.date || null,
        counterparty_name:
          row.invoice?.counterparty && typeof row.invoice.counterparty === 'object'
            ? (row.invoice.counterparty as any).denom || null
            : null,
        invoice_direction: row.invoice?.direction || null,
      })
    }

    if (data.length < BATCH) break
    page++
  }

  return all
}

/* ─── Classified + Skipped views ─────────────── */

export interface ClassifiedLine {
  invoice_line_id: string
  invoice_id: string
  article_id: string
  article_code: string
  article_name: string
  confidence: number | null
  assigned_by: string
  line_description: string | null
  quantity: number | null
  total_price: number | null
  invoice_number: string | null
  invoice_date: string | null
  counterparty_name: string | null
}

export interface SkippedLine {
  id: string            // invoice_line.id
  invoice_id: string
  line_description: string | null
  quantity: number | null
  total_price: number | null
  invoice_number: string | null
  invoice_date: string | null
  counterparty_name: string | null
}

/**
 * Load all confirmed (verified=true) line-article assignments.
 */
export async function loadClassifiedLines(companyId: string): Promise<ClassifiedLine[]> {
  const BATCH = 1000
  let all: ClassifiedLine[] = []
  let page = 0

  while (true) {
    const from = page * BATCH
    const to = from + BATCH - 1
    const { data, error } = await supabase
      .from('invoice_line_articles')
      .select(`
        invoice_line_id, invoice_id, article_id, confidence, assigned_by,
        article:articles!inner(code, name),
        line:invoice_lines!inner(description, quantity, total_price),
        invoice:invoices!inner(number, date, counterparty)
      `)
      .eq('company_id', companyId)
      .eq('verified', true)
      .range(from, to)

    if (error) throw error
    if (!data || data.length === 0) break

    for (const row of data as any[]) {
      all.push({
        invoice_line_id: row.invoice_line_id,
        invoice_id: row.invoice_id,
        article_id: row.article_id,
        article_code: row.article?.code || '',
        article_name: row.article?.name || '',
        confidence: row.confidence,
        assigned_by: row.assigned_by,
        line_description: row.line?.description || null,
        quantity: row.line?.quantity ?? null,
        total_price: row.line?.total_price ?? null,
        invoice_number: row.invoice?.number || null,
        invoice_date: row.invoice?.date || null,
        counterparty_name:
          row.invoice?.counterparty && typeof row.invoice.counterparty === 'object'
            ? (row.invoice.counterparty as any).denom || null
            : null,
      })
    }

    if (data.length < BATCH) break
    page++
  }

  return all
}

/**
 * Load all skipped (classification_status='skipped') invoice lines.
 */
export async function loadSkippedLines(companyId: string): Promise<SkippedLine[]> {
  const BATCH = 1000
  let all: SkippedLine[] = []
  let page = 0

  while (true) {
    const from = page * BATCH
    const to = from + BATCH - 1
    const { data, error } = await supabase
      .from('invoice_lines')
      .select(`
        id, invoice_id, description, quantity, total_price,
        invoice:invoices!inner(number, date, company_id, counterparty)
      `)
      .eq('invoice.company_id', companyId)
      .eq('classification_status', 'skipped')
      .range(from, to)

    if (error) throw error
    if (!data || data.length === 0) break

    for (const row of data as any[]) {
      all.push({
        id: row.id,
        invoice_id: row.invoice_id,
        line_description: row.description || null,
        quantity: row.quantity ?? null,
        total_price: row.total_price ?? null,
        invoice_number: row.invoice?.number || null,
        invoice_date: row.invoice?.date || null,
        counterparty_name:
          row.invoice?.counterparty && typeof row.invoice.counterparty === 'object'
            ? (row.invoice.counterparty as any).denom || null
            : null,
      })
    }

    if (data.length < BATCH) break
    page++
  }

  return all
}

/**
 * Unskip a previously skipped line (set back to 'pending').
 */
export async function unskipLine(lineId: string): Promise<void> {
  const { error } = await supabase
    .from('invoice_lines')
    .update({ classification_status: 'pending' } as any)
    .eq('id', lineId)
  if (error) throw error
}

/* ─── Categories helper ──────────────────────── */

/* ─── AI Article Matching (Haiku Level 2) ────── */

export interface AiMatchRequest {
  line_id: string
  description: string
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  invoice_number: string | null
  counterparty_name: string | null
}

export interface AiMatchResult {
  line_id: string
  article_id: string | null
  article_code: string | null
  confidence: number
  reasoning: string
}

/**
 * Call the article-ai-match edge function for ambiguous lines.
 * Max 20 lines per call. Returns AI classification results.
 */
export async function callArticleAiMatch(
  companyId: string,
  lines: AiMatchRequest[],
): Promise<AiMatchResult[]> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/article-ai-match`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ company_id: companyId, lines }),
  })

  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }

  const data = await res.json()
  return data.results || []
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
