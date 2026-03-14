import { supabase } from '@/integrations/supabase/client'

export type WeakFieldState = 'assigned' | 'unassigned' | 'needs_review'
export type LineDecisionStatus = 'pending' | 'finalized' | 'needs_review' | 'unassigned'
// 'revisore' kept for backward compatibility with existing DB records
export type FinalDecisionSource = 'commercialista' | 'revisore' | 'consulente' | 'user' | 'exact_match' | 'none'

export interface SupportingEvidence {
  source: 'kb' | 'memory' | 'deterministic' | 'reviewer' | 'consultant' | 'company_stats' | 'invoice' | 'history' | 'user'
  label: string
  detail?: string | null
  ref?: string | null
}

export interface StructuredRationale {
  rationale_summary: string | null
  decision_basis: string[]
  supporting_factors: string[]
  supporting_evidence: SupportingEvidence[]
}

export interface CommercialistaProposalRow extends StructuredRationale {
  line_id: string
  confidence: number | null
  proposal: Record<string, unknown>
}

export interface ReviewerVerdictRow extends StructuredRationale {
  line_id: string
  decision_status: LineDecisionStatus
  final_confidence: number | null
  verdict: Record<string, unknown>
  red_flags?: string[]
}

export interface FinalDecisionRow extends StructuredRationale {
  line_id: string
  decision_source: FinalDecisionSource
  decision_status: LineDecisionStatus
  confidence: number | null
  applied_payload: Record<string, unknown>
}

export interface ConsultantLinePatch {
  line_id: string
  category_id?: string | null
  account_id?: string | null
  fiscal_flags?: Record<string, unknown> | null
  decision_status?: LineDecisionStatus
  reasoning_summary_final?: string | null
  final_confidence?: number | null
  note?: string | null
}

export interface ConsultantResolutionPayload extends StructuredRationale {
  resolution_status?: 'proposed' | 'applied' | 'dismissed'
  invoice_line_ids: string[]
  message_excerpt?: string | null
  recommended_conclusion?: string | null
  risk_level?: 'low' | 'medium' | 'high' | null
  expected_impact?: string | null
  decision_patch?: Record<string, unknown>
  source_payload?: Record<string, unknown>
  line_updates?: ConsultantLinePatch[]
}

function uniqStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
}

function normalizeStructuredRationale(input?: Partial<StructuredRationale> | null): StructuredRationale {
  return {
    rationale_summary: input?.rationale_summary?.trim() || null,
    decision_basis: uniqStrings(input?.decision_basis || []),
    supporting_factors: uniqStrings(input?.supporting_factors || []),
    supporting_evidence: Array.isArray(input?.supporting_evidence) ? input.supporting_evidence : [],
  }
}

export async function saveCommercialistaProposals(
  companyId: string,
  invoiceId: string,
  rows: CommercialistaProposalRow[],
): Promise<void> {
  if (rows.length === 0) return
  const payload = rows.map((row) => {
    const rationale = normalizeStructuredRationale(row)
    return {
      company_id: companyId,
      invoice_id: invoiceId,
      invoice_line_id: row.line_id,
      proposal: row.proposal,
      confidence: row.confidence,
      rationale_summary: rationale.rationale_summary,
      decision_basis: rationale.decision_basis,
      supporting_factors: rationale.supporting_factors,
      supporting_evidence: rationale.supporting_evidence,
    }
  })
  const { error } = await supabase.from('invoice_line_commercialista_proposals').insert(payload as any)
  if (error) throw error
}

export async function saveReviewerVerdicts(
  companyId: string,
  invoiceId: string,
  rows: ReviewerVerdictRow[],
): Promise<void> {
  if (rows.length === 0) return
  const payload = rows.map((row) => {
    const rationale = normalizeStructuredRationale(row)
    return {
      company_id: companyId,
      invoice_id: invoiceId,
      invoice_line_id: row.line_id,
      verdict: row.verdict,
      decision_status: row.decision_status,
      final_confidence: row.final_confidence,
      rationale_summary: rationale.rationale_summary,
      decision_basis: rationale.decision_basis,
      supporting_factors: rationale.supporting_factors,
      supporting_evidence: rationale.supporting_evidence,
      red_flags: uniqStrings(row.red_flags || []),
    }
  })
  const { error } = await supabase.from('invoice_line_reviewer_verdicts').insert(payload as any)
  if (error) throw error
}

export async function saveFinalDecisions(
  companyId: string,
  invoiceId: string,
  rows: FinalDecisionRow[],
): Promise<void> {
  if (rows.length === 0) return
  const payload = rows.map((row) => {
    const rationale = normalizeStructuredRationale(row)
    return {
      company_id: companyId,
      invoice_id: invoiceId,
      invoice_line_id: row.line_id,
      decision_source: row.decision_source,
      decision_status: row.decision_status,
      applied_payload: row.applied_payload,
      confidence: row.confidence,
      rationale_summary: rationale.rationale_summary,
      decision_basis: rationale.decision_basis,
      supporting_factors: rationale.supporting_factors,
      supporting_evidence: rationale.supporting_evidence,
    }
  })
  const { error } = await supabase.from('invoice_line_final_decisions').insert(payload as any)
  if (error) throw error
}

