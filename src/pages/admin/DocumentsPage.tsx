// src/pages/admin/DocumentsPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { Plus, X, Search, Loader2, FileText, Globe, Type, ChevronDown, ChevronUp, BookOpen } from 'lucide-react'

interface KBDocument {
  id: string; title: string | null; source_type: string | null; source_url: string | null;
  issuer: string | null; publication_date: string | null; effective_date: string | null;
  status: string; chunk_count: number; full_text: string | null; tags: string[];
  active: boolean; created_at: string; file_name: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600', processing: 'bg-amber-100 text-amber-700',
  ready: 'bg-green-100 text-green-700', error: 'bg-red-100 text-red-700',
  superseded: 'bg-gray-100 text-gray-500', uploading: 'bg-blue-100 text-blue-600',
}
const SOURCE_ICONS: Record<string, typeof FileText> = { pdf: FileText, url: Globe, text: Type }

export default function DocumentsPage() {
  const [docs, setDocs] = useState<KBDocument[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [showUpload, setShowUpload] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Upload form
  const [form, setForm] = useState({ title: '', source_type: 'text' as string, source_url: '', issuer: '', publication_date: '', effective_date: '', tags: [] as string[], text_content: '' })
  const [uploading, setUploading] = useState(false)

  const loadDocs = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('kb_documents').select('id, title, source_type, source_url, issuer, publication_date, effective_date, status, chunk_count, full_text, tags, active, created_at, file_name')
      .eq('active', true).order('created_at', { ascending: false })
    if (filterStatus) q = q.eq('status', filterStatus)
    const { data } = await q
    setDocs((data as any[]) || [])
    setLoading(false)
  }, [filterStatus])

  useEffect(() => { loadDocs() }, [loadDocs])

  const filtered = docs.filter(d => {
    if (!search) return true
    const s = search.toLowerCase()
    return (d.title || '').toLowerCase().includes(s) || (d.issuer || '').toLowerCase().includes(s) || (d.file_name || '').toLowerCase().includes(s)
  })

  const handleUpload = async () => {
    if (!form.title.trim()) { toast.error('Il titolo è obbligatorio'); return }
    setUploading(true)
    try {
      const payload: any = {
        title: form.title.trim(),
        source_type: form.source_type,
        source_url: form.source_type === 'url' ? form.source_url.trim() || null : null,
        issuer: form.issuer.trim() || null,
        publication_date: form.publication_date || null,
        effective_date: form.effective_date || null,
        tags: form.tags,
        status: form.source_type === 'text' ? 'ready' : 'pending',
        full_text: form.source_type === 'text' ? form.text_content : null,
        active: true,
        chunk_count: 0,
      }
      const { error } = await supabase.from('kb_documents').insert(payload)
      if (error) throw error
      toast.success('Documento salvato. ' + (form.source_type !== 'text' ? 'Il processing dei chunk verrà eseguito automaticamente.' : ''))
      setShowUpload(false)
      setForm({ title: '', source_type: 'text', source_url: '', issuer: '', publication_date: '', effective_date: '', tags: [], text_content: '' })
      loadDocs()
    } catch (e: any) {
      toast.error(e.message)
    }
    setUploading(false)
  }

  const markSuperseded = async (id: string) => {
    await supabase.from('kb_documents').update({ status: 'superseded', updated_at: new Date().toISOString() } as any).eq('id', id)
    toast.success('Documento segnato come superato')
    loadDocs()
  }

  return (
    <div className="p-6 space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <FileText className="h-6 w-6 text-emerald-600" /> Documenti Sorgente
          </h1>
          <p className="text-sm text-slate-500 mt-1">Normativa, circolari e documenti per RAG</p>
        </div>
        <Button onClick={() => setShowUpload(true)}>
          <Plus className="h-4 w-4 mr-1.5" /> Carica documento
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Cerca..." className="pl-8 h-9 text-sm" />
        </div>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} className="h-9 border rounded-md px-2 text-xs">
          <option value="">Tutti gli stati</option>
          <option value="pending">Pending</option>
          <option value="processing">Processing</option>
          <option value="ready">Ready</option>
          <option value="error">Error</option>
          <option value="superseded">Superseded</option>
        </select>
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      ) : filtered.length === 0 ? (
        <p className="text-center text-sm text-slate-400 py-12">Nessun documento trovato</p>
      ) : (
        <div className="space-y-2">
          {filtered.map(doc => {
            const SrcIcon = SOURCE_ICONS[doc.source_type || 'text'] || Type
            const expanded = expandedId === doc.id
            return (
              <div key={doc.id} className="border rounded-lg bg-white">
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50/50" onClick={() => setExpandedId(expanded ? null : doc.id)}>
                  <SrcIcon className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{doc.title || doc.file_name || 'Senza titolo'}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {doc.issuer && <span className="text-[10px] text-slate-500">{doc.issuer}</span>}
                      {doc.publication_date && <span className="text-[10px] text-slate-400">{doc.publication_date}</span>}
                    </div>
                  </div>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${STATUS_COLORS[doc.status] || 'bg-gray-100'}`}>
                    {doc.status}
                  </span>
                  <span className="text-xs text-slate-400 shrink-0">{doc.chunk_count} chunks</span>
                  {expanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                </div>
                {expanded && (
                  <div className="px-4 pb-4 pt-1 border-t space-y-3">
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                      <div><span className="text-slate-400">Tipo:</span> <span className="font-medium">{doc.source_type || '—'}</span></div>
                      <div><span className="text-slate-400">Chunks:</span> <span className="font-medium">{doc.chunk_count}</span></div>
                      <div><span className="text-slate-400">Pubblicazione:</span> <span className="font-medium">{doc.publication_date || '—'}</span></div>
                      <div><span className="text-slate-400">In vigore:</span> <span className="font-medium">{doc.effective_date || '—'}</span></div>
                    </div>
                    {doc.tags && doc.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {doc.tags.map((t, i) => <span key={i} className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">{t}</span>)}
                      </div>
                    )}
                    {doc.full_text && (
                      <details className="text-xs">
                        <summary className="cursor-pointer text-sky-600 hover:text-sky-800 font-medium">Mostra testo completo</summary>
                        <pre className="mt-2 max-h-60 overflow-y-auto bg-slate-50 rounded p-3 text-[11px] whitespace-pre-wrap">{doc.full_text}</pre>
                      </details>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => toast.info('Funzionalità in arrivo nella Fase 2')}>
                        <BookOpen className="h-3.5 w-3.5 mr-1" /> Estrai regole
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => markSuperseded(doc.id)}>
                        Segna come superato
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Upload Dialog */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Carica documento</h2>
              <button onClick={() => setShowUpload(false)} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
            </div>

            <div>
              <Label className="text-xs">Titolo *</Label>
              <Input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} className="mt-1" placeholder="es. Circolare AdE 18/E del 2024" />
            </div>

            <div>
              <Label className="text-xs">Tipo sorgente</Label>
              <div className="flex gap-3 mt-1.5">
                {(['pdf', 'url', 'text'] as const).map(t => (
                  <label key={t} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md border cursor-pointer text-sm ${form.source_type === t ? 'border-sky-500 bg-sky-50 text-sky-700' : 'border-gray-200 text-gray-600'}`}>
                    <input type="radio" name="source_type" value={t} checked={form.source_type === t}
                      onChange={() => setForm(f => ({ ...f, source_type: t }))} className="sr-only" />
                    {t === 'pdf' ? 'PDF' : t === 'url' ? 'URL' : 'Testo'}
                  </label>
                ))}
              </div>
            </div>

            {form.source_type === 'pdf' && (
              <div className="bg-amber-50 rounded-lg px-3 py-2 text-xs text-amber-700">
                ⚠ Upload PDF: il processing dei chunk verrà implementato nella Fase 2. Per ora il documento verrà salvato con status "pending".
              </div>
            )}

            {form.source_type === 'url' && (
              <div>
                <Label className="text-xs">URL</Label>
                <Input value={form.source_url} onChange={e => setForm(f => ({ ...f, source_url: e.target.value }))} className="mt-1" placeholder="https://..." />
              </div>
            )}

            {form.source_type === 'text' && (
              <div>
                <Label className="text-xs">Testo</Label>
                <textarea value={form.text_content} onChange={e => setForm(f => ({ ...f, text_content: e.target.value }))}
                  className="mt-1 w-full border rounded-md px-3 py-2 text-sm min-h-[160px] resize-y" placeholder="Incolla il testo normativo qui..." />
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Emittente</Label>
                <Input value={form.issuer} onChange={e => setForm(f => ({ ...f, issuer: e.target.value }))} className="mt-1" placeholder="es. Agenzia Entrate, OIC" />
              </div>
              <div>
                <Label className="text-xs">Data pubblicazione</Label>
                <Input type="date" value={form.publication_date} onChange={e => setForm(f => ({ ...f, publication_date: e.target.value }))} className="mt-1" />
              </div>
              <div>
                <Label className="text-xs">Data entrata in vigore</Label>
                <Input type="date" value={form.effective_date} onChange={e => setForm(f => ({ ...f, effective_date: e.target.value }))} className="mt-1" />
              </div>
            </div>

            <div>
              <Label className="text-xs">Tags</Label>
              <TagInput value={form.tags} onChange={v => setForm(f => ({ ...f, tags: v }))} placeholder="es. TUIR, IVA, art.164" />
            </div>

            <div className="flex gap-2 justify-end pt-2 border-t">
              <Button variant="outline" onClick={() => setShowUpload(false)}>Annulla</Button>
              <Button onClick={handleUpload} disabled={uploading}>
                {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                Salva
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
