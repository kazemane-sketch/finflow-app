import { useState, useEffect, useCallback, useRef } from 'react'
import { useCompany } from '@/hooks/useCompany'
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'
import {
  Send, Plus, MessageSquare, Search, Sparkles,
  BarChart3, FileText, Landmark, Link2, ChevronDown, ChevronRight,
  Loader2, MoreHorizontal, Trash2, Pencil, Check, X,
  Upload, BookOpen, AlertCircle,
} from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/* ─── types ───────────────────────────────── */

interface Chat {
  id: string
  title: string
  updated_at: string
  message_count: number
}

interface Message {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_name?: string
  created_at: string
}

interface ToolCallDisplay {
  name: string
  args: Record<string, unknown>
  result_count: number
}

interface KbDocument {
  id: string
  file_name: string
  file_type: string
  file_size: number
  status: 'uploading' | 'processing' | 'ready' | 'error'
  chunk_count: number
  error_message?: string
  created_at: string
}

/* ─── tool label map ──────────────────────── */

const TOOL_LABELS: Record<string, string> = {
  get_invoices: 'Cercando fatture',
  get_invoice_detail: 'Dettaglio fattura',
  get_bank_transactions: 'Cercando movimenti',
  get_transaction_detail: 'Dettaglio movimento',
  get_open_installments: 'Rate aperte',
  search_raw_text: 'Ricerca testo bancario',
  get_counterparties: 'Cercando controparti',
  get_company_stats: 'Statistiche azienda',
  suggest_reconciliation: 'Suggerimento riconciliazione',
  search_knowledge_base: 'Ricerca knowledge base',
}

/* ─── relative time helper ────────────────── */

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'ora'
  if (mins < 60) return `${mins} min fa`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} ore fa`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}g fa`
  return new Date(dateStr).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
}

/* ─── suggestion cards ────────────────────── */

const SUGGESTIONS = [
  { icon: BarChart3, text: 'Riepilogo finanziario dell\'azienda', color: 'text-blue-600 bg-blue-50' },
  { icon: FileText, text: 'Fatture scadute da pagare', color: 'text-red-600 bg-red-50' },
  { icon: Landmark, text: 'Movimenti bancari da riconciliare', color: 'text-amber-600 bg-amber-50' },
  { icon: Link2, text: 'Cerca un pagamento specifico', color: 'text-emerald-600 bg-emerald-50' },
]

/* ─── main component ──────────────────────── */

