// src/pages/admin/KBDocumentsPage.tsx
// Platform-level normative document management with rich taxonomy
// Supports CRUD, taxonomy filters, detail view with chunks, relations, and rule generation

import { useState, useEffect, useCallback, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import TagInput from '@/components/TagInput'
import MultiSelectChips from '@/components/ui/MultiSelectChips'
import NullableMultiSelect from '@/components/ui/NullableMultiSelect'
import { supabase } from '@/integrations/supabase/client'
import { toast } from 'sonner'
import { useAIJob } from '@/hooks/useAIJob'
import {
  Plus, X, Search, Loader2, FileText, Globe, Type, Trash2,
  ChevronDown, ChevronUp, ArrowLeft, Link2, BookOpen, Sparkles,
  Calendar, Shield, Building2, Eye, Pencil, ExternalLink, Upload,
  Brain, CheckCircle2, Square, Zap,
} from 'lucide-react'

// ════════════════════════════════════════════════
// Cancellable invoke wrapper (supabase.functions.invoke doesn't support AbortSignal)
// ════════════════════════════════════════════════

async function invokeCancellable(
  functionName: string,
  body: any,
  signal: AbortSignal,
): Promise<any> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const promise = supabase.functions.invoke(functionName, { body })
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
    promise.then(resolve).catch(reject)
  })
}

// ════════════════════════════════════════════════
// Constants / Enums
// ════════════════════════════════════════════════

const SOURCE_TYPES = [
  { value: 'legge', label: 'Legge' },
  { value: 'dpr', label: 'DPR' },
  { value: 'dlgs', label: 'D.Lgs.' },
  { value: 'dm', label: 'DM' },
  { value: 'dpcm', label: 'DPCM' },
  { value: 'circolare_ade', label: 'Circolare AdE' },
  { value: 'risoluzione_ade', label: 'Risoluzione AdE' },
  { value: 'interpello_ade', label: 'Interpello AdE' },
  { value: 'principio_oic', label: 'Principio OIC' },
  { value: 'principio_isa', label: 'Principio ISA' },
  { value: 'sentenza', label: 'Sentenza' },
  { value: 'prassi', label: 'Prassi' },
  { value: 'normativa_eu', label: 'Normativa EU' },
  { value: 'altro', label: 'Altro' },
]

const AUTHORITIES = [
  { value: 'tuir', label: 'TUIR' },
  { value: 'dpr_633', label: 'DPR 633 (IVA)' },
  { value: 'dpr_600', label: 'DPR 600' },
  { value: 'codice_civile', label: 'Codice Civile' },
  { value: 'oic', label: 'OIC' },
  { value: 'isa_italia', label: 'ISA Italia' },
  { value: 'agenzia_entrate', label: 'Agenzia Entrate' },
  { value: 'mef', label: 'MEF' },
  { value: 'cassazione', label: 'Cassazione' },
  { value: 'corte_costituzionale', label: 'Corte Costituzionale' },
  { value: 'commissione_tributaria', label: 'Comm. Tributaria' },
  { value: 'cndcec', label: 'CNDCEC' },
  { value: 'eu', label: 'EU' },
  { value: 'altro', label: 'Altro' },
]

const CATEGORIES = [
  { value: 'normativa_fiscale', label: 'Normativa Fiscale' },
  { value: 'principi_contabili', label: 'Principi Contabili' },
  { value: 'principi_revisione', label: 'Principi Revisione' },
  { value: 'prassi_interpretativa', label: 'Prassi Interpretativa' },
  { value: 'normativa_periodica', label: 'Normativa Periodica' },
  { value: 'giurisprudenza', label: 'Giurisprudenza' },
  { value: 'tabelle_operative', label: 'Tabelle Operative' },
  { value: 'normativa_lavoro', label: 'Normativa Lavoro' },
  { value: 'normativa_societaria', label: 'Normativa Societaria' },
]

const TAX_AREAS = [
  { value: 'imposte_dirette', label: 'Imposte Dirette' },
  { value: 'iva', label: 'IVA' },
  { value: 'irap', label: 'IRAP' },
  { value: 'ritenute', label: 'Ritenute' },
  { value: 'imu', label: 'IMU' },
  { value: 'imposta_registro', label: 'Imposta Registro' },
]

const ACCOUNTING_AREAS = [
  { value: 'bilancio', label: 'Bilancio' },
  { value: 'ammortamento', label: 'Ammortamento' },
  { value: 'fondi_rischi', label: 'Fondi Rischi' },
  { value: 'ratei_risconti', label: 'Ratei/Risconti' },
  { value: 'conto_economico', label: 'Conto Economico' },
  { value: 'stato_patrimoniale', label: 'Stato Patrimoniale' },
]

const LEGAL_FORMS = [
  { value: 'srl', label: 'SRL' }, { value: 'spa', label: 'SPA' },
  { value: 'sapa', label: 'SAPA' }, { value: 'snc', label: 'SNC' },
  { value: 'sas', label: 'SAS' }, { value: 'ditta_individuale', label: 'Ditta Ind.' },
  { value: 'cooperativa', label: 'Coop.' }, { value: 'associazione', label: 'Assoc.' },
  { value: 'ente_non_commerciale', label: 'Ente non comm.' },
]

const REGIMES = [
  { value: 'ordinario', label: 'Ordinario' }, { value: 'semplificato', label: 'Semplificato' },
  { value: 'forfettario', label: 'Forfettario' }, { value: 'agricoltura', label: 'Agricoltura' },
  { value: 'editoria', label: 'Editoria' }, { value: 'agenzie_viaggio', label: 'Agenzie Viaggio' },
  { value: 'beni_usati', label: 'Beni Usati' },
]

const OPERATIONS = [
  { value: 'acquisto_beni_strumentali', label: 'Acq. Beni Strum.' },
  { value: 'leasing', label: 'Leasing' }, { value: 'noleggio', label: 'Noleggio' },
  { value: 'servizi', label: 'Servizi' }, { value: 'cessione', label: 'Cessione' },
  { value: 'prestazione_professionale', label: 'Prest. Prof.' },
  { value: 'rimborso_spese', label: 'Rimborso Spese' }, { value: 'autofattura', label: 'Autofattura' },
]

const COUNTERPARTY_TYPES = [
  { value: 'fornitore_it', label: 'Fornitore IT' },
  { value: 'professionista', label: 'Professionista' },
  { value: 'fornitore_ue', label: 'Fornitore UE' },
  { value: 'fornitore_extraue', label: 'Fornitore ExtraUE' },
  { value: 'pa', label: 'PA' },
  { value: 'banca', label: 'Banca' },
  { value: 'assicurazione', label: 'Assicurazione' },
  { value: 'forfettario', label: 'Forfettario' },
]

const SIZE_CLASSES = [
  { value: 'micro', label: 'Micro' }, { value: 'piccola', label: 'Piccola' },
  { value: 'media', label: 'Media' }, { value: 'grande', label: 'Grande' },
]

const UPDATE_FREQUENCIES = [
  { value: 'static', label: 'Statico' }, { value: 'annual', label: 'Annuale' },
  { value: 'periodic', label: 'Periodico' }, { value: 'volatile', label: 'Volatile' },
]

