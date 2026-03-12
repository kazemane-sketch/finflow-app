import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

export type EdgeAuthFetchError = Error & {
  status?: number
  payload?: unknown
  bodyText?: string
}

function createEdgeAuthFetchError(
  message: string,
  extra?: Partial<EdgeAuthFetchError>,
): EdgeAuthFetchError {
  const err = new Error(message) as EdgeAuthFetchError
  if (extra?.status != null) err.status = extra.status
  if (extra?.payload !== undefined) err.payload = extra.payload
  if (extra?.bodyText !== undefined) err.bodyText = extra.bodyText
  return err
}

async function fetchWithToken(
  functionName: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  forceRefresh = false,
) {
  const token = await getValidAccessToken(forceRefresh ? { forceRefresh: true } : undefined)
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  })

  const text = await res.text().catch(() => '')
  let payload: unknown = {}
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = {}
    }
  }

  return { res, text, payload }
}

export async function postEdgeJsonWithAuthRetry<T>(
  functionName: string,
  body: Record<string, unknown>,
  options?: { signal?: AbortSignal },
): Promise<T> {
  const first = await fetchWithToken(functionName, body, options?.signal)
  let final = first

  if (first.res.status === 401 || first.res.status === 403) {
    final = await fetchWithToken(functionName, body, options?.signal, true)
  }

  if (!final.res.ok) {
    const payload = final.payload as Record<string, unknown> | undefined
    const message =
      (typeof payload?.error === 'string' && payload.error) ||
      (typeof payload?.message === 'string' && payload.message) ||
      `HTTP ${final.res.status}`

    throw createEdgeAuthFetchError(message, {
      status: final.res.status,
      payload: final.payload,
      bodyText: final.text,
    })
  }

  return final.payload as T
}
