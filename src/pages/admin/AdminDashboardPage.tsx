// src/pages/admin/AdminDashboardPage.tsx
import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { BookOpen, FileText, Bot, ScrollText, Loader2 } from 'lucide-react'
import { supabase } from '@/integrations/supabase/client'

interface DashboardStats {
  kb: { total: number; approved: number; draft: number; byDomain: Record<string, number> }
  docs: { total: number; ready: number; processing: number; pending: number }
  agents: Array<{ agent_type: string; display_name: string; version: number; rulesCount: number }>
}

export default function AdminDashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadStats()
  }, [])

  async function loadStats() {
    setLoading(true)
    try {
      // KB stats
      const { data: kbData } = await supabase.from('knowledge_base').select('id, domain, status, active')
      const kbItems = kbData || []
      const approved = kbItems.filter(k => k.status === 'approved' && k.active).length
      const draft = kbItems.filter(k => k.status === 'draft').length
      const byDomain: Record<string, number> = {}
      kbItems.filter(k => k.active).forEach(k => { byDomain[k.domain] = (byDomain[k.domain] || 0) + 1 })

      // Docs stats
      const { data: docsData } = await supabase.from('kb_documents').select('id, status, active').eq('active', true)
      const docs = docsData || []
      const ready = docs.filter(d => d.status === 'ready').length
      const processing = docs.filter(d => d.status === 'processing').length
      const pending = docs.filter(d => d.status === 'pending').length

      // Agent configs
      const { data: agentsData } = await supabase.from('agent_config').select('agent_type, display_name, version').eq('active', true)
      const agents = agentsData || []

      // Agent rules counts
      const { data: rulesData } = await supabase.from('agent_rules').select('agent_type').eq('active', true)
      const rulesCounts: Record<string, number> = {}
      ;(rulesData || []).forEach(r => { rulesCounts[r.agent_type] = (rulesCounts[r.agent_type] || 0) + 1 })

      setStats({
        kb: { total: kbItems.length, approved, draft, byDomain },
        docs: { total: docs.length, ready, processing, pending },
        agents: agents.map(a => ({
          ...a,
          rulesCount: rulesCounts[a.agent_type] || 0,
        })),
      })
    } catch (e) {
      console.error('Dashboard stats error:', e)
    }
    setLoading(false)
  }

  const domainLabels: Record<string, string> = {
    iva: 'IVA', ires_irap: 'IRES/IRAP', ritenute: 'Ritenute',
    classificazione: 'Classificazione', settoriale: 'Settoriale',
    operativo: 'Operativo', aggiornamenti: 'Aggiornamenti',
  }
  const domainColors: Record<string, string> = {
    iva: 'bg-blue-100 text-blue-700', ires_irap: 'bg-purple-100 text-purple-700',
    ritenute: 'bg-red-100 text-red-700', classificazione: 'bg-green-100 text-green-700',
    settoriale: 'bg-amber-100 text-amber-700', operativo: 'bg-slate-100 text-slate-700',
    aggiornamenti: 'bg-cyan-100 text-cyan-700',
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Admin Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">Panoramica Knowledge Base, Documenti e Agent AI</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Knowledge Base */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-blue-600" />
              Knowledge Base
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold text-slate-900">{stats?.kb.total || 0}</span>
              <span className="text-sm text-slate-500">regole totali</span>
            </div>
            <div className="flex gap-3 text-xs">
              <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                {stats?.kb.approved || 0} approved
              </span>
              <span className="px-2 py-0.5 rounded bg-yellow-100 text-yellow-700 font-medium">
                {stats?.kb.draft || 0} draft
              </span>
            </div>
            {stats?.kb.byDomain && Object.keys(stats.kb.byDomain).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {Object.entries(stats.kb.byDomain).sort((a, b) => b[1] - a[1]).map(([domain, count]) => (
                  <span key={domain} className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${domainColors[domain] || 'bg-gray-100 text-gray-600'}`}>
                    {domainLabels[domain] || domain}: {count}
                  </span>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Documents */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-600" />
              Documenti Sorgente
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-bold text-slate-900">{stats?.docs.total || 0}</span>
              <span className="text-sm text-slate-500">documenti</span>
            </div>
            <div className="flex gap-3 text-xs">
              <span className="px-2 py-0.5 rounded bg-green-100 text-green-700 font-medium">
                {stats?.docs.ready || 0} ready
              </span>
              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                {stats?.docs.processing || 0} processing
              </span>
              <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-600 font-medium">
                {stats?.docs.pending || 0} pending
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Agent cards */}
        {(stats?.agents || []).map(agent => (
          <Card key={agent.agent_type}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Bot className={`h-4 w-4 ${agent.agent_type === 'commercialista' ? 'text-sky-600' : 'text-violet-600'}`} />
                {agent.display_name}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center gap-3 text-sm">
                <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-700 font-mono text-xs">
                  v{agent.version}
                </span>
                <span className="text-slate-500">Versione prompt</span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <ScrollText className="h-3.5 w-3.5 text-slate-400" />
                <span className="text-slate-600 font-medium">{agent.rulesCount}</span>
                <span className="text-slate-500">regole attive</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
