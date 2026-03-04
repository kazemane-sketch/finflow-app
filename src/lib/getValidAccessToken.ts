import { supabase } from '@/integrations/supabase/client'

export type AccessTokenError = Error & {
  status?: number
  errorCode?: string
  hint?: string
}

function createAccessTokenError(message: string, extra?: Partial<AccessTokenError>): AccessTokenError {
  const err = new Error(message) as AccessTokenError
  if (extra?.status != null) err.status = extra.status
  if (extra?.errorCode) err.errorCode = extra.errorCode
  if (extra?.hint) err.hint = extra.hint
  return err
}

/**
 * Decode JWT exp claim and check if it's expired or about to expire.
 */
function isTokenExpiringSoon(token: string, bufferSeconds = 60): boolean {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return true
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`
    const payload = JSON.parse(atob(padded))
    const exp = payload?.exp
    if (typeof exp !== 'number') return true
    return Date.now() / 1000 > exp - bufferSeconds
  } catch {
    return true
  }
}

/**
 * Get a valid (non-expired) access token for edge function calls.
 *
 * Strategy:
 * 1. Check cached session — if token is valid (>60s remaining), use it
 * 2. Otherwise, call getUser() which makes a network request and
 *    triggers the Supabase client's auto-refresh internally
 *    (same mechanism that keeps regular .from() queries working)
 * 3. After getUser(), re-read the session for the fresh token
 * 4. If still invalid, try explicit refreshSession() as last resort
 */
export async function getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const forceRefresh = opts?.forceRefresh === true

  // Step 1: check cached session (skip if forceRefresh)
  if (!forceRefresh) {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token
    if (token && !isTokenExpiringSoon(token)) return token
  }

  // Step 2: call getUser() — this hits /auth/v1/user and the Supabase
  // client will auto-refresh the access token if it's expired.
  // This is the SAME auto-refresh mechanism that makes regular
  // supabase.from(...).select() work even with expired tokens.
  try {
    const { error: userError } = await supabase.auth.getUser()
    if (!userError) {
      // Auto-refresh succeeded — read the updated session
      const { data: freshSession } = await supabase.auth.getSession()
      const freshToken = freshSession?.session?.access_token
      if (freshToken && !isTokenExpiringSoon(freshToken, 5)) return freshToken
    }
  } catch {
    // getUser failed — fall through to refreshSession
  }

  // Step 3: explicit refreshSession as last resort
  try {
    const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
    if (!refreshError) {
      const refreshedToken = refreshed?.session?.access_token
      if (refreshedToken && !isTokenExpiringSoon(refreshedToken, 5)) return refreshedToken
    }
  } catch {
    // refresh failed
  }

  // All strategies exhausted — session is truly dead
  throw createAccessTokenError('Sessione scaduta: effettua nuovamente il login.', {
    status: 401,
    errorCode: 'AUTH_SESSION_EXPIRED',
    hint: 'La sessione è scaduta. Ricarica la pagina o effettua il logout e login.',
  })
}
