/**
 * classificationPipelineService — Frontend orchestrator for the v2 cascade pipeline.
 *
 * Pipeline steps (sequential, per invoice):
 *   1. classify-v2-deterministic → instant rules + history matches
 *   2. classify-v2-understand    → comprehension (what is this operation?)
 *   3. classify-v2-classify      → account/category/article assignment
 *   4. classify-v2-cdc           → cost center assignment for ALL lines
 *   5. fiscal-reviewer           → fiscal flags validation + alerts
 *   6. Persist results to DB (same pattern as classify-invoice-lines)
 *
 * Designed to be called from FatturePage via useAIJob pattern.
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

/* ─── Types ──────────────────────────────────── */

interface InputLine {
  line_id: string
  description: string
  quantity: number | null
  unit_price: number | null
  total_price: number | null
}

interface DeterministicResult {
  line_id: string
  category_id: string | null
  account_id: string | null
  article_id: string | null
  phase_id: string | null
  cost_center_allocations: { project_id: string; percentage: number }[] | null
  fiscal_flags: Record<string, unknown> | null
  confidence: number
  reasoning: string
  source: 'rule' | 'history'
  rule_id: string | null
  matched_groups: string[]
}

interface UnresolvedLine extends InputLine {
  matched_groups: string[]
}

interface Understanding {
  line_id: string
  operation_type: string
  account_sections: string[]
  is_NOT: string[]
  reasoning: string
}

interface ClassifyResult {
  line_id: string
  article_code: string | null
  phase_code: string | null
  category_id: string | null
  category_name: string | null
  account_id: string | null
  account_code: string | null
  confidence: number
  reasoning: string
  fiscal_flags: Record<string, unknown>
  suggest_new_account?: Record<string, string> | null
  suggest_new_category?: Record<string, string> | null
}

interface CdcAllocation {
  line_id: string
  cost_center_allocations: { project_id: string; percentage: number }[]
}

interface ReviewResult {
  line_id: string
  fiscal_flags_corrected: Record<string, unknown>
  issues: string[]
  confidence_adjustment: number
}

interface FiscalAlert {
  type: string
  severity: 'warning' | 'info'
  title: string
  description: string
  current_choice: string
  options: { label: string; fiscal_override: Record<string, unknown>; is_default: boolean }[]
  affected_lines: string[]
}

export interface PipelineResult {
  lines: {
    line_id: string
    category_id: string | null
    account_id: string | null
    account_code: string | null
    article_id: string | null
    phase_id: string | null
    cost_center_allocations: { project_id: string; percentage: number }[]
    confidence: number
    reasoning: string
    fiscal_flags: Record<string, unknown>
    source: string
    rule_id?: string | null
    suggest_new_account?: Record<string, string> | null
    suggest_new_category?: Record<string, string> | null
  }[]
  alerts: FiscalAlert[]
  stats: {
    total: number
    deterministic: number
    ai_classified: number
    cdc_assigned: number
    fiscal_issues: number
  }
}

/* ─── API call helper ────────────────────────── */

async function callEdge(
  functionName: string,
  body: Record<string, unknown>,
  token: string,
  signal?: AbortSignal,
): Promise<any> {
  let res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(body),
    signal,
  })

  // 401 = JWT expired → force refresh and retry once
  if (res.status === 401) {
    const newToken = await getValidAccessToken({ forceRefresh: true })
    res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${newToken}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(body),
      signal,
    })
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${functionName} HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  return res.json()
}

/* ─── Persistence (via supabase client, mirrors classify-invoice-lines) ── */