export default function AiChatPage() {
  const { company } = useCompany()
  const companyId = company?.id

  // Chat list
  const [chats, setChats] = useState<Chat[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)

  // Messages
  const [messages, setMessages] = useState<Message[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallDisplay[]>([])

  // Input
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  // Chat management: rename + delete
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Knowledge base
  const [kbDocs, setKbDocs] = useState<KbDocument[]>([])
  const [kbExpanded, setKbExpanded] = useState(false)
  const [kbUploading, setKbUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Refs
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // ─── load chats ─────────────────────────
  const loadChats = useCallback(async () => {
    if (!companyId) return
    const { data } = await supabase
      .from('ai_chats')
      .select('id, title, updated_at, message_count')
      .eq('company_id', companyId)
      .order('updated_at', { ascending: false })
      .limit(50)
    if (data) setChats(data)
  }, [companyId])

  useEffect(() => { loadChats() }, [loadChats])

  // ─── load kb documents ───────────────────
  const loadKbDocs = useCallback(async () => {
    if (!companyId) return
    const { data } = await supabase
      .from('kb_documents')
      .select('id, file_name, file_type, file_size, status, chunk_count, error_message, created_at')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (data) setKbDocs(data as KbDocument[])
  }, [companyId])

  useEffect(() => { loadKbDocs() }, [loadKbDocs])

  // ─── poll processing documents ──────────
  useEffect(() => {
    const hasProcessing = kbDocs.some(d => d.status === 'uploading' || d.status === 'processing')
    if (!hasProcessing) return
    const interval = setInterval(loadKbDocs, 4000)
    return () => clearInterval(interval)
  }, [kbDocs, loadKbDocs])

  // ─── load messages for selected chat ────
  const loadMessages = useCallback(async (chatId: string) => {
    const { data } = await supabase
      .from('ai_messages')
      .select('id, role, content, tool_name, created_at')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
      .limit(100)
    if (data) setMessages(data.filter(m => m.role === 'user' || m.role === 'assistant') as Message[])
  }, [])

  useEffect(() => {
    if (selectedChatId) loadMessages(selectedChatId)
    else setMessages([])
  }, [selectedChatId, loadMessages])

  // ─── scroll to bottom ──────────────────
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // ─── auto-resize textarea ──────────────
  const handleInputChange = (val: string) => {
    setInput(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 160) + 'px'
    }
  }

  // ─── new chat ──────────────────────────
  const startNewChat = () => {
    setSelectedChatId(null)
    setMessages([])
    setToolCalls([])
    setInput('')
  }

  // ─── rename chat ──────────────────────
  const startRename = (chat: Chat) => {
    setRenamingId(chat.id)
    setRenameValue(chat.title)
    // Focus input after React renders it
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const confirmRename = async () => {
    if (!renamingId || !renameValue.trim()) { setRenamingId(null); return }
    const { error } = await supabase
      .from('ai_chats')
      .update({ title: renameValue.trim() })
      .eq('id', renamingId)
    if (!error) {
      setChats(prev => prev.map(c => c.id === renamingId ? { ...c, title: renameValue.trim() } : c))
    }
    setRenamingId(null)
  }

  const cancelRename = () => setRenamingId(null)

  // ─── delete chat ──────────────────────
  const confirmDelete = async () => {
    if (!deletingId) return
    setDeleteLoading(true)
    const { error } = await supabase
      .from('ai_chats')
      .delete()
      .eq('id', deletingId)
    if (!error) {
      setChats(prev => prev.filter(c => c.id !== deletingId))
      if (selectedChatId === deletingId) {
        setSelectedChatId(null)
        setMessages([])
        setToolCalls([])
      }
    }
    setDeleteLoading(false)
    setDeletingId(null)
  }

  // ─── upload kb file ──────────────────────
  const uploadKbFile = async (file: File) => {
    if (!companyId) return
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    const allowedTypes = ['pdf', 'txt', 'csv']
    if (!allowedTypes.includes(ext)) {
      alert('Formato non supportato. Usa PDF, TXT o CSV.')
      return
    }
    if (file.size > 20 * 1024 * 1024) {
      alert('File troppo grande (max 20 MB).')
      return
    }

    setKbUploading(true)
    try {
      const token = await getValidAccessToken()

      // 1. Create db record
      const { data: doc, error: dbErr } = await supabase
        .from('kb_documents')
        .insert({
          company_id: companyId,
          user_id: (await supabase.auth.getUser()).data.user?.id,
          file_name: file.name,
          file_type: ext,
          file_size: file.size,
          status: 'uploading',
        })
        .select('id')
        .single()
      if (dbErr || !doc) throw new Error(dbErr?.message || 'Errore creazione record')

      // 2. Upload file to storage
      const storagePath = `${companyId}/${doc.id}/${file.name}`
      const { error: uploadErr } = await supabase.storage
        .from('kb-documents')
        .upload(storagePath, file)
      if (uploadErr) throw new Error(uploadErr.message)

      // 3. Update record with storage path + status → processing
      await supabase
        .from('kb_documents')
        .update({ storage_path: storagePath, status: 'processing' })
        .eq('id', doc.id)

      // 4. Trigger processing edge function
      fetch(`${SUPABASE_URL}/functions/v1/kb-process-document`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ document_id: doc.id, company_id: companyId }),
      }).catch(() => {}) // fire-and-forget

      void loadKbDocs()
    } catch (err: unknown) {
      alert('Errore upload: ' + (err instanceof Error ? err.message : String(err)))
    }
    setKbUploading(false)
  }

  const deleteKbDoc = async (docId: string) => {
    const doc = kbDocs.find(d => d.id === docId)
    if (!doc) return
    // Delete storage file
    if (doc.file_name && companyId) {
      await supabase.storage.from('kb-documents').remove([`${companyId}/${docId}/${doc.file_name}`])
    }
    // Delete db record (cascades to chunks)
    await supabase.from('kb_documents').delete().eq('id', docId)
    setKbDocs(prev => prev.filter(d => d.id !== docId))
  }

  // ─── send message ──────────────────────
  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim()
    if (!msg || loading || !companyId) return

    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'

    // Optimistic UI
    const tempUserMsg: Message = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: msg,
      created_at: new Date().toISOString(),
    }
    setMessages(prev => [...prev, tempUserMsg])
    setToolCalls([])
    setLoading(true)

    try {
      const token = await getValidAccessToken()

      const res = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({
          mode: 'chat',
          company_id: companyId,
          chat_id: selectedChatId,
          message: msg,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

      // Update chat ID if new
      if (!selectedChatId && data.chat_id) {
        setSelectedChatId(data.chat_id)
      }

      // Add assistant message
      const assistantMsg: Message = {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: data.message?.content || 'Nessuna risposta.',
        created_at: new Date().toISOString(),
      }
      setMessages(prev => [...prev, assistantMsg])

      // Tool calls display
      if (data.tool_calls?.length) {
        setToolCalls(data.tool_calls)
      }

      // Refresh chat list
      void loadChats()
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errorMsg: Message = {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Errore: ${errMsg}`,
        created_at: new Date().toISOString(),
      }
      setMessages(prev => [...prev, errorMsg])
    }
    setLoading(false)
  }

  // ─── render ────────────────────────────
  return (
    <div className="flex h-full">
      {/* ──── Chat sidebar ──── */}
      <div className="w-72 border-r bg-slate-50/50 flex flex-col shrink-0 hidden md:flex">
        <div className="p-3">
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-purple-700 bg-purple-50 border border-purple-200 rounded-lg hover:bg-purple-100 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Nuova chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`group relative flex items-center rounded-md text-sm transition-colors ${
                selectedChatId === chat.id
                  ? 'bg-purple-100 text-purple-900'
                  : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {/* Main clickable area */}
              <button
                onClick={() => { setSelectedChatId(chat.id); setToolCalls([]); setRenamingId(null) }}
                className="flex-1 text-left px-3 py-2 min-w-0"
              >
                <div className="flex items-center gap-2">
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
                  {renamingId === chat.id ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0" onClick={e => e.stopPropagation()}>
                      <input
                        ref={renameInputRef}
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') confirmRename()
                          if (e.key === 'Escape') cancelRename()
                        }}
                        className="flex-1 min-w-0 bg-white border border-purple-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-purple-400"
                        autoFocus
                      />
                      <button onClick={confirmRename} className="p-0.5 text-green-600 hover:text-green-800">
                        <Check className="h-3 w-3" />
                      </button>
                      <button onClick={cancelRename} className="p-0.5 text-slate-400 hover:text-slate-600">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ) : (
                    <span className="truncate font-medium">{chat.title}</span>
                  )}
                </div>
                {renamingId !== chat.id && (
                  <div className="text-[10px] text-slate-400 mt-0.5 pl-5.5">
                    {timeAgo(chat.updated_at)}
                  </div>
                )}
              </button>

              {/* Three-dot dropdown menu */}
              {renamingId !== chat.id && (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      className="opacity-0 group-hover:opacity-100 p-1.5 mr-1 rounded hover:bg-slate-200/70 transition-opacity shrink-0"
                      onClick={e => e.stopPropagation()}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5 text-slate-400" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      align="end"
                      sideOffset={4}
                      className="z-50 min-w-[140px] bg-white rounded-lg border border-slate-200 shadow-lg py-1 animate-in fade-in-0 zoom-in-95"
                    >
                      <DropdownMenu.Item
                        className="flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 cursor-pointer outline-none"
                        onSelect={() => startRename(chat)}
                      >
                        <Pencil className="h-3 w-3" /> Rinomina
                      </DropdownMenu.Item>
                      <DropdownMenu.Separator className="h-px bg-slate-100 my-1" />
                      <DropdownMenu.Item
                        className="flex items-center gap-2 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 cursor-pointer outline-none"
                        onSelect={() => setDeletingId(chat.id)}
                      >
                        <Trash2 className="h-3 w-3" /> Elimina
                      </DropdownMenu.Item>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}
            </div>
          ))}
          {chats.length === 0 && (
            <div className="text-xs text-slate-400 text-center py-8">
              Nessuna conversazione
            </div>
          )}
        </div>

        {/* ──── Knowledge Base section ──── */}
        <div className="border-t">
          <button
            onClick={() => setKbExpanded(!kbExpanded)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide hover:bg-slate-100 transition-colors"
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span className="flex-1 text-left">Knowledge Base</span>
            {kbDocs.length > 0 && (
              <span className="text-[10px] font-normal bg-purple-100 text-purple-700 rounded-full px-1.5 py-0.5">
                {kbDocs.filter(d => d.status === 'ready').length}
              </span>
            )}
            {kbExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>

          {kbExpanded && (
            <div className="px-2 pb-2 space-y-1">
              {/* Upload button */}
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={kbUploading}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-purple-700 bg-purple-50 border border-dashed border-purple-200 rounded-md hover:bg-purple-100 transition-colors disabled:opacity-50"
              >
                {kbUploading
                  ? <Loader2 className="h-3 w-3 animate-spin" />
                  : <Upload className="h-3 w-3" />
                }
                {kbUploading ? 'Caricamento...' : 'Carica documento'}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.txt,.csv"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  if (f) uploadKbFile(f)
                  e.target.value = ''
                }}
              />

              {/* Document list */}
              {kbDocs.map(doc => (
                <div key={doc.id} className="group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs hover:bg-slate-100 transition-colors">
                  <FileText className="h-3 w-3 shrink-0 text-slate-400" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium text-slate-700">{doc.file_name}</div>
                    <div className="text-[10px] text-slate-400 flex items-center gap-1">
                      {doc.status === 'ready' && (
                        <><span className="text-green-600">{doc.chunk_count} chunks</span> · {(doc.file_size / 1024).toFixed(0)} KB</>
                      )}
                      {doc.status === 'processing' && (
                        <><Loader2 className="h-2.5 w-2.5 animate-spin text-amber-500" /> Elaborazione...</>
                      )}
                      {doc.status === 'uploading' && (
                        <><Loader2 className="h-2.5 w-2.5 animate-spin text-blue-500" /> Upload...</>
                      )}
                      {doc.status === 'error' && (
                        <><AlertCircle className="h-2.5 w-2.5 text-red-500" /> <span className="text-red-500 truncate">{doc.error_message || 'Errore'}</span></>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteKbDoc(doc.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-400 hover:text-red-500 transition-opacity"
                    title="Elimina documento"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}

              {kbDocs.length === 0 && (
                <div className="text-[10px] text-slate-400 text-center py-3">
                  Nessun documento caricato.<br />
                  Supporta PDF, TXT, CSV (max 20 MB)
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ──── Chat area ──── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
          {/* Empty state with suggestions */}
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full gap-6">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 text-white mb-4">
                  <Sparkles className="h-7 w-7" />
                </div>
                <h2 className="text-xl font-semibold text-slate-800">Assistente AI FinFlow</h2>
                <p className="text-sm text-slate-500 mt-1 max-w-md">
                  Chiedi qualcosa sui tuoi dati finanziari. Posso cercare fatture, movimenti bancari, rate e molto altro.
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg w-full">
                {SUGGESTIONS.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => sendMessage(s.text)}
                    className="flex items-center gap-3 p-3 rounded-xl border border-slate-200 bg-white hover:border-purple-300 hover:shadow-sm transition-all text-left"
                  >
                    <div className={`p-2 rounded-lg ${s.color}`}>
                      <s.icon className="h-4 w-4" />
                    </div>
                    <span className="text-sm text-slate-700">{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Messages list */}
          {messages.map((msg, idx) => (
            <div key={msg.id}>
              {/* Tool calls chip between user and assistant */}
              {msg.role === 'assistant' && idx > 0 && toolCalls.length > 0 && messages[idx - 1]?.role === 'user' && (
                <ToolCallsChip calls={toolCalls} />
              )}

              <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
                  msg.role === 'user'
                    ? 'bg-blue-50 text-blue-900 rounded-br-md'
                    : 'bg-white border border-slate-200 text-slate-800 rounded-bl-md shadow-sm'
                }`}>
                  {msg.role === 'assistant' ? (
                    <div className="prose prose-sm prose-slate max-w-none [&_table]:text-xs [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {loading && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-2xl rounded-bl-md px-4 py-2.5 text-sm text-slate-500 shadow-sm">
                <Loader2 className="h-4 w-4 animate-spin text-purple-500" />
                FinFlow AI sta analizzando...
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div className="border-t bg-white px-4 py-3">
          <div className="max-w-3xl mx-auto flex items-end gap-2">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={e => handleInputChange(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  sendMessage()
                }
              }}
              placeholder="Chiedi qualcosa sui tuoi dati..."
              disabled={loading}
              rows={1}
              className="flex-1 resize-none rounded-xl border border-slate-200 px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent disabled:opacity-50 bg-slate-50"
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              className="shrink-0 p-2.5 rounded-xl bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* ──── Delete confirmation modal ──── */}
      {deletingId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-lg font-semibold text-slate-800">Eliminare la conversazione?</h3>
            <p className="text-sm text-slate-500">
              Questa azione eliminerà la conversazione e tutti i suoi messaggi. Non è reversibile.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => !deleteLoading && setDeletingId(null)}
                className="px-4 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 transition-colors"
                disabled={deleteLoading}
              >
                Annulla
              </button>
              <button
                onClick={confirmDelete}
                disabled={deleteLoading}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center gap-2"
              >
                {deleteLoading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Tool calls chip ─────────────────────── */

function ToolCallsChip({ calls }: { calls: ToolCallDisplay[] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex justify-start mb-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-slate-100 text-xs text-slate-500 hover:bg-slate-200 transition-colors"
      >
        <Search className="h-3 w-3" />
        {calls.length === 1
          ? `${TOOL_LABELS[calls[0].name] || calls[0].name} · ${calls[0].result_count} risultati`
          : `${calls.length} ricerche completate`
        }
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      </button>
      {expanded && (
        <div className="ml-2 text-[10px] text-slate-400 flex flex-col gap-0.5">
          {calls.map((c, i) => (
            <span key={i}>
              {TOOL_LABELS[c.name] || c.name}: {c.result_count} risultati
              {c.args && Object.keys(c.args).length > 0 && (
                <span className="text-slate-300"> ({Object.entries(c.args).map(([k, v]) => `${k}=${v}`).join(', ')})</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
