// src/pages/admin/DocumentsPage.tsx
// Document management with automatic processing via kb-process-document
// Supports PDF upload with base64, text/URL documents, status polling, and chunk viewing

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import { supabase, SUPABASE_URL } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import {
  Plus, X, Search, Loader2, FileText, Globe, Type,
  ChevronDown, ChevronUp, BookOpen, Upload, Hash, Sparkles, Check
} from 'lucide-react'

interface KBDocument {
  id: string; title: string | null; source_type: string | null; source_url: string | null;
  issuer: string | null; publication_date: string | null; effective_date: string | null;
  status: string; chunk_count: number; full_text: string | null; tags: string[];
  active: boolean; created_at: string; file_name: string | null;
}

interface KBChunk {
  id: string; chunk_index: number; content: string;
  section_title: string | null; article_reference: string | null; token_count: number;
}

interface CandidateRule {
  domain: string; audience: string; title: string; content: string;
  normativa_ref: string[]; fiscal_values: Record<string, unknown>;
  trigger_keywords: string[]; trigger_ateco_prefixes: string[];
  trigger_vat_natures: string[]; trigger_doc_types: string[];
  priority: number;
  _selected?: boolean; // frontend-only
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
  const [chunks, setChunks] = useState<Record<string, KBChunk[]>>({})
  const [chunksLoading, setChunksLoading] = useState<string | null>(null)