async function persistPipelineResults(
  companyId: string,
  invoiceId: string,
  result: PipelineResult,
): Promise<void> {
  const MIN_CONFIDENCE = 60

  for (const lr of result.lines) {
    if (lr.confidence < MIN_CONFIDENCE) {
      // Still mark low-confidence lines for review
      await supabase.from('invoice_lines').update({
        ai_confidence: Math.round(lr.confidence),
        needs_review: true,
      } as any).eq('id', lr.line_id)
      continue
    }

    // Update line classification
    if (lr.category_id || lr.account_id) {
      const needsReview = lr.confidence < 65
        || !!(lr.fiscal_flags?.note && /verificar|controllare|dubbio/i.test(String(lr.fiscal_flags.note || '')))
        || lr.suggest_new_account != null

      await supabase.from('invoice_lines').update({
        category_id: lr.category_id,
        account_id: lr.account_id,
        fiscal_flags: lr.fiscal_flags,
        classification_status: 'ai_suggested',
        ai_confidence: Math.round(lr.confidence),
        needs_review: needsReview,
      } as any).eq('id', lr.line_id).is('category_id', null)
    }

    // CdC allocations
    for (const pa of lr.cost_center_allocations || []) {
      try {
        await supabase.from('invoice_line_projects').upsert({
          company_id: companyId,
          invoice_id: invoiceId,
          invoice_line_id: lr.line_id,
          project_id: pa.project_id,
          percentage: pa.percentage,
          assigned_by: 'ai_auto',
        } as any, { onConflict: 'invoice_line_id,project_id' })
      } catch { /* ignore duplicate */ }
    }
  }

  // Invoice-level classification (weighted best)
  const classified = result.lines.filter(l => l.confidence >= MIN_CONFIDENCE && (l.category_id || l.account_id))
  if (classified.length > 0) {
    // Best category/account by weighted confidence
    const best = classified.reduce((a, b) =>
      (Math.abs(b.confidence) > Math.abs(a.confidence)) ? b : a
    )
    const avgConf = Math.round(classified.reduce((s, l) => s + l.confidence, 0) / classified.length)

    await supabase.from('invoice_classifications').upsert({
      company_id: companyId,
      invoice_id: invoiceId,
      category_id: best.category_id,
      account_id: best.account_id,
      assigned_by: 'ai_auto',
      verified: false,
      ai_confidence: avgConf,
      ai_reasoning: `Pipeline v2: ${result.stats.deterministic} deterministiche, ${result.stats.ai_classified} AI. Conf. media: ${avgConf}%`,
      invoice_notes: result.alerts.length > 0 ? JSON.stringify(result.alerts) : null,
    } as any, { onConflict: 'invoice_id' })
  }

  // Set has_fiscal_alerts flag on invoice
  await supabase.from('invoices').update({
    has_fiscal_alerts: result.alerts.length > 0,
    classification_status: 'ai_suggested',
  } as any).eq('id', invoiceId)
}

/* ─── Main pipeline executor ─────────────────── */

