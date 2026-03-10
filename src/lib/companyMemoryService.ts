/**
 * Company Memory Service — Persistent AI knowledge base per azienda.
 *
 * Ogni conferma/correzione dell'utente genera un "fatto" in company_memory.
 * L'edge function classify-invoice-lines usa questi fatti (via embedding search)
 * per produrre suggerimenti piu precisi a costo ridotto (Haiku + pre-flight).
 *
 * Pattern:
 *   1. Utente conferma → createMemoryFrom*() → insert in company_memory
 *   2. triggerMemoryEmbed() → fire-and-forget POST a memory-embed edge function
 *   3. classify-invoice-lines → search_company_memory() pgvector search
 *
 * Soft-delete: active = false (mai DELETE fisico).
 */
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

/* ─── Types ─────────────────────────────────────── */

type FactType = 'counterparty_pattern' | 'account_mapping' | 'user_correction' | 'fiscal_rule' | 'general'
type FactSource = 'system' | 'user_confirm' | 'user_correction' | 'reconciliation' | 'ai_chat' | 'manual'

interface MemoryInsert {
  company_id: string
  fact_type: FactType
  fact_text: string
  metadata?: Record<string, unknown>
  counterparty_id?: string | null
  source: FactSource
}

/* ─── Generic: insert memory fact ───────────────── */

export async function insertMemoryFact(row: MemoryInsert): Promise<string | null> {
  if (!row.fact_text || row.fact_text.length < 5) return null

  try {
    const { data, error } = await supabase
      .from('company_memory')
      .insert({
        company_id: row.company_id,
        fact_type: row.fact_type,
        fact_text: row.fact_text.slice(0, 2000),
        metadata: row.metadata || {},
        counterparty_id: row.counterparty_id || null,
        source: row.source,
      })
      .select('id')
      .single()

    if (error) {
      // Dedup index violation → fact already exists, just return null
      if (error.code === '23505') return null
      console.warn('[companyMemory] insertMemoryFact error:', error.message)
      return null
    }
    return data?.id || null
  } catch (err) {
    console.warn('[companyMemory] insertMemoryFact exception:', err)
    return null
  }
}

/* ─── Fire-and-forget: trigger embedding ─────────── */

/**
 * Triggers the memory-embed edge function to generate embeddings
 * for the given memory fact IDs. Non-blocking (fire-and-forget).
 */
export async function triggerMemoryEmbed(memoryIds: string[], companyId: string): Promise<void> {
  if (memoryIds.length === 0) return

  try {
    const token = await getValidAccessToken()
    fetch(`${SUPABASE_URL}/functions/v1/memory-embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        memory_ids: memoryIds,
        company_id: companyId,
      }),
    }).catch(err => console.warn('[companyMemory] triggerMemoryEmbed fetch error:', err))
  } catch (err) {
    console.warn('[companyMemory] triggerMemoryEmbed token error:', err)
  }
}

/**
 * Triggers precompute-embeddings for entity tables (chart_of_accounts,
 * categories, articles, projects). Use after creating/updating entities.
 * Non-blocking (fire-and-forget).
 *
 * @param entityIds — Optional: embed only these specific entity UUIDs
 *   (for incremental updates after create/edit). Omit for full backfill.
 */
export async function triggerEntityEmbedding(
  companyId: string,
  entityTypes?: ('chart_of_accounts' | 'categories' | 'articles' | 'projects')[],
  entityIds?: string[],
): Promise<void> {
  try {
    const token = await getValidAccessToken()
    const payload: Record<string, unknown> = { company_id: companyId }
    if (entityTypes) payload.entity_types = entityTypes
    if (entityIds && entityIds.length > 0) payload.entity_ids = entityIds

    fetch(`${SUPABASE_URL}/functions/v1/precompute-embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    }).catch(err => console.warn('[companyMemory] triggerEntityEmbedding fetch error:', err))
  } catch (err) {
    console.warn('[companyMemory] triggerEntityEmbedding token error:', err)
  }
}

/* ─── Full backfill: Brain AI activation ─────────── */

export interface BrainBackfillResult {
  entities: Record<string, { processed: number; errors: number; remaining: number }>
  memory: { processed: number; errors: number; remaining: number }
  /** Current step label for live UI updates */
  currentStep?: string
}

const ENTITY_TYPES = ['chart_of_accounts', 'categories', 'articles', 'projects'] as const
const ENTITY_LABELS: Record<string, string> = {
  chart_of_accounts: 'Conti',
  categories: 'Categorie',
  articles: 'Articoli',
  projects: 'CdC',
}

/**
 * Triggers a FULL backfill of all entity embeddings + company_memory embeddings.
 *
 * **Key design**: calls precompute-embeddings with ONE entity_type at a time
 * to avoid the 60s edge function timeout. Each type loops until remaining = 0
 * (max 20 rounds × 50 items/round = 1000 per type).
 *
 * @param onProgress — called after each batch so the UI can update live
 */
