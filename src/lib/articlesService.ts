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

export interface ArticlePhase {
  id: string
  company_id: string
  article_id: string
  code: string
  name: string
  phase_type: 'cost' | 'revenue' | 'neutral'
  is_counting_point: boolean
  invoice_direction: 'in' | 'out' | null
  default_account_id: string | null
  default_category_id: string | null
  sort_order: number
  notes: string | null
  active: boolean
  created_at: string
}

export interface ArticleWithPhases extends Article {
  phases: ArticlePhase[]
}

export type PhasePreset = 'ciclo_completo' | 'acquisto_vendita' | 'solo_vendita' | 'personalizzato'

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
  phase_id: string | null
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
  phase_id?: string | null
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
    .select('id, article_id, phase_id, pattern, confidence, hit_count, reject_count, source')
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
  phaseId?: string | null,
): Promise<void> {
  const row: Record<string, unknown> = {
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
  }
  if (phaseId) row.phase_id = phaseId

  const { error } = await supabase
    .from('invoice_line_articles')
    .upsert(row, { onConflict: 'invoice_line_id' })

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
  phaseId?: string | null,
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
    const newRule: Record<string, unknown> = {
      company_id: companyId,
      article_id: articleId,
      pattern: { description_contains: descKeywords },
      confidence: 0.6,
      source: 'learned',
    }
    if (phaseId) newRule.phase_id = phaseId
    await supabase.from('article_assignment_rules').insert(newRule)
  }

  // RAG: create learning example for accepted assignments (fire-and-forget)
  if (accepted) {
    const { data: artData } = await supabase
      .from('articles').select('code, name').eq('id', articleId).single()
    if (artData) {
      createArticleExample(companyId, description, null, null,
        artData.code, artData.name, articleId, null, phaseId,
      ).catch(err => console.warn('[recordAssignmentFeedback] learning example error:', err))
    }
  }
}

/* ─── Batch feedback (bulk confirm perf optimization) ─── */

