/**
 * classificationPipelineService — Frontend orchestrator for invoice vNext.
 *
 * Pipeline steps:
 *   1. classify-v2-deterministic → exact/history evidence gate
 *   2. classify-v2-classify      → commercialista invoice-wide proposal
 *   3. classify-v2-cdc           → cost center assignment
 *   4. fiscal-reviewer           → reviewer final verdict + alerts
 *   5. Persist results + audit trail
 */

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import {
  saveCommercialistaProposals,
  saveFinalDecisions,
  saveReviewerVerdicts,
  type FinalDecisionSource,
  type LineDecisionStatus,
  type SupportingEvidence,
  type WeakFieldState,
} from '@/lib/invoiceDecisionService'

/* ─── Types ──────────────────────────────────── */

interface InputLine {
  line_id: string
  description: string
  quantity: number | null
  unit_price: number | null
  total_price: number | null
  vat_rate: number | null
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

interface WeakField<T = string | null> {
  value: T | null
  state: WeakFieldState
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
  rationale_summary?: string | null
  decision_basis?: string[]
  supporting_factors?: string[]
  supporting_evidence?: SupportingEvidence[]
  weak_fields?: {
    category?: WeakField
    account?: WeakField
    article?: WeakField
    phase?: WeakField
    cost_center?: WeakField
  }
  exact_match_evidence_used?: boolean
  fiscal_flags: Record<string, unknown>
  suggest_new_account?: Record<string, string> | null
  suggest_new_category?: Record<string, string> | null
}

interface CommercialistaPayload {
  invoice_summary: string | null
  evidence_refs: string[]
  needs_consultant_hint: boolean
  line_proposals: ClassifyResult[]
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

interface ReviewerLineVerdict {
  line_id: string
  decision_status: LineDecisionStatus
  rationale_summary: string
  decision_basis: string[]
  supporting_factors: string[]
  supporting_evidence: SupportingEvidence[]
  clear_fields?: string[]
  consultant_recommended?: boolean
}

interface ReviewerPayload {
  invoice_summary_final: string | null
  line_verdicts: ReviewerLineVerdict[]
  escalation_candidates: string[]
  red_flags: string[]
}

interface FiscalAlert {
  type: string
  severity: 'warning' | 'info'
  title: string
  description: string
  current_choice: string
  options: { label: string; fiscal_override: Record<string, unknown>; is_default?: boolean; isConservative?: boolean; suggestedNote?: string }[]
  affected_lines: string[]
}

export interface PipelineStepDebug {
  step: string
  prompt_sent?: string
  raw_response?: string
  model_used?: string
  agent_config_loaded?: boolean
  agent_rules_count?: number
  kb_rules_count?: number
  kb_rules_titles?: string[]
  company_ateco?: string
  accounts_shown?: number
  accounts_by_section?: Record<string, number>
  understandings?: Array<{
    line_id: string
    operation_type: string
    account_sections: string[]
    is_NOT: string[]
  }>
  extra?: Record<string, unknown>
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
    reasoning_summary_final: string | null
    decision_status: LineDecisionStatus
    final_decision_source: FinalDecisionSource
    decision_basis: string[]
    supporting_factors: string[]
    supporting_evidence: SupportingEvidence[]
    fiscal_flags: Record<string, unknown>
    source: string
    rule_id?: string | null
    suggest_new_account?: Record<string, string> | null
    suggest_new_category?: Record<string, string> | null
    classification_reasoning?: string | null
    classification_thinking?: string | null
    fiscal_reasoning?: string | null
    fiscal_thinking?: string | null
    fiscal_confidence?: number | null
  }[]
  alerts: FiscalAlert[]
  commercialista?: CommercialistaPayload
  reviewer?: ReviewerPayload
  stats: {
    total: number
    deterministic: number
    ai_classified: number
    cdc_assigned: number
    fiscal_issues: number
  }
  debug?: PipelineStepDebug[]
}

export interface PipelineEvents {
  onStage?: (stage: string, current: number, total: number, message?: string) => void
  onProgress?: (current: number, total: number, meta?: { stage?: string; message?: string }) => void
  onLog?: (text: string) => void
}

const PIPELINE_TOTAL_STEPS = 5

type FinalLineResult = PipelineResult['lines'][number]

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError()
}

