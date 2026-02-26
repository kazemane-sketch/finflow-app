import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Toaster } from '@/components/ui/toaster'
import AppLayout from '@/components/layout/AppLayout'
import AuthPage from '@/pages/AuthPage'
import DashboardPage from '@/pages/DashboardPage'
import FatturePage from '@/pages/FatturePage'
import BancaPage from '@/pages/BancaPage'
import RiconciliazionePage from '@/pages/RiconciliazionePage'
import ScadenzarioPage from '@/pages/ScadenzarioPage'
import ImpostazioniPage from '@/pages/ImpostazioniPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-extrabold text-sm animate-pulse">F</div>
          <span className="text-muted-foreground">Caricamento...</span>
        </div>
      </div>
    )
  }

  if (!user) return <Navigate to="/auth" replace />
  return <>{children}</>
}

export default function App() {
  const { user, loading } = useAuth()

  return (
    <>
      <Routes>
        <Route path="/auth" element={
          loading ? null : user ? <Navigate to="/" replace /> : <AuthPage />
        } />
        <Route element={
          <ProtectedRoute>
            <AppLayout />
          </ProtectedRoute>
        }>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/fatture" element={<FatturePage />} />
          <Route path="/banca" element={<BancaPage />} />
          <Route path="/riconciliazione" element={<RiconciliazionePage />} />
          <Route path="/scadenzario" element={<ScadenzarioPage />} />
          <Route path="/impostazioni" element={<ImpostazioniPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
