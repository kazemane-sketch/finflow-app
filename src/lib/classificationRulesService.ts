/**
 * classificationRulesService — Deterministic fast-path classification rules.
 *
 * When a user confirms a classification, a "rule" is saved. Next time a similar
 * invoice line appears from the same counterparty, the system proposes the same
 * classification instantly (0ms) as a SUGGESTION — never applied automatically.
 *
 * Flow:
 *   1. User confirms → createRuleFromConfirmation() → upsert classification_rules
 *   2. New invoice opened → findMatchingRules() → instant suggestions
 *   3. User corrects a rule suggestion → recordRuleCorrection() → deactivate if too many corrections
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
  category_id: string | null
  account_id: string | null
  cost_center_allocations: { project_id: string; percentage: number }[] | null
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
  category_id: string | null
  account_id: string | null
  cost_center_allocations: { project_id: string; percentage: number }[] | null
  confidence: number
  source: 'rule'
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
function normalizeVatKey(piva: string): string {
  return piva.toUpperCase().replace(/^IT/i, '').replace(/[^A-Z0-9]/gi, '')
}

/* ─── Find matching rules ────────────────────── */

/**
 * For each invoice line, search for a matching classification rule.
 * Match logic:
 *   1. If vat_key available → search by vat_key + description_pattern (substring match)
 *   2. If no vat_key → search by counterparty_name_pattern
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
    const normalizedDesc = normalizeDescription(line.description)
    if (normalizedDesc.length < 3) continue

    // Find best matching rule: the rule's description_pattern must be a substring of the normalized description
    let bestRule: ClassificationRule | null = null
    let bestMatchLength = 0

    for (const rule of rules) {
      // Check if the rule's pattern is contained in the line's normalized description
      if (normalizedDesc.includes(rule.description_pattern)) {
        // Prefer longer patterns (more specific match)
        if (rule.description_pattern.length > bestMatchLength) {
          bestMatchLength = rule.description_pattern.length
          bestRule = rule
        }
      }
    }

    if (bestRule) {
      suggestions.push({
        line_id: line.id,
        rule_id: bestRule.id,
        article_id: bestRule.article_id,
        category_id: bestRule.category_id,
        account_id: bestRule.account_id,
        cost_center_allocations: bestRule.cost_center_allocations,
        confidence: Number(bestRule.confidence),
        source: 'rule',
      })

      // Update times_applied + last_applied_at (fire-and-forget)
      Promise.resolve(
        supabase
          .from('classification_rules')
          .update({
            times_applied: (bestRule.times_applied || 0) + 1,
            last_applied_at: new Date().toISOString(),
          })
          .eq('id', bestRule.id)
      ).catch(() => {})
    }
  }

  return suggestions
}

/* ─── Create/update rule from confirmation ───── */

/**
 * Create or update a classification rule when the user CONFIRMS a classification.
 * Called alongside createClassificationExample() in the confirm flow.
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
    category_id?: string | null
    account_id?: string | null
    cost_center_allocations?: { project_id: string; percentage: number }[] | null
  },
): Promise<void> {
  const normalizedDesc = normalizeDescription(lineDescription)
  if (normalizedDesc.length < 3) return

  const vatKey = counterpartyVatKey ? normalizeVatKey(counterpartyVatKey) : null

  // Check if rule exists
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

  const { data: existing } = await query.maybeSingle()

  if (existing) {
    // Update existing rule: increment times_confirmed, update classification
    await supabase
      .from('classification_rules')
      .update({
        times_confirmed: (existing.times_confirmed || 0) + 1,
        article_id: classification.article_id ?? null,
        category_id: classification.category_id ?? null,
        account_id: classification.account_id ?? null,
        cost_center_allocations: classification.cost_center_allocations ?? null,
        active: true, // Re-activate if it was deactivated
        updated_at: new Date().toISOString(),
      })
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
      category_id: classification.category_id ?? null,
      account_id: classification.account_id ?? null,
      cost_center_allocations: classification.cost_center_allocations ?? null,
      confidence: 95,
      times_applied: 0,
      times_confirmed: 1,
      times_corrected: 0,
      source: 'user_confirm',
      active: true,
    }

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

/* ─── Record rule correction ─────────────────── */

/**
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
