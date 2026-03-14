// src/pages/admin/KnowledgeBasePage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import { supabase, SUPABASE_URL } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Plus, X, Search, Loader2, Pencil, Trash2, BookOpen } from 'lucide-react'

const DOMAINS = ['iva', 'ires_irap', 'ritenute', 'classificazione', 'settoriale', 'operativo', 'aggiornamenti'] as const
const AUDIENCES = ['commercialista', 'consulente', 'both'] as const
const STATUSES = ['draft', 'approved', 'rejected', 'superseded'] as const

const DOMAIN_LABELS: Record<string, string> = {
  iva: 'IVA', ires_irap: 'IRES/IRAP', ritenute: 'Ritenute',
  classificazione: 'Classificazione', settoriale: 'Settoriale',
  operativo: 'Operativo', aggiornamenti: 'Aggiornamenti',
}
const DOMAIN_COLORS: Record<string, string> = {
  iva: 'bg-blue-100 text-blue-700', ires_irap: 'bg-purple-100 text-purple-700',
  ritenute: 'bg-red-100 text-red-700', classificazione: 'bg-green-100 text-green-700',
  settoriale: 'bg-amber-100 text-amber-700', operativo: 'bg-slate-100 text-slate-700',
  aggiornamenti: 'bg-cyan-100 text-cyan-700',
}
const AUDIENCE_LABELS: Record<string, string> = { commercialista: 'Commercialista', consulente: 'Consulente', both: 'Entrambi' }
const STATUS_COLORS: Record<string, string> = {
  approved: 'bg-green-100 text-green-700', draft: 'bg-yellow-100 text-yellow-700',
  rejected: 'bg-red-100 text-red-700', superseded: 'bg-gray-100 text-gray-500',
}

interface KBRule {
  knowledge_kind?: 'advisory_note' | 'numeric_fact'
  id: string; domain: string; audience: string; title: string; content: string;
  summary_structured?: Record<string, any>;
  applicability?: Record<string, any>;
  source_chunk_ids?: string[];
  normativa_ref: string[]; fiscal_values: Record<string, any>;
  trigger_keywords: string[]; trigger_ateco_prefixes: string[];
  trigger_counterparty_types: string[]; trigger_vat_natures: string[];
  trigger_doc_types: string[]; ateco_scope: string[] | null;
  effective_from: string; effective_to: string;
  priority: number; status: string; active: boolean; updated_at: string;
}

const emptyRule: Omit<KBRule, 'id' | 'updated_at'> = {
  knowledge_kind: 'advisory_note',
  domain: 'classificazione', audience: 'both', title: '', content: '',
  summary_structured: {}, applicability: {}, source_chunk_ids: [],
  normativa_ref: [], fiscal_values: {}, trigger_keywords: [],
  trigger_ateco_prefixes: [], trigger_counterparty_types: [],
  trigger_vat_natures: [], trigger_doc_types: [],
  ateco_scope: null, effective_from: '2000-01-01', effective_to: '2099-12-31',
  priority: 50, status: 'approved', active: true,
}

// Fiscal values editor
function FiscalValuesEditor({ value, onChange }: { value: Record<string, any>; onChange: (v: Record<string, any>) => void }) {
  const entries = Object.entries(value)
  const addEntry = () => onChange({ ...value, '': '' })
  const updateKey = (oldKey: string, newKey: string) => {
    const newObj: Record<string, any> = {}
    for (const [k, v] of Object.entries(value)) {
      newObj[k === oldKey ? newKey : k] = v
    }
    onChange(newObj)
  }
  const updateVal = (key: string, newVal: string) => {
    const parsed = newVal === 'true' ? true : newVal === 'false' ? false : isNaN(Number(newVal)) ? newVal : Number(newVal)
    onChange({ ...value, [key]: parsed })
  }
  const removeEntry = (key: string) => {
    const copy = { ...value }
    delete copy[key]
    onChange(copy)
  }
  return (
    <div className="space-y-1.5">
      {entries.map(([k, v], i) => (
        <div key={i} className="flex gap-1.5 items-center">
          <input className="flex-1 border rounded px-2 py-1 text-xs" placeholder="chiave" value={k} onChange={e => updateKey(k, e.target.value)} />
          <input className="flex-1 border rounded px-2 py-1 text-xs" placeholder="valore" value={String(v)} onChange={e => updateVal(k, e.target.value)} />
          <button type="button" onClick={() => removeEntry(k)} className="text-gray-400 hover:text-red-500"><X className="h-3.5 w-3.5" /></button>
        </div>
      ))}
      <button type="button" onClick={addEntry} className="text-xs text-sky-600 hover:text-sky-800 font-medium">+ Aggiungi campo</button>
    </div>
  )
}

