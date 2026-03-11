// src/pages/admin/AgentConfigPage.tsx
import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Bot, Loader2, Save } from 'lucide-react'

interface AgentConfig {
  id: string; agent_type: string; display_name: string; description: string | null;
  system_prompt: string; model: string; model_escalation: string | null;
  temperature: number; thinking_level: string; max_output_tokens: number;
  version: number; updated_at: string;
}

const MODELS = ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-3.1-pro-preview']
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']

export default function AgentConfigPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, Partial<AgentConfig>>>({})
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    loadAgents()
  }, [])

  async function loadAgents() {
    setLoading(true)
    const { data } = await supabase.from('agent_config').select('*').eq('active', true).order('agent_type')
    const items = (data as any[]) || []
    setAgents(items)
    const editMap: Record<string, Partial<AgentConfig>> = {}
    items.forEach(a => { editMap[a.id] = { ...a } })
    setEdits(editMap)
    setLoading(false)
  }

  const getEdit = (id: string) => edits[id] || {}

  const updateField = (id: string, field: string, value: any) => {
    setEdits(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
  }

  const handleSave = async (agent: AgentConfig) => {
    const edit = getEdit(agent.id)
    if (!edit.system_prompt?.trim()) { toast.error('System prompt obbligatorio'); return }
    setSaving(agent.id)
    try {
      const { error } = await supabase.from('agent_config').update({
        display_name: edit.display_name || agent.display_name,
        description: edit.description,
        system_prompt: edit.system_prompt!.trim(),
        model: edit.model || agent.model,
        model_escalation: edit.model_escalation || null,
        temperature: Number(edit.temperature ?? agent.temperature),
        thinking_level: edit.thinking_level || agent.thinking_level,
        max_output_tokens: Number(edit.max_output_tokens ?? agent.max_output_tokens),
        version: agent.version + 1,
        updated_at: new Date().toISOString(),
      } as any).eq('id', agent.id)
      if (error) throw error
      toast.success(`${agent.display_name} aggiornato (v${agent.version + 1})`)
      loadAgents()
    } catch (e: any) {
      toast.error(e.message)
    }
    setSaving(null)
  }

  if (loading) {
    return <div className="flex justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <Bot className="h-6 w-6 text-sky-600" /> Agent Config
        </h1>
        <p className="text-sm text-slate-500 mt-1">System prompt e parametri per ciascun agent AI</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {agents.map(agent => {
          const edit = getEdit(agent.id)
          const isSaving = saving === agent.id
          const color = agent.agent_type === 'commercialista' ? 'sky' : 'violet'
          return (
            <Card key={agent.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Bot className={`h-4 w-4 text-${color}-600`} />
                  <span className="flex-1">{agent.display_name}</span>
                  <span className="text-[10px] font-mono bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">v{agent.version}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 flex-1 flex flex-col">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label className="text-xs">Display name</Label>
                    <Input value={edit.display_name || ''} onChange={e => updateField(agent.id, 'display_name', e.target.value)} className="mt-1 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs">Descrizione</Label>
                    <Input value={edit.description || ''} onChange={e => updateField(agent.id, 'description', e.target.value)} className="mt-1 text-sm" />
                  </div>
                </div>

                <div className="flex-1 flex flex-col">
                  <Label className="text-xs flex items-center gap-2">
                    System prompt
                    <span className="text-[10px] text-slate-400">{(edit.system_prompt || '').length} chars</span>
                  </Label>
                  <textarea
                    value={edit.system_prompt || ''}
                    onChange={e => updateField(agent.id, 'system_prompt', e.target.value)}
                    className="mt-1 flex-1 w-full border rounded-md px-3 py-2 text-xs font-mono min-h-[400px] resize-y leading-relaxed"
                  />
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <div>
                    <Label className="text-xs">Modello primario</Label>
                    <select value={edit.model || ''} onChange={e => updateField(agent.id, 'model', e.target.value)}
                      className="mt-1 w-full h-8 border rounded-md px-1.5 text-xs">
                      {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">Modello escalation</Label>
                    <select value={edit.model_escalation || ''} onChange={e => updateField(agent.id, 'model_escalation', e.target.value || null)}
                      className="mt-1 w-full h-8 border rounded-md px-1.5 text-xs">
                      <option value="">Nessuno</option>
                      {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label className="text-xs">Temperature</Label>
                    <div className="flex items-center gap-2 mt-1">
                      <input type="range" min="0" max="1" step="0.05"
                        value={edit.temperature ?? 0.1}
                        onChange={e => updateField(agent.id, 'temperature', Number(e.target.value))}
                        className="flex-1 h-1.5 accent-sky-500" />
                      <span className="text-xs font-mono w-8 text-right">{(edit.temperature ?? 0.1).toFixed(2)}</span>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">Thinking level</Label>
                    <select value={edit.thinking_level || 'medium'} onChange={e => updateField(agent.id, 'thinking_level', e.target.value)}
                      className="mt-1 w-full h-8 border rounded-md px-1.5 text-xs">
                      {THINKING_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <Label className="text-xs">Max output tokens</Label>
                  <Input type="number" value={edit.max_output_tokens ?? 65536}
                    onChange={e => updateField(agent.id, 'max_output_tokens', Number(e.target.value))}
                    className="mt-1 w-32 text-sm" />
                </div>

                <div className="flex items-center justify-between pt-2 border-t">
                  <span className="text-[10px] text-slate-400">
                    Ultimo aggiornamento: {new Date(agent.updated_at).toLocaleString('it-IT')}
                  </span>
                  <Button onClick={() => handleSave(agent)} disabled={isSaving} size="sm">
                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                    Salva
                  </Button>
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
