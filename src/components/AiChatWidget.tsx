import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Sparkles, Send, Loader2, X, Maximize2, Minus, FileText,
  Zap, Brain, Search, ChevronDown, ChevronRight, Menu, Plus,
  MessageSquare,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAiChat, type ToolCallDisplay } from '@/contexts/AiChatContext'
import { usePageEntity } from '@/contexts/PageEntityContext'
import { useCompany } from '@/hooks/useCompany'
import { supabase } from '@/integrations/supabase/client'

/* ─── page label map ──────────────────────── */

const PAGE_LABELS: Record<string, string> = {
  '/': 'Dashboard',
  '/fatture': 'Fatture',
  '/banca': 'Banca',
  '/scadenzario': 'Scadenzario',
  '/controparti': 'Controparti',
  '/articoli': 'Articoli',
  '/riconciliazione': 'Riconciliazione',
  '/iva': 'IVA',
  '/impostazioni': 'Impostazioni',
}

/* ─── tool labels (duplicated for widget) ─── */

const TOOL_LABELS: Record<string, string> = {
  get_invoices: 'Cercando fatture',
  get_invoice_detail: 'Dettaglio fattura',
  get_invoice_consulting_context: 'Contesto classificazione fattura',
  get_bank_transactions: 'Cercando movimenti',
  get_transaction_detail: 'Dettaglio movimento',
  get_open_installments: 'Rate aperte',
  search_raw_text: 'Ricerca testo bancario',
  get_counterparties: 'Cercando controparti',
  get_company_stats: 'Statistiche azienda',
  suggest_reconciliation: 'Suggerimento riconciliazione',
  search_knowledge_base: 'Ricerca knowledge base',
  get_chart_of_accounts: 'Piano dei conti',
  get_categories: 'Categorie',
  get_cost_centers: 'Centri di costo',
  get_articles: 'Articoli',
  get_company_settings: 'Impostazioni azienda',
  get_reconciliation_stats: 'Statistiche riconciliazione',
  apply_invoice_consultant_resolution: 'Applicando decisione fattura',
}

/* ─── main widget ─────────────────────────── */

interface ChatListItem {
  id: string
  title: string | null
  updated_at: string
  message_count: number
}

