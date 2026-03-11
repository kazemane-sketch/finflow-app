/**
 * classificationRulesService — Deterministic fast-path classification rules.
 *
 * When a user confirms a classification, a "rule" is saved. Next time a similar
 * invoice line appears from the same counterparty, the system proposes the same
 * classification instantly (0ms) as a SUGGESTION — never applied automatically.
 *
 * v2 (Fase 3): rules now include fiscal_flags, operation_group_code, and
 * subject_keywords for smarter matching. Wrong rules are DELETED (not deactivated).
 *
 * Flow:
 *   1. User confirms → createRuleFromConfirmation() → upsert classification_rules
 *   2. New invoice opened → findMatchingRules() → instant suggestions
 *   3. User corrects → handleRuleCorrection() → DELETE old rule + create new one
 */
import { supabase } from '@/integrations/supabase/client'

/* ─── Types ──────────────────────────────────── */

export interface ClassificationRule {
  id: string
  company_id: string
  counterparty_vat_key: string | null
  counterparty_name_pattern: string | null
  description_pattern: string
  direction: string | null
  article_id: string | null
  phase_id: string | null
  category_id: string | null
  account_id: string | null
  cost_center_allocations: { project_id: string; percentage: number }[] | null
  fiscal_flags: Record<string, unknown> | null
  operation_group_code: string | null
  subject_keywords: string[]
  confidence: number
  times_applied: number
  times_confirmed: number
  times_corrected: number
  source: string
  active: boolean
}

export interface RuleSuggestion {
  line_id: string
  rule_id: string
  article_id: string | null
  phase_id: string | null
  category_id: string | null
  account_id: string | null
  cost_center_allocations: { project_id: string; percentage: number }[] | null
  fiscal_flags: Record<string, unknown> | null
  confidence: number
  source: 'rule'
}

/* ─── Operation keyword groups cache ─────────── */

let _groupsCache: { group_code: string; group_name: string; keywords: string[] }[] | null = null
let _groupsCacheTime = 0
const GROUPS_CACHE_TTL = 5 * 60 * 1000 // 5 min

async function loadKeywordGroups(): Promise<{ group_code: string; group_name: string; keywords: string[] }[]> {
  const now = Date.now()
  if (_groupsCache && now - _groupsCacheTime < GROUPS_CACHE_TTL) return _groupsCache

  const { data } = await supabase
    .from('operation_keyword_groups')
    .select('group_code, group_name, keywords')
    .eq('active', true)
    .order('sort_order')

  _groupsCache = (data || []) as { group_code: string; group_name: string; keywords: string[] }[]
  _groupsCacheTime = now
  return _groupsCache
}

/* ─── Description normalization ──────────────── */

/**
 * Normalize a line description for pattern matching:
 * - lowercase
 * - remove pure numbers and amounts (€, EUR, digits with decimals)
 * - collapse whitespace
 * - trim
 *
 * Example:
 *   "Growth Technology Root Riot, confezione da 100 pezzi sfusi" →
 *   "growth technology root riot confezione pezzi sfusi"
 */