const RELATION_TYPES = [
  { value: 'rinvia_a', label: 'Rinvia a' }, { value: 'modifica', label: 'Modifica' },
  { value: 'interpreta', label: 'Interpreta' }, { value: 'abroga', label: 'Abroga' },
  { value: 'attua', label: 'Attua' }, { value: 'deroga', label: 'Deroga' },
  { value: 'integra', label: 'Integra' }, { value: 'cita', label: 'Cita' },
  { value: 'genera_regola', label: 'Genera regola' },
]

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600',
  processing: 'bg-amber-100 text-amber-700',
  chunking: 'bg-blue-100 text-blue-600',
  ready: 'bg-green-100 text-green-700',
  error: 'bg-red-100 text-red-700',
  superseded: 'bg-gray-100 text-gray-500',
  uploading: 'bg-blue-100 text-blue-600',
}

const SOURCE_TYPE_COLORS: Record<string, string> = {
  legge: 'bg-blue-100 text-blue-700',
  dpr: 'bg-blue-100 text-blue-700',
  dlgs: 'bg-blue-100 text-blue-700',
  dm: 'bg-blue-100 text-blue-700',
  circolare_ade: 'bg-amber-100 text-amber-700',
  risoluzione_ade: 'bg-amber-100 text-amber-700',
  interpello_ade: 'bg-amber-100 text-amber-700',
  principio_oic: 'bg-purple-100 text-purple-700',
  principio_isa: 'bg-purple-100 text-purple-700',
  sentenza: 'bg-rose-100 text-rose-700',
  prassi: 'bg-emerald-100 text-emerald-700',
  normativa_eu: 'bg-indigo-100 text-indigo-700',
}

// ════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════

interface KBDoc {
  id: string
  title: string | null
  source_type: string | null
  source_input_type: string | null
  source_url: string | null
  authority: string | null
  legal_reference: string | null
  category: string | null
  subcategory: string | null
  tax_area: string[]
  accounting_area: string[]
  topic_tags: string[]
  applies_to_legal_forms: string[] | null
  applies_to_regimes: string[] | null
  applies_to_ateco_prefixes: string[] | null
  applies_to_operations: string[] | null
  applies_to_counterparty: string[] | null
  applies_to_size: string[] | null
  amount_threshold_min: number | null
  amount_threshold_max: number | null
  publication_date: string | null
  effective_from: string | null
  effective_until: string | null
  superseded_by: string | null
  update_frequency: string
  status: string
  chunk_count: number
  full_text: string | null
  summary: string | null
  storage_path: string | null
  original_filename: string | null
  active: boolean
  created_at: string
  processing_error: string | null
}

interface KBChunk {
  id: string
  chunk_index: number
  content: string
  section_title: string | null
  page_number: number | null
}

interface KBRelation {
  id: string
  source_document_id: string
  target_document_id: string | null
  target_rule_id: string | null
  relation_type: string
  note: string | null
  created_at: string
  target_doc_title?: string
  target_rule_title?: string
}

// ════════════════════════════════════════════════
// Empty form template
// ════════════════════════════════════════════════

function emptyForm(): Partial<KBDoc> & { _inputType: 'pdf' | 'url' | 'text'; _rawText: string; _file: File | null } {
  return {
    title: '',
    source_type: null,
    source_input_type: null,
    source_url: null,
    authority: null,
    legal_reference: null,
    category: null,
    subcategory: null,
    tax_area: [],
    accounting_area: [],
    topic_tags: [],
    applies_to_legal_forms: null,
    applies_to_regimes: null,
    applies_to_ateco_prefixes: null,
    applies_to_operations: null,
    applies_to_counterparty: null,
    applies_to_size: null,
    amount_threshold_min: null,
    amount_threshold_max: null,
    publication_date: null,
    effective_from: '2000-01-01',
    effective_until: null,
    update_frequency: 'static',
    summary: null,
    active: true,
    _inputType: 'text',
    _rawText: '',
    _file: null,
  }
}

// ════════════════════════════════════════════════
// Collapsible Section
// ════════════════════════════════════════════════

