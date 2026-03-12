// src/pages/admin/AdminLayout.tsx
import { NavLink, Outlet } from 'react-router-dom'
import {
  LayoutDashboard,
  BookOpen,
  FileText,
  Bot,
  ScrollText,
  FlaskConical,
  Tags,
  ArrowLeft,
  Library,
} from 'lucide-react'
import AIJobIndicator from '@/components/AIJobIndicator'

const adminNav = [
  { to: '/admin', icon: LayoutDashboard, label: 'Dashboard', end: true },
  { to: '/admin/knowledge', icon: BookOpen, label: 'Knowledge Base' },
  { to: '/admin/documents', icon: FileText, label: 'Documenti' },
  { to: '/admin/kb-documents', icon: Library, label: 'Documenti KB' },
  { to: '/admin/agents', icon: Bot, label: 'Agent Config' },
  { to: '/admin/rules', icon: ScrollText, label: 'Agent Rules' },
  { to: '/admin/keywords', icon: Tags, label: 'Dizionario Sinonimi' },
  { to: '/admin/test-lab', icon: FlaskConical, label: 'Test Lab' },
]

export default function AdminLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Dark admin sidebar */}
      <aside className="w-60 flex flex-col bg-slate-900 text-slate-300 shrink-0">
        {/* Header */}
        <div className="px-5 py-4 flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-red-600 text-white flex items-center justify-center font-extrabold text-xs">A</div>
          <div>
            <span className="text-sm font-bold text-white tracking-tight">FinFlow</span>
            <span className="ml-1.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-600 text-white uppercase tracking-wider">Admin</span>
          </div>
        </div>

        <div className="h-px bg-slate-700 mx-3" />

        {/* Nav links */}
        <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
          {adminNav.map(({ to, icon: Icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-slate-700/80 text-white'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* AI Job progress (admin operations) */}
        <AIJobIndicator />

        <div className="h-px bg-slate-700 mx-3" />

        {/* Back to app */}
        <div className="px-3 py-3">
          <NavLink
            to="/"
            className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft className="h-4 w-4 shrink-0" />
            Torna a FinFlow
          </NavLink>
        </div>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-y-auto min-h-0">
        <Outlet />
      </main>
    </div>
  )
}