export async function triggerFullBrainBackfill(
  companyId: string,
  onProgress?: (partial: BrainBackfillResult) => void,
): Promise<BrainBackfillResult> {
  const token = await getValidAccessToken()
  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${token}`,
  }

  const result: BrainBackfillResult = {
    entities: {},
    memory: { processed: 0, errors: 0, remaining: 0 },
  }

  const MAX_ROUNDS = 20

  // ── Entity embeddings: one type at a time, each loops until done ──
  for (const entityType of ENTITY_TYPES) {
    const label = ENTITY_LABELS[entityType] || entityType
    result.currentStep = `${label}...`
    onProgress?.({ ...result, entities: { ...result.entities }, memory: { ...result.memory } })

    for (let round = 0; round < MAX_ROUNDS; round++) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/precompute-embeddings`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            company_id: companyId,
            entity_types: [entityType],
          }),
        })
        if (!res.ok) {
          console.warn(`[brainBackfill] ${entityType} round ${round} HTTP ${res.status}`)
          break
        }
        const data = await res.json()
        const typeResult = data.processed_by_type?.[entityType] as
          { processed: number; errors: number; remaining: number } | undefined

        if (!typeResult) break

        // Accumulate
        if (!result.entities[entityType]) {
          result.entities[entityType] = { processed: 0, errors: 0, remaining: 0 }
        }
        result.entities[entityType].processed += typeResult.processed
        result.entities[entityType].errors += typeResult.errors
        result.entities[entityType].remaining = typeResult.remaining

        // Update step label with counts
        const e = result.entities[entityType]
        result.currentStep = `${label}: ${e.processed}${typeResult.remaining > 0 ? ` (${typeResult.remaining} rimanenti)` : ' ✓'}`
        onProgress?.({ ...result, entities: { ...result.entities }, memory: { ...result.memory } })

        // Done with this type?
        if (typeResult.remaining === 0 || typeResult.processed === 0) break
      } catch (err) {
        console.warn(`[brainBackfill] ${entityType} round ${round} error:`, err)
        break
      }
    }
  }

  // ── Memory embeddings: loop until remaining = 0 ──
  result.currentStep = 'Memoria...'
  onProgress?.({ ...result, entities: { ...result.entities }, memory: { ...result.memory } })

  for (let round = 0; round < MAX_ROUNDS; round++) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/memory-embed`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ company_id: companyId, mode: 'backfill' }),
      })
      if (!res.ok) {
        console.warn(`[brainBackfill] memory round ${round} HTTP ${res.status}`)
        break
      }
      const data = await res.json()
      result.memory.processed += data.processed || 0
      result.memory.errors += data.errors || 0
      result.memory.remaining = data.remaining || 0

      result.currentStep = `Memoria: ${result.memory.processed}${data.remaining > 0 ? ` (${data.remaining} rimanenti)` : ' ✓'}`
      onProgress?.({ ...result, entities: { ...result.entities }, memory: { ...result.memory } })

      if (data.remaining === 0 || (data.processed || 0) === 0) break
    } catch (err) {
      console.warn('[brainBackfill] memory round error:', err)
      break
    }
  }

  result.currentStep = undefined
  return result
}

/* ─── Domain helpers ────────────────────────────── */

/**
 * Creates a memory fact from a confirmed classification.
 * Called for each invoice line the user confirms.
 *
 * fact_type: 'counterparty_pattern'
 * fact_text: "Controparte 'X' fattura passiva: riga 'Y' → conto Z (Nome), categoria W"
 */
export async function createMemoryFromClassification(
  companyId: string,
  counterpartyId: string | null,
  counterpartyName: string | null,
  lineDescription: string,
  categoryName: string | null,
  accountCode: string | null,
  accountName: string | null,
  direction: 'in' | 'out',
  articleCode?: string | null,
  articleName?: string | null,
): Promise<string | null> {
  if (!lineDescription || lineDescription.length < 3) return null

  const dirLabel = direction === 'in' ? 'fattura passiva' : 'fattura attiva'
  const cpLabel = counterpartyName || 'sconosciuto'

  let factText = `Controparte '${cpLabel}' ${dirLabel}: riga '${lineDescription}'`
  if (accountCode && accountName) {
    factText += ` → conto ${accountCode} (${accountName})`
  }
  if (categoryName) {
    factText += `, categoria ${categoryName}`
  }
  if (articleCode && articleName) {
    factText += `, articolo ${articleCode} (${articleName})`
  }

  const metadata: Record<string, unknown> = { direction }
  if (accountCode) metadata.account_code = accountCode
  if (categoryName) metadata.category_name = categoryName
  if (articleCode) metadata.article_code = articleCode

  const memId = await insertMemoryFact({
    company_id: companyId,
    fact_type: 'counterparty_pattern',
    fact_text: factText,
    metadata,
    counterparty_id: counterpartyId,
    source: 'user_confirm',
  })

  if (memId) triggerMemoryEmbed([memId], companyId)
  return memId
}

/**
 * Creates a memory fact when the user CORRECTS an AI suggestion.
 * Captures what was wrong and what the correct classification should be.
 *
 * fact_type: 'user_correction'
 */
export async function createMemoryFromCorrection(
  companyId: string,
  counterpartyId: string | null,
  lineDescription: string,
  originalAccountCode: string | null,
  originalAccountName: string | null,
  correctedAccountCode: string | null,
  correctedAccountName: string | null,
  originalCategoryName: string | null,
  correctedCategoryName: string | null,
): Promise<string | null> {
  if (!lineDescription || lineDescription.length < 3) return null

  const parts: string[] = [`Utente ha corretto riga '${lineDescription}'`]

  if (originalAccountCode && correctedAccountCode && originalAccountCode !== correctedAccountCode) {
    parts.push(`conto da ${originalAccountCode} (${originalAccountName || '?'}) a ${correctedAccountCode} (${correctedAccountName || '?'})`)
  }
  if (originalCategoryName && correctedCategoryName && originalCategoryName !== correctedCategoryName) {
    parts.push(`categoria da '${originalCategoryName}' a '${correctedCategoryName}'`)
  }

  // Only create if there's an actual correction
  if (parts.length < 2) return null

  const factText = parts.join(' — ')
  const metadata: Record<string, unknown> = {}
  if (originalAccountCode) metadata.original_account_code = originalAccountCode
  if (correctedAccountCode) metadata.corrected_account_code = correctedAccountCode
  if (originalCategoryName) metadata.original_category_name = originalCategoryName
  if (correctedCategoryName) metadata.corrected_category_name = correctedCategoryName

  const memId = await insertMemoryFact({
    company_id: companyId,
    fact_type: 'user_correction',
    fact_text: factText,
    metadata,
    counterparty_id: counterpartyId,
    source: 'user_correction',
  })

  if (memId) triggerMemoryEmbed([memId], companyId)
  return memId
}

/**
 * Creates a memory fact from a confirmed reconciliation.
 * Captures the pattern: transaction description → invoice match.
 *
 * fact_type: 'counterparty_pattern' (because it's about counterparty payment patterns)
 */
export async function createMemoryFromReconciliation(
  companyId: string,
  counterpartyId: string | null,
  counterpartyName: string | null,
  txDescription: string,
  invoiceNumber: string | null,
  txAmount: number,
  matchScore: number | null,
): Promise<string | null> {
  if (!txDescription || txDescription.length < 3) return null

  const cpLabel = counterpartyName || 'sconosciuto'
  const invLabel = invoiceNumber || 'N/D'
  const factText = `Riconciliazione: movimento '${txDescription}' (${txAmount} EUR) di '${cpLabel}' → fattura ${invLabel}`

  const metadata: Record<string, unknown> = {
    tx_amount: txAmount,
    match_score: matchScore,
    invoice_number: invoiceNumber,
  }

  const memId = await insertMemoryFact({
    company_id: companyId,
    fact_type: 'counterparty_pattern',
    fact_text: factText,
    metadata,
    counterparty_id: counterpartyId,
    source: 'reconciliation',
  })

  if (memId) triggerMemoryEmbed([memId], companyId)
  return memId
}

/* ─── Reset / Soft-delete ───────────────────────── */

/**
 * Soft-deletes all company_memory facts for a specific counterparty.
 * Also deactivates classification_rules for that counterparty.
 * Returns the count of deactivated facts.
 */
export async function resetCounterpartyMemory(
  companyId: string,
  counterpartyId: string,
  counterpartyVatKey?: string | null,
): Promise<{ memoryDeactivated: number; rulesDeactivated: number }> {
  let memoryDeactivated = 0
  let rulesDeactivated = 0

  // 1. Soft-delete company_memory facts
  const { data: memData, error: memErr } = await supabase
    .from('company_memory')
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('counterparty_id', counterpartyId)
    .eq('active', true)
    .select('id')

  if (memErr) {
    console.error('[companyMemory] resetCounterpartyMemory error:', memErr.message)
  } else {
    memoryDeactivated = memData?.length || 0
  }

  // 2. Soft-delete classification_rules if VAT key available
  if (counterpartyVatKey) {
    const vatKey = counterpartyVatKey.toUpperCase().replace(/^IT/i, '').replace(/[^A-Z0-9]/gi, '')
    const { data: ruleData, error: ruleErr } = await supabase
      .from('classification_rules')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('counterparty_vat_key', vatKey)
      .eq('active', true)
      .select('id')

    if (ruleErr) {
      console.error('[companyMemory] resetCounterpartyMemory rules error:', ruleErr.message)
    } else {
      rulesDeactivated = ruleData?.length || 0
    }
  }

  return { memoryDeactivated, rulesDeactivated }
}
