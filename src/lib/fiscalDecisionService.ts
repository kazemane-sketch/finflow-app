/**
 * Fiscal Decision Service — gestisce le scelte fiscali dell'utente.
 *
 * Quando il revisore genera un alert (es. "auto 20% o camion 100%?")
 * e l'utente sceglie, la decisione viene salvata in fiscal_decisions.
 *
 * La prossima volta che una fattura con la STESSA combinazione di:
 *   controparte + gruppo operazione + subject keywords + direzione
 * si ripresenta, il sistema applica la decisione automaticamente
 * SENZA chiedere di nuovo.
 *
 * Il matching è ESTREMAMENTE stringente:
 * - Stessa controparte (vat_key esatto)
 * - Stesso operation_group_code
 * - Subject keywords devono avere overlap >= 80%
 * - Stessa direzione
 */

import { supabase } from '@/integrations/supabase/client'
import {
  normalizeDescription,
  normalizeVatKey,
  getOperationGroupForDescription,
  extractSubjectKeywords,
} from './classificationRulesService'

/* ─── Types ──────────────────────────────────── */

export interface FiscalDecision {
  id: string
  alert_type: string
  chosen_option_label: string
  fiscal_override: Record<string, unknown>
  times_applied: number
  subject_keywords: string[]
  operation_group_code: string
}

function requiresExactContractRef(description: string): boolean {
  return /\b(leasing|locazione finanziaria)\b/i.test(description)
}

/* ─── Save a fiscal decision ─────────────────── */

/**
 * Salva una decisione fiscale dell'utente.
 * Chiamata quando l'utente clicca un'opzione su un alert del revisore.
 */
export async function saveFiscalDecision(
  companyId: string,
  invoiceId: string,
  lineDescription: string,
  counterpartyVatKey: string,
  direction: 'in' | 'out',
  alert: {
    type: string
    chosen_option_label: string
    fiscal_override: Record<string, unknown>
  },
  contractRef?: string | null,
  accountId?: string | null,
): Promise<void> {
  const vatKey = normalizeVatKey(counterpartyVatKey)
  if (!vatKey) return

  const operationGroup = await getOperationGroupForDescription(lineDescription)
  if (!operationGroup) return // Non possiamo salvare senza gruppo operazione

  const subjectKw = extractSubjectKeywords(lineDescription)
  const normalizedDesc = normalizeDescription(lineDescription)

  const { error } = await supabase
    .from('fiscal_decisions')
    .upsert({
      company_id: companyId,
      counterparty_vat_key: vatKey,
      operation_group_code: operationGroup.group_code,
      subject_keywords: subjectKw,
      direction,
      description_pattern: normalizedDesc,
      alert_type: alert.type,
      chosen_option_label: alert.chosen_option_label,
      fiscal_override: alert.fiscal_override,
      contract_ref: contractRef || null,
      account_id: accountId || null,
      times_applied: 1,
      source_invoice_id: invoiceId,
      updated_at: new Date().toISOString(),
    } as any, {
      // Updated unique index idx_fd_dedup includes contract_ref + account_id
      ignoreDuplicates: false,
    })

  if (error) {
    console.warn('[fiscalDecision] saveFiscalDecision error:', error.message)
    throw error
  }
}

export async function deleteFiscalDecisionsForInvoice(invoiceId: string): Promise<number> {
  const { data, error } = await supabase
    .from('fiscal_decisions')
    .delete()
    .eq('source_invoice_id', invoiceId)
    .select('id')

  if (error) {
    console.warn('[fiscalDecision] deleteFiscalDecisionsForInvoice error:', error.message)
    throw error
  }

  return data?.length || 0
}

/* ─── Find matching fiscal decisions ─────────── */

/**
 * Cerca decisioni fiscali matching per le righe di una fattura.
 * Usato dal fiscal-reviewer per pre-applicare decisioni già prese.
 *
 * Il matching è MOLTO stringente:
 * 1. Stessa controparte (vat_key esatto)
 * 2. Stesso operation_group_code
 * 3. Subject keywords overlap >= 80% (Jaccard)
 * 4. Stessa direzione
 */
export async function findMatchingFiscalDecisions(
  companyId: string,
  counterpartyVatKey: string,
  direction: 'in' | 'out',
  lines: { id: string; description: string; account_id?: string | null }[],
  contractRefs?: string[],
): Promise<Map<string, FiscalDecision[]>> {
  const vatKey = normalizeVatKey(counterpartyVatKey)
  if (!vatKey) return new Map()

  const { data: decisions } = await supabase
    .from('fiscal_decisions')
    .select('*')
    .eq('company_id', companyId)
    .eq('counterparty_vat_key', vatKey)
    .eq('direction', direction)

  if (!decisions || decisions.length === 0) return new Map()

  const result = new Map<string, FiscalDecision[]>()

  for (const line of lines) {
    const lineOpGroup = await getOperationGroupForDescription(line.description)
    if (!lineOpGroup) continue

    const lineSubjectKw = extractSubjectKeywords(line.description)
    const lineSubjectSet = new Set(lineSubjectKw)
    const requireContractRef = requiresExactContractRef(line.description)

    const matching: FiscalDecision[] = []

    for (const dec of decisions) {
      // Check 1: stesso operation group
      if (dec.operation_group_code !== lineOpGroup.group_code) continue

      // Check 1.5: contract_ref compatibility
      // If the decision has a contract_ref, the invoice MUST have the same ref
      if (requireContractRef) {
        if (!(dec as any).contract_ref) continue
        if (!contractRefs?.includes((dec as any).contract_ref)) continue
      } else if ((dec as any).contract_ref) {
        if (!contractRefs?.includes((dec as any).contract_ref)) continue
      }

      // Check 1.6: account_id compatibility
      // If the decision has an account_id, the line MUST have the same account
      if ((dec as any).account_id) {
        if (line.account_id !== (dec as any).account_id) continue
      }

      // Check 2: subject keywords overlap >= 80% (Jaccard)
      const decSubjectSet = new Set((dec.subject_keywords as string[]) || [])

      // Se entrambi sono vuoti → match (operazione generica)
      // Se solo uno è vuoto → NO match (uno è specifico, l'altro no)
      if (lineSubjectSet.size === 0 && decSubjectSet.size === 0) {
        matching.push(dec as FiscalDecision)
        continue
      }
      if (lineSubjectSet.size === 0 || decSubjectSet.size === 0) continue

      const intersection = [...lineSubjectSet].filter(w => decSubjectSet.has(w)).length
      const union = new Set([...lineSubjectSet, ...decSubjectSet]).size
      const jaccard = union > 0 ? intersection / union : 0

      // Soglia MOLTO alta: 80%
      if (jaccard >= 0.80) {
        matching.push(dec as FiscalDecision)
      }
    }

    if (matching.length > 0) {
      result.set(line.id, matching)
    }
  }

  return result
}