interface FeedbackItem {
  articleId: string
  description: string
  accepted: boolean
  phaseId?: string | null
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
  const newRuleMap = new Map<string, { articleId: string; keywords: string[]; hits: number; phaseId: string | null }>()

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
        newRuleMap.set(kwKey, { articleId: fb.articleId, keywords: descKeywords, hits: 1, phaseId: fb.phaseId || null })
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
  const newRules = [...newRuleMap.values()].map(nr => {
    const rule: Record<string, unknown> = {
      company_id: companyId,
      article_id: nr.articleId,
      pattern: { description_contains: nr.keywords },
      confidence: Math.min(0.6 + (nr.hits - 1) * 0.05, 0.95),
      source: 'learned',
      hit_count: nr.hits,
    }
    if (nr.phaseId) rule.phase_id = nr.phaseId
    return rule
  })
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
  // qty: only positive-price lines (exclude discounts/adjustments from production counting)
  // rev: all lines (negative amounts reduce net revenue — needed for accurate price-per-unit)
  const agg = new Map<string, { qty: number; rev: number; count: number }>()
  for (const l of lines) {
    if (validInvoiceIds && !validInvoiceIds.has(l.invoice_id)) continue
    const prev = agg.get(l.article_id) || { qty: 0, rev: 0, count: 0 }
    const tp = Number(l.total_price || 0)
    if (tp > 0) prev.qty += Number(l.quantity || 0) // only count positive-price lines for production
    prev.rev += tp                                   // all lines for economic breakdown
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
      avg_price: stats.qty > 0 ? stats.rev / stats.qty : 0, // net price per unit
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
  phase_id: string | null
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
        invoice_line_id, invoice_id, article_id, phase_id, confidence,
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
        phase_id: row.phase_id || null,
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
  phase_id: string | null
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
        invoice_line_id, invoice_id, article_id, phase_id, confidence, assigned_by,
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
        phase_id: row.phase_id || null,
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

/* ─── Phase CRUD ─────────────────────────────── */

export async function loadPhases(articleId: string): Promise<ArticlePhase[]> {
  const { data, error } = await supabase
    .from('article_phases')
    .select('*')
    .eq('article_id', articleId)
    .order('sort_order', { ascending: true })
  if (error) throw error
  return (data || []) as ArticlePhase[]
}

export async function createPhase(
  companyId: string,
  articleId: string,
  phase: Partial<ArticlePhase>,
): Promise<ArticlePhase> {
  const { data, error } = await supabase
    .from('article_phases')
    .insert({
      company_id: companyId,
      article_id: articleId,
      code: phase.code || 'custom',
      name: phase.name || 'Nuova fase',
      phase_type: phase.phase_type || 'cost',
      is_counting_point: phase.is_counting_point ?? false,
      invoice_direction: phase.invoice_direction || null,
      sort_order: phase.sort_order ?? 0,
      notes: phase.notes || null,
    })
    .select()
    .single()
  if (error) throw error
  return data as ArticlePhase
}

export async function updatePhase(
  phaseId: string,
  updates: Partial<ArticlePhase>,
): Promise<void> {
  const allowed: Record<string, unknown> = {}
  if (updates.code !== undefined) allowed.code = updates.code
  if (updates.name !== undefined) allowed.name = updates.name
  if (updates.phase_type !== undefined) allowed.phase_type = updates.phase_type
  if (updates.is_counting_point !== undefined) allowed.is_counting_point = updates.is_counting_point
  if (updates.invoice_direction !== undefined) allowed.invoice_direction = updates.invoice_direction
  if (updates.default_account_id !== undefined) allowed.default_account_id = updates.default_account_id
  if (updates.default_category_id !== undefined) allowed.default_category_id = updates.default_category_id
  if (updates.sort_order !== undefined) allowed.sort_order = updates.sort_order
  if (updates.notes !== undefined) allowed.notes = updates.notes
  if (updates.active !== undefined) allowed.active = updates.active

  const { error } = await supabase.from('article_phases').update(allowed).eq('id', phaseId)
  if (error) throw error
}

export async function deletePhase(phaseId: string): Promise<void> {
  const { error } = await supabase.from('article_phases').delete().eq('id', phaseId)
  if (error) throw error
}

/** Get phase preset template data */
export function getPhasePresetData(preset: PhasePreset): Partial<ArticlePhase>[] {
  switch (preset) {
    case 'ciclo_completo':
      return [
        { code: 'extraction',    name: 'Estrazione',         phase_type: 'cost',    is_counting_point: false, invoice_direction: 'in',  sort_order: 1 },
        { code: 'processing',    name: 'Lavorazione',        phase_type: 'cost',    is_counting_point: false, invoice_direction: 'in',  sort_order: 2 },
        { code: 'transport_in',  name: 'Trasporto Ingresso', phase_type: 'cost',    is_counting_point: false, invoice_direction: 'in',  sort_order: 3 },
        { code: 'transport_out', name: 'Trasporto Uscita',   phase_type: 'cost',    is_counting_point: false, invoice_direction: 'out', sort_order: 4 },
        { code: 'sale',          name: 'Vendita',            phase_type: 'revenue', is_counting_point: true,  invoice_direction: 'out', sort_order: 5 },
      ]
    case 'acquisto_vendita':
      return [
        { code: 'service',       name: 'Acquisto',           phase_type: 'cost',    is_counting_point: false, invoice_direction: 'in',  sort_order: 1 },
        { code: 'sale',          name: 'Vendita',            phase_type: 'revenue', is_counting_point: true,  invoice_direction: 'out', sort_order: 2 },
      ]
    case 'solo_vendita':
      return [
        { code: 'sale',          name: 'Vendita',            phase_type: 'revenue', is_counting_point: true,  invoice_direction: 'out', sort_order: 1 },
      ]
    default:
      return []
  }
}

/** Create phases from a preset template */
export async function createPhasesFromPreset(
  companyId: string,
  articleId: string,
  preset: PhasePreset,
): Promise<ArticlePhase[]> {
  const templates = getPhasePresetData(preset)
  if (templates.length === 0) return []

  const rows = templates.map(t => ({
    company_id: companyId,
    article_id: articleId,
    code: t.code || 'custom',
    name: t.name || 'Fase',
    phase_type: t.phase_type || 'cost',
    is_counting_point: t.is_counting_point ?? false,
    invoice_direction: t.invoice_direction || null,
    sort_order: t.sort_order ?? 0,
  }))

  const { data, error } = await supabase
    .from('article_phases')
    .upsert(rows, { onConflict: 'article_id,code', ignoreDuplicates: true })
    .select()

  if (error) throw error
  return (data || []) as ArticlePhase[]
}

/** Load all articles with their phases pre-loaded */
export async function loadArticlesWithPhases(
  companyId: string,
  filters?: ArticleFilters,
): Promise<ArticleWithPhases[]> {
  const articles = await loadArticles(companyId, filters)

  // Batch load all phases for this company's active articles
  const articleIds = articles.map(a => a.id)
  if (articleIds.length === 0) return articles.map(a => ({ ...a, phases: [] }))

  const { data: phases, error } = await supabase
    .from('article_phases')
    .select('*')
    .in('article_id', articleIds)
    .eq('active', true)
    .order('sort_order', { ascending: true })

  if (error) throw error

  const phasesByArticle = new Map<string, ArticlePhase[]>()
  for (const p of (phases || []) as ArticlePhase[]) {
    if (!phasesByArticle.has(p.article_id)) phasesByArticle.set(p.article_id, [])
    phasesByArticle.get(p.article_id)!.push(p)
  }

  return articles.map(a => ({ ...a, phases: phasesByArticle.get(a.id) || [] }))
}

/* ─── Dashboard by Phase ─────────────────────── */

export interface DashboardPhaseRow {
  article_id: string
  article_code: string
  article_name: string
  phase_id: string | null
  phase_code: string | null
  phase_name: string | null
  phase_type: string | null
  is_counting_point: boolean
  total_quantity: number
  total_amount: number
  avg_price: number
  line_count: number
}

export async function loadDashboardByPhase(
  companyId: string,
  year?: number,
): Promise<DashboardPhaseRow[]> {
  // Load all verified line articles with phase info
  const { data: lines, error: e1 } = await supabase
    .from('invoice_line_articles')
    .select('article_id, phase_id, quantity, total_price, invoice_id')
    .eq('company_id', companyId)
    .eq('verified', true)

  if (e1) throw e1
  if (!lines || lines.length === 0) return []

  // If year filter, load invoices for that year
  let validInvoiceIds: Set<string> | null = null
  if (year) {
    const invoiceIds = [...new Set(lines.map(l => l.invoice_id))]
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, date')
      .in('id', invoiceIds)
      .gte('date', `${year}-01-01`)
      .lte('date', `${year}-12-31`)
    validInvoiceIds = new Set((invoices || []).map(i => i.id))
  }

  // Load articles + phases
  const [{ data: articles }, { data: phases }] = await Promise.all([
    supabase.from('articles').select('id, code, name').eq('company_id', companyId),
    supabase.from('article_phases').select('id, article_id, code, name, phase_type, is_counting_point').eq('company_id', companyId),
  ])

  const artMap = new Map((articles || []).map(a => [a.id, a]))
  const phaseMap = new Map((phases || []).map(p => [p.id, p]))

  // Aggregate by article+phase
  const aggKey = (artId: string, phaseId: string | null) => `${artId}|${phaseId || '_'}`
  const agg = new Map<string, { artId: string; phaseId: string | null; qty: number; amt: number; count: number }>()

  for (const l of lines) {
    if (validInvoiceIds && !validInvoiceIds.has(l.invoice_id)) continue
    const key = aggKey(l.article_id, l.phase_id)
    const prev = agg.get(key) || { artId: l.article_id, phaseId: l.phase_id, qty: 0, amt: 0, count: 0 }
    const tp = Number(l.total_price || 0)
    if (tp > 0) prev.qty += Number(l.quantity || 0) // only count positive-price lines for production
    prev.amt += tp                                   // all lines for economic breakdown
    prev.count++
    agg.set(key, prev)
  }

  const results: DashboardPhaseRow[] = []
  for (const stats of agg.values()) {
    const art = artMap.get(stats.artId)
    if (!art) continue
    const phase = stats.phaseId ? phaseMap.get(stats.phaseId) : null
    results.push({
      article_id: stats.artId,
      article_code: art.code,
      article_name: art.name,
      phase_id: stats.phaseId,
      phase_code: phase?.code || null,
      phase_name: phase?.name || null,
      phase_type: phase?.phase_type || null,
      is_counting_point: phase?.is_counting_point ?? true, // null phase = legacy = counting
      total_quantity: stats.qty,
      total_amount: stats.amt,
      avg_price: stats.qty > 0 ? stats.amt / stats.qty : 0,
      line_count: stats.count,
    })
  }

  return results.sort((a, b) => {
    if (a.article_code !== b.article_code) return a.article_code.localeCompare(b.article_code)
    return (a.phase_code || 'zzz').localeCompare(b.phase_code || 'zzz')
  })
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
  invoice_id?: string
  invoice_direction?: string | null
}

export interface AiMatchResult {
  line_id: string
  article_id: string | null
  article_code: string | null
  confidence: number
  reasoning: string
}

/**
 * AI article matching via classify-invoice-lines edge function.
 * Groups lines by invoice_id, calls the unified classifier, extracts article assignments.
 */
export async function callArticleAiMatch(
  companyId: string,
  lines: AiMatchRequest[],
): Promise<AiMatchResult[]> {
  // Group lines by invoice_id (fall back to first line's invoice_id if missing)
  const byInvoice = new Map<string, AiMatchRequest[]>()
  for (const line of lines) {
    const invId = line.invoice_id || 'unknown'
    if (!byInvoice.has(invId)) byInvoice.set(invId, [])
    byInvoice.get(invId)!.push(line)
  }

  const allResults: AiMatchResult[] = []
  const { data: { session } } = await supabase.auth.getSession()
  const token = session?.access_token || ''

  for (const [invoiceId, invoiceLines] of byInvoice) {
    if (invoiceId === 'unknown') continue
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/classify-invoice-lines`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          company_id: companyId,
          invoice_id: invoiceId,
          lines: invoiceLines.map(l => ({
            line_id: l.line_id,
            description: l.description,
            quantity: l.quantity,
            unit_price: l.unit_price,
            total_price: l.total_price,
          })),
          direction: invoiceLines[0]?.invoice_direction || 'in',
          counterparty_name: invoiceLines[0]?.counterparty_name || '',
        }),
      })
      if (!res.ok) continue
      const data = await res.json()
      for (const lr of data.lines || []) {
        allResults.push({
          line_id: lr.line_id,
          article_id: lr.article_id || null,
          article_code: lr.article_code || null,
          confidence: (lr.confidence || 0) / 100, // normalize 0-100 → 0-1
          reasoning: lr.reasoning || '',
        })
      }
    } catch (err) {
      console.error(`[callArticleAiMatch] classify-invoice-lines error for invoice ${invoiceId}:`, err)
    }
  }
  return allResults
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
