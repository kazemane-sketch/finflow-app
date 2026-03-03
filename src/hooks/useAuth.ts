import { useEffect, useState } from 'react'
import { supabase } from '@/integrations/supabase/client'
import type { User, Session } from '@supabase/supabase-js'

function isAuthFailure(error: any): boolean {
  const status = Number(error?.status || error?.statusCode || 0)
  if (status === 401 || status === 403) return true

  const code = String(error?.code || error?.name || '').toLowerCase()
  if (/auth|jwt|token|session|expired|invalid/.test(code)) return true

  const message = String(error?.message || '').toLowerCase()
  return /auth|jwt|token|session|expired|invalid/.test(message)
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    const applySession = (nextSession: Session | null) => {
      if (!mounted) return
      setSession(nextSession)
      setUser(nextSession?.user ?? null)
      setLoading(false)
    }

    const bootstrapSession = async () => {
      const { data: { session: rawSession } } = await supabase.auth.getSession()
      if (!rawSession) {
        applySession(null)
        return
      }

      const { data: userData, error: userError } = await supabase.auth.getUser()
      if (!userError && userData?.user) {
        applySession(rawSession)
        return
      }
      if (userError && !isAuthFailure(userError)) {
        applySession(rawSession)
        return
      }

      const { data: refreshed, error: refreshError } = await supabase.auth.refreshSession()
      const refreshedSession = refreshed?.session ?? null
      if (refreshError || !refreshedSession?.access_token) {
        applySession(null)
        return
      }

      applySession(refreshedSession)
    }

    void bootstrapSession()

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      applySession(session)
    })

    return () => {
      mounted = false
      subscription.unsubscribe()
    }
  }, [])

  const signInWithEmail = async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }

  const signUp = async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password })
    return { error }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return { user, session, loading, signInWithEmail, signUp, signOut }
}
