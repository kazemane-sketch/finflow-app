import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useCompany } from '@/hooks/useCompany'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  LayoutDashboard,
  FileText,
  Users,
  Landmark,
  Package,
  Link2,
  CalendarClock,
  Receipt,
  Settings,
  LogOut,
  Menu,
  X,
  Sparkles,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { useState, useEffect } from 'react'
import { supabase } from '@/integrations/supabase/client'
import AiChatWidget from '@/components/AiChatWidget'
import AIJobIndicator from '@/components/AIJobIndicator'

const nav = [
  { to: '/ai', icon: Sparkles, label: 'Assistente AI', className: 'text-purple-600' },
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/fatture', icon: FileText, label: 'Fatture' },
  { to: '/scadenzario', icon: CalendarClock, label: 'Scadenzario' },
  { to: '/controparti', icon: Users, label: 'Controparti' },
  { to: '/articoli', icon: Package, label: 'Articoli' },
  { to: '/banca', icon: Landmark, label: 'Banca' },
  { to: '/riconciliazione', icon: Link2, label: 'Riconciliazione' },
  { to: '/iva', icon: Receipt, label: 'IVA' },
  { to: '/impostazioni', icon: Settings, label: 'Impostazioni' },
]

export default function AppLayout() {
  const { user, signOut } = useAuth()
  const { company } = useCompany()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [reconBadge, setReconBadge] = useState(0)

  // Lightweight count of pending reconciliation suggestions for sidebar badge
  useEffect(() => {
    if (!company?.id) return
    supabase
      .from('reconciliation_suggestions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', company.id)
      .eq('status', 'pending')
      .then(({ count }) => setReconBadge(count || 0))
  }, [company?.id])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Mobile overlay */}
      {open && <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Sidebar */}
      <aside className={`
        fixed inset-y-0 left-0 z-50 w-60 flex flex-col bg-card border-r transition-transform lg:static lg:translate-x-0
        ${open ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-extrabold text-sm">F</div>
          <span className="text-lg font-bold tracking-tight">FinFlow</span>
          <button className="ml-auto lg:hidden" onClick={() => setOpen(false)}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <Separator />

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {nav.map(({ to, icon: Icon, label, className: iconClass }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              onClick={() => setOpen(false)}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                }`
              }
            >
              <Icon className={`h-4 w-4 shrink-0 ${iconClass || ''}`} />
              {label}
              {to === '/riconciliazione' && reconBadge > 0 && (
                <span className="ml-auto text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                  {reconBadge > 99 ? '99+' : reconBadge}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        {/* AI Job Indicator */}
        <AIJobIndicator />

        <Separator />

        {/* User */}
        <div className="px-3 py-3">
          <div className="text-xs text-muted-foreground truncate mb-2 px-3">{user?.email}</div>
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground" onClick={signOut}>
            <LogOut className="h-4 w-4" /> Esci
          </Button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b px-4 py-2.5 lg:hidden">
          <button onClick={() => setOpen(true)}>
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-bold">FinFlow</span>
        </header>

        {/* Global navigation arrows — outside scroll container so h-full pages work */}
        <div className="shrink-0 flex items-center gap-1 px-4 py-1.5 bg-white/80 border-b border-gray-100">
          <button
            onClick={() => navigate(-1)}
            className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="Indietro"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            onClick={() => navigate(1)}
            className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="Avanti"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        <main className="flex-1 overflow-y-auto min-h-0">
          <Outlet />
        </main>
      </div>

      {/* AI Chat Widget — floating on all pages except /ai */}
      <AiChatWidget />
    </div>
  )
}