function createPipelineReporter(events?: PipelineEvents) {
  let current = 0

  const beginStage = (stage: string, message?: string) => {
    events?.onStage?.(stage, current, PIPELINE_TOTAL_STEPS, message)
    events?.onProgress?.(current, PIPELINE_TOTAL_STEPS, { stage, message })
  }

  const finishStage = (stage: string, message?: string) => {
    current += 1
    events?.onProgress?.(current, PIPELINE_TOTAL_STEPS, { stage, message })
    if (message) events?.onLog?.(message)
  }

  return { beginStage, finishStage }
}

async function callEdge(
  functionName: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  const text = await res.text().catch(() => '')
  if (!res.ok) {
    throw new Error(`${functionName} HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function defaultFiscalFlags(flags?: Record<string, unknown> | null) {
  const normalized = {
    ritenuta_acconto: null,
    reverse_charge: false,
    split_payment: false,
    bene_strumentale: false,
    deducibilita_pct: 100,
    iva_detraibilita_pct: 100,
    note: null,
    ...(flags || {}),
  }
  if (normalized.deducibilita_pct == null) normalized.deducibilita_pct = 0
  if (normalized.iva_detraibilita_pct == null) normalized.iva_detraibilita_pct = 0
  return normalized
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  return Array.from(new Set(input.map((value) => String(value || '').trim()).filter(Boolean)))
}

function normalizeEvidenceSource(input: unknown): SupportingEvidence['source'] {
  const raw = String(input || '').trim().toLowerCase()
  switch (raw) {
    case 'kb':
    case 'memory':
    case 'deterministic':
    case 'reviewer':
    case 'consultant':
    case 'company_stats':
    case 'invoice':
    case 'history':
    case 'user':
      return raw
    case 'rule':
    case 'exact_match':
      return 'deterministic'
    case 'commercialista':
      return 'invoice'
    default:
      return 'invoice'
  }
}

function normalizeEvidence(input: unknown): SupportingEvidence[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const row = item as Record<string, unknown>
      return {
        source: normalizeEvidenceSource(row.source),
        label: String(row.label || row.ref || 'Evidenza'),
        detail: row.detail != null ? String(row.detail) : null,
        ref: row.ref != null ? String(row.ref) : null,
      }
    })
}

function shouldNeedsReview(line: Pick<FinalLineResult, 'decision_status' | 'confidence' | 'fiscal_flags' | 'suggest_new_account'>) {
  return line.decision_status !== 'finalized'
    || line.confidence < 65
    || !!(line.fiscal_flags?.note && /verificar|controllare|dubbio|incert/i.test(String(line.fiscal_flags.note || '')))
    || line.suggest_new_account != null
}

async function persistPipelineResults(
  companyId: string,
  invoiceId: string,
  result: PipelineResult,
  signal?: AbortSignal,
): Promise<void> {
  const commercialistaRows = result.commercialista?.line_proposals || []
  const reviewerRows = result.reviewer?.line_verdicts || []

  if (commercialistaRows.length > 0) {
    await saveCommercialistaProposals(companyId, invoiceId, commercialistaRows.map((row) => ({
      line_id: row.line_id,
      confidence: row.confidence,
      proposal: row as unknown as Record<string, unknown>,
      rationale_summary: row.rationale_summary || row.reasoning || null,
      decision_basis: normalizeStringArray(row.decision_basis),
      supporting_factors: normalizeStringArray(row.supporting_factors),
      supporting_evidence: normalizeEvidence(row.supporting_evidence),
    })))
  }

  if (reviewerRows.length > 0) {
    await saveReviewerVerdicts(companyId, invoiceId, reviewerRows.map((row) => ({
      line_id: row.line_id,
      decision_status: row.decision_status,
      final_confidence: result.lines.find((line) => line.line_id === row.line_id)?.confidence ?? null,
      verdict: row as unknown as Record<string, unknown>,
      rationale_summary: row.rationale_summary,
      decision_basis: normalizeStringArray(row.decision_basis),
      supporting_factors: normalizeStringArray(row.supporting_factors),
      supporting_evidence: normalizeEvidence(row.supporting_evidence),
      red_flags: row.consultant_recommended ? ['consultant_recommended'] : [],
    })))
  }

  await saveFinalDecisions(companyId, invoiceId, result.lines.map((line) => ({
    line_id: line.line_id,
    decision_source: line.final_decision_source,
    decision_status: line.decision_status,
    confidence: line.confidence,
    applied_payload: {
      category_id: line.category_id,
      account_id: line.account_id,
      article_id: line.article_id,
      phase_id: line.phase_id,
      cost_center_allocations: line.cost_center_allocations,
      fiscal_flags: line.fiscal_flags,
    },
    rationale_summary: line.reasoning_summary_final,
    decision_basis: line.decision_basis,
    supporting_factors: line.supporting_factors,
    supporting_evidence: line.supporting_evidence,
  })))

  for (const lr of result.lines) {
    throwIfAborted(signal)
    await supabase.from('invoice_lines').update({
      category_id: lr.category_id,
      account_id: lr.account_id,
      fiscal_flags: lr.fiscal_flags,
      classification_status: 'ai_suggested',
      ai_confidence: Math.round(lr.confidence),
      needs_review: shouldNeedsReview(lr),
      classification_reasoning: lr.classification_reasoning || null,
      classification_thinking: lr.classification_thinking || null,
      fiscal_reasoning: lr.fiscal_reasoning || null,
      fiscal_thinking: lr.fiscal_thinking || null,
      fiscal_confidence: lr.fiscal_confidence != null ? Math.round(lr.fiscal_confidence) : null,
      decision_status: lr.decision_status,
      reasoning_summary_final: lr.reasoning_summary_final,
      final_confidence: Math.round(lr.confidence),
      final_decision_source: lr.final_decision_source,
    } as any).eq('id', lr.line_id)

    const { error: deleteProjectsError } = await supabase
      .from('invoice_line_projects')
      .delete()
      .eq('invoice_line_id', lr.line_id)
    if (deleteProjectsError) throw deleteProjectsError

    for (const allocation of lr.cost_center_allocations || []) {
      const { error } = await supabase.from('invoice_line_projects').insert({
        company_id: companyId,
        invoice_id: invoiceId,
        invoice_line_id: lr.line_id,
        project_id: allocation.project_id,
        percentage: allocation.percentage,
        assigned_by: 'ai_auto',
      } as any)
      if (error) throw error
    }
  }

  const classified = result.lines.filter((line) => line.decision_status === 'finalized' && (line.category_id || line.account_id))
  if (classified.length > 0) {
    const best = classified.reduce((current, candidate) =>
      candidate.confidence > current.confidence ? candidate : current,
    )
    const avgConf = Math.round(classified.reduce((sum, line) => sum + line.confidence, 0) / classified.length)
    await supabase.from('invoice_classifications').upsert({
      company_id: companyId,
      invoice_id: invoiceId,
      category_id: best.category_id,
      account_id: best.account_id,
      assigned_by: 'ai_auto',
      verified: false,
      ai_confidence: avgConf,
      ai_reasoning: result.reviewer?.invoice_summary_final
        || result.commercialista?.invoice_summary
        || `Verdetto AI consolidato su ${classified.length} righe`,
      invoice_notes: result.alerts.length > 0 ? JSON.stringify(result.alerts) : null,
    } as any, { onConflict: 'invoice_id' })
  }

  await supabase.from('invoices').update({
    has_fiscal_alerts: result.alerts.length > 0,
    classification_status: 'ai_suggested',
  } as any).eq('id', invoiceId)
}

function buildInitialResult(line: InputLine, deterministic?: DeterministicResult): FinalLineResult {
  const fiscalFlags = defaultFiscalFlags(deterministic?.fiscal_flags || null)
  return {
    line_id: line.line_id,
    category_id: deterministic?.category_id || null,
    account_id: deterministic?.account_id || null,
    account_code: null,
    article_id: deterministic?.article_id || null,
    phase_id: deterministic?.phase_id || null,
    cost_center_allocations: deterministic?.cost_center_allocations || [],
    confidence: deterministic?.confidence || 0,
    reasoning: deterministic?.reasoning || 'Non classificata',
    reasoning_summary_final: deterministic?.reasoning || null,
    decision_status: deterministic ? 'pending' : 'unassigned',
    final_decision_source: deterministic?.source === 'rule' ? 'exact_match' : 'none',
    decision_basis: deterministic ? ['deterministic_evidence'] : [],
    supporting_factors: deterministic ? [deterministic.reasoning] : [],
    supporting_evidence: deterministic ? [{
      source: deterministic.source === 'rule' ? 'deterministic' : 'history',
      label: deterministic.source === 'rule' ? 'Exact match da regola' : 'Pattern storico controparte',
      detail: deterministic.reasoning,
      ref: deterministic.rule_id || null,
    }] : [],
    fiscal_flags: fiscalFlags,
    source: deterministic?.source || 'none',
    rule_id: deterministic?.rule_id || null,
    classification_reasoning: deterministic?.reasoning || null,
    classification_thinking: null,
    fiscal_reasoning: null,
    fiscal_thinking: null,
    fiscal_confidence: deterministic?.confidence ?? null,
  }
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
  events?: PipelineEvents,
  contractRefs?: string[],
): Promise<PipelineResult> {
  const reporter = createPipelineReporter(events)
  const debugSteps: PipelineStepDebug[] = []

  let invoiceNotes = ''
  let invoiceCausale = ''
  try {
    const { data: inv } = await supabase
      .from('invoices')
      .select('notes, raw_xml')
      .eq('id', invoiceId)
      .single()
    if (inv?.notes) invoiceNotes = inv.notes
    if (inv?.raw_xml) {
      try {
        const { reparseXml } = await import('@/lib/invoiceParser')
        const parsed = reparseXml(inv.raw_xml)
        const body = parsed.bodies?.[0]
        if (body?.causali?.length) invoiceCausale = body.causali.filter(Boolean).join(' | ')
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    // ignore
  }

  const commonBody = {
    company_id: companyId,
    invoice_id: invoiceId,
    direction,
    counterparty_vat_key: counterpartyVatKey,
    counterparty_name: counterpartyName,
    invoice_notes: invoiceNotes || null,
    invoice_causale: invoiceCausale || null,
  }

  reporter.beginStage('Ricerca regole e storico', `Analizzo ${lines.length} righe della fattura`)
  const step1 = await callEdge('classify-v2-deterministic', {
    ...commonBody,
    lines,
    ...(contractRefs?.length ? { contract_refs: contractRefs } : {}),
  }, signal)
  throwIfAborted(signal)

  const resolved: DeterministicResult[] = step1.resolved || []
  const unresolved: Array<InputLine & { matched_groups: string[] }> = step1.unresolved || []
  const deterministicMap = new Map(resolved.map((row) => [row.line_id, row]))
  const matchedGroupsMap = new Map<string, string[]>()
  for (const row of resolved) matchedGroupsMap.set(row.line_id, row.matched_groups || [])
  for (const row of unresolved) matchedGroupsMap.set(row.line_id, row.matched_groups || [])

  if (step1._debug) {
    debugSteps.push({ step: 'deterministic', extra: step1._debug })
  }
  reporter.finishStage(
    'Ricerca regole e storico',
    `Gate completato: ${resolved.length} evidenze determinate, ${unresolved.length} righe senza exact match pieno`,
  )

  reporter.beginStage('Commercialista', 'Propongo classificazione e fiscalita su fattura intera')
  const step2 = await callEdge('classify-v2-classify', {
    ...commonBody,
    lines: lines.map((line) => ({
      ...line,
      matched_groups: matchedGroupsMap.get(line.line_id) || [],
    })),
    deterministic_matches: resolved.map((row) => ({
      line_id: row.line_id,
      source: row.source,
      confidence: row.confidence,
      reasoning: row.reasoning,
      category_id: row.category_id,
      account_id: row.account_id,
      article_id: row.article_id,
      phase_id: row.phase_id,
    })),
  }, signal)
  throwIfAborted(signal)

  const commercialista: CommercialistaPayload = {
    invoice_summary: step2.commercialista?.invoice_summary || null,
    evidence_refs: Array.isArray(step2.commercialista?.evidence_refs) ? step2.commercialista.evidence_refs : [],
    needs_consultant_hint: Boolean(step2.commercialista?.needs_consultant_hint),
    line_proposals: Array.isArray(step2.commercialista?.line_proposals)
      ? step2.commercialista.line_proposals
      : (step2.classifications || []),
  }
  const classifyThinking: string | null = step2.thinking || null

  if (step2._debug) {
    debugSteps.push({
      step: 'commercialista',
      prompt_sent: step2._debug.prompt_sent,
      raw_response: step2._debug.raw_response,
      model_used: step2._debug.model_used,
      agent_config_loaded: step2._debug.agent_config_loaded,
      agent_rules_count: step2._debug.agent_rules_count,
      kb_rules_count: step2._debug.kb_rules_count,
      kb_rules_titles: step2._debug.kb_rules_titles,
      company_ateco: step2._debug.company_ateco,
      accounts_shown: step2.accounts_shown,
      accounts_by_section: step2._debug.accounts_by_section,
      understandings: step2._debug.understandings_received,
      extra: {
        evidence_refs: commercialista.evidence_refs,
        needs_consultant_hint: commercialista.needs_consultant_hint,
        history_count: step2._debug.history_count,
        memory_facts_count: step2._debug.memory_facts_count,
      },
    })
  }
  reporter.finishStage(
    'Commercialista',
    `Commercialista: ${commercialista.line_proposals.length} proposte elaborate sull'intera fattura`,
  )

  const lineResults = new Map<string, FinalLineResult>()
  for (const line of lines) {
    lineResults.set(line.line_id, buildInitialResult(line, deterministicMap.get(line.line_id)))
  }

  for (const proposal of commercialista.line_proposals) {
    const current = lineResults.get(proposal.line_id)
    if (!current) continue
    const deterministic = deterministicMap.get(proposal.line_id)
    const confidence = Math.max(proposal.confidence || 0, deterministic?.confidence || 0)
    lineResults.set(proposal.line_id, {
      ...current,
      category_id: proposal.category_id ?? current.category_id,
      account_id: proposal.account_id ?? current.account_id,
      account_code: proposal.account_code ?? current.account_code,
      confidence,
      reasoning: proposal.reasoning,
      reasoning_summary_final: proposal.rationale_summary || proposal.reasoning || current.reasoning_summary_final,
      decision_status: 'pending',
      final_decision_source: current.final_decision_source === 'exact_match' && !proposal.exact_match_evidence_used ? 'commercialista' : current.final_decision_source,
      decision_basis: normalizeStringArray(proposal.decision_basis),
      supporting_factors: normalizeStringArray(proposal.supporting_factors),
      supporting_evidence: normalizeEvidence(proposal.supporting_evidence).concat(current.supporting_evidence),
      fiscal_flags: defaultFiscalFlags(proposal.fiscal_flags),
      source: deterministic ? `${proposal.exact_match_evidence_used ? 'deterministic+' : ''}commercialista` : 'commercialista',
      suggest_new_account: proposal.suggest_new_account,
      suggest_new_category: proposal.suggest_new_category,
      classification_reasoning: proposal.rationale_summary || proposal.reasoning || null,
      classification_thinking: classifyThinking,
      fiscal_confidence: confidence,
    })
  }

  let cdcAssigned = 0
  reporter.beginStage('Attribuzione CdC', 'Assegno i centri di costo alle righe proposte')
  try {
    const step3 = await callEdge('classify-v2-cdc', {
      ...commonBody,
      lines: lines.map((line) => {
        const result = lineResults.get(line.line_id)
        return {
          line_id: line.line_id,
          description: line.description,
          total_price: line.total_price,
          account_code: result?.account_code || undefined,
          category_name: undefined,
        }
      }),
    }, signal)
    throwIfAborted(signal)

    if (step3._debug) debugSteps.push({ step: 'cdc', extra: step3._debug })

    if (!step3.skipped) {
      const allocations: CdcAllocation[] = step3.allocations || []
      for (const allocation of allocations) {
        const current = lineResults.get(allocation.line_id)
        if (current && allocation.cost_center_allocations?.length > 0) {
          current.cost_center_allocations = allocation.cost_center_allocations
          cdcAssigned += 1
        }
      }
      reporter.finishStage('Attribuzione CdC', `CdC trovati per ${cdcAssigned} righe`)
    } else {
      reporter.finishStage('Attribuzione CdC', 'CdC saltati: nessun centro applicabile')
    }
  } catch (error) {
    console.warn('[pipeline] CdC step failed (non-blocking):', error)
    reporter.finishStage('Attribuzione CdC', `CdC: warning non bloccante (${error instanceof Error ? error.message : 'errore sconosciuto'})`)
  }

  let alerts: FiscalAlert[] = []
  let fiscalIssues = 0
  const reviewerPayload: ReviewerPayload = {
    invoice_summary_final: null,
    line_verdicts: [],
    escalation_candidates: [],
    red_flags: [],
  }

  reporter.beginStage('Revisore', 'Consolido il verdetto finale riga per riga')
  try {
    const reviewLines = lines.map((line) => {
      const current = lineResults.get(line.line_id)
      const ruleResolved = deterministicMap.get(line.line_id)
      const hasFiscalFromRule = !!(ruleResolved?.fiscal_flags && Object.keys(ruleResolved.fiscal_flags).length > 0)
      return {
        line_id: line.line_id,
        description: line.description,
        total_price: line.total_price,
        vat_rate: line.vat_rate,
        category_id: current?.category_id || null,
        category_name: null,
        account_id: current?.account_id || null,
        account_code: current?.account_code || null,
        account_name: null,
        confidence: current?.confidence || 0,
        fiscal_flags: defaultFiscalFlags(current?.fiscal_flags),
        source: current?.source || 'unknown',
        fiscal_flags_source: hasFiscalFromRule ? 'rule_confirmed' : 'to_review',
        fiscal_flags_preset: hasFiscalFromRule ? ruleResolved?.fiscal_flags : null,
      }
    }).filter((line) => {
      const current = lineResults.get(line.line_id)
      return current && (current.account_id || current.category_id || current.confidence > 0)
    })

    if (reviewLines.length > 0) {
      const step4 = await callEdge('fiscal-reviewer', {
        ...commonBody,
        lines: reviewLines,
        ...(contractRefs?.length ? { contract_refs: contractRefs } : {}),
      }, signal)
      throwIfAborted(signal)

      const reviews: ReviewResult[] = step4.reviews || []
      alerts = step4.alerts || []
      reviewerPayload.invoice_summary_final = step4.reviewer_verdict?.invoice_summary_final || null
      reviewerPayload.line_verdicts = Array.isArray(step4.reviewer_verdict?.line_verdicts)
        ? step4.reviewer_verdict.line_verdicts
        : []
      reviewerPayload.escalation_candidates = Array.isArray(step4.reviewer_verdict?.escalation_candidates)
        ? step4.reviewer_verdict.escalation_candidates
        : []
      reviewerPayload.red_flags = Array.isArray(step4.reviewer_verdict?.red_flags)
        ? step4.reviewer_verdict.red_flags
        : []
      const fiscalThinking: string | null = step4.thinking || null

      if (step4._debug) {
        debugSteps.push({
          step: 'reviewer',
          prompt_sent: step4._debug.prompt_sent,
          raw_response: step4._debug.raw_response,
          model_used: step4._debug.model_used,
          agent_config_loaded: step4._debug.agent_config_loaded,
          agent_rules_count: step4._debug.agent_rules_count,
          kb_rules_count: step4._debug.kb_rules_count,
          company_ateco: step4._debug.company_ateco,
          extra: {
            counterparty_ateco: step4._debug.counterparty_ateco,
            counterparty_legal_type: step4._debug.counterparty_legal_type,
            pre_resolved_decisions: step4._debug.pre_resolved_decisions,
            rule_confirmed_lines: step4._debug.rule_confirmed_lines,
            escalation_candidates: reviewerPayload.escalation_candidates,
          },
        })
      }

      for (const review of reviews) {
        const current = lineResults.get(review.line_id)
        if (!current) continue
        current.fiscal_flags = defaultFiscalFlags(review.fiscal_flags_corrected)
        current.confidence = Math.max(0, Math.min(100, current.confidence + (review.confidence_adjustment || 0)))
        current.fiscal_reasoning = review.issues?.length ? review.issues.join('; ') : 'Nessun problema fiscale rilevato'
        current.fiscal_thinking = fiscalThinking
        current.fiscal_confidence = current.confidence
        if (review.issues?.length) fiscalIssues += review.issues.length
      }

      const verdictMap = new Map(reviewerPayload.line_verdicts.map((row) => [row.line_id, row]))
      for (const line of lines) {
        const current = lineResults.get(line.line_id)
        if (!current) continue
        const verdict = verdictMap.get(line.line_id)
        if (verdict) {
          current.decision_status = verdict.decision_status
          current.reasoning_summary_final = verdict.rationale_summary || current.reasoning_summary_final
          current.decision_basis = normalizeStringArray(verdict.decision_basis)
          current.supporting_factors = normalizeStringArray(verdict.supporting_factors)
          current.supporting_evidence = normalizeEvidence(verdict.supporting_evidence).concat(current.supporting_evidence)
          current.final_decision_source = 'revisore'
          current.fiscal_reasoning = verdict.rationale_summary || current.fiscal_reasoning
        } else {
          current.decision_status = current.account_id || current.category_id ? 'finalized' : 'unassigned'
          current.final_decision_source = current.final_decision_source === 'none' ? 'commercialista' : current.final_decision_source
        }

        if (current.decision_status !== 'finalized') {
          current.final_decision_source = 'revisore'
        }
      }

      reporter.finishStage('Revisore', `Revisore: ${reviews.length} revisioni, ${alerts.length} alert, ${reviewerPayload.escalation_candidates.length} escalation`)
    } else {
      reporter.finishStage('Revisore', 'Revisore saltato: nessuna proposta sostanziale da consolidare')
    }
  } catch (error) {
    console.warn('[pipeline] Reviewer failed (non-blocking):', error)
    reporter.finishStage('Revisore', `Revisore: warning non bloccante (${error instanceof Error ? error.message : 'errore sconosciuto'})`)
  }

  const finalLines = lines.map((line) => lineResults.get(line.line_id) || buildInitialResult(line))
  for (const finalLine of finalLines) {
    if (!finalLine.reasoning_summary_final) {
      finalLine.reasoning_summary_final = finalLine.decision_status === 'unassigned'
        ? 'Decisione non applicata: evidenza insufficiente sulla riga'
        : finalLine.classification_reasoning || finalLine.fiscal_reasoning || finalLine.reasoning
    }
    if (finalLine.decision_status === 'pending') {
      finalLine.decision_status = finalLine.account_id || finalLine.category_id ? 'finalized' : 'unassigned'
      if (finalLine.final_decision_source === 'none') {
        finalLine.final_decision_source = finalLine.account_id || finalLine.category_id ? 'commercialista' : 'none'
      }
    }
  }

  const pipelineResult: PipelineResult = {
    lines: finalLines,
    alerts,
    commercialista,
    reviewer: reviewerPayload,
    stats: {
      total: lines.length,
      deterministic: resolved.length,
      ai_classified: commercialista.line_proposals.length,
      cdc_assigned: cdcAssigned,
      fiscal_issues: fiscalIssues,
    },
    debug: debugSteps.length > 0 ? debugSteps : undefined,
  }

  reporter.beginStage('Salvataggio risultati', 'Persisto verdetti, trail strutturato e snapshot finale')
  throwIfAborted(signal)
  await persistPipelineResults(companyId, invoiceId, pipelineResult, signal)
  reporter.finishStage('Salvataggio risultati', `Salvataggio completato su ${pipelineResult.lines.length} righe`)

  return pipelineResult
}
