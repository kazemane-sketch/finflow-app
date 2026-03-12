// src/lib/reconciliationTrigger.ts
// Fire-and-forget auto-trigger for reconciliation after imports.
// Bank imports: extract refs first, then generate suggestions.
// Invoice imports: generate suggestions directly.

import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'
import { toast } from 'sonner'

interface ReconciliationResult {
  processed: number
  new_suggestions: number
}

/**
 * Run bank-extract-refs in a loop until no pending remain.
 */
async function runExtractRefs(companyId: string): Promise<number> {
  let totalProcessed = 0
  while (true) {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/bank-extract-refs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ company_id: companyId, batch_size: 50 }),
    })
    if (!res.ok) throw new Error(`extract-refs HTTP ${res.status}`)
    const data = await res.json()
    totalProcessed += (data.processed || 0)
    if ((data.total_pending || 0) <= 0) break
  }
  return totalProcessed
}

/**
 * Run reconciliation-generate once.
 */
async function runReconciliationGenerate(
  companyId: string,
  token: string,
): Promise<ReconciliationResult> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/reconciliation-generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ company_id: companyId, batch_size: 100, engine_mode: 'contextual' }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
  return await res.json()
}

export interface AutoReconcileOptions {
  /** If true, run bank-extract-refs first (needed for bank imports) */
  extractFirst?: boolean
  /** Callback after completion (e.g., refresh badge data) */
  onComplete?: (result: ReconciliationResult) => void
  /** Show toast when new suggestions found (default: true) */
  showToast?: boolean
}

/**
 * Fire-and-forget: auto-trigger the reconciliation pipeline after an import.
 *
 * For bank imports: set extractFirst=true (runs bank-extract-refs loop first).
 * For invoice imports: leave extractFirst=false.
 *
 * Never throws, never blocks the caller.
 */
export function triggerAutoReconciliation(
  companyId: string,
  options: AutoReconcileOptions = {},
): void {
  const {
    extractFirst = false,
    onComplete,
    showToast = true,
  } = options

  void (async () => {
    try {
      // Phase 1: Extract refs if needed (bank imports only)
      if (extractFirst) {
        const extracted = await runExtractRefs(companyId)
        if (extracted > 0) {
          console.log(`[AutoReconcile] Extracted refs for ${extracted} transactions`)
        }
      }

      // Phase 2: Generate reconciliation suggestions
      const token = await getValidAccessToken()
      const result = await runReconciliationGenerate(companyId, token)

      console.log(
        `[AutoReconcile] Done: ${result.new_suggestions} new suggestions from ${result.processed} transactions`,
      )

      if (result.new_suggestions > 0 && showToast) {
        toast.info(
          `Riconciliazione automatica: ${result.new_suggestions} nuov${result.new_suggestions === 1 ? 'o suggerimento' : 'i suggerimenti'}`,
          { duration: 4000 },
        )
      }

      onComplete?.(result)
    } catch (err) {
      // Silent failure: don't disrupt the import flow
      console.warn('[AutoReconcile] Error (non-blocking):', err)
    }
  })()
}