  // Upload form
  const [form, setForm] = useState({
    title: '', source_type: 'text' as string, source_url: '',
    issuer: '', publication_date: '', effective_date: '',
    tags: [] as string[], text_content: '',
  })
  const [pdfFile, setPdfFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const pdfRef = useRef<HTMLInputElement>(null)

  // Extract rules state
  const [extracting, setExtracting] = useState(false)
  const [extractDocId, setExtractDocId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<CandidateRule[]>([])
  const [showExtractDialog, setShowExtractDialog] = useState(false)
  const [savingRules, setSavingRules] = useState(false)

  // Status polling
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollingDocIdRef = useRef<string | null>(null)

  const stopPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    pollingDocIdRef.current = null
  }, [])

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling])

  const loadDocs = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('kb_documents').select(
      'id, title, source_type, source_url, issuer, publication_date, effective_date, status, chunk_count, full_text, tags, active, created_at, file_name'
    ).eq('active', true).order('created_at', { ascending: false })
    if (filterStatus) q = q.eq('status', filterStatus)
    const { data } = await q
    setDocs((data as any[]) || [])
    setLoading(false)
  }, [filterStatus])

  useEffect(() => { loadDocs() }, [loadDocs])

  const filtered = docs.filter(d => {
    if (!search) return true
    const s = search.toLowerCase()
    return (d.title || '').toLowerCase().includes(s) ||
           (d.issuer || '').toLowerCase().includes(s) ||
           (d.file_name || '').toLowerCase().includes(s)
  })

  // Start polling for a document
  const startPolling = useCallback((docId: string) => {
    stopPolling()
    pollingDocIdRef.current = docId
    pollingRef.current = setInterval(async () => {
      const { data } = await supabase.from('kb_documents')
        .select('status, chunk_count')
        .eq('id', docId)
        .single()
      if (data && (data.status === 'ready' || data.status === 'error')) {
        stopPolling()
        loadDocs()
        if (data.status === 'ready') {
          toast.success(`Documento processato: ${data.chunk_count} chunks generati`)
        } else {
          toast.error('Errore nel processing del documento')
        }
      }
    }, 5000)
  }, [stopPolling, loadDocs])

  // File to base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // Remove data URL prefix if present
        const base64 = result.includes(',') ? result.split(',')[1] : result
        resolve(base64)
      }
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  const handleUpload = async () => {
    if (!form.title.trim()) { toast.error('Il titolo è obbligatorio'); return }
    if (form.source_type === 'pdf' && !pdfFile) { toast.error('Seleziona un file PDF'); return }
    if (form.source_type === 'text' && !form.text_content.trim()) { toast.error('Inserisci il testo'); return }
    setUploading(true)
    try {
      const isText = form.source_type === 'text'
      const payload: any = {
        title: form.title.trim(),
        source_type: form.source_type,
        source_url: form.source_type === 'url' ? form.source_url.trim() || null : null,
        issuer: form.issuer.trim() || null,
        publication_date: form.publication_date || null,
        effective_date: form.effective_date || null,
        tags: form.tags,
        status: isText ? 'ready' : 'processing',
        full_text: isText ? form.text_content : null,
        file_name: pdfFile?.name || null,
        file_type: form.source_type === 'pdf' ? 'pdf' : null,
        active: true,
        chunk_count: 0,
      }

      const { data: newDoc, error: insertErr } = await supabase
        .from('kb_documents')
        .insert(payload)
        .select('id')
        .single()
      if (insertErr) throw insertErr
      const newDocId = (newDoc as any).id

      // If PDF: trigger processing
      if (form.source_type === 'pdf' && pdfFile) {
        const base64Data = await fileToBase64(pdfFile)
        const { data: { session } } = await supabase.auth.getSession()
        const processRes = await fetch(`${SUPABASE_URL}/functions/v1/kb-process-document`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            document_id: newDocId,
            pdf_base64: base64Data,
          }),
        })
        if (!processRes.ok) {
          const errText = await processRes.text()
          console.warn('Processing trigger failed:', errText)
          toast.warning('Documento salvato ma processing fallito. Riprova più tardi.')
        } else {
          startPolling(newDocId)
        }
      } else if (form.source_type === 'text' && form.text_content.trim()) {
        // For text: also trigger processing to generate chunks+embeddings
        const { data: { session } } = await supabase.auth.getSession()
        // Update full_text first, then trigger
        await fetch(`${SUPABASE_URL}/functions/v1/kb-process-document`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({ document_id: newDocId }),
        }).catch(e => console.warn('Text processing trigger failed:', e))
      }

      toast.success('Documento salvato' + (form.source_type === 'pdf' ? '. Processing in corso...' : ''))
      setShowUpload(false)
      setForm({ title: '', source_type: 'text', source_url: '', issuer: '', publication_date: '', effective_date: '', tags: [], text_content: '' })
      setPdfFile(null)
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

  // Extract rules from document
  const handleExtractRules = async (docId: string) => {
    setExtracting(true)
    setExtractDocId(docId)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      const res = await fetch(`${SUPABASE_URL}/functions/v1/admin-extract-rules`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({
          document_id: docId,
          company_id: session?.user?.user_metadata?.company_id || (await supabase.from('company_members').select('company_id').eq('user_id', session?.user?.id || '').limit(1).single()).data?.company_id,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Errore sconosciuto' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      const result = await res.json()
      const cands = (result.candidates || []).map((c: CandidateRule) => ({ ...c, _selected: true }))
      setCandidates(cands)
      setShowExtractDialog(true)
      if (cands.length === 0) {
        toast.info('Nessuna regola fiscale trovata in questo documento')
      } else {
        toast.success(`${cands.length} regole candidate estratte`)
      }
    } catch (e: any) {
      toast.error(`Estrazione fallita: ${e.message}`)
    }
    setExtracting(false)
  }

  // Save approved candidate rules to knowledge_base
  const handleSaveExtractedRules = async () => {
    const selected = candidates.filter(c => c._selected)
    if (selected.length === 0) {
      toast.warning('Seleziona almeno una regola')
      return
    }
    setSavingRules(true)
    try {
      const rows = selected.map(c => ({
        domain: c.domain,
        audience: c.audience,
        title: c.title,
        content: c.content,
        normativa_ref: c.normativa_ref,
        fiscal_values: c.fiscal_values,
        trigger_keywords: c.trigger_keywords,
        trigger_ateco_prefixes: c.trigger_ateco_prefixes,
        trigger_vat_natures: c.trigger_vat_natures,
        trigger_doc_types: c.trigger_doc_types,
        priority: c.priority,
        status: 'approved',
        active: true,
        effective_from: new Date().toISOString().slice(0, 10),
        effective_to: '2099-12-31',
        source_document_id: extractDocId,
      }))

      const { error } = await supabase.from('knowledge_base').insert(rows as any)
      if (error) throw error

      toast.success(`${selected.length} regole salvate nella Knowledge Base`)
      setShowExtractDialog(false)
      setCandidates([])
    } catch (e: any) {
      toast.error(`Salvataggio fallito: ${e.message}`)
    }
    setSavingRules(false)
  }

  // Load chunks for expanded document
  const loadChunks = async (docId: string) => {
    if (chunks[docId]) return // already loaded
    setChunksLoading(docId)
    const { data } = await supabase.from('kb_chunks')
      .select('id, chunk_index, content, section_title, article_reference, token_count')
      .eq('document_id', docId)
      .order('chunk_index')
    setChunks(prev => ({ ...prev, [docId]: (data as any[]) || [] }))
    setChunksLoading(null)
  }

  const handleExpand = (docId: string) => {
    const isExpanding = expandedId !== docId
    setExpandedId(isExpanding ? docId : null)
    if (isExpanding) {
      const doc = docs.find(d => d.id === docId)
      if (doc && doc.status === 'ready' && doc.chunk_count > 0) {
        loadChunks(docId)
      }
    }
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
            const isPolling = pollingDocIdRef.current === doc.id
            const docChunks = chunks[doc.id]

            return (
              <div key={doc.id} className="border rounded-lg bg-white">
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50/50" onClick={() => handleExpand(doc.id)}>
                  <SrcIcon className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{doc.title || doc.file_name || 'Senza titolo'}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {doc.issuer && <span className="text-[10px] text-slate-500">{doc.issuer}</span>}
                      {doc.publication_date && <span className="text-[10px] text-slate-400">{doc.publication_date}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {(doc.status === 'processing' || isPolling) && (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />
                    )}
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[doc.status] || 'bg-gray-100'}`}>
                      {doc.status}
                    </span>
                    <span className="text-xs text-slate-400">{doc.chunk_count} chunks</span>
                    {expanded ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
                  </div>
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

                    {/* Chunks viewer */}
                    {doc.status === 'ready' && doc.chunk_count > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                          <Hash className="h-3 w-3" /> Chunks ({doc.chunk_count})
                        </p>
                        {chunksLoading === doc.id ? (
                          <div className="flex items-center gap-2 py-2">
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />
                            <span className="text-xs text-slate-400">Caricamento chunks...</span>
                          </div>
                        ) : docChunks && docChunks.length > 0 ? (
                          <div className="space-y-1.5 max-h-80 overflow-y-auto">
                            {docChunks.map(ch => (
                              <div key={ch.id} className="bg-slate-50 rounded-lg px-3 py-2 text-[11px]">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[9px] font-bold bg-slate-200 text-slate-600 px-1 py-0.5 rounded">
                                    #{ch.chunk_index}
                                  </span>
                                  {ch.section_title && (
                                    <span className="text-[9px] text-purple-600 font-medium">{ch.section_title}</span>
                                  )}
                                  {ch.article_reference && (
                                    <span className="text-[9px] text-sky-600">{ch.article_reference}</span>
                                  )}
                                  <span className="text-[9px] text-slate-400 ml-auto">{ch.token_count} tokens</span>
                                </div>
                                <p className="text-slate-700 line-clamp-3">
                                  {ch.content.split(/\s+/).slice(0, 30).join(' ')}{ch.content.split(/\s+/).length > 30 ? '...' : ''}
                                </p>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[10px] text-slate-400">Nessun chunk trovato</p>
                        )}
                      </div>
                    )}

                    <div className="flex gap-2">
                      <Button size="sm" variant="outline"
                        disabled={doc.status !== 'ready' || (extracting && extractDocId === doc.id)}
                        onClick={(e) => { e.stopPropagation(); handleExtractRules(doc.id) }}>
                        {(extracting && extractDocId === doc.id)
                          ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                          : <Sparkles className="h-3.5 w-3.5 mr-1" />}
                        Estrai regole AI
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

      {/* Extract Rules Dialog */}
      {showExtractDialog && candidates.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-2xl w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                Regole estratte ({candidates.filter(c => c._selected).length}/{candidates.length} selezionate)
              </h2>
              <button onClick={() => { setShowExtractDialog(false); setCandidates([]) }} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="space-y-2 max-h-[60vh] overflow-y-auto">
              {candidates.map((c, i) => {
                const domainColors: Record<string, string> = {
                  iva: 'bg-blue-100 text-blue-700', ires_irap: 'bg-purple-100 text-purple-700',
                  ritenute: 'bg-rose-100 text-rose-700', classificazione: 'bg-emerald-100 text-emerald-700',
                  settoriale: 'bg-amber-100 text-amber-700', operativo: 'bg-slate-100 text-slate-700',
                  aggiornamenti: 'bg-cyan-100 text-cyan-700',
                }
                return (
                  <div key={i} className={`border rounded-lg p-3 cursor-pointer transition-colors ${c._selected ? 'border-sky-300 bg-sky-50/30' : 'border-gray-200 bg-gray-50/50 opacity-60'}`}
                    onClick={() => setCandidates(prev => prev.map((cc, j) => j === i ? { ...cc, _selected: !cc._selected } : cc))}>
                    <div className="flex items-start gap-2">
                      <div className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${c._selected ? 'bg-sky-500 border-sky-500' : 'border-gray-300'}`}>
                        {c._selected && <Check className="h-3 w-3 text-white" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${domainColors[c.domain] || 'bg-gray-100 text-gray-600'}`}>
                            {c.domain.toUpperCase()}
                          </span>
                          <span className="text-[9px] text-slate-400">{c.audience}</span>
                          <span className="text-[9px] text-slate-400">P{c.priority}</span>
                        </div>
                        <p className="text-sm font-medium text-slate-800 mt-1">{c.title}</p>
                        <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">{c.content}</p>
                        {c.normativa_ref.length > 0 && (
                          <p className="text-[10px] text-sky-600 mt-1">{c.normativa_ref.join(', ')}</p>
                        )}
                        {Object.keys(c.fiscal_values).length > 0 && (
                          <p className="text-[10px] text-purple-600 mt-0.5">
                            Valori: {Object.entries(c.fiscal_values).map(([k, v]) => `${k}=${v}`).join(', ')}
                          </p>
                        )}
                        {c.trigger_keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {c.trigger_keywords.slice(0, 6).map((kw, ki) => (
                              <span key={ki} className="text-[9px] bg-slate-200 text-slate-600 px-1 py-0.5 rounded">{kw}</span>
                            ))}
                            {c.trigger_keywords.length > 6 && <span className="text-[9px] text-slate-400">+{c.trigger_keywords.length - 6}</span>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="flex gap-2">
                <button className="text-xs text-sky-600 hover:text-sky-800" onClick={() => setCandidates(prev => prev.map(c => ({ ...c, _selected: true })))}>
                  Seleziona tutte
                </button>
                <button className="text-xs text-slate-500 hover:text-slate-700" onClick={() => setCandidates(prev => prev.map(c => ({ ...c, _selected: false })))}>
                  Deseleziona tutte
                </button>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => { setShowExtractDialog(false); setCandidates([]) }}>Annulla</Button>
                <Button onClick={handleSaveExtractedRules} disabled={savingRules || candidates.filter(c => c._selected).length === 0}>
                  {savingRules ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Check className="h-4 w-4 mr-1" />}
                  Salva {candidates.filter(c => c._selected).length} regole
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload Dialog */}
      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-lg w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-slate-900">Carica documento</h2>
              <button onClick={() => { setShowUpload(false); setPdfFile(null) }} className="text-slate-400 hover:text-slate-600"><X className="h-5 w-5" /></button>
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
                      onChange={() => { setForm(f => ({ ...f, source_type: t })); setPdfFile(null) }} className="sr-only" />
                    {t === 'pdf' ? 'PDF' : t === 'url' ? 'URL' : 'Testo'}
                  </label>
                ))}
              </div>
            </div>

            {form.source_type === 'pdf' && (
              <div className="space-y-2">
                <div
                  onClick={() => pdfRef.current?.click()}
                  className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-sky-400 hover:bg-sky-50/30 transition-colors"
                >
                  {pdfFile ? (
                    <div className="flex items-center justify-center gap-2">
                      <FileText className="h-5 w-5 text-emerald-500" />
                      <span className="text-sm font-medium text-slate-700">{pdfFile.name}</span>
                      <span className="text-[10px] text-slate-400">({(pdfFile.size / 1024).toFixed(0)} KB)</span>
                    </div>
                  ) : (
                    <>
                      <Upload className="h-6 w-6 text-slate-400 mx-auto mb-1" />
                      <p className="text-xs text-slate-500">Clicca per selezionare un PDF</p>
                    </>
                  )}
                  <input
                    ref={pdfRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) setPdfFile(f) }}
                  />
                </div>
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
              <Button variant="outline" onClick={() => { setShowUpload(false); setPdfFile(null) }}>Annulla</Button>
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