function Section({ title, icon: Icon, children, defaultOpen = true }: {
  title: string; icon: typeof FileText; children: React.ReactNode; defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border rounded-lg">
      <button type="button" onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50 transition-colors">
        <Icon className="h-4 w-4 text-gray-400" />
        {title}
        <span className="ml-auto">{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</span>
      </button>
      {open && <div className="px-4 pb-4 space-y-3 border-t">{children}</div>}
    </div>
  )
}

// ════════════════════════════════════════════════
// Labelled select helper
// ════════════════════════════════════════════════
function LabelledSelect({ label, value, onChange, options, placeholder = '— Seleziona —', allowNull = true }: {
  label: string; value: string | null; onChange: (v: string | null) => void
  options: { value: string; label: string }[]; placeholder?: string; allowNull?: boolean
}) {
  return (
    <div>
      <Label className="text-xs">{label}</Label>
      <select
        value={value || ''}
        onChange={e => onChange(e.target.value || null)}
        className="mt-1 w-full h-9 border rounded-md px-2 text-sm bg-white"
      >
        {allowNull && <option value="">{placeholder}</option>}
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  )
}

// ════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════

type View = 'list' | 'detail' | 'form'

export default function KBDocumentsPage() {
  // ── State ──
  const [view, setView] = useState<View>('list')
  const [docs, setDocs] = useState<KBDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedDoc, setSelectedDoc] = useState<KBDoc | null>(null)
  const [form, setForm] = useState(emptyForm())
  const [saving, setSaving] = useState(false)
  const [editId, setEditId] = useState<string | null>(null) // null = new

  // Filters
  const [search, setSearch] = useState('')
  const [fCategory, setFCategory] = useState('')
  const [fSourceType, setFSourceType] = useState('')
  const [fAuthority, setFAuthority] = useState('')
  const [fStatus, setFStatus] = useState('')

  // Detail sub-data
  const [chunks, setChunks] = useState<KBChunk[]>([])
  const [relations, setRelations] = useState<KBRelation[]>([])
  const [generatedRules, setGeneratedRules] = useState<{ id: string; title: string; domain: string }[]>([])
  const [loadingDetail, setLoadingDetail] = useState(false)

  // AI Job hooks (global, persist across navigation)
  const { isRunning: processRunning, startOrStop: processStartOrStop } = useAIJob('kb-process', 'Processing documento KB')
  const { isRunning: classifyRunning, startOrStop: classifyStartOrStop } = useAIJob('kb-classify', 'Classificazione AI documento KB')
  const { isRunning: batchProcessRunning, progress: batchProcessProgress, startOrStop: batchProcessStartOrStop } = useAIJob('kb-process-batch', 'Processing batch KB')
  const { isRunning: batchClassifyRunning, progress: batchClassifyProgress, startOrStop: batchClassifyStartOrStop } = useAIJob('kb-classify-batch', 'Classificazione batch KB')

  // Upload state (not an AI job)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Suggested relations dialog (from AI classification)
  const [showSuggestedRels, setShowSuggestedRels] = useState(false)
  const [suggestedRels, setSuggestedRels] = useState<{
    target_id: string; target_type: 'document' | 'rule';
    relation_type: string; note: string; checked: boolean; target_title?: string
  }[]>([])

  // Relation dialog
  const [showRelationDialog, setShowRelationDialog] = useState(false)
  const [relForm, setRelForm] = useState({ relation_type: 'rinvia_a', target_type: 'doc' as 'doc' | 'rule', target_id: '', note: '' })
  const [relSearchResults, setRelSearchResults] = useState<{ id: string; title: string }[]>([])
  const [relSearch, setRelSearch] = useState('')

  // ── Load documents ──
  const loadDocs = useCallback(async () => {
    setLoading(true)
    let query = supabase
      .from('kb_documents')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(200)

    if (fCategory) query = query.eq('category', fCategory)
    if (fSourceType) query = query.eq('source_type', fSourceType)
    if (fAuthority) query = query.eq('authority', fAuthority)
    if (fStatus) query = query.eq('status', fStatus)
    if (search) query = query.or(`title.ilike.%${search}%,legal_reference.ilike.%${search}%`)

    const { data, error } = await query
    if (error) { toast.error('Errore caricamento: ' + error.message); setLoading(false); return }
    setDocs((data || []) as any)
    setLoading(false)
  }, [fCategory, fSourceType, fAuthority, fStatus, search])

  useEffect(() => { loadDocs() }, [loadDocs])

  // ── Load detail data ──
  const loadDetail = useCallback(async (doc: KBDoc) => {
    setLoadingDetail(true)
    setSelectedDoc(doc)
    setView('detail')

    // Load chunks
    const { data: ch } = await supabase
      .from('kb_chunks')
      .select('id, chunk_index, content, section_title, page_number')
      .eq('document_id', doc.id)
      .order('chunk_index')
    setChunks((ch || []) as any)

    // Load relations
    const { data: rels } = await supabase
      .from('kb_document_relations')
      .select('*')
      .eq('source_document_id', doc.id)
      .order('created_at')

    // Resolve target names
    const relsParsed: KBRelation[] = []
    for (const r of (rels || []) as any[]) {
      const rel: KBRelation = { ...r }
      if (r.target_document_id) {
        const { data: td } = await supabase
          .from('kb_documents').select('title').eq('id', r.target_document_id).single()
        rel.target_doc_title = td?.title || r.target_document_id
      }
      if (r.target_rule_id) {
        const { data: tr } = await supabase
          .from('knowledge_base').select('title').eq('id', r.target_rule_id).single()
        rel.target_rule_title = tr?.title || r.target_rule_id
      }
      relsParsed.push(rel)
    }
    setRelations(relsParsed)

    // Load generated rules
    const { data: rules } = await supabase
      .from('knowledge_base')
      .select('id, title, domain')
      .eq('source_document_id', doc.id)
      .order('created_at')
    setGeneratedRules((rules || []) as any)

    setLoadingDetail(false)
  }, [])

  // ── Open form (new or edit) ──
  const openForm = (doc?: KBDoc) => {
    if (doc) {
      setEditId(doc.id)
      setForm({
        ...doc,
        _inputType: (doc.source_input_type as any) || 'text',
        _rawText: doc.full_text || '',
        _file: null,
      })
    } else {
      setEditId(null)
      setForm(emptyForm())
    }
    setView('form')
  }

  // ── Save document ──
  /** Convert empty strings / undefined / empty arrays → null for Supabase CHECK constraints */
  function emptyToNull(val: any): any {
    if (val === '' || val === undefined) return null;
    if (Array.isArray(val) && val.length === 0) return null;
    return val;
  }

  const handleSave = async () => {
    if (!form.title?.trim()) { toast.error('Il titolo è obbligatorio'); return }

    setSaving(true)
    try {
      const payload: Record<string, any> = {
        title: form.title!.trim(),
        source_type: emptyToNull(form.source_type),
        source_input_type: form._inputType,
        source_url: emptyToNull(form.source_url),
        authority: emptyToNull(form.authority),
        legal_reference: emptyToNull(form.legal_reference),
        category: emptyToNull(form.category),
        subcategory: emptyToNull(form.subcategory),
        tax_area: emptyToNull(form.tax_area),
        accounting_area: emptyToNull(form.accounting_area),
        topic_tags: emptyToNull(form.topic_tags),
        applies_to_legal_forms: emptyToNull(form.applies_to_legal_forms),
        applies_to_regimes: emptyToNull(form.applies_to_regimes),
        applies_to_ateco_prefixes: emptyToNull(form.applies_to_ateco_prefixes),
        applies_to_operations: emptyToNull(form.applies_to_operations),
        applies_to_counterparty: emptyToNull(form.applies_to_counterparty),
        applies_to_size: emptyToNull(form.applies_to_size),
        amount_threshold_min: emptyToNull(form.amount_threshold_min),
        amount_threshold_max: emptyToNull(form.amount_threshold_max),
        publication_date: emptyToNull(form.publication_date),
        effective_from: emptyToNull(form.effective_from),
        effective_until: emptyToNull(form.effective_until),
        update_frequency: emptyToNull(form.update_frequency),
        summary: emptyToNull(form.summary),
        active: form.active ?? true,
      }

      // If text input, set full_text
      if (form._inputType === 'text' && form._rawText) {
        payload.full_text = form._rawText
      }

      // If URL input, set source_url
      if (form._inputType === 'url' && form.source_url) {
        payload.source_url = form.source_url
      }

      if (editId) {
        const { error } = await supabase
          .from('kb_documents')
          .update(payload as any)
          .eq('id', editId)
        if (error) throw error

        // Upload PDF if new file selected
        if (form._file && form._inputType === 'pdf') {
          await handlePdfUpload(form._file, editId)
        }

        toast.success('Documento aggiornato')
      } else {
        payload.status = 'pending'
        const { data: inserted, error } = await supabase
          .from('kb_documents')
          .insert(payload as any)
          .select('id')
          .single()
        if (error) throw error

        // Upload PDF if file selected
        if (form._file && form._inputType === 'pdf' && inserted?.id) {
          await handlePdfUpload(form._file, inserted.id)
        }

        toast.success('Documento creato')
      }

      await loadDocs()
      setView('list')
    } catch (e: any) {
      toast.error('Errore: ' + e.message)
    }
    setSaving(false)
  }

  // ── Delete ──
  const handleDelete = async (docId: string) => {
    if (!confirm('Eliminare questo documento e tutti i chunk/relazioni associati?')) return
    const { error } = await supabase.from('kb_documents').delete().eq('id', docId)
    if (error) { toast.error('Errore: ' + error.message); return }
    toast.success('Documento eliminato')
    if (view === 'detail') setView('list')
    loadDocs()
  }

  // ── Relation management ──
  const searchRelTargets = async (term: string) => {
    setRelSearch(term)
    if (term.length < 2) { setRelSearchResults([]); return }
    if (relForm.target_type === 'doc') {
      const { data } = await supabase
        .from('kb_documents')
        .select('id, title')
        .ilike('title', `%${term}%`)
        .neq('id', selectedDoc?.id || '')
        .limit(10)
      setRelSearchResults((data || []).map((d: any) => ({ id: d.id, title: d.title || '(senza titolo)' })))
    } else {
      const { data } = await supabase
        .from('knowledge_base')
        .select('id, title')
        .ilike('title', `%${term}%`)
        .limit(10)
      setRelSearchResults((data || []).map((d: any) => ({ id: d.id, title: d.title })))
    }
  }

  const saveRelation = async () => {
    if (!relForm.target_id) { toast.error('Seleziona un target'); return }
    const payload: Record<string, any> = {
      source_document_id: selectedDoc!.id,
      relation_type: relForm.relation_type,
      note: relForm.note || null,
    }
    if (relForm.target_type === 'doc') payload.target_document_id = relForm.target_id
    else payload.target_rule_id = relForm.target_id

    const { error } = await supabase.from('kb_document_relations').insert(payload as any)
    if (error) { toast.error('Errore: ' + error.message); return }
    toast.success('Relazione aggiunta')
    setShowRelationDialog(false)
    loadDetail(selectedDoc!)
  }

  const deleteRelation = async (relId: string) => {
    const { error } = await supabase.from('kb_document_relations').delete().eq('id', relId)
    if (error) { toast.error(error.message); return }
    setRelations(r => r.filter(x => x.id !== relId))
    toast.success('Relazione rimossa')
  }

  // ── Process document (text extraction + chunking + embedding) ──
  const handleProcess = (docId: string) => {
    processStartOrStop(async (signal, updateProgress) => {
      updateProgress(0, 1, { message: 'Estrazione testo, chunking, embedding...' })
      const result = await invokeCancellable('kb-process-document', { action: 'process', document_id: docId }, signal)
      const { data, error } = result
      if (error) throw new Error(error.message || 'Errore invocazione')
      if (data?.error) throw new Error(data.error)
      toast.success(`Documento processato: ${data.chunks} chunk creati`)
      updateProgress(1, 1, { message: `${data.chunks} chunk creati` })
      // Reload detail + list
      const { data: updatedDoc } = await supabase
        .from('kb_documents').select('*').eq('id', docId).single()
      if (updatedDoc) {
        setSelectedDoc(updatedDoc as any)
        loadDetail(updatedDoc as any)
      }
      loadDocs()
    }, 1)
  }

  // ── Classify document (AI metadata) ──
  const handleClassify = (docId: string) => {
    classifyStartOrStop(async (signal, updateProgress) => {
      updateProgress(0, 1, { message: 'Analisi con Gemini Pro in corso...' })
      const result = await invokeCancellable('kb-process-document', { action: 'classify', document_id: docId }, signal)
      const { data, error } = result
      if (error) throw new Error(error.message || 'Errore invocazione')
      if (data?.error) throw new Error(data.error)

      const updated = data.fields_updated?.length || 0
      toast.success(`Classificazione completata: ${updated} campi aggiornati`)
      updateProgress(1, 1, { message: `${updated} campi aggiornati` })

      // Reload document detail + list
      const { data: updatedDoc } = await supabase
        .from('kb_documents').select('*').eq('id', docId).single()
      if (updatedDoc) {
        setSelectedDoc(updatedDoc as any)
        loadDetail(updatedDoc as any)
      }
      loadDocs()

      // Show suggested relations dialog if any
      const rels = data.suggested_relations || []
      if (rels.length > 0) {
        const enriched = await Promise.all(rels.map(async (r: any) => {
          let title = '(sconosciuto)'
          if (r.target_type === 'document') {
            const { data: td } = await supabase
              .from('kb_documents').select('title').eq('id', r.target_id).single()
            title = td?.title || r.target_id
          } else if (r.target_type === 'rule') {
            const { data: tr } = await supabase
              .from('knowledge_base').select('title').eq('id', r.target_id).single()
            title = tr?.title || r.target_id
          }
          return { ...r, checked: true, target_title: title }
        }))
        setSuggestedRels(enriched)
        setShowSuggestedRels(true)
      }
    }, 1)
  }

  // ── Batch Process all pending documents ──
  const handleBatchProcess = () => {
    const pending = docs.filter(d => d.status === 'pending' || d.status === 'error')
    if (pending.length === 0) { toast.info('Nessun documento da processare'); return }
    batchProcessStartOrStop(async (signal, updateProgress, appendLog) => {
      updateProgress(0, pending.length)
      let ok = 0, fail = 0
      for (let i = 0; i < pending.length; i++) {
        if (signal.aborted) return
        const doc = pending[i]
        updateProgress(i, pending.length, { message: `${doc.title?.slice(0, 40)}...` })
        try {
          const result = await invokeCancellable('kb-process-document', { action: 'process', document_id: doc.id }, signal)
          const { data, error } = result
          if (error || data?.error) throw new Error(error?.message || data?.error)
          ok++
          appendLog?.(`✓ ${doc.title?.slice(0, 50)} — ${data.chunks} chunk`)
        } catch (e: any) {
          if (e.name === 'AbortError') return
          fail++
          appendLog?.(`✗ ${doc.title?.slice(0, 50)} — ${e.message}`)
        }
        updateProgress(i + 1, pending.length)
      }
      loadDocs()
      toast.success(`Batch completato: ${ok} processati, ${fail} errori`)
    }, pending.length)
  }

  // ── Batch Classify all ready documents without summary ──
  const handleBatchClassify = () => {
    const ready = docs.filter(d => d.status === 'ready' && !d.summary)
    if (ready.length === 0) { toast.info('Nessun documento da classificare'); return }
    batchClassifyStartOrStop(async (signal, updateProgress, appendLog) => {
      updateProgress(0, ready.length)
      let ok = 0, fail = 0
      for (let i = 0; i < ready.length; i++) {
        if (signal.aborted) return
        const doc = ready[i]
        updateProgress(i, ready.length, { message: `${doc.title?.slice(0, 40)}...` })
        try {
          const result = await invokeCancellable('kb-process-document', { action: 'classify', document_id: doc.id }, signal)
          const { data, error } = result
          if (error || data?.error) throw new Error(error?.message || data?.error)
          ok++
          const fields = data.fields_updated?.length || 0
          appendLog?.(`✓ ${doc.title?.slice(0, 50)} — ${fields} campi`)
          // Auto-approve suggested relations in batch
          const rels = data.suggested_relations || []
          if (rels.length > 0) {
            for (const r of rels) {
              const payload: Record<string, any> = {
                source_document_id: doc.id,
                relation_type: r.relation_type,
                note: r.note || null,
              }
              if (r.target_type === 'document') payload.target_document_id = r.target_id
              if (r.target_type === 'rule') payload.target_rule_id = r.target_id
              await supabase.from('kb_document_relations').insert(payload).catch(() => {})
            }
          }
        } catch (e: any) {
          if (e.name === 'AbortError') return
          fail++
          appendLog?.(`✗ ${doc.title?.slice(0, 50)} — ${e.message}`)
        }
        updateProgress(i + 1, ready.length)
      }
      loadDocs()
      toast.success(`Batch completato: ${ok} classificati, ${fail} errori`)
    }, ready.length)
  }

  // ── Approve suggested relations ──
  const approveSuggestedRels = async () => {
    const checked = suggestedRels.filter(r => r.checked)
    if (!selectedDoc || checked.length === 0) {
      setShowSuggestedRels(false)
      return
    }
    let inserted = 0
    for (const r of checked) {
      const payload: Record<string, any> = {
        source_document_id: selectedDoc.id,
        relation_type: r.relation_type,
        note: r.note || null,
      }
      if (r.target_type === 'document') payload.target_document_id = r.target_id
      else payload.target_rule_id = r.target_id

      const { error } = await supabase.from('kb_document_relations').insert(payload as any)
      if (!error) inserted++
    }
    toast.success(`${inserted} relazioni aggiunte`)
    setShowSuggestedRels(false)
    if (selectedDoc) loadDetail(selectedDoc)
  }

  // ── Upload PDF to storage ──
  const handlePdfUpload = async (file: File, docId: string) => {
    setUploading(true)
    try {
      const storagePath = `${docId}/${file.name}`
      const { error: uploadErr } = await supabase.storage
        .from('kb-documents')
        .upload(storagePath, file, { upsert: true })
      if (uploadErr) throw uploadErr

      // Update document record
      const { error: updateErr } = await supabase
        .from('kb_documents')
        .update({
          storage_path: storagePath,
          original_filename: file.name,
          source_input_type: 'pdf',
          status: 'pending',
        } as any)
        .eq('id', docId)
      if (updateErr) throw updateErr

      toast.success(`PDF "${file.name}" caricato`)

      // Reload
      const { data: updatedDoc } = await supabase
        .from('kb_documents').select('*').eq('id', docId).single()
      if (updatedDoc) {
        setSelectedDoc(updatedDoc as any)
        loadDetail(updatedDoc as any)
      }
    } catch (e: any) {
      toast.error('Errore upload: ' + e.message)
    }
    setUploading(false)
  }

  // ── Stats ──
  const stats = {
    total: docs.length,
    ready: docs.filter(d => d.status === 'ready').length,
    processing: docs.filter(d => d.status === 'processing' || d.status === 'chunking').length,
    error: docs.filter(d => d.status === 'error').length,
    superseded: docs.filter(d => d.status === 'superseded').length,
  }

  // ════════════════════════════════════════════════
  // RENDER: LIST VIEW
  // ════════════════════════════════════════════════
  if (view === 'list') return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-sky-600" />
            Documenti KB
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">Documenti normativi e fiscali della Knowledge Base</p>
        </div>
        <div className="flex gap-2">
          {/* Batch Process */}
          <Button variant={batchProcessRunning ? 'destructive' : 'outline'} size="sm"
            onClick={handleBatchProcess}>
            {batchProcessRunning
              ? <><Square className="h-3.5 w-3.5 mr-1" />Stop ({batchProcessProgress.current}/{batchProcessProgress.total})</>
              : <><Zap className="h-3.5 w-3.5 mr-1" />Processa pending ({stats.total - stats.ready - stats.superseded})</>
            }
          </Button>
          {/* Batch Classify */}
          <Button variant={batchClassifyRunning ? 'destructive' : 'outline'} size="sm"
            onClick={handleBatchClassify}>
            {batchClassifyRunning
              ? <><Square className="h-3.5 w-3.5 mr-1" />Stop ({batchClassifyProgress.current}/{batchClassifyProgress.total})</>
              : <><Brain className="h-3.5 w-3.5 mr-1" />Classifica ready</>
            }
          </Button>
          <Button onClick={() => openForm()}>
            <Plus className="h-4 w-4 mr-1.5" />Nuovo Documento
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'Totale', value: stats.total, color: 'text-gray-900' },
          { label: 'Pronti', value: stats.ready, color: 'text-green-600' },
          { label: 'In elaborazione', value: stats.processing, color: 'text-amber-600' },
          { label: 'Errori', value: stats.error, color: 'text-red-600' },
          { label: 'Superati', value: stats.superseded, color: 'text-gray-400' },
        ].map(s => (
          <div key={s.label} className="bg-white border rounded-lg px-3 py-2">
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">{s.label}</p>
            <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
            <Input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Cerca per titolo o riferimento..." className="pl-9" />
          </div>
        </div>
        <select value={fCategory} onChange={e => setFCategory(e.target.value)}
          className="h-9 border rounded-md px-2 text-xs bg-white">
          <option value="">Tutte le categorie</option>
          {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={fSourceType} onChange={e => setFSourceType(e.target.value)}
          className="h-9 border rounded-md px-2 text-xs bg-white">
          <option value="">Tutti i tipi</option>
          {SOURCE_TYPES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={fAuthority} onChange={e => setFAuthority(e.target.value)}
          className="h-9 border rounded-md px-2 text-xs bg-white">
          <option value="">Tutte le autorità</option>
          {AUTHORITIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)}
          className="h-9 border rounded-md px-2 text-xs bg-white">
          <option value="">Tutti gli stati</option>
          <option value="ready">Pronto</option>
          <option value="pending">In attesa</option>
          <option value="processing">Elaborazione</option>
          <option value="error">Errore</option>
          <option value="superseded">Superato</option>
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-sky-500" />
        </div>
      ) : docs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <BookOpen className="h-10 w-10 mx-auto mb-2 opacity-30" />
          <p>Nessun documento trovato</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b text-left">
                <th className="px-3 py-2 font-semibold text-gray-600">Titolo</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-24">Tipo</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-32">Categoria</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-24">Autorità</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-28">Riferimento</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-20">Stato</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-24">Vigenza</th>
                <th className="px-3 py-2 font-semibold text-gray-600 w-36">Tags</th>
                <th className="px-3 py-2 w-20"></th>
              </tr>
            </thead>
            <tbody>
              {docs.map(doc => {
                const catObj = CATEGORIES.find(c => c.value === doc.category)
                const srcObj = SOURCE_TYPES.find(s => s.value === doc.source_type)
                const authObj = AUTHORITIES.find(a => a.value === doc.authority)
                const vigente = !doc.effective_until
                const tags = doc.topic_tags || []
                return (
                  <tr key={doc.id} className="border-b hover:bg-sky-50/30 cursor-pointer transition-colors"
                    onClick={() => loadDetail(doc)}>
                    <td className="px-3 py-2">
                      <span className="font-medium text-gray-900 line-clamp-1">{doc.title || '(senza titolo)'}</span>
                    </td>
                    <td className="px-3 py-2">
                      {doc.source_type && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SOURCE_TYPE_COLORS[doc.source_type] || 'bg-gray-100 text-gray-600'}`}>
                          {srcObj?.label || doc.source_type}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {catObj && <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">{catObj.label}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">{authObj?.label || doc.authority}</td>
                    <td className="px-3 py-2 text-xs text-gray-600 font-mono">{doc.legal_reference}</td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[doc.status] || 'bg-gray-100'}`}>
                        {doc.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-500">
                      {vigente
                        ? <span className="text-green-600 font-medium">Vigente</span>
                        : doc.effective_until
                      }
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-0.5">
                        {tags.slice(0, 3).map(t => (
                          <span key={t} className="text-[9px] bg-gray-100 text-gray-600 px-1 py-0.5 rounded">{t}</span>
                        ))}
                        {tags.length > 3 && <span className="text-[9px] text-gray-400">+{tags.length - 3}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button onClick={() => openForm(doc)} className="p-1 text-gray-400 hover:text-gray-700 rounded">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleDelete(doc.id)} className="p-1 text-gray-400 hover:text-red-600 rounded">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )

  // ════════════════════════════════════════════════
  // RENDER: DETAIL VIEW
  // ════════════════════════════════════════════════
  if (view === 'detail' && selectedDoc) {
    const doc = selectedDoc
    const catObj = CATEGORIES.find(c => c.value === doc.category)
    const srcObj = SOURCE_TYPES.find(s => s.value === doc.source_type)
    const authObj = AUTHORITIES.find(a => a.value === doc.authority)

    return (
      <div className="p-6 space-y-5 max-w-4xl">
        {/* Back */}
        <button onClick={() => setView('list')} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <ArrowLeft className="h-4 w-4" /> Torna alla lista
        </button>

        {/* Title + Actions */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-lg font-bold text-gray-900">{doc.title || '(senza titolo)'}</h1>
            <div className="flex items-center gap-2 mt-1">
              {doc.source_type && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${SOURCE_TYPE_COLORS[doc.source_type] || 'bg-gray-100'}`}>
                  {srcObj?.label}
                </span>
              )}
              {doc.category && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">{catObj?.label}</span>
              )}
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${STATUS_COLORS[doc.status]}`}>{doc.status}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openForm(doc)}>
              <Pencil className="h-3.5 w-3.5 mr-1" />Modifica
            </Button>
            {(doc.status === 'pending' || doc.status === 'error') && (
              <Button size="sm" onClick={() => handleProcess(doc.id)}
                variant={processRunning ? 'destructive' : 'default'}>
                {processRunning
                  ? <><Square className="h-3.5 w-3.5 mr-1" />Stop</>
                  : <><Sparkles className="h-3.5 w-3.5 mr-1" />Processa</>
                }
              </Button>
            )}
            {doc.full_text && (
              <Button variant={classifyRunning ? 'destructive' : 'outline'} size="sm"
                onClick={() => handleClassify(doc.id)}>
                {classifyRunning
                  ? <><Square className="h-3.5 w-3.5 mr-1" />Stop</>
                  : <><Brain className="h-3.5 w-3.5 mr-1" />Compila metadata con AI</>
                }
              </Button>
            )}
            <Button variant="outline" size="sm"
              onClick={() => toast.info('Estrazione regole non ancora implementata. Sarà nella prossima fase.')}>
              <BookOpen className="h-3.5 w-3.5 mr-1" />Estrai regole
            </Button>
          </div>
        </div>

        {loadingDetail ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-sky-500" /></div>
        ) : (
          <>
            {/* Metadata grid */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 bg-white border rounded-lg p-4">
              <MetaField label="Autorità" value={authObj?.label || doc.authority} />
              <MetaField label="Riferimento" value={doc.legal_reference} mono />
              <MetaField label="Data pubblicazione" value={doc.publication_date} />
              <MetaField label="In vigore da" value={doc.effective_from} />
              <MetaField label="In vigore fino a" value={doc.effective_until || 'Vigente'} />
              <MetaField label="Frequenza aggiornamento" value={UPDATE_FREQUENCIES.find(f => f.value === doc.update_frequency)?.label} />
              <MetaField label="Sottocategoria" value={doc.subcategory} />
              <MetaField label="Chunk" value={String(doc.chunk_count)} />
              {doc.source_url && (
                <div className="col-span-2">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">URL Fonte</p>
                  <a href={doc.source_url} target="_blank" rel="noopener" className="text-sm text-sky-600 hover:underline flex items-center gap-1">
                    {doc.source_url.slice(0, 60)}... <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              )}
            </div>

            {/* Tax / Accounting / Topic tags */}
            {((doc.tax_area?.length || 0) > 0 || (doc.accounting_area?.length || 0) > 0 || (doc.topic_tags?.length || 0) > 0) && (
              <div className="bg-white border rounded-lg p-4 space-y-2">
                {(doc.tax_area?.length || 0) > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Area Fiscale</p>
                    <div className="flex flex-wrap gap-1">
                      {doc.tax_area!.map(t => <span key={t} className="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded font-medium">{TAX_AREAS.find(a => a.value === t)?.label || t}</span>)}
                    </div>
                  </div>
                )}
                {(doc.accounting_area?.length || 0) > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Area Contabile</p>
                    <div className="flex flex-wrap gap-1">
                      {doc.accounting_area!.map(t => <span key={t} className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded font-medium">{ACCOUNTING_AREAS.find(a => a.value === t)?.label || t}</span>)}
                    </div>
                  </div>
                )}
                {(doc.topic_tags?.length || 0) > 0 && (
                  <div>
                    <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Topic Tags</p>
                    <div className="flex flex-wrap gap-1">
                      {doc.topic_tags!.map(t => <span key={t} className="text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">{t}</span>)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Summary */}
            {doc.summary && (
              <div className="bg-white border rounded-lg p-4">
                <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-1">Riassunto</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{doc.summary}</p>
              </div>
            )}

            {/* Processing error */}
            {doc.processing_error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <strong>Errore:</strong> {doc.processing_error}
              </div>
            )}

            {/* PDF upload for pending PDF docs without file yet */}
            {doc.source_input_type === 'pdf' && !doc.storage_path && (doc.status === 'pending' || doc.status === 'error') && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <p className="text-sm text-amber-700 font-medium mb-2">PDF non ancora caricato</p>
                <div
                  className="border-2 border-dashed border-amber-300 rounded-lg p-4 text-center text-amber-500 text-sm cursor-pointer hover:border-amber-400 hover:bg-amber-100/30 transition-colors"
                  onDragOver={e => { e.preventDefault() }}
                  onDrop={e => {
                    e.preventDefault()
                    const file = e.dataTransfer.files?.[0]
                    if (file && file.type === 'application/pdf') handlePdfUpload(file, doc.id)
                    else toast.error('Solo file PDF supportati')
                  }}
                  onClick={() => {
                    const input = document.createElement('input')
                    input.type = 'file'; input.accept = 'application/pdf'
                    input.onchange = () => { if (input.files?.[0]) handlePdfUpload(input.files[0], doc.id) }
                    input.click()
                  }}
                >
                  {uploading
                    ? <><Loader2 className="h-6 w-6 mx-auto mb-1 animate-spin" />Caricamento in corso...</>
                    : <><Upload className="h-6 w-6 mx-auto mb-1 opacity-50" />Trascina il PDF qui o clicca per caricare</>
                  }
                </div>
              </div>
            )}

            {/* Chunks */}
            {chunks.length > 0 && (
              <div className="bg-white border rounded-lg p-4 space-y-2">
                <p className="text-sm font-semibold text-gray-700">Chunk ({chunks.length})</p>
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {chunks.map(c => (
                    <div key={c.id} className="bg-gray-50 rounded-lg p-3 text-xs">
                      <div className="flex items-center gap-2 mb-1 text-gray-500">
                        <span className="font-mono">#{c.chunk_index}</span>
                        {c.section_title && <span className="font-medium text-gray-700">{c.section_title}</span>}
                        {c.page_number && <span>p.{c.page_number}</span>}
                      </div>
                      <p className="text-gray-600 whitespace-pre-wrap line-clamp-4">{c.content}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Relations */}
            <div className="bg-white border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                  <Link2 className="h-4 w-4 text-gray-400" /> Relazioni ({relations.length})
                </p>
                <Button variant="outline" size="sm" onClick={() => {
                  setRelForm({ relation_type: 'rinvia_a', target_type: 'doc', target_id: '', note: '' })
                  setRelSearch('')
                  setRelSearchResults([])
                  setShowRelationDialog(true)
                }}>
                  <Plus className="h-3.5 w-3.5 mr-1" />Aggiungi
                </Button>
              </div>
              {relations.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">Nessuna relazione</p>
              ) : (
                <div className="space-y-1.5">
                  {relations.map(r => (
                    <div key={r.id} className="flex items-center gap-2 bg-gray-50 rounded-lg px-3 py-2 group">
                      <span className="text-[10px] font-medium bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">
                        {RELATION_TYPES.find(t => t.value === r.relation_type)?.label || r.relation_type}
                      </span>
                      <span className="flex-1 text-sm text-gray-700">
                        {r.target_doc_title || r.target_rule_title || '(target)'}
                      </span>
                      {r.note && <span className="text-[10px] text-gray-400 italic">{r.note}</span>}
                      <button onClick={() => deleteRelation(r.id)}
                        className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Generated rules */}
            <div className="bg-white border rounded-lg p-4 space-y-3">
              <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-amber-500" /> Regole generate ({generatedRules.length})
              </p>
              {generatedRules.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-4">Nessuna regola generata da questo documento</p>
              ) : (
                <div className="space-y-1">
                  {generatedRules.map(r => (
                    <div key={r.id} className="flex items-center gap-2 bg-amber-50 rounded-lg px-3 py-2">
                      <span className="text-[10px] font-medium bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded">{r.domain}</span>
                      <span className="text-sm text-gray-700">{r.title}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Relation Dialog ── */}
        {showRelationDialog && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full mx-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">Aggiungi relazione</h3>
                <button onClick={() => setShowRelationDialog(false)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
              </div>

              <LabelledSelect label="Tipo relazione" value={relForm.relation_type}
                onChange={v => setRelForm(f => ({ ...f, relation_type: v || 'rinvia_a' }))}
                options={RELATION_TYPES} allowNull={false} />

              <div>
                <Label className="text-xs">Target</Label>
                <div className="flex gap-2 mt-1 mb-2">
                  <button type="button"
                    onClick={() => { setRelForm(f => ({ ...f, target_type: 'doc', target_id: '' })); setRelSearch(''); setRelSearchResults([]) }}
                    className={`px-2 py-1 text-xs rounded border ${relForm.target_type === 'doc' ? 'bg-sky-100 border-sky-300 text-sky-700' : 'border-gray-200 text-gray-500'}`}
                  >Documento</button>
                  <button type="button"
                    onClick={() => { setRelForm(f => ({ ...f, target_type: 'rule', target_id: '' })); setRelSearch(''); setRelSearchResults([]) }}
                    className={`px-2 py-1 text-xs rounded border ${relForm.target_type === 'rule' ? 'bg-sky-100 border-sky-300 text-sky-700' : 'border-gray-200 text-gray-500'}`}
                  >Regola KB</button>
                </div>
                <Input value={relSearch} onChange={e => searchRelTargets(e.target.value)}
                  placeholder={`Cerca ${relForm.target_type === 'doc' ? 'documento' : 'regola'}...`} />
                {relSearchResults.length > 0 && (
                  <div className="mt-1 border rounded-md max-h-40 overflow-y-auto">
                    {relSearchResults.map(r => (
                      <button key={r.id} type="button"
                        onClick={() => { setRelForm(f => ({ ...f, target_id: r.id })); setRelSearch(r.title); setRelSearchResults([]) }}
                        className={`w-full text-left px-3 py-1.5 text-sm hover:bg-sky-50 ${relForm.target_id === r.id ? 'bg-sky-50 text-sky-700' : 'text-gray-700'}`}>
                        {r.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <Label className="text-xs">Note (opzionale)</Label>
                <Input value={relForm.note} onChange={e => setRelForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="Nota sulla relazione..." className="mt-1" />
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" onClick={() => setShowRelationDialog(false)}>Annulla</Button>
                <Button onClick={saveRelation} disabled={!relForm.target_id}>Salva</Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Suggested Relations Dialog (from AI classification) ── */}
        {showSuggestedRels && suggestedRels.length > 0 && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
            <div className="bg-white rounded-xl shadow-xl p-6 max-w-lg w-full mx-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 flex items-center gap-2">
                  <Brain className="h-4 w-4 text-purple-600" />
                  Relazioni suggerite dall'AI ({suggestedRels.length})
                </h3>
                <button onClick={() => setShowSuggestedRels(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <p className="text-xs text-gray-500">
                L'AI ha suggerito le seguenti relazioni. Seleziona quelle che vuoi approvare.
              </p>

              <div className="max-h-64 overflow-y-auto space-y-2">
                {suggestedRels.map((r, i) => (
                  <label key={i} className="flex items-start gap-2 bg-gray-50 rounded-lg px-3 py-2 cursor-pointer hover:bg-gray-100 transition-colors">
                    <input type="checkbox" checked={r.checked}
                      onChange={() => setSuggestedRels(prev =>
                        prev.map((x, j) => j === i ? { ...x, checked: !x.checked } : x)
                      )}
                      className="mt-1 rounded border-gray-300" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-medium bg-sky-100 text-sky-700 px-1.5 py-0.5 rounded">
                          {RELATION_TYPES.find(t => t.value === r.relation_type)?.label || r.relation_type}
                        </span>
                        <span className="text-[10px] font-medium bg-gray-200 text-gray-600 px-1 py-0.5 rounded">
                          {r.target_type === 'document' ? 'Doc' : 'Regola'}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 mt-0.5 line-clamp-1">{r.target_title || r.target_id}</p>
                      {r.note && <p className="text-[11px] text-gray-400 italic mt-0.5">{r.note}</p>}
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex gap-2 justify-end">
                <Button variant="outline" size="sm" onClick={() => setShowSuggestedRels(false)}>Ignora tutto</Button>
                <Button size="sm" onClick={approveSuggestedRels}
                  disabled={!suggestedRels.some(r => r.checked)}>
                  <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                  Approva selezionate ({suggestedRels.filter(r => r.checked).length})
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ════════════════════════════════════════════════
  // RENDER: FORM VIEW (new / edit)
  // ════════════════════════════════════════════════
  return (
    <div className="p-6 space-y-5 max-w-3xl">
      <button onClick={() => setView(editId ? 'detail' : 'list')}
        className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> {editId ? 'Torna al dettaglio' : 'Torna alla lista'}
      </button>

      <h1 className="text-lg font-bold">{editId ? 'Modifica Documento' : 'Nuovo Documento'}</h1>

      <div className="space-y-4">
        {/* ── CONTENUTO ── */}
        <Section title="Contenuto" icon={FileText}>
          <div>
            <Label className="text-xs">Titolo *</Label>
            <Input value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
              placeholder='Es. "Art. 164 TUIR — Limiti deducibilità veicoli"' className="mt-1" />
          </div>

          <div>
            <Label className="text-xs">Tipo input</Label>
            <div className="flex gap-2 mt-1">
              {([['pdf', 'PDF Upload', FileText], ['url', 'URL', Globe], ['text', 'Testo', Type]] as const).map(([val, lbl, Icon]) => (
                <button key={val} type="button"
                  onClick={() => setForm(f => ({ ...f, _inputType: val as any }))}
                  className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border transition-all ${
                    form._inputType === val ? 'bg-sky-100 border-sky-300 text-sky-700' : 'border-gray-200 text-gray-500 hover:border-gray-300'
                  }`}>
                  <Icon className="h-3.5 w-3.5" />{lbl}
                </button>
              ))}
            </div>
          </div>

          {form._inputType === 'url' && (
            <div>
              <Label className="text-xs">URL fonte</Label>
              <Input value={form.source_url || ''} onChange={e => setForm(f => ({ ...f, source_url: e.target.value }))}
                placeholder="https://www.normattiva.it/..." className="mt-1" />
            </div>
          )}

          {form._inputType === 'text' && (
            <div>
              <Label className="text-xs">Testo completo</Label>
              <textarea value={form._rawText} onChange={e => setForm(f => ({ ...f, _rawText: e.target.value }))}
                placeholder="Incolla il testo del documento..."
                className="mt-1 w-full border rounded-md px-3 py-2 text-sm min-h-[160px] resize-y" />
            </div>
          )}

          {form._inputType === 'pdf' && (
            <div>
              {form.storage_path || form.original_filename ? (
                <div className="border rounded-lg p-4 bg-green-50 text-sm flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span className="text-green-700 font-medium">PDF caricato: {form.original_filename || form.storage_path}</span>
                  <button type="button" onClick={() => setForm(f => ({ ...f, storage_path: null, original_filename: null, _file: null }))}
                    className="ml-auto text-gray-400 hover:text-red-500"><X className="h-4 w-4" /></button>
                </div>
              ) : (
                <div
                  className="border-2 border-dashed rounded-lg p-6 text-center text-gray-400 text-sm cursor-pointer hover:border-sky-400 hover:bg-sky-50/30 transition-colors"
                  onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('border-sky-400', 'bg-sky-50/30') }}
                  onDragLeave={e => { e.currentTarget.classList.remove('border-sky-400', 'bg-sky-50/30') }}
                  onDrop={e => {
                    e.preventDefault(); e.currentTarget.classList.remove('border-sky-400', 'bg-sky-50/30')
                    const file = e.dataTransfer.files?.[0]
                    if (file && file.type === 'application/pdf') {
                      setForm(f => ({ ...f, _file: file, original_filename: file.name }))
                    } else {
                      toast.error('Solo file PDF sono supportati')
                    }
                  }}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="h-8 w-8 mx-auto mb-2 opacity-30" />
                  {form._file
                    ? <p className="text-gray-700 font-medium">{form._file.name} <span className="text-gray-400">({(form._file.size / 1024 / 1024).toFixed(1)} MB)</span></p>
                    : <p>Trascina un PDF qui oppure clicca per selezionare</p>
                  }
                  <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) setForm(f => ({ ...f, _file: file, original_filename: file.name }))
                    }} />
                </div>
              )}
            </div>
          )}

          <div>
            <Label className="text-xs">Riassunto (opzionale)</Label>
            <textarea value={form.summary || ''} onChange={e => setForm(f => ({ ...f, summary: e.target.value }))}
              placeholder="Breve riassunto AI-friendly..."
              className="mt-1 w-full border rounded-md px-3 py-2 text-sm min-h-[60px] resize-y" />
          </div>
        </Section>

        {/* ── CLASSIFICAZIONE FONTE ── */}
        <Section title="Classificazione Fonte" icon={Shield}>
          <div className="grid grid-cols-2 gap-3">
            <LabelledSelect label="Tipo fonte" value={form.source_type || null}
              onChange={v => setForm(f => ({ ...f, source_type: v }))} options={SOURCE_TYPES} />
            <LabelledSelect label="Autorità" value={form.authority || null}
              onChange={v => setForm(f => ({ ...f, authority: v }))} options={AUTHORITIES} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Riferimento normativo</Label>
              <Input value={form.legal_reference || ''} onChange={e => setForm(f => ({ ...f, legal_reference: e.target.value }))}
                placeholder="Es. D.Lgs. 917/1986 art. 164" className="mt-1 font-mono text-sm" />
            </div>
            <div>
              <Label className="text-xs">Data pubblicazione</Label>
              <Input type="date" value={form.publication_date || ''} onChange={e => setForm(f => ({ ...f, publication_date: e.target.value || null }))}
                className="mt-1" />
            </div>
          </div>
        </Section>

        {/* ── TASSONOMIA ── */}
        <Section title="Tassonomia" icon={BookOpen}>
          <div className="grid grid-cols-2 gap-3">
            <LabelledSelect label="Categoria *" value={form.category || null}
              onChange={v => setForm(f => ({ ...f, category: v }))} options={CATEGORIES} />
            <div>
              <Label className="text-xs">Sottocategoria</Label>
              <Input value={form.subcategory || ''} onChange={e => setForm(f => ({ ...f, subcategory: e.target.value }))}
                placeholder="Es. ammortamento, reverse_charge" className="mt-1" />
            </div>
          </div>
          <MultiSelectChips label="Area Fiscale" options={TAX_AREAS}
            value={form.tax_area || []} onChange={v => setForm(f => ({ ...f, tax_area: v }))} />
          <MultiSelectChips label="Area Contabile" options={ACCOUNTING_AREAS}
            value={form.accounting_area || []} onChange={v => setForm(f => ({ ...f, accounting_area: v }))} />
          <div>
            <Label className="text-xs">Topic Tags</Label>
            <TagInput value={form.topic_tags || []} onChange={v => setForm(f => ({ ...f, topic_tags: v }))}
              placeholder="Aggiungi tag (es. veicoli, leasing, carburanti)..." />
          </div>
        </Section>

        {/* ── APPLICABILITÀ ── */}
        <Section title="Applicabilità" icon={Building2} defaultOpen={false}>
          <NullableMultiSelect label="Forme giuridiche" options={LEGAL_FORMS}
            value={form.applies_to_legal_forms ?? null} onChange={v => setForm(f => ({ ...f, applies_to_legal_forms: v }))} />
          <NullableMultiSelect label="Regimi contabili" options={REGIMES}
            value={form.applies_to_regimes ?? null} onChange={v => setForm(f => ({ ...f, applies_to_regimes: v }))} />
          <div>
            <Label className="text-xs">Prefissi ATECO (null = tutti)</Label>
            <TagInput value={form.applies_to_ateco_prefixes || []} onChange={v => setForm(f => ({ ...f, applies_to_ateco_prefixes: v.length ? v : null }))}
              placeholder='Es. 08, 41, F...' />
          </div>
          <NullableMultiSelect label="Operazioni" options={OPERATIONS}
            value={form.applies_to_operations ?? null} onChange={v => setForm(f => ({ ...f, applies_to_operations: v }))} />
          <NullableMultiSelect label="Tipo controparte" options={COUNTERPARTY_TYPES}
            value={form.applies_to_counterparty ?? null} onChange={v => setForm(f => ({ ...f, applies_to_counterparty: v }))} />
          <NullableMultiSelect label="Classe dimensionale" options={SIZE_CLASSES}
            value={form.applies_to_size ?? null} onChange={v => setForm(f => ({ ...f, applies_to_size: v }))} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Soglia importo min (€)</Label>
              <Input type="number" step="0.01" value={form.amount_threshold_min ?? ''}
                onChange={e => setForm(f => ({ ...f, amount_threshold_min: e.target.value ? Number(e.target.value) : null }))}
                placeholder="Es. 516.46" className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Soglia importo max (€)</Label>
              <Input type="number" step="0.01" value={form.amount_threshold_max ?? ''}
                onChange={e => setForm(f => ({ ...f, amount_threshold_max: e.target.value ? Number(e.target.value) : null }))}
                placeholder="Es. 18075.99" className="mt-1" />
            </div>
          </div>
        </Section>

        {/* ── TEMPORALITÀ ── */}
        <Section title="Temporalità" icon={Calendar} defaultOpen={false}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">In vigore da</Label>
              <Input type="date" value={form.effective_from || ''} onChange={e => setForm(f => ({ ...f, effective_from: e.target.value || null }))}
                className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">In vigore fino a (vuoto = vigente)</Label>
              <Input type="date" value={form.effective_until || ''} onChange={e => setForm(f => ({ ...f, effective_until: e.target.value || null }))}
                className="mt-1" />
            </div>
          </div>
          <LabelledSelect label="Frequenza aggiornamento" value={form.update_frequency || 'static'}
            onChange={v => setForm(f => ({ ...f, update_frequency: v || 'static' }))} options={UPDATE_FREQUENCIES} allowNull={false} />
          <div className="flex items-center gap-3">
            <Label className="text-xs">Attivo</Label>
            <button type="button" onClick={() => setForm(f => ({ ...f, active: !f.active }))}
              className={`w-10 h-5 rounded-full transition-all ${form.active ? 'bg-green-500' : 'bg-gray-300'}`}>
              <div className={`h-4 w-4 bg-white rounded-full shadow transition-transform ${form.active ? 'translate-x-5' : 'translate-x-0.5'}`} />
            </button>
          </div>
        </Section>
      </div>

      {/* Save / Cancel */}
      <div className="flex gap-3 justify-end border-t pt-4">
        <Button variant="outline" onClick={() => setView(editId ? 'detail' : 'list')} disabled={saving}>Annulla</Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Salvataggio...</> : editId ? 'Aggiorna' : 'Crea documento'}
        </Button>
      </div>
    </div>
  )
}

// Helper: metadata field display
function MetaField({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</p>
      <p className={`text-sm text-gray-800 ${mono ? 'font-mono' : ''}`}>{value || '—'}</p>
    </div>
  )
}
