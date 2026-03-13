// src/pages/admin/AgentConfigPage.tsx
import { useState, useEffect } from 'react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Bot, Loader2, Save, Brain, Cpu, Zap } from 'lucide-react'

interface AgentConfig {
  id: string; agent_type: string; display_name: string; description: string | null;
  system_prompt: string; model: string; model_escalation: string | null;
  temperature: number; thinking_level: string; thinking_budget: number | null; thinking_budget_escalation: number | null;
  max_output_tokens: number; version: number; updated_at: string;
}

const MODEL_OPTIONS = [
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', desc: 'Stabile, thinking controllabile, 1000 RPD' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', desc: 'Economico, veloce' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', desc: 'Top qualita, RPD basso (250)' },
  { value: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', desc: 'Veloce, economico' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', desc: 'Molto forte su ragionamento e consulenza' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', desc: 'Rapido per chat leggere' },
]

const THINKING_BUDGET_OPTIONS = [
  { value: 0, label: 'Disattivato', desc: 'Nessun ragionamento interno' },
  { value: 1024, label: '1K', desc: 'Minimo (task semplici)' },
  { value: 4096, label: '4K', desc: 'Moderato (classificazione fatture)' },
  { value: 8192, label: '8K', desc: 'Buono (analisi documenti)' },
  { value: 16384, label: '16K', desc: 'Profondo (revisione fiscale)' },
  { value: 32768, label: '32K', desc: 'Massimo (interpretazione norme complesse)' },
]

// Models that DON'T support explicit thinkingConfig
const NO_THINKING_CONFIG_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview-customtools']

const AGENT_COLORS: Record<string, string> = {
  commercialista: 'sky',
  revisore: 'violet',
  consulente: 'amber',
  kb_classifier: 'emerald',
}

const AGENT_ICONS: Record<string, typeof Bot> = {
  commercialista: Cpu,
  revisore: Brain,
  consulente: Bot,
  kb_classifier: Zap,
}

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
        thinking_budget: edit.thinking_budget != null ? Number(edit.thinking_budget) : null,
        thinking_budget_escalation: edit.thinking_budget_escalation != null ? Number(edit.thinking_budget_escalation) : null,
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
        <p className="text-sm text-slate-500 mt-1">System prompt, modello AI e parametri di ragionamento per ciascun agent</p>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {agents.map(agent => {
          const edit = getEdit(agent.id)
          const isSaving = saving === agent.id
          const color = AGENT_COLORS[agent.agent_type] || 'slate'
          const IconComponent = AGENT_ICONS[agent.agent_type] || Bot
          const thinkingBudget = edit.thinking_budget ?? 0
          const escalationThinkingBudget = edit.thinking_budget_escalation ?? 0
          const modelSupportsThinking = !NO_THINKING_CONFIG_MODELS.includes(edit.model || agent.model)
          const escalationModelSupportsThinking = !NO_THINKING_CONFIG_MODELS.includes(edit.model_escalation || agent.model_escalation || '')
          const costPerCall = thinkingBudget > 0 && modelSupportsThinking
            ? (thinkingBudget / 1_000_000 * 10).toFixed(3)
            : '0.000'

          return (
            <Card key={agent.id} className="flex flex-col">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <IconComponent className={`h-4 w-4 text-${color}-600`} />
                  <span className="flex-1">{agent.display_name}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded bg-${color}-50 text-${color}-700`}>
                    {agent.agent_type}
                  </span>
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

                {/* ── Model + Thinking Section ── */}
                <div className="border rounded-lg p-3 space-y-3 bg-slate-50/50">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Modello e Ragionamento</p>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Modello primario</Label>
                      <select value={edit.model || ''} onChange={e => updateField(agent.id, 'model', e.target.value)}
                        className="mt-1 w-full h-9 border rounded-md px-2 text-xs bg-white">
                        {MODEL_OPTIONS.map(m => (
                          <option key={m.value} value={m.value}>{m.label} — {m.desc}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <Label className="text-xs">Modello escalation</Label>
                      <select value={edit.model_escalation || ''} onChange={e => updateField(agent.id, 'model_escalation', e.target.value || null)}
                        className="mt-1 w-full h-9 border rounded-md px-2 text-xs bg-white">
                        <option value="">Nessuno</option>
                        {MODEL_OPTIONS.map(m => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs">Thinking Budget</Label>
                      <select
                        value={thinkingBudget}
                        onChange={e => updateField(agent.id, 'thinking_budget', Number(e.target.value))}
                        className="mt-1 w-full h-9 border rounded-md px-2 text-xs bg-white"
                        disabled={!modelSupportsThinking}
                      >
                        {THINKING_BUDGET_OPTIONS.map(o => (
                          <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                        ))}
                      </select>
                      {!modelSupportsThinking && (
                        <p className="text-[10px] text-amber-600 mt-1">
                          {edit.model || agent.model} non supporta thinkingConfig esplicito
                        </p>
                      )}
                      {modelSupportsThinking && thinkingBudget > 0 && (
                        <p className="text-[10px] text-slate-500 mt-1">
                          Costo thinking max/chiamata: ~&euro;{costPerCall}
                        </p>
                      )}
                    </div>
                    <div className="space-y-2">
                      {agent.agent_type === 'consulente' && (
                        <div>
                          <Label className="text-xs">Thinking Deep Mode</Label>
                          <select
                            value={escalationThinkingBudget}
                            onChange={e => updateField(agent.id, 'thinking_budget_escalation', Number(e.target.value))}
                            className="mt-1 w-full h-9 border rounded-md px-2 text-xs bg-white"
                            disabled={!escalationModelSupportsThinking}
                          >
                            {THINKING_BUDGET_OPTIONS.map(o => (
                              <option key={o.value} value={o.value}>{o.label} — {o.desc}</option>
                            ))}
                          </select>
                          {!escalationModelSupportsThinking && (
                            <p className="text-[10px] text-amber-600 mt-1">
                              {(edit.model_escalation || agent.model_escalation || 'Nessuno')} non supporta thinkingConfig esplicito
                            </p>
                          )}
                        </div>
                      )}
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
                        <Label className="text-xs">Max output tokens</Label>
                        <Input type="number" value={edit.max_output_tokens ?? 65536}
                          onChange={e => updateField(agent.id, 'max_output_tokens', Number(e.target.value))}
                          className="mt-1 w-full text-xs h-8" />
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── System Prompt ── */}
                <div className="flex-1 flex flex-col">
                  <Label className="text-xs flex items-center gap-2">
                    System prompt
                    <span className="text-[10px] text-slate-400">{(edit.system_prompt || '').length} chars</span>
                  </Label>
                  <textarea
                    value={edit.system_prompt || ''}
                    onChange={e => updateField(agent.id, 'system_prompt', e.target.value)}
                    className="mt-1 flex-1 w-full border rounded-md px-3 py-2 text-xs font-mono min-h-[350px] resize-y leading-relaxed"
                  />
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