export async function clearInvoiceDecisionTrail(invoiceId: string): Promise<void> {
  const tables = [
    'invoice_line_commercialista_proposals',
    'invoice_line_reviewer_verdicts',
    'invoice_line_final_decisions',
    'invoice_consultant_resolutions',
  ] as const

  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('invoice_id', invoiceId)
    if (error) throw error
  }
}

export async function saveConsultantResolution(
  companyId: string,
  invoiceId: string,
  payload: ConsultantResolutionPayload,
): Promise<string> {
  const rationale = normalizeStructuredRationale(payload)
  const row = {
    company_id: companyId,
    invoice_id: invoiceId,
    invoice_line_ids: payload.invoice_line_ids,
    resolution_status: payload.resolution_status || 'proposed',
    message_excerpt: payload.message_excerpt || null,
    recommended_conclusion: payload.recommended_conclusion || null,
    rationale_summary: rationale.rationale_summary,
    risk_level: payload.risk_level || null,
    supporting_evidence: rationale.supporting_evidence,
    expected_impact: payload.expected_impact || null,
    decision_patch: payload.decision_patch || {},
    source_payload: payload.source_payload || {},
  }
  const { data, error } = await supabase
    .from('invoice_consultant_resolutions')
    .insert(row as any)
    .select('id')
    .single()

  if (error) throw error
  return data.id as string
}

function isUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

export async function applyConsultantResolution(
  companyId: string,
  invoiceId: string,
  payload: ConsultantResolutionPayload,
): Promise<{ resolutionId: string, resolvedUpdates: ConsultantLinePatch[] }> {
  // ─── Resolve non-UUID values in line_updates ──────
  for (const update of payload.line_updates || []) {
    // Resolve account_id: if not a valid UUID, treat as account code
    if (update.account_id && !isUUID(update.account_id)) {
      const { data: acc } = await supabase
        .from('chart_of_accounts')
        .select('id')
        .eq('company_id', companyId)
        .eq('code', update.account_id)
        .eq('active', true)
        .limit(1)
        .single()
      if (acc) {
        update.account_id = acc.id
      } else {
        // Try partial match (without dots)
        const cleanCode = update.account_id.replace(/\./g, '')
        const { data: accFuzzy } = await supabase
          .from('chart_of_accounts')
          .select('id, code')
          .eq('company_id', companyId)
          .eq('active', true)
          .ilike('code', `%${cleanCode}%`)
          .limit(1)
          .single()
        update.account_id = accFuzzy?.id || null
      }
    }

    // Resolve category_id: if not a valid UUID, treat as category name/slug
    if (update.category_id && !isUUID(update.category_id)) {
      const searchTerm = update.category_id
        .replace(/_/g, ' ')    // cat_leasing → cat leasing
        .replace(/^cat\s*/i, '') // cat leasing → leasing
      const { data: cat } = await supabase
        .from('categories')
        .select('id')
        .eq('company_id', companyId)
        .eq('active', true)
        .ilike('name', `%${searchTerm}%`)
        .limit(1)
        .single()
      update.category_id = cat?.id || null
    }
  }

  const resolutionId = await saveConsultantResolution(companyId, invoiceId, {
    ...payload,
    line_updates: payload.line_updates, // Will be saved with the resolved UUIDs
    resolution_status: 'applied',
  })

  for (const update of payload.line_updates || []) {
    const { error } = await supabase
      .from('invoice_lines')
      .update({
        ...(update.category_id !== undefined ? { category_id: update.category_id } : {}),
        ...(update.account_id !== undefined ? { account_id: update.account_id } : {}),
        ...(update.fiscal_flags !== undefined ? { fiscal_flags: update.fiscal_flags } : {}),
        decision_status: update.decision_status || 'finalized',
        reasoning_summary_final: update.reasoning_summary_final || payload.rationale_summary || null,
        final_confidence: update.final_confidence ?? null,
        final_decision_source: 'consulente',
        ...(update.note !== undefined ? {
          line_note: update.note,
          line_note_source: 'ai_consultant',
          line_note_updated_at: new Date().toISOString(),
        } : {}),
      } as any)
      .eq('id', update.line_id)
    if (error) throw error
  }

  await saveFinalDecisions(companyId, invoiceId, (payload.line_updates || []).map((update) => ({
    line_id: update.line_id,
    decision_source: 'consulente',
    decision_status: update.decision_status || 'finalized',
    confidence: update.final_confidence ?? null,
    applied_payload: {
      resolution_id: resolutionId,
      category_id: update.category_id,
      account_id: update.account_id,
      fiscal_flags: update.fiscal_flags,
      note: update.note,
    },
    rationale_summary: update.reasoning_summary_final || payload.rationale_summary || null,
    decision_basis: payload.decision_basis,
    supporting_factors: payload.supporting_factors,
    supporting_evidence: payload.supporting_evidence,
  })))

  return { resolutionId, resolvedUpdates: payload.line_updates || [] }
}