export default function AiChatWidget() {
  const location = useLocation()
  const navigate = useNavigate()
  const {
    messages, loading, toolCalls,
    modelPreference, setModelPreference,
    sendMessage, startNewChat,
    chatId, setChatId, setMessages, setToolCalls, chatVersion,
  } = useAiChat()
  const { entity: pageEntity } = usePageEntity()
  const { company } = useCompany()

  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [showChatList, setShowChatList] = useState(false)
  const [chatHistory, setChatHistory] = useState<ChatListItem[]>([])
  const [chatListLoading, setChatListLoading] = useState(false)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /* ── load recent chats ─────────────────── */
  const loadChatHistory = useCallback(async () => {
    if (!company?.id) return
    setChatListLoading(true)
    const { data } = await supabase
      .from('ai_chats')
      .select('id, title, updated_at, message_count')
      .eq('company_id', company.id)
      .order('updated_at', { ascending: false })
      .limit(20)
    if (data) setChatHistory(data)
    setChatListLoading(false)
  }, [company?.id])

  /* ── reload chat list when chatVersion bumps ── */
  useEffect(() => {
    if (showChatList) loadChatHistory()
  }, [showChatList, chatVersion, loadChatHistory])

  /* ── select a chat from the history ──────── */
  const selectChat = useCallback(async (chatIdToLoad: string) => {
    setChatId(chatIdToLoad)
    setToolCalls([])
    setShowChatList(false)
    const { data } = await supabase
      .from('ai_messages')
      .select('id, role, content, tool_name, created_at')
      .eq('chat_id', chatIdToLoad)
      .order('created_at', { ascending: true })
      .limit(100)
    if (data) setMessages(data.filter(m => m.role === 'user' || m.role === 'assistant'))
  }, [setChatId, setMessages, setToolCalls])

  /* ── scroll to bottom on new messages ──── */
  // IMPORTANT: all hooks must be BEFORE any conditional return (React Rules of Hooks)
  useEffect(() => {
    if (open) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, loading, open])

  // Don't render on /ai page (after all hooks!)
  if (location.pathname === '/ai') return null

  // Page context from current location + selected entity (include UUID so AI can call tools)
  const pageLabel = PAGE_LABELS[location.pathname] || location.pathname
  const pageContext = pageEntity
    ? `${pageLabel}. L'utente sta guardando: ${pageEntity.summary}. ${pageEntity.type}_id (database UUID) = "${pageEntity.id}" — usa questo ID per chiamare i tool come get_invoice_detail o get_transaction_detail.`
    : pageLabel

  /* ── auto-resize textarea ─────────────── */
  const handleInputChange = (val: string) => {
    setInput(val)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 100) + 'px'
    }
  }

  /* ── send ──────────────────────────────── */
  const handleSend = async () => {
    if (!input.trim() || loading) return
    const text = input
    setInput('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    await sendMessage(text, pageContext)
  }

  /* ── expand to full page ──────────────── */
  const expandToFullPage = () => {
    setOpen(false)
    navigate('/ai')
  }

  /* ── closed: floating bubble ──────────── */
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center justify-center w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg hover:shadow-xl hover:scale-105 transition-all animate-pulse-soft"
        title="Apri assistente AI"
      >
        <Sparkles className="h-6 w-6" />
      </button>
    )
  }

  /* ── opened: chat panel ────────────────── */
  return (
    <div className="fixed bottom-6 right-6 z-50 w-[400px] h-[520px] flex flex-col bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden relative">
      {/* ── Header ─────────────────────── */}
      <div className="flex items-center gap-1.5 px-3 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 text-white shrink-0">
        {/* Chat history toggle */}
        <button
          onClick={() => setShowChatList(prev => !prev)}
          className="p-1 rounded hover:bg-white/20 transition-colors"
          title="Cronologia chat"
        >
          <Menu className="h-3.5 w-3.5" />
        </button>

        <Sparkles className="h-4 w-4" />
        <span className="text-sm font-semibold flex-1">
          Assistente AI
          {modelPreference === 'thinking' ? (
            <span className="ml-1.5 text-[10px] opacity-80 font-normal">Thinking</span>
          ) : (
            <span className="ml-1.5 text-[10px] opacity-80 font-normal">Fast</span>
          )}
        </span>

        {/* New chat */}
        <button
          onClick={() => { startNewChat(); setShowChatList(false) }}
          className="p-1 rounded hover:bg-white/20 transition-colors"
          title="Nuova chat"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        {/* Minimize */}
        <button
          onClick={() => setOpen(false)}
          className="p-1 rounded hover:bg-white/20 transition-colors"
          title="Minimizza"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        {/* Expand to /ai */}
        <button
          onClick={expandToFullPage}
          className="p-1 rounded hover:bg-white/20 transition-colors"
          title="Espandi a pagina intera"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        {/* Close */}
        <button
          onClick={() => { setOpen(false) }}
          className="p-1 rounded hover:bg-white/20 transition-colors"
          title="Chiudi"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* ── Entity context indicator ──── */}
      {pageEntity && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-50 border-b border-purple-100 text-[10px] text-purple-700 shrink-0">
          <FileText className="h-3 w-3 shrink-0" />
          <span className="truncate">{pageEntity.summary}</span>
        </div>
      )}

      {/* ── Chat history dropdown ────────── */}
      {showChatList && (
        <div className="absolute top-[48px] left-0 right-0 z-10 bg-white border-b border-slate-200 shadow-md max-h-[300px] overflow-y-auto">
          <div className="p-2 space-y-0.5">
            {chatListLoading ? (
              <div className="flex items-center justify-center py-4 text-xs text-slate-400">
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                Caricamento...
              </div>
            ) : chatHistory.length === 0 ? (
              <div className="text-center py-4 text-xs text-slate-400">
                Nessuna chat precedente
              </div>
            ) : (
              chatHistory.map(chat => (
                <button
                  key={chat.id}
                  onClick={() => selectChat(chat.id)}
                  className={`w-full text-left px-2.5 py-2 rounded-lg text-xs transition-colors hover:bg-purple-50 ${
                    chatId === chat.id ? 'bg-purple-50 text-purple-700' : 'text-slate-700'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <MessageSquare className="h-3 w-3 shrink-0 text-slate-400" />
                    <span className="truncate font-medium">
                      {chat.title || 'Chat senza titolo'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 ml-[18px]">
                    <span className="text-[10px] text-slate-400">
                      {new Date(chat.updated_at).toLocaleDateString('it-IT', {
                        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span className="text-[10px] text-slate-300">
                      {chat.message_count} msg
                    </span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}

      {/* ── Messages ───────────────────── */}
      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Empty state */}
        {messages.length === 0 && !loading && (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 text-white flex items-center justify-center mb-3">
              <Sparkles className="h-5 w-5" />
            </div>
            <p className="text-sm font-medium text-slate-700">Chiedimi qualcosa</p>
            <p className="text-xs text-slate-400 mt-1">
              Posso aiutarti con fatture, movimenti, scadenze e molto altro.
            </p>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, idx) => (
          <div key={msg.id}>
            {/* Tool calls chip */}
            {msg.role === 'assistant' && idx > 0 && toolCalls.length > 0 && messages[idx - 1]?.role === 'user' && (
              <WidgetToolChip calls={toolCalls} />
            )}

            <div className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs ${
                msg.role === 'user'
                  ? 'bg-blue-50 text-blue-900 rounded-br-md'
                  : 'bg-slate-50 border border-slate-200 text-slate-800 rounded-bl-md'
              }`}>
                {msg.role === 'assistant' ? (
                  <div className="prose prose-xs prose-slate max-w-none [&_table]:text-[10px] [&_th]:px-1.5 [&_td]:px-1.5 [&_th]:py-0.5 [&_td]:py-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs">
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

        {/* Loading */}
        {loading && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-2xl rounded-bl-md px-3 py-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-purple-500" />
              {modelPreference === 'thinking' ? 'Ragionando...' : 'Analizzando...'}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* ── Model toggle + Input ────────── */}
      <div className="border-t bg-white px-3 py-2 space-y-2 shrink-0">
        {/* Model toggle */}
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setModelPreference('fast')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
              modelPreference === 'fast'
                ? 'bg-amber-100 text-amber-700'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Zap className="h-3 w-3" />
            Fast
          </button>
          <div
            onClick={() => setModelPreference(modelPreference === 'fast' ? 'thinking' : 'fast')}
            className="relative w-8 h-4 bg-slate-200 rounded-full cursor-pointer transition-colors"
          >
            <div
              className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${
                modelPreference === 'thinking'
                  ? 'left-[18px] bg-purple-600'
                  : 'left-0.5 bg-amber-500'
              }`}
            />
          </div>
          <button
            onClick={() => setModelPreference('thinking')}
            className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-medium transition-colors ${
              modelPreference === 'thinking'
                ? 'bg-purple-100 text-purple-700'
                : 'text-slate-400 hover:text-slate-600'
            }`}
          >
            <Brain className="h-3 w-3" />
            Thinking
          </button>
        </div>

        {/* Input row */}
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => handleInputChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Chiedi qualcosa..."
            disabled={loading}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-slate-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-purple-400 focus:border-transparent disabled:opacity-50 bg-slate-50"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading}
            className="shrink-0 p-2 rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─── Tool calls chip (compact for widget) ── */

function WidgetToolChip({ calls }: { calls: ToolCallDisplay[] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="flex justify-start mb-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-[10px] text-slate-500 hover:bg-slate-200 transition-colors"
      >
        <Search className="h-2.5 w-2.5" />
        {calls.length === 1
          ? `${TOOL_LABELS[calls[0].name] || calls[0].name} · ${calls[0].result_count}`
          : `${calls.length} ricerche`
        }
        {expanded ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
      </button>
      {expanded && (
        <div className="ml-1 text-[9px] text-slate-400 flex flex-col">
          {calls.map((c, i) => (
            <span key={i}>
              {TOOL_LABELS[c.name] || c.name}: {c.result_count}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