export async function runClassificationPipeline(
  companyId: string,
  invoiceId: string,
  lines: InputLine[],
  direction: 'in' | 'out',
  counterpartyVatKey: string | null,
  counterpartyName: string | null,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const token = await getValidAccessToken()
  const commonBody = {
    company_id: companyId,
    invoice_id: invoiceId,
    direction,
    counterparty_vat_key: counterpartyVatKey,
    counterparty_name: counterpartyName,
  }

  // ─── Step 1: Deterministic (rules + history) ──────────
  const step1 = await callEdge('classify-v2-deterministic', {
    ...commonBody,
    lines: lines.map(l => ({
      line_id: l.line_id,
      description: l.description,
      quantity: l.quantity,
      unit_price: l.unit_price,
      total_price: l.total_price,
    })),
  }, token, signal)

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

  const resolved: DeterministicResult[] = step1.resolved || []
  const unresolved: UnresolvedLine[] = step1.unresolved || []

  // Merge deterministic results into final format
  const lineResults = new Map<string, PipelineResult['lines'][0]>()
  for (const r of resolved) {
    // Use fiscal_flags from rule if available, otherwise defaults
    const defaultFlags = {
      ritenuta_acconto: null,
      reverse_charge: false,
      split_payment: false,
      bene_strumentale: false,
      deducibilita_pct: 100,
      iva_detraibilita_pct: 100,
      note: null,
    }
    const fiscalFlags = r.fiscal_flags && Object.keys(r.fiscal_flags).length > 0
      ? { ...defaultFlags, ...r.fiscal_flags }
      : defaultFlags

    lineResults.set(r.line_id, {
      line_id: r.line_id,
      category_id: r.category_id,
      account_id: r.account_id,
      account_code: null,
      article_id: r.article_id,
      phase_id: r.phase_id,
      cost_center_allocations: r.cost_center_allocations || [],
      confidence: r.confidence,
      reasoning: r.reasoning,
      fiscal_flags: fiscalFlags,
      source: r.source,
      rule_id: r.rule_id || null,
    })
  }

  let aiClassifiedCount = 0

  // ─── Steps 2+3: AI Classification (only for unresolved) ──
  if (unresolved.length > 0) {
    // Step 2: Understand
    const step2 = await callEdge('classify-v2-understand', {
      ...commonBody,
      lines: unresolved,
    }, token, signal)

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const understandings: Understanding[] = step2.understandings || []

    // Step 3: Classify (with understanding context)
    const step3 = await callEdge('classify-v2-classify', {
      ...commonBody,
      lines: unresolved,
      understandings,
    }, token, signal)

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const classifications: ClassifyResult[] = step3.classifications || []

    for (const c of classifications) {
      lineResults.set(c.line_id, {
        line_id: c.line_id,
        category_id: c.category_id,
        account_id: c.account_id,
        account_code: c.account_code,
        article_id: null, // article_code needs resolution — done at persist time
        phase_id: null,
        cost_center_allocations: [],
        confidence: c.confidence,
        reasoning: c.reasoning,
        fiscal_flags: c.fiscal_flags || {},
        source: 'ai',
        suggest_new_account: c.suggest_new_account,
        suggest_new_category: c.suggest_new_category,
      })
      aiClassifiedCount++
    }
  }

  // ─── Step 4: CdC Assignment (for ALL lines) ───────────
  let cdcAssigned = 0
  try {
    const allLineData = lines.map(l => {
      const lr = lineResults.get(l.line_id)
      return {
        line_id: l.line_id,
        description: l.description,
        total_price: l.total_price,
        category_name: lr?.category_id ? undefined : undefined, // keep it lightweight
        account_code: lr?.account_code || undefined,
      }
    })

    const step4 = await callEdge('classify-v2-cdc', {
      ...commonBody,
      lines: allLineData,
    }, token, signal)

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    if (!step4.skipped) {
      const allocations: CdcAllocation[] = step4.allocations || []
      for (const a of allocations) {
        const existing = lineResults.get(a.line_id)
        if (existing && a.cost_center_allocations?.length > 0) {
          existing.cost_center_allocations = a.cost_center_allocations
          cdcAssigned++
        }
      }
    }
  } catch (e) {
    console.warn('[pipeline] CdC step failed (non-blocking):', e)
  }

  // ─── Step 5: Fiscal Review (ALL lines) ─────────────────
  let alerts: FiscalAlert[] = []
  let fiscalIssues = 0
  try {
    // Build review input from all classified lines
    // For rule-confirmed lines, communicate their fiscal_flags_source
    const reviewLines = lines.map(l => {
      const lr = lineResults.get(l.line_id)
      const ruleResolved = resolved.find(r => r.line_id === l.line_id)
      const hasFiscalFromRule = ruleResolved?.fiscal_flags && Object.keys(ruleResolved.fiscal_flags).length > 0

      return {
        line_id: l.line_id,
        description: l.description,
        total_price: l.total_price,
        category_name: null, // would need lookup
        account_code: lr?.account_code || null,
        account_name: null,
        confidence: lr?.confidence || 0,
        fiscal_flags: lr?.fiscal_flags || {
          ritenuta_acconto: null, reverse_charge: false, split_payment: false,
          bene_strumentale: false, deducibilita_pct: 100, iva_detraibilita_pct: 100, note: null,
        },
        source: lr?.source || 'unknown',
        fiscal_flags_source: hasFiscalFromRule ? 'rule_confirmed' : 'to_review',
        fiscal_flags_preset: hasFiscalFromRule ? ruleResolved!.fiscal_flags : null,
      }
    }).filter(l => {
      const lr = lineResults.get(l.line_id)
      return lr && lr.confidence >= 50 // only review lines with some classification
    })

    if (reviewLines.length > 0) {
      const step5 = await callEdge('fiscal-reviewer', {
        ...commonBody,
        lines: reviewLines,
      }, token, signal)

      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')

      const reviews: ReviewResult[] = step5.reviews || []
      alerts = step5.alerts || []

      // Apply fiscal corrections
      for (const rev of reviews) {
        const lr = lineResults.get(rev.line_id)
        if (lr && rev.fiscal_flags_corrected) {
          lr.fiscal_flags = rev.fiscal_flags_corrected
          lr.confidence = Math.max(0, Math.min(100, lr.confidence + (rev.confidence_adjustment || 0)))
        }
        if (rev.issues?.length) fiscalIssues += rev.issues.length
      }
    }
  } catch (e) {
    console.warn('[pipeline] Fiscal review failed (non-blocking):', e)
  }

  // ─── Build final result ─────────────────────────────────
  const finalLines = lines.map(l => {
    const lr = lineResults.get(l.line_id)
    if (lr) return lr
    return {
      line_id: l.line_id,
      category_id: null,
      account_id: null,
      account_code: null,
      article_id: null,
      phase_id: null,
      cost_center_allocations: [],
      confidence: 0,
      reasoning: 'Non classificata',
      fiscal_flags: {},
      source: 'none',
    }
  })

  const pipelineResult: PipelineResult = {
    lines: finalLines,
    alerts,
    stats: {
      total: lines.length,
      deterministic: resolved.length,
      ai_classified: aiClassifiedCount,
      cdc_assigned: cdcAssigned,
      fiscal_issues: fiscalIssues,
    },
  }

  // ─── Persist to DB ────────────────────────────────────
  await persistPipelineResults(companyId, invoiceId, pipelineResult)

  return pipelineResult
}
