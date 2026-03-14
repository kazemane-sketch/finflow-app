/**
 * classificationPipelineService — Frontend orchestrator for invoice vNext.
 *
 * Pipeline steps:
 *   1. classify-v2-deterministic → exact/history evidence gate
 *   2. classify-v2-classify      → commercialista with function calling (classifica + fiscalità)
 *   3. classify-v2-cdc           → cost center assignment
 *   4. Persist results + audit trail (with conditional CFO if needs_consultant)
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
import { calcolaImportiFiscali, type FiscalInput, type FiscalOutput } from '@/lib/fiscalCalculator'

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

interface FiscalV1 {
  tax_code: string | null
  iva_detraibilita_pct: number
  deducibilita_ires_pct: number
  irap_mode: string
  irap_pct?: number
  ritenuta_applicabile: boolean
  ritenuta_tipo?: string
  ritenuta_aliquota_pct?: number
  ritenuta_base_pct?: number
  cassa_previdenziale_pct?: number
  reverse_charge: boolean
  split_payment: boolean
  bene_strumentale: boolean
  asset_candidate: boolean
  asset_category_guess?: string
  ammortamento_aliquota_proposta?: number
  debt_related: boolean
  debt_type?: string
  competenza_dal?: string
  competenza_al?: string
  costo_personale: boolean
  warning_flags: string[]
  fiscal_reasoning_short: string
}

interface CommercialistaPayload {
  invoice_summary: string | null
  evidence_refs: string[]
  needs_consultant_hint: boolean
  needs_consultant?: boolean
  consultant_reason?: string | null
  line_proposals: (ClassifyResult & { fiscal_v1?: FiscalV1 | null; doubts?: { question: string; impact: string }[] })[]
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
  kb_notes_used?: number
  kb_note_titles?: string[]
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
    // V1 typed fiscal fields
    fiscal_v1?: FiscalV1 | null
    fiscal_computed?: FiscalOutput | null
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

const PIPELINE_TOTAL_STEPS = 4

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
    const fv1 = (lr as any).fiscal_v1 as FiscalV1 | null | undefined
    const fc = (lr as any).fiscal_computed as FiscalOutput | null | undefined
    const updatePayload: Record<string, unknown> = {
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
    }
    // V1 typed fiscal columns
    if (fv1) {
      updatePayload.iva_detraibilita_pct = fv1.iva_detraibilita_pct ?? 100
      updatePayload.reverse_charge = fv1.reverse_charge || false
      updatePayload.split_payment = fv1.split_payment || false
      updatePayload.deducibilita_ires_pct = fv1.deducibilita_ires_pct ?? 100
      updatePayload.irap_mode = fv1.irap_mode || 'follows_ires'
      updatePayload.irap_pct = fv1.irap_pct ?? null
      updatePayload.costo_personale = fv1.costo_personale || false
      updatePayload.ritenuta_applicabile = fv1.ritenuta_applicabile || false
      updatePayload.ritenuta_tipo = fv1.ritenuta_tipo || null
      updatePayload.ritenuta_aliquota_pct = fv1.ritenuta_aliquota_pct ?? null
      updatePayload.ritenuta_base_pct = fv1.ritenuta_base_pct ?? 100
      updatePayload.cassa_previdenziale_pct = fv1.cassa_previdenziale_pct ?? null
      updatePayload.bene_strumentale = fv1.bene_strumentale || false
      updatePayload.asset_candidate = fv1.asset_candidate || false
      updatePayload.asset_category_guess = fv1.asset_category_guess || null
      updatePayload.ammortamento_aliquota_proposta = fv1.ammortamento_aliquota_proposta ?? null
      updatePayload.debt_related = fv1.debt_related || false
      updatePayload.debt_type = fv1.debt_type || null
      updatePayload.competenza_dal = fv1.competenza_dal || null
      updatePayload.competenza_al = fv1.competenza_al || null
      updatePayload.warning_flags = fv1.warning_flags || []
      updatePayload.fiscal_reasoning_short = fv1.fiscal_reasoning_short || null
    }
    // Computed fiscal amounts
    if (fc) {
      updatePayload.iva_importo = fc.iva_importo
      updatePayload.iva_detraibile = fc.iva_detraibile
      updatePayload.iva_indetraibile = fc.iva_indetraibile
      updatePayload.iva_importo_source = fc.iva_importo_source
      updatePayload.costo_fiscale = fc.costo_fiscale
      updatePayload.importo_deducibile_ires = fc.importo_deducibile_ires
      updatePayload.importo_indeducibile_ires = fc.importo_indeducibile_ires
      updatePayload.importo_deducibile_irap = fc.importo_deducibile_irap
      updatePayload.importo_competenza = fc.importo_competenza
      updatePayload.importo_risconto = fc.importo_risconto
      updatePayload.ritenuta_importo = fc.ritenuta_importo
    }
    await supabase.from('invoice_lines').update(updatePayload as any).eq('id', lr.line_id)

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
      ai_reasoning: result.commercialista?.invoice_summary
        || result.reviewer?.invoice_summary_final
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

  // Load IVA data per line from invoice_vat_entries
  let ivaByLine = new Map<string, { iva_importo: number; vat_nature: string | null }>()
  try {
    const lineIds = lines.map((l) => l.line_id)
    const { data: vatEntries } = await supabase
      .from('invoice_vat_entries')
      .select('invoice_line_id, tax_amount, vat_nature')
      .in('invoice_line_id', lineIds)
    if (vatEntries) {
      for (const ve of vatEntries) {
        ivaByLine.set(ve.invoice_line_id, {
          iva_importo: ve.tax_amount || 0,
          vat_nature: ve.vat_nature || null,
        })
      }
    }
  } catch {
    // ignore — IVA data is supplementary
  }

  // Enrich lines with IVA data for the commercialista
  const enrichedLines = lines.map((line) => {
    const iva = ivaByLine.get(line.line_id)
    return {
      ...line,
      iva_importo: iva?.iva_importo ?? null,
      vat_nature: iva?.vat_nature ?? null,
    }
  })

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

  reporter.beginStage('Commercialista', 'Classifico e determino fiscalità con function calling')
  const step2 = await callEdge('classify-v2-classify', {
    ...commonBody,
    lines: enrichedLines.map((line) => ({
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
    needs_consultant_hint: Boolean(step2.commercialista?.needs_consultant_hint || step2.commercialista?.needs_consultant),
    needs_consultant: Boolean(step2.commercialista?.needs_consultant),
    consultant_reason: step2.commercialista?.consultant_reason || null,
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
      kb_notes_used: step2._debug.kb_notes_used,
      kb_note_titles: step2._debug.kb_note_titles,
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

  // ─── Fiscal Calculator: compute amounts from AI percentages ──────
  const invoiceDate = new Date()
  try {
    const { data: inv } = await supabase.from('invoices').select('date').eq('id', invoiceId).single()
    if (inv?.date) invoiceDate.setTime(new Date(inv.date).getTime())
  } catch { /* use current year */ }
  const annoEsercizio = invoiceDate.getFullYear()

  for (const proposal of commercialista.line_proposals) {
    const current = lineResults.get(proposal.line_id)
    if (!current) continue
    const fv1 = (proposal as any).fiscal_v1 as FiscalV1 | null | undefined
    if (fv1) {
      const inputLine = enrichedLines.find((l) => l.line_id === proposal.line_id)
      const fiscalInput: FiscalInput = {
        total_price: inputLine?.total_price || 0,
        vat_rate: inputLine?.vat_rate ?? null,
        iva_xml: inputLine?.iva_importo ?? null,
        iva_detraibilita_pct: fv1.iva_detraibilita_pct ?? 100,
        deducibilita_ires_pct: fv1.deducibilita_ires_pct ?? 100,
        irap_mode: (fv1.irap_mode as FiscalInput['irap_mode']) || 'follows_ires',
        irap_pct: fv1.irap_pct,
        ritenuta_applicabile: fv1.ritenuta_applicabile || false,
        ritenuta_aliquota_pct: fv1.ritenuta_aliquota_pct,
        ritenuta_base_pct: fv1.ritenuta_base_pct,
        cassa_previdenziale_pct: fv1.cassa_previdenziale_pct,
        competenza_dal: fv1.competenza_dal,
        competenza_al: fv1.competenza_al,
        anno_esercizio: annoEsercizio,
      }
      const computed = calcolaImportiFiscali(fiscalInput);
      (current as any).fiscal_v1 = fv1;
      (current as any).fiscal_computed = computed
      current.fiscal_reasoning = fv1.fiscal_reasoning_short || current.fiscal_reasoning
    }
  }

  // ─── Convert commercialista doubts → FiscalAlert[] ──────
  const doubtsAlerts: FiscalAlert[] = []
  for (const proposal of commercialista.line_proposals) {
    if (proposal.doubts && Array.isArray(proposal.doubts) && proposal.doubts.length > 0) {
      for (const doubt of proposal.doubts) {
        doubtsAlerts.push({
          type: 'commercialista_doubt',
          severity: 'warning',
          title: doubt.question || 'Dubbio classificazione',
          description: doubt.impact || '',
          current_choice: proposal.account_code || proposal.account_id || 'non assegnato',
          options: [],
          affected_lines: [proposal.line_id],
        })
      }
    }
  }

  // ─── Conditional CFO: only if commercialista flagged needs_consultant ──────
  let alerts: FiscalAlert[] = [...doubtsAlerts]
  let fiscalIssues = 0
  const reviewerPayload: ReviewerPayload = {
    invoice_summary_final: null,
    line_verdicts: [],
    escalation_candidates: [],
    red_flags: [],
  }

  if (commercialista.needs_consultant) {
    reporter.beginStage('Consulente CFO', 'Revisione fiscale approfondita')
    try {
      const cfoResult = await callEdge('ai-fiscal-consultant', {
        invoice_id: invoiceId,
        company_id: companyId,
        line_ids: lines.map((l) => l.line_id),
        alert_context: commercialista.consultant_reason || '',
        consulting_mode: 'pipeline',
        commercialista_result: {
          invoice_summary: commercialista.invoice_summary,
          consultant_reason: commercialista.consultant_reason,
          lines: commercialista.line_proposals,
        },
        direction,
        counterparty_vat_key: counterpartyVatKey,
      }, signal)
      throwIfAborted(signal)

      if (cfoResult._debug || cfoResult.tool_calls) {
        debugSteps.push({
          step: 'consulente_cfo',
          model_used: cfoResult.model_used,
          extra: { tool_calls: cfoResult.tool_calls, action: cfoResult.action },
        })
      }

      // Apply CFO overrides if any
      if (cfoResult.action?.line_overrides && Array.isArray(cfoResult.action.line_overrides)) {
        for (const override of cfoResult.action.line_overrides) {
          const current = lineResults.get(override.line_id)
          if (!current) continue
          if (override.field === 'account_id' && override.new_value) current.account_id = override.new_value
          if (override.field === 'category_id' && override.new_value) current.category_id = override.new_value
          current.final_decision_source = 'consulente' as FinalDecisionSource
          current.fiscal_reasoning = override.reasoning || current.fiscal_reasoning
        }
        fiscalIssues += cfoResult.action.line_overrides.length
      }

      reviewerPayload.invoice_summary_final = cfoResult.action?.review_summary || cfoResult.message || null

      reporter.finishStage('Consulente CFO', `CFO: ${fiscalIssues} override, risk=${cfoResult.action?.risk_level || 'N/A'}`)
    } catch (error) {
      console.warn('[pipeline] CFO step failed (non-blocking):', error)
      reporter.finishStage('Consulente CFO', `CFO: warning non bloccante (${error instanceof Error ? error.message : 'errore sconosciuto'})`)
    }
  }

  // Finalize decision status for all lines
  for (const line of lines) {
    const current = lineResults.get(line.line_id)
    if (!current) continue
    if (current.decision_status === 'pending') {
      current.decision_status = current.account_id || current.category_id ? 'finalized' : 'unassigned'
      if (current.final_decision_source === 'none') {
        current.final_decision_source = current.account_id || current.category_id ? 'commercialista' : 'none'
      }
    }
  }

  const finalLines = lines.map((line) => lineResults.get(line.line_id) || buildInitialResult(line))
  // BUG 5: lines without account_id should never be 'finalized'
  for (const finalLine of finalLines) {
    if (!finalLine.account_id && finalLine.decision_status === 'finalized') {
      finalLine.decision_status = 'needs_review'
    }
  }
  for (const finalLine of finalLines) {
    if (!finalLine.reasoning_summary_final) {
      finalLine.reasoning_summary_final = finalLine.decision_status === 'unassigned'
        ? 'Decisione non applicata: evidenza insufficiente sulla riga'
        : finalLine.classification_reasoning || finalLine.fiscal_reasoning || finalLine.reasoning
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
