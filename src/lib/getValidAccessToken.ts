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

export async function getValidAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  const forceRefresh = opts?.forceRefresh === true

  if (!forceRefresh) {
    const { data: sessionData } = await supabase.auth.getSession()
    const token = sessionData?.session?.access_token
    if (token) return token
  }

  const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
    .catch(() => ({ data: null as any, error: new Error('refresh_failed') as Error }))

  const refreshedToken = refreshed?.session?.access_token
  if (refreshedToken) return refreshedToken

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
