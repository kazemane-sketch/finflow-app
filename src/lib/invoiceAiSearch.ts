/**
 * Shared helpers for calling the invoice-ai-search edge function.
 * Used by FatturePage (main invoice search) and RiconciliazionePage (candidate search).
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

// ---- Types ----

export type InvoiceAiSearchResponse = {
  query_type: 'deterministic'
  ids: string[]
  total: number
  explanation: string
  filters: any[]
  request_id?: string
}

export type InvoiceAiResult = {
  text: string
  isError: boolean
  requestId?: string
  candidateIds?: string[]
  total?: number
}

// ---- Helpers ----

export function normalizeCandidateIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0)
}

async function invokeInvoiceAiSearch(
  body: Record<string, unknown>,
  token: string,
): Promise<InvoiceAiSearchResponse> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/invoice-ai-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`
    const err = new Error(msg) as any
    err.status = res.status
    err.errorCode = data?.error_code
    err.hint = data?.hint
    err.details = data?.details
    throw err
  }

  return {
    query_type: data.query_type || 'deterministic',
    ids: normalizeCandidateIds(data.ids),
    total: Number(data.total || 0),
    explanation: typeof data.explanation === 'string' ? data.explanation : '',
    filters: Array.isArray(data.filters) ? data.filters : [],
    request_id: data.request_id,
  }
}

/**
 * Call invoice-ai-search with automatic 401 retry (token refresh).
 */
export async function askInvoiceAiSearch(
  body: Record<string, unknown>,
): Promise<InvoiceAiSearchResponse> {
  let token = await getValidAccessToken()
  try {
    return await invokeInvoiceAiSearch(body, token)
  } catch (e: any) {
    if (e?.status === 401) {
      // Retry once with force-refreshed token
      token = await getValidAccessToken({ forceRefresh: true })
      return await invokeInvoiceAiSearch(body, token)
    }
    throw e
  }
}
