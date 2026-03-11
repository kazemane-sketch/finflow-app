// src/pages/admin/KeywordGroupsPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Plus, X, Loader2, Tags, Trash2, Search, ToggleLeft, ToggleRight } from 'lucide-react'

interface KeywordGroup {
  id: string
  group_code: string
  group_name: string
  macro_category: string
  keywords: string[]
  active: boolean
  sort_order: number
}

const MACRO_CATEGORIES = [
  'compravendita', 'logistica', 'locazione', 'energia', 'manutenzione',
  'veicoli', 'servizi_professionali', 'materiali', 'personale',
  'assicurazioni', 'imposte', 'finanziarie', 'telecomunicazioni',
  'marketing', 'servizi_vari', 'opere', 'rinnovabili', 'sanitario',
]

const emptyGroup = (): Omit<KeywordGroup, 'id'> => ({
  group_code: '', group_name: '', macro_category: 'compravendita',
  keywords: [], active: true, sort_order: 0,
})

export default function KeywordGroupsPage() {
  const [groups, setGroups] = useState<KeywordGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [editGroup, setEditGroup] = useState<Partial<KeywordGroup> | null>(null)
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState<string>('all')

  const loadGroups = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('operation_keyword_groups')
      .select('*')
      .order('sort_order')
      .order('group_code')
    setGroups((data as any[]) || [])
    setLoading(false)
  }, [])

  useEffect(() => { loadGroups() }, [loadGroups])

  const handleSave = async () => {
    if (!editGroup) return
    if (!editGroup.group_code?.trim() || !editGroup.group_name?.trim()) {
      toast.error('Codice e nome gruppo sono obbligatori')
      return
    }
    if (!editGroup.keywords?.length) {
      toast.error('Inserire almeno un keyword')
      return
    }
    setSaving(true)
    const payload = {
      group_code: editGroup.group_code!.trim().toUpperCase(),
      group_name: editGroup.group_name!.trim(),
      macro_category: editGroup.macro_category || 'compravendita',
      keywords: editGroup.keywords || [],
      active: editGroup.active !== false,
      sort_order: editGroup.sort_order ?? 0,
      updated_at: new Date().toISOString(),
    }
    try {
      if (editGroup.id) {
        const { error } = await supabase
          .from('operation_keyword_groups')
          .update(payload as any)
          .eq('id', editGroup.id)
        if (error) throw error
        toast.success('Gruppo aggiornato')
      } else {
        const { error } = await supabase
          .from('operation_keyword_groups')
          .insert(payload as any)
        if (error) throw error
        toast.success('Gruppo creato')
      }
      setEditGroup(null)
      loadGroups()
    } catch (e: any) {
      toast.error(e.message)
    }
    setSaving(false)
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Eliminare questo gruppo di sinonimi?')) return
    await supabase.from('operation_keyword_groups').delete().eq('id', id) as any
    toast.success('Gruppo eliminato')
    loadGroups()
  }

  const toggleActive = async (g: KeywordGroup) => {
    await supabase
      .from('operation_keyword_groups')
      .update({ active: !g.active, updated_at: new Date().toISOString() } as any)
      .eq('id', g.id)
    loadGroups()
  }

  // Filter groups
  const filtered = groups.filter(g => {
    if (filterCat !== 'all' && g.macro_category !== filterCat) return false
    if (search) {
      const q = search.toLowerCase()
      return g.group_code.toLowerCase().includes(q)
        || g.group_name.toLowerCase().includes(q)
        || g.keywords.some(k => k.toLowerCase().includes(q))
    }
    return true
  })

  // Group by macro_category for display
  const byCategory = new Map<string, KeywordGroup[]>()
  for (const g of filtered) {
    const arr = byCategory.get(g.macro_category) || []
    arr.push(g)
    byCategory.set(g.macro_category, arr)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-violet-100 text-violet-700 flex items-center justify-center">
            <Tags className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Dizionario Sinonimi</h1>
            <p className="text-sm text-gray-500">
              Gruppi di keyword per il matching delle operazioni — {groups.length} gruppi
            </p>
          </div>
        </div>
        <Button size="sm" onClick={() => setEditGroup(emptyGroup())}>
          <Plus className="h-4 w-4 mr-1" /> Nuovo gruppo
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Cerca codice, nome o keyword..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <select
          value={filterCat}
          onChange={e => setFilterCat(e.target.value)}
          className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm"
        >
          <option value="all">Tutte le categorie</option>
          {MACRO_CATEGORIES.map(c => (
            <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
          ))}
        </select>
      </div>

      {/* Edit modal */}
      {editGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">
                {editGroup.id ? 'Modifica gruppo' : 'Nuovo gruppo sinonimi'}
              </h2>
              <button onClick={() => setEditGroup(null)}><X className="h-5 w-5 text-gray-400" /></button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Codice gruppo *</Label>
                <Input
                  value={editGroup.group_code || ''}
                  onChange={e => setEditGroup({ ...editGroup, group_code: e.target.value.toUpperCase() })}
                  placeholder="VND"
                  className="h-9 font-mono"
                />
              </div>
              <div>
                <Label className="text-xs">Nome gruppo *</Label>
                <Input
                  value={editGroup.group_name || ''}
                  onChange={e => setEditGroup({ ...editGroup, group_name: e.target.value })}
                  placeholder="Vendita / Cessione"
                  className="h-9"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Macro categoria</Label>
                <select
                  value={editGroup.macro_category || 'compravendita'}
                  onChange={e => setEditGroup({ ...editGroup, macro_category: e.target.value })}
                  className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm"
                >
                  {MACRO_CATEGORIES.map(c => (
                    <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label className="text-xs">Ordine</Label>
                <Input
                  type="number"
                  value={editGroup.sort_order ?? 0}
                  onChange={e => setEditGroup({ ...editGroup, sort_order: parseInt(e.target.value) || 0 })}
                  className="h-9"
                />
              </div>
            </div>

            <div>
              <Label className="text-xs">Keywords (sinonimi) *</Label>
              <TagInput
                value={editGroup.keywords || []}
                onChange={keywords => setEditGroup({ ...editGroup, keywords })}
                placeholder="Aggiungi keyword e premi Invio..."
              />
              <p className="text-[10px] text-gray-400 mt-1">
                Ogni keyword è un sinonimo per questo tipo di operazione
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={editGroup.active !== false}
                onChange={e => setEditGroup({ ...editGroup, active: e.target.checked })}
                className="rounded"
              />
              <Label className="text-xs">Attivo</Label>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={() => setEditGroup(null)}>Annulla</Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                Salva
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Groups list by category */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-400">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Caricamento...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-gray-400">
          Nessun gruppo trovato
        </div>
      ) : (
        <div className="space-y-6">
          {[...byCategory.entries()].map(([cat, catGroups]) => (
            <div key={cat}>
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">
                {cat.replace(/_/g, ' ')} ({catGroups.length})
              </h3>
              <div className="grid gap-2">
                {catGroups.map(g => (
                  <div
                    key={g.id}
                    className={`rounded-lg border p-3 flex items-start gap-3 transition-colors ${
                      g.active ? 'bg-white border-gray-200' : 'bg-gray-50 border-gray-100 opacity-60'
                    }`}
                  >
                    {/* Code badge */}
                    <span className="shrink-0 font-mono text-xs font-bold px-2 py-1 rounded bg-violet-50 text-violet-700 border border-violet-200">
                      {g.group_code}
                    </span>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-800">{g.group_name}</div>
                      <div className="flex flex-wrap gap-1 mt-1">
                        {g.keywords.slice(0, 8).map((kw, i) => (
                          <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                            {kw}
                          </span>
                        ))}
                        {g.keywords.length > 8 && (
                          <span className="text-[10px] px-1.5 py-0.5 text-gray-400">
                            +{g.keywords.length - 8}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => toggleActive(g)}
                        className="p-1 rounded hover:bg-gray-100"
                        title={g.active ? 'Disattiva' : 'Attiva'}
                      >
                        {g.active
                          ? <ToggleRight className="h-4 w-4 text-green-600" />
                          : <ToggleLeft className="h-4 w-4 text-gray-400" />
                        }
                      </button>
                      <button
                        onClick={() => setEditGroup(g)}
                        className="text-xs px-2 py-1 rounded hover:bg-gray-100 text-gray-600"
                      >
                        Modifica
                      </button>
                      <button
                        onClick={() => handleDelete(g.id)}
                        className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
