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

async function isTokenAcceptedByAuth(token: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.getUser(token)
    return !error && !!data?.user
  } catch {
    return false
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
  const { data: sessionData } = await supabase.auth.getSession()
  const currentSession = sessionData?.session ?? null
  const currentToken = currentSession?.access_token ?? null

  // Step 1: check cached session (skip if forceRefresh)
  if (!forceRefresh && currentToken && !isTokenExpiringSoon(currentToken)) {
    return currentToken
  }

  // Step 2: explicit refresh using the stored refresh token.
  // This is more reliable than relying on getUser() side effects when the
  // access token is still unexpired but has become invalid server-side.
  try {
    if (currentSession?.refresh_token) {
      const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession({
        refresh_token: currentSession.refresh_token,
      })
      const refreshedToken = refreshed?.session?.access_token
      if (!refreshError && refreshedToken && !isTokenExpiringSoon(refreshedToken, 5)) {
        const verified = await isTokenAcceptedByAuth(refreshedToken)
        if (verified) return refreshedToken
      }
    }
  } catch {
    // fall through to getUser() verification
  }

  // Step 3: verify current session via Auth API, which may also auto-refresh
  // sessions managed internally by the Supabase client.
  try {
    const { error: userError } = currentToken
      ? await supabase.auth.getUser(currentToken)
      : await supabase.auth.getUser()
    if (!userError) {
      const { data: freshSession } = await supabase.auth.getSession()
      const freshToken = freshSession?.session?.access_token
      if (freshToken && !isTokenExpiringSoon(freshToken, 5)) {
        const verified = await isTokenAcceptedByAuth(freshToken)
        if (verified) return freshToken
      }
    }
  } catch {
    // getUser verification failed
  }

  // Step 4: clear the local stale session to avoid repeating the same invalid
  // JWT forever after project/key rotation.
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch {
    // sign-out cleanup is best-effort
  }

  // All strategies exhausted — session is truly dead
  throw createAccessTokenError('Sessione scaduta: effettua nuovamente il login.', {
    status: 401,
    errorCode: 'AUTH_SESSION_EXPIRED',
    hint: 'La sessione è scaduta. Ricarica la pagina o effettua il logout e login.',
  })
}
