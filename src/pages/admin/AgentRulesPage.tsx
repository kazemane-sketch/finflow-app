// src/pages/admin/AgentRulesPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Plus, X, Loader2, ScrollText, ChevronUp, ChevronDown, Trash2 } from 'lucide-react'

interface AgentRule {
  id: string; agent_type: string; title: string; rule_text: string;
  trigger_condition: string | null; trigger_keywords: string[];
  priority: number; sort_order: number; active: boolean;
}

const emptyRule = (agentType: string): Omit<AgentRule, 'id'> => ({
  agent_type: agentType, title: '', rule_text: '',
  trigger_condition: null, trigger_keywords: [],
  priority: 50, sort_order: 0, active: true,
})

export default function AgentRulesPage() {
  const [agentType, setAgentType] = useState<'commercialista' | 'consulente'>('commercialista')
  const [rules, setRules] = useState<AgentRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editRule, setEditRule] = useState<Partial<AgentRule> | null>(null)
  const [saving, setSaving] = useState(false)

  const loadRules = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('agent_rules').select('*')
      .eq('agent_type', agentType).order('sort_order').order('priority', { ascending: false })
    setRules((data as any[]) || [])
    setLoading(false)
  }, [agentType])

  useEffect(() => { loadRules() }, [loadRules])

  const handleSave = async () => {
    if (!editRule) return
    if (!editRule.title?.trim() || !editRule.rule_text?.trim()) {
      toast.error('Titolo e testo regola sono obbligatori')
      return
    }
    setSaving(true)
    const payload = {
      agent_type: agentType,
      title: editRule.title!.trim(),
      rule_text: editRule.rule_text!.trim(),
      trigger_condition: editRule.trigger_condition?.trim() || null,
      trigger_keywords: editRule.trigger_keywords || [],
      priority: editRule.priority ?? 50,
      sort_order: editRule.sort_order ?? (rules.length + 1),
      active: editRule.active !== false,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editRule.id) {
        const { error } = await supabase.from('agent_rules').update(payload as any).eq('id', editRule.id)
        if (error) throw error
        toast.success('Regola aggiornata')
      } else {
        const { error } = await supabase.from('agent_rules').insert(payload as any)
        if (error) throw error
        toast.success('Regola creata')
      }
      setEditRule(null)
      loadRules()
    } catch (e: any) {
      toast.error(e.message)
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminare questa regola?')) return
    await supabase.from('agent_rules').delete().eq('id', id)
    toast.success('Regola eliminata')
    loadRules()
  }

  const toggleActive = async (rule: AgentRule) => {
    await supabase.from('agent_rules').update({ active: !rule.active, updated_at: new Date().toISOString() } as any).eq('id', rule.id)
    loadRules()
  }

  const moveSortOrder = async (rule: AgentRule, direction: 'up' | 'down') => {
    const idx = rules.findIndex(r => r.id === rule.id)
    const swapIdx = direction === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= rules.length) return
    const other = rules[swapIdx]
    await Promise.all([
      supabase.from('agent_rules').update({ sort_order: other.sort_order } as any).eq('id', rule.id),
      supabase.from('agent_rules').update({ sort_order: rule.sort_order } as any).eq('id', other.id),
    ])
    loadRules()
  }

  return (
    <div className="p-6 space-y-4 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <ScrollText className="h-6 w-6 text-amber-600" /> Agent Rules
          </h1>
          <p className="text-sm text-slate-500 mt-1">Regole operative per ciascun agent AI</p>
        </div>
        <Button onClick={() => setEditRule(emptyRule(agentType))}>
          <Plus className="h-4 w-4 mr-1.5" /> Nuova regola
        </Button>
      </div>

      {/* Agent type tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {(['commercialista', 'consulente'] as const).map(t => (
          <button key={t} onClick={() => setAgentType(t)}
            className={`px-4 py-2 text-sm font-semibold border-b-2 transition-all ${
              agentType === t
                ? 'text-sky-700 border-sky-500 bg-sky-50/50'
                : 'text-gray-400 border-transparent hover:text-gray-600 hover:bg-gray-50'
            }`}>
            {t === 'commercialista' ? '📊 Commercialista' : '💼 Consulente'}
          </button>
        ))}
      </div>

      {/* Rules list */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : rules.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-12">Nessuna regola per questo agent</p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, idx) => (
            <div key={rule.id} className={`border rounded-lg p-3 bg-white ${!rule.active ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                {/* Sort arrows */}
                <div className="flex flex-col gap-0.5 shrink-0 pt-0.5">
                  <button onClick={() => moveSortOrder(rule, 'up')} disabled={idx === 0}
                    className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ChevronUp className="h-3.5 w-3.5" /></button>
                  <button onClick={() => moveSortOrder(rule, 'down')} disabled={idx === rules.length - 1}
                    className="text-slate-300 hover:text-slate-600 disabled:opacity-30"><ChevronDown className="h-3.5 w-3.5" /></button>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0 cursor-pointer" onClick={() => setEditRule({ ...rule })}>
                  <p className="text-sm font-medium text-slate-800">{rule.title}</p>
                  <p className="text-xs text-slate-500 mt-0.5 line-clamp-2">{rule.rule_text}</p>
                  {rule.trigger_keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {rule.trigger_keywords.map((kw, i) => (
                        <span key={i} className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded">{kw}</span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Priority + controls */}
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[10px] text-slate-400 font-mono">P{rule.priority}</span>
                  <button onClick={() => toggleActive(rule)}
                    className={`w-8 h-4.5 rounded-full relative transition-colors ${rule.active ? 'bg-green-500' : 'bg-gray-300'}`}>
                    <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${rule.active ? 'left-4' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => handleDelete(rule.id)} className="text-slate-300 hover:text-red-500 p-1">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      {editRule && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">{editRule.id ? 'Modifica regola' : 'Nuova regola'}</h2>
              <button onClick={() => setEditRule(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>

            <div>
              <Label className="text-xs">Titolo *</Label>
              <Input value={editRule.title || ''} onChange={e => setEditRule(r => r ? { ...r, title: e.target.value } : r)} className="mt-1" />
            </div>

            <div>
              <Label className="text-xs">Testo regola *</Label>
              <textarea value={editRule.rule_text || ''} onChange={e => setEditRule(r => r ? { ...r, rule_text: e.target.value } : r)}
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y" />
            </div>

            <div>
              <Label className="text-xs">Condizione trigger (testo)</Label>
              <Input value={editRule.trigger_condition || ''} onChange={e => setEditRule(r => r ? { ...r, trigger_condition: e.target.value } : r)}
                className="mt-1" placeholder="es. Quando la riga menziona auto/veicolo" />
            </div>

            <div>
              <Label className="text-xs">Trigger keywords</Label>
              <TagInput value={editRule.trigger_keywords || []} onChange={v => setEditRule(r => r ? { ...r, trigger_keywords: v } : r)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Priorità (0-100)</Label>
                <Input type="number" min={0} max={100} value={editRule.priority ?? 50}
                  onChange={e => setEditRule(r => r ? { ...r, priority: Number(e.target.value) } : r)} className="mt-1" />
              </div>
              <div className="flex items-end pb-1">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={editRule.active !== false}
                    onChange={e => setEditRule(r => r ? { ...r, active: e.target.checked } : r)}
                    className="rounded" />
                  Attiva
                </label>
              </div>
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button variant="outline" onClick={() => setEditRule(null)}>Annulla</Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                {editRule.id ? 'Aggiorna' : 'Crea'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
