// src/components/AdminGuard.tsx
import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { supabase } from '@/integrations/supabase/client'
import { ShieldAlert, ArrowLeft, Loader2 } from 'lucide-react'

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth()
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)

  useEffect(() => {
    if (!user) return
    supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => setIsAdmin(!!data))
  }, [user])

  if (authLoading || isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          <span className="text-slate-500 text-sm">Verifica accesso admin...</span>
        </div>
      </div>
    )
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="text-center space-y-4 max-w-sm">
          <div className="mx-auto h-16 w-16 rounded-full bg-red-100 flex items-center justify-center">
            <ShieldAlert className="h-8 w-8 text-red-500" />
          </div>
          <h1 className="text-xl font-bold text-slate-900">Accesso non autorizzato</h1>
          <p className="text-sm text-slate-500">
            Non hai i permessi per accedere al pannello di amministrazione.
          </p>
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm font-medium text-sky-600 hover:text-sky-800"
          >
            <ArrowLeft className="h-4 w-4" />
            Torna a FinFlow
          </Link>
        </div>
      </div>
    )
  }

  return <>{children}</>
}

// Hook for checking admin status from other components
export function useIsAdmin() {
  const { user } = useAuth()
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!user) { setLoading(false); return }
    supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        setIsAdmin(!!data)
        setLoading(false)
      })
  }, [user])

  return { isAdmin, loading }
}
