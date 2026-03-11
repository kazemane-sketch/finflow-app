import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { Toaster } from '@/components/ui/toaster'
import { AiChatProvider } from '@/contexts/AiChatContext'
import { PageEntityProvider } from '@/contexts/PageEntityContext'
import AppLayout from '@/components/layout/AppLayout'
import AuthPage from '@/pages/AuthPage'
import DashboardPage from '@/pages/DashboardPage'
import FatturePage from '@/pages/FatturePage'
import BancaPage from '@/pages/BancaPage'
import ContropartiPage from '@/pages/ContropartiPage'
import RiconciliazionePage from '@/pages/RiconciliazionePage'
import ScadenzarioPage from '@/pages/ScadenzarioPage'
import ImpostazioniPage from '@/pages/ImpostazioniPage'
import IvaPage from '@/pages/IvaPage'
import AiChatPage from '@/pages/AiChatPage'
import ArticoliPage from '@/pages/ArticoliPage'
import AdminGuard from '@/components/AdminGuard'
import AdminLayout from '@/pages/admin/AdminLayout'
import AdminDashboardPage from '@/pages/admin/AdminDashboardPage'
import KnowledgeBasePage from '@/pages/admin/KnowledgeBasePage'
import DocumentsPage from '@/pages/admin/DocumentsPage'
import AgentConfigPage from '@/pages/admin/AgentConfigPage'
import AgentRulesPage from '@/pages/admin/AgentRulesPage'
import TestLabPage from '@/pages/admin/TestLabPage'
import KeywordGroupsPage from '@/pages/admin/KeywordGroupsPage'

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
            <AiChatProvider>
              <PageEntityProvider>
                <AppLayout />
              </PageEntityProvider>
            </AiChatProvider>
          </ProtectedRoute>
        }>
          <Route path="/ai" element={<AiChatPage />} />
          <Route path="/" element={<DashboardPage />} />
          <Route path="/fatture" element={<FatturePage />} />
          <Route path="/controparti" element={<ContropartiPage />} />
          <Route path="/articoli" element={<ArticoliPage />} />
          <Route path="/banca" element={<BancaPage />} />
          <Route path="/riconciliazione" element={<RiconciliazionePage />} />
          <Route path="/scadenzario" element={<ScadenzarioPage />} />
          <Route path="/iva" element={<IvaPage />} />
          <Route path="/impostazioni" element={<ImpostazioniPage />} />
        </Route>
        <Route path="/admin" element={
          <ProtectedRoute>
            <AdminGuard><AdminLayout /></AdminGuard>
          </ProtectedRoute>
        }>
          <Route index element={<AdminDashboardPage />} />
          <Route path="knowledge" element={<KnowledgeBasePage />} />
          <Route path="documents" element={<DocumentsPage />} />
          <Route path="agents" element={<AgentConfigPage />} />
          <Route path="rules" element={<AgentRulesPage />} />
          <Route path="test-lab" element={<TestLabPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}