export default function KnowledgeBasePage() {
  const [rules, setRules] = useState<KBRule[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterDomain, setFilterDomain] = useState<string>('')
  const [filterAudience, setFilterAudience] = useState<string>('')
  const [filterStatus, setFilterStatus] = useState<string>('')
  const [editRule, setEditRule] = useState<Partial<KBRule> | null>(null)
  const [saving, setSaving] = useState(false)

  const loadRules = useCallback(async () => {
    setLoading(true)
    let q = supabase
      .from('knowledge_base')
      .select('*')
      .neq('knowledge_kind', 'legacy_rule')
      .order('priority', { ascending: false })
      .order('updated_at', { ascending: false })
    if (filterDomain) q = q.eq('domain', filterDomain)
    if (filterAudience) q = q.eq('audience', filterAudience)
    if (filterStatus) q = q.eq('status', filterStatus)
    const { data } = await q
    setRules((data as any[]) || [])
    setLoading(false)
  }, [filterDomain, filterAudience, filterStatus])

  useEffect(() => { loadRules() }, [loadRules])

  const filtered = rules.filter(r => {
    if (!search) return true
    const s = search.toLowerCase()
    return r.title.toLowerCase().includes(s) || r.content.toLowerCase().includes(s)
  })

  // Trigger embedding generation for a KB rule (fire-and-forget)
  const triggerEmbedding = async (ruleId: string) => {
    try {
      const { data: { session } } = await supabase.auth.getSession()
      await fetch(`${SUPABASE_URL}/functions/v1/admin-embed-kb-rule`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ rule_id: ruleId }),
      })
    } catch (e) {
      console.warn('Embedding generation failed:', e)
      // Non-blocking: embedding is nice-to-have
    }
  }

  const handleSave = async () => {
    if (!editRule) return
    if (!editRule.title?.trim() || !editRule.content?.trim()) {
      toast.error('Titolo e contenuto sono obbligatori')
      return
    }
    setSaving(true)
    const payload = {
      domain: editRule.domain, audience: editRule.audience,
      knowledge_kind: editRule.knowledge_kind || 'advisory_note',
      title: editRule.title!.trim(), content: editRule.content!.trim(),
      summary_structured: editRule.summary_structured || {},
      applicability: editRule.applicability || {},
      source_chunk_ids: editRule.source_chunk_ids || [],
      normativa_ref: editRule.normativa_ref || [],
      fiscal_values: editRule.fiscal_values || {},
      trigger_keywords: editRule.trigger_keywords || [],
      trigger_ateco_prefixes: editRule.trigger_ateco_prefixes || [],
      trigger_counterparty_types: editRule.trigger_counterparty_types || [],
      trigger_vat_natures: editRule.trigger_vat_natures || [],
      trigger_doc_types: editRule.trigger_doc_types || [],
      ateco_scope: editRule.ateco_scope && editRule.ateco_scope.length > 0 ? editRule.ateco_scope : null,
      effective_from: editRule.effective_from || '2000-01-01',
      effective_to: editRule.effective_to || '2099-12-31',
      priority: editRule.priority ?? 50,
      status: editRule.status || 'approved',
      active: editRule.active !== false,
      updated_at: new Date().toISOString(),
    }
    try {
      let savedId: string | null = null
      if (editRule.id) {
        const { error } = await supabase.from('knowledge_base').update(payload as any).eq('id', editRule.id)
        if (error) throw error
        savedId = editRule.id
        toast.success('Nota KB aggiornata')
      } else {
        const { data, error } = await supabase.from('knowledge_base').insert(payload as any).select('id').single()
        if (error) throw error
        savedId = (data as any)?.id
        toast.success('Nota KB creata')
      }
      // Trigger embedding generation (fire-and-forget)
      if (savedId) triggerEmbedding(savedId)
      setEditRule(null)
      loadRules()
    } catch (e: any) {
      toast.error(e.message)
    }
    setSaving(false)
  }

  const toggleActive = async (rule: KBRule) => {
    await supabase.from('knowledge_base').update({ active: !rule.active, updated_at: new Date().toISOString() } as any).eq('id', rule.id)
    loadRules()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminare questa nota KB?')) return
    await supabase.from('knowledge_base').delete().eq('id', id)
    toast.success('Nota KB eliminata')
    loadRules()
  }

  return (
    <div className="p-6 space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-blue-600" /> Knowledge Base
          </h1>
          <p className="text-sm text-slate-500 mt-1">Note consultive strutturate per gli agenti AI</p>
        </div>
        <Button onClick={() => setEditRule({ ...emptyRule })}>
          <Plus className="h-4 w-4 mr-1.5" /> Nuova nota
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca..." className="pl-8 h-9 text-sm" />
        </div>
        <select value={filterDomain} onChange={e => setFilterDomain(e.target.value)} className="h-9 border rounded-md px-2 text-xs">
          <option value="">Tutti i domini</option>
          {DOMAINS.map(d => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
        </select>
        <select value={filterAudience} onChange={e => setFilterAudience(e.target.value)} className="h-9 border rounded-md px-2 text-xs">
          <option value="">Tutti gli audience</option>
          {AUDIENCES.map(a => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="h-9 border rounded-md px-2 text-xs">
          <option value="">Tutti gli stati</option>
          {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-12">Nessuna nota trovata</p>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2">Titolo</th>
                <th className="px-3 py-2 w-28">Dominio</th>
                <th className="px-3 py-2 w-28">Audience</th>
                <th className="px-3 py-2 w-24">Stato</th>
                <th className="px-3 py-2 w-16 text-center">Prior.</th>
                <th className="px-3 py-2 w-16 text-center">Attiva</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.map(r => (
                <tr key={r.id} className="hover:bg-slate-50/50 cursor-pointer" onClick={() => setEditRule({ ...r })}>
                  <td className="px-3 py-2 font-medium text-slate-800">{r.title}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${DOMAIN_COLORS[r.domain] || 'bg-gray-100'}`}>
                      {DOMAIN_LABELS[r.domain] || r.domain}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">{AUDIENCE_LABELS[r.audience] || r.audience}</td>
                  <td className="px-3 py-2">
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[r.status] || 'bg-gray-100'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-center text-xs text-slate-500">{r.priority}</td>
                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                    <button
                      onClick={() => toggleActive(r)}
                      className={`w-8 h-4.5 rounded-full relative transition-colors ${r.active ? 'bg-green-500' : 'bg-gray-300'}`}
                    >
                      <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${r.active ? 'left-4' : 'left-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    <button onClick={() => handleDelete(r.id)} className="text-slate-400 hover:text-red-500 p-1">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit Dialog */}
      {editRule && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">{editRule.id ? 'Modifica nota KB' : 'Nuova nota KB'}</h2>
              <button onClick={() => setEditRule(null)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Dominio *</Label>
                <select value={editRule.domain} onChange={e => setEditRule(r => r ? { ...r, domain: e.target.value } : r)}
                  className="mt-1 w-full h-9 border rounded-md px-2 text-sm">
                  {DOMAINS.map(d => <option key={d} value={d}>{DOMAIN_LABELS[d]}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs">Audience *</Label>
                <select value={editRule.audience} onChange={e => setEditRule(r => r ? { ...r, audience: e.target.value } : r)}
                  className="mt-1 w-full h-9 border rounded-md px-2 text-sm">
                  {AUDIENCES.map(a => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
                </select>
              </div>
              <div>
                <Label className="text-xs">Stato</Label>
                <select value={editRule.status} onChange={e => setEditRule(r => r ? { ...r, status: e.target.value } : r)}
                  className="mt-1 w-full h-9 border rounded-md px-2 text-sm">
                  {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            <div>
              <Label className="text-xs">Titolo *</Label>
              <Input value={editRule.title || ''} onChange={e => setEditRule(r => r ? { ...r, title: e.target.value } : r)}
                className="mt-1" placeholder="Titolo della nota" />
            </div>

            <div>
              <Label className="text-xs">Contenuto *</Label>
              <textarea value={editRule.content || ''} onChange={e => setEditRule(r => r ? { ...r, content: e.target.value } : r)}
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm min-h-[120px] resize-y" placeholder="Testo della nota consultiva..." />
            </div>

            <div>
              <Label className="text-xs">Riferimenti normativi</Label>
              <TagInput value={editRule.normativa_ref || []} onChange={v => setEditRule(r => r ? { ...r, normativa_ref: v } : r)}
                placeholder="es. art. 164 TUIR" />
            </div>

            <div>
              <Label className="text-xs">Valori fiscali (JSON key-value)</Label>
              <FiscalValuesEditor value={editRule.fiscal_values || {}} onChange={v => setEditRule(r => r ? { ...r, fiscal_values: v } : r)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Trigger keywords</Label>
                <TagInput value={editRule.trigger_keywords || []} onChange={v => setEditRule(r => r ? { ...r, trigger_keywords: v } : r)} />
              </div>
              <div>
                <Label className="text-xs">Trigger ATECO prefixes</Label>
                <TagInput value={editRule.trigger_ateco_prefixes || []} onChange={v => setEditRule(r => r ? { ...r, trigger_ateco_prefixes: v } : r)} placeholder="es. 08, 41" />
              </div>
              <div>
                <Label className="text-xs">Trigger counterparty types</Label>
                <TagInput value={editRule.trigger_counterparty_types || []} onChange={v => setEditRule(r => r ? { ...r, trigger_counterparty_types: v } : r)} placeholder="es. professionista, srl" />
              </div>
              <div>
                <Label className="text-xs">Trigger VAT natures</Label>
                <TagInput value={editRule.trigger_vat_natures || []} onChange={v => setEditRule(r => r ? { ...r, trigger_vat_natures: v } : r)} placeholder="es. N6.3, N4" />
              </div>
              <div>
                <Label className="text-xs">Trigger doc types</Label>
                <TagInput value={editRule.trigger_doc_types || []} onChange={v => setEditRule(r => r ? { ...r, trigger_doc_types: v } : r)} placeholder="es. TD04, TD16" />
              </div>
              <div>
                <Label className="text-xs">ATECO scope (vuoto = tutti)</Label>
                <TagInput value={editRule.ateco_scope || []} onChange={v => setEditRule(r => r ? { ...r, ateco_scope: v } : r)} placeholder="es. 08, 49" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">In vigore da</Label>
                <Input type="date" value={editRule.effective_from || ''} onChange={e => setEditRule(r => r ? { ...r, effective_from: e.target.value } : r)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">In vigore fino a</Label>
                <Input type="date" value={editRule.effective_to || ''} onChange={e => setEditRule(r => r ? { ...r, effective_to: e.target.value } : r)} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Priorità (0-100)</Label>
                <Input type="number" min={0} max={100} value={editRule.priority ?? 50}
                  onChange={e => setEditRule(r => r ? { ...r, priority: Number(e.target.value) } : r)} className="mt-1" />
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
