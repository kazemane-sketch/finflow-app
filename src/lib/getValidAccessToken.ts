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
 * Check if a JWT is expired or about to expire (within bufferSeconds).
 * Returns true if the token should be refreshed proactively.
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
    return true // if we can't decode, assume expired
  }
}

export async function getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const forceRefresh = opts?.forceRefresh === true

  if (!forceRefresh) {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token
    // Only use cached token if it's still valid for at least 60 more seconds
    if (token && !isTokenExpiringSoon(token)) return token
  }

  // Token is expired/expiring/missing — force refresh
  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
    .catch(() => ({ data: null as any, error: new Error('refresh_failed') as Error }))

  const refreshedToken = refreshed?.session?.access_token
  if (refreshedToken && !isTokenExpiringSoon(refreshedToken, 5)) return refreshedToken

  if (refreshError) {
    throw createAccessTokenError('Sessione non valida o scaduta.', {
      status: 401,
      errorCode: 'AUTH_REFRESH_FAILED',
      hint: 'Effettua nuovamente il login e riprova.',
    })
  }

  throw createAccessTokenError('Sessione assente: effettua nuovamente il login.', {
    status: 401,
    errorCode: 'AUTH_SESSION_MISSING',
    hint: 'Rifai login e riprova.',
  })
}