export function normalizeDescription(desc: string): string {
  return desc
    .toLowerCase()
    // Remove currency symbols and amounts like "€ 123,45" or "123.45 EUR"
    .replace(/[€$]/g, '')
    .replace(/\b\d+([.,]\d+)?\s*(eur|euro)?\b/gi, '')
    // Remove standalone pure numbers (quantities, line numbers, etc.)
    .replace(/\b\d+\b/g, '')
    // Remove common punctuation that doesn't affect meaning
    .replace(/[,;:()[\]{}'"]/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normalize a VAT key for consistent matching.
 * Strips country prefix and non-alphanumeric characters.
 */
export function normalizeVatKey(piva: string): string {
  return piva.toUpperCase().replace(/^IT/i, '').replace(/[^A-Z0-9]/gi, '')
}

/* ─── Operation group matching ───────────────── */

/**
 * Cerca nel dizionario sinonimi il gruppo operazione per una descrizione.
 * Ritorna il gruppo con la keyword più lunga trovata (match più specifico).
 */
export async function getOperationGroupForDescription(
  description: string,
): Promise<{ group_code: string; group_name: string } | null> {
  const descLower = description.toLowerCase()
  const groups = await loadKeywordGroups()

  let bestMatch: { group_code: string; group_name: string; matchLen: number } | null = null

  for (const g of groups) {
    for (const kw of (g.keywords || [])) {
      const kwLower = kw.toLowerCase()
      if (descLower.includes(kwLower)) {
        if (!bestMatch || kwLower.length > bestMatch.matchLen) {
          bestMatch = { group_code: g.group_code, group_name: g.group_name, matchLen: kwLower.length }
        }
      }
    }
  }

  return bestMatch ? { group_code: bestMatch.group_code, group_name: bestMatch.group_name } : null
}

/* ─── Subject keywords extraction ────────────── */

const STOPWORDS = new Set([
  'per', 'con', 'del', 'della', 'dei', 'delle', 'dal', 'dalla',
  'nel', 'nella', 'sul', 'sulla', 'che', 'non', 'una', 'uno',
  'gli', 'alla', 'alle', 'tra', 'fra', 'come', 'anche', 'più',
  'rif', 'vostro', 'nostro', 'sig', 'spett', 'fattura', 'fatt',
  'numero', 'num', 'art', 'cod', 'tipo', 'data', 'periodo',
  'mese', 'anno', 'totale', 'importo', 'prezzo', 'costo',
  'netto', 'lordo', 'iva', 'inclusa', 'esclusa',
])

/**
 * Estrae le keywords del SOGGETTO dalla descrizione.
 * Il soggetto è CIÒ su cui si agisce (camion, auto, escavatore, ufficio...),
 * non L'AZIONE (riparazione, vendita, trasporto).
 *
 * Approccio: rimuovi targhe/numeri/importi/date, poi filtra stopwords.
 * Le parole restanti significative sono i subject keywords.
 */
export function extractSubjectKeywords(description: string): string[] {
  let desc = description.toLowerCase()

  // Rimuovi targhe (es. FG123XX, AB789ZZ)
  desc = desc.replace(/\b[a-z]{2}\d{3}[a-z]{2}\b/gi, '')

  // Rimuovi numeri, importi, date
  desc = desc.replace(/\b\d+([.,]\d+)?\s*(eur|euro|€|kg|lt|ton|pz|nr|q\.li)?\b/gi, '')
  desc = desc.replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, '')

  // Rimuovi punteggiatura
  desc = desc.replace(/[,;:()[\]{}'"/\\.\-]/g, ' ')

  // Normalizza spazi
  desc = desc.replace(/\s+/g, ' ').trim()

  // Le parole rimaste (filtrate per lunghezza >= 3 e non stopwords)
  const words = desc.split(' ').filter(w => w.length >= 3 && !STOPWORDS.has(w))

  // Ritorna max 5 keywords significative (le più lunghe = più specifiche)
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, 5)
}

/* ─── Find matching rules ────────────────────── */

/**
 * For each invoice line, search for a matching classification rule.
 * v2: uses operation_group_code matching and Jaccard similarity >= 0.85.
 *
 * Returns only SUGGESTIONS — never writes to DB.
 */
export async function findMatchingRules(
  companyId: string,
  counterpartyVatKey: string | null,
  counterpartyName: string | null,
  lines: { id: string; description: string }[],
  direction: 'in' | 'out',
): Promise<RuleSuggestion[]> {
  if (lines.length === 0) return []

  // Load active rules for this company + direction
  let rules: ClassificationRule[] = []

  const vatKey = counterpartyVatKey ? normalizeVatKey(counterpartyVatKey) : null

  if (vatKey) {
    // Primary: match by vat_key
    const { data, error } = await supabase
      .from('classification_rules')
      .select('*')
      .eq('company_id', companyId)
      .eq('counterparty_vat_key', vatKey)
      .eq('direction', direction)
      .eq('active', true)

    if (!error && data) rules = data as ClassificationRule[]
  }

  // Fallback: match by name pattern (if no vat_key rules found or no vat_key)
  if (rules.length === 0 && counterpartyName) {
    const nameLower = counterpartyName.toLowerCase().trim()
    const { data, error } = await supabase
      .from('classification_rules')
      .select('*')
      .eq('company_id', companyId)
      .eq('direction', direction)
      .eq('active', true)
      .not('counterparty_name_pattern', 'is', null)

    if (!error && data) {
      // Filter by name pattern match (case-insensitive substring)
      rules = (data as ClassificationRule[]).filter(r =>
        r.counterparty_name_pattern && nameLower.includes(r.counterparty_name_pattern.toLowerCase())
      )
    }
  }

  if (rules.length === 0) return []

  // Match lines against rules
  const suggestions: RuleSuggestion[] = []

  for (const line of lines) {
    const normalizedLine = normalizeDescription(line.description)
    if (normalizedLine.length < 3) continue

    // Estrai operation group della riga corrente
    const lineOpGroup = await getOperationGroupForDescription(line.description)

    const lineWords = new Set(normalizedLine.split(' ').filter(w => w.length >= 2))

    for (const rule of rules) {
      const ruleWords = new Set(
        (rule.description_pattern || '').split(' ').filter((w: string) => w.length >= 2)
      )

      // ── CHECK 1: Operation group deve corrispondere ──
      // Se la regola ha un operation_group_code e la riga ha un gruppo diverso → skip
      if (rule.operation_group_code && lineOpGroup?.group_code) {
        if (rule.operation_group_code !== lineOpGroup.group_code) continue
      }

      // ── CHECK 2: Similarità Jaccard sulle parole normalizzate ──
      const intersection = [...lineWords].filter(w => ruleWords.has(w)).length
      const union = new Set([...lineWords, ...ruleWords]).size
      const similarity = union > 0 ? intersection / union : 0

      if (similarity < 0.85) continue

      suggestions.push({
        line_id: line.id,
        rule_id: rule.id,
        article_id: rule.article_id,
        phase_id: rule.phase_id,
        category_id: rule.category_id,
        account_id: rule.account_id,
        cost_center_allocations: rule.cost_center_allocations,
        fiscal_flags: rule.fiscal_flags || null,
        confidence: Number(rule.confidence),
        source: 'rule',
      })

      // Update times_applied + last_applied_at (fire-and-forget)
      Promise.resolve(
        supabase
          .from('classification_rules')
          .update({
            times_applied: (rule.times_applied || 0) + 1,
            last_applied_at: new Date().toISOString(),
          })
          .eq('id', rule.id)
      ).catch(() => {})

      break // una sola regola per riga
    }
  }

  return suggestions
}

/* ─── Create/update rule from confirmation ───── */

/**
 * Create or update a classification rule when the user CONFIRMS a classification.
 * v2: now includes fiscal_flags, operation_group_code, subject_keywords.
 *
 * If a rule already exists for the same counterparty + description pattern,
 * increment times_confirmed and update classification if changed.
 */
export async function createRuleFromConfirmation(
  companyId: string,
  counterpartyVatKey: string | null,
  counterpartyName: string | null,
  lineDescription: string,
  direction: 'in' | 'out',
  classification: {
    article_id?: string | null
    phase_id?: string | null
    category_id?: string | null
    account_id?: string | null
    cost_center_allocations?: { project_id: string; percentage: number }[] | null
    fiscal_flags?: Record<string, unknown> | null
  },
  sourceInvoiceId?: string | null,
  contractRef?: string | null,
): Promise<void> {
  const normalizedDesc = normalizeDescription(lineDescription)
  if (normalizedDesc.length < 3) return

  const vatKey = counterpartyVatKey ? normalizeVatKey(counterpartyVatKey) : null

  // Estrai operation_group_code dal dizionario sinonimi
  const operationGroup = await getOperationGroupForDescription(lineDescription)

  // Estrai subject_keywords dalla descrizione
  const subjectKw = extractSubjectKeywords(lineDescription)

  // Check if rule exists (now includes contract_ref in the lookup)
  let query = supabase
    .from('classification_rules')
    .select('id, times_confirmed')
    .eq('company_id', companyId)
    .eq('description_pattern', normalizedDesc)
    .eq('direction', direction)

  if (vatKey) {
    query = query.eq('counterparty_vat_key', vatKey)
  } else {
    query = query.is('counterparty_vat_key', null)
  }

  // Contract ref: if provided, match only rules with same contract_ref
  // If not provided, match only rules without contract_ref
  if (contractRef) {
    query = query.eq('contract_ref', contractRef)
  } else {
    query = query.is('contract_ref', null)
  }

  const { data: existing } = await query.maybeSingle()

  if (existing) {
    // Update existing rule: increment times_confirmed, update classification
    const updatePayload: Record<string, unknown> = {
      times_confirmed: (existing.times_confirmed || 0) + 1,
      article_id: classification.article_id ?? null,
      phase_id: classification.phase_id ?? null,
      category_id: classification.category_id ?? null,
      account_id: classification.account_id ?? null,
      cost_center_allocations: classification.cost_center_allocations ?? null,
      fiscal_flags: classification.fiscal_flags ?? null,
      operation_group_code: operationGroup?.group_code || null,
      subject_keywords: subjectKw,
      contract_ref: contractRef || null,
      active: true, // Re-activate if it was deactivated
      updated_at: new Date().toISOString(),
    }
    if (sourceInvoiceId) updatePayload.source_invoice_id = sourceInvoiceId
    await supabase
      .from('classification_rules')
      .update(updatePayload)
      .eq('id', existing.id)
  } else {
    // Create new rule
    const row: Record<string, unknown> = {
      company_id: companyId,
      counterparty_vat_key: vatKey,
      counterparty_name_pattern: !vatKey && counterpartyName ? counterpartyName.toLowerCase().trim() : null,
      description_pattern: normalizedDesc,
      direction,
      article_id: classification.article_id ?? null,
      phase_id: classification.phase_id ?? null,
      category_id: classification.category_id ?? null,
      account_id: classification.account_id ?? null,
      cost_center_allocations: classification.cost_center_allocations ?? null,
      fiscal_flags: classification.fiscal_flags ?? null,
      operation_group_code: operationGroup?.group_code || null,
      subject_keywords: subjectKw,
      contract_ref: contractRef || null,
      confidence: 95,
      times_applied: 0,
      times_confirmed: 1,
      times_corrected: 0,
      source: 'user_confirm',
      active: true,
    }
    if (sourceInvoiceId) row.source_invoice_id = sourceInvoiceId

    const { error } = await supabase
      .from('classification_rules')
      .insert(row)

    if (error) {
      // Unique constraint violation → rule was created concurrently, just update
      if (error.code === '23505') {
        console.warn('[classificationRules] Duplicate rule, skipping:', normalizedDesc.slice(0, 50))
      } else {
        console.error('[classificationRules] Error creating rule:', error.message)
      }
    }
  }
}

/* ─── Deactivate rules for a cancelled invoice ── */

/**
 * Soft-delete (deactivate) classification rules that were created from a specific invoice.
 * Called when the user cancels a classification ("Cancella tutto" + Save).
 *
 * Only deactivates rules whose source_invoice_id matches — rules without a source
 * (legacy rules from before migration 044) are preserved.
 */
export async function deactivateRulesForInvoice(invoiceId: string): Promise<void> {
  const { error } = await supabase
    .from('classification_rules')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('source_invoice_id', invoiceId)
    .eq('active', true)

  if (error) {
    console.warn('[classificationRules] Error deactivating rules for invoice:', error.message)
  }
}

/* ─── Handle rule correction (DELETE + recreate) ── */

/**
 * L'utente ha corretto una classificazione suggerita da una regola.
 * ELIMINA la regola sbagliata e crea una nuova con i dati corretti.
 *
 * v2: DELETE fisico, non disattivazione.
 */
export async function handleRuleCorrection(
  companyId: string,
  invoiceId: string,
  ruleId: string,
  correctedLine: {
    description: string
    category_id: string | null
    account_id: string | null
    fiscal_flags?: Record<string, unknown> | null
  },
  counterpartyVatKey: string | null,
  counterpartyName: string | null,
  direction: 'in' | 'out',
  articleId?: string | null,
  phaseId?: string | null,
  costCenterAllocations?: { project_id: string; percentage: number }[] | null,
): Promise<void> {
  // ELIMINA la regola sbagliata (DELETE fisico, non disattivazione)
  await supabase
    .from('classification_rules')
    .delete()
    .eq('id', ruleId)

  // Crea una nuova regola con i dati corretti
  await createRuleFromConfirmation(
    companyId, counterpartyVatKey, counterpartyName,
    correctedLine.description, direction,
    {
      category_id: correctedLine.category_id,
      account_id: correctedLine.account_id,
      article_id: articleId || null,
      phase_id: phaseId || null,
      cost_center_allocations: costCenterAllocations || null,
      fiscal_flags: correctedLine.fiscal_flags || null,
    },
    invoiceId,
  )
}

/* ─── Record rule correction (legacy, kept for compat) ── */

/**
 * @deprecated Use handleRuleCorrection() instead.
 * When a user corrects a classification that was suggested by a rule.
 * Increment times_corrected. If correction rate > 30%, deactivate the rule.
 */
export async function recordRuleCorrection(ruleId: string): Promise<void> {
  const { data: rule } = await supabase
    .from('classification_rules')
    .select('times_applied, times_corrected')
    .eq('id', ruleId)
    .single()

  if (!rule) return

  const newCorrected = (rule.times_corrected || 0) + 1
  const totalApplied = rule.times_applied || 1
  const correctionRate = newCorrected / totalApplied

  await supabase
    .from('classification_rules')
    .update({
      times_corrected: newCorrected,
      active: correctionRate <= 0.3, // Deactivate if > 30% corrections
      updated_at: new Date().toISOString(),
    })
    .eq('id', ruleId)
}
