import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { useCompany } from '@/hooks/useCompany'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

/* ─── types ───────────────────────────────── */

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool_name?: string
  created_at: string
}

export interface ToolCallDisplay {
  name: string
  args: Record<string, unknown>
  result_count: number
}

export type ModelPreference = 'fast' | 'thinking'

interface AiChatContextValue {
  /* state */
  messages: ChatMessage[]
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>
  chatId: string | null
  setChatId: (id: string | null) => void
  loading: boolean
  toolCalls: ToolCallDisplay[]
  setToolCalls: React.Dispatch<React.SetStateAction<ToolCallDisplay[]>>

  /* model */
  modelPreference: ModelPreference
  setModelPreference: (pref: ModelPreference) => void

  /* actions */
  sendMessage: (text: string, pageContext?: string) => Promise<void>
  startNewChat: () => void

  /* helpers for AiChatPage sidebar refresh */
  chatVersion: number          // bumped after each send to trigger sidebar reload
}

const AiChatContext = createContext<AiChatContextValue | null>(null)

/* ─── provider ────────────────────────────── */

export function AiChatProvider({ children }: { children: ReactNode }) {
  const { company } = useCompany()
  const companyId = company?.id

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatId, setChatId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [toolCalls, setToolCalls] = useState<ToolCallDisplay[]>([])
  const [modelPreference, setModelPreference] = useState<ModelPreference>('fast')
  const [chatVersion, setChatVersion] = useState(0)

  /* ── start a new chat ──────────────────── */
  const startNewChat = useCallback(() => {
    setChatId(null)
    setMessages([])
    setToolCalls([])
  }, [])

  /* ── send a message ────────────────────── */
  const sendMessage = useCallback(
    async (text: string, pageContext?: string) => {
      const msg = text.trim()
      if (!msg || loading || !companyId) return

      // Prepend page context if provided
      const fullMessage = pageContext
        ? `Contesto: L'utente sta guardando la pagina ${pageContext}.\n\n${msg}`
        : msg

      // Optimistic UI — add user message (show without context prefix)
      const tempUserMsg: ChatMessage = {
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
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            mode: 'chat',
            company_id: companyId,
            chat_id: chatId,
            message: fullMessage,
            model_preference: modelPreference,
          }),
        })

        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)

        // Set chat ID if new
        if (!chatId && data.chat_id) {
          setChatId(data.chat_id)
        }

        // Add assistant message
        const assistantMsg: ChatMessage = {
          id: `resp-${Date.now()}`,
          role: 'assistant',
          content: data.message?.content || 'Nessuna risposta.',
          created_at: new Date().toISOString(),
        }
        setMessages(prev => [...prev, assistantMsg])

        // Tool calls
        if (data.tool_calls?.length) {
          setToolCalls(data.tool_calls)
        }

        // Bump version so sidebar can reload
        setChatVersion(v => v + 1)
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const errorMsg: ChatMessage = {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Errore: ${errMsg}`,
          created_at: new Date().toISOString(),
        }
        setMessages(prev => [...prev, errorMsg])
      }

      setLoading(false)
    },
    [chatId, companyId, loading, modelPreference],
  )

  return (
    <AiChatContext.Provider
      value={{
        messages,
        setMessages,
        chatId,
        setChatId,
        loading,
        toolCalls,
        setToolCalls,
        modelPreference,
        setModelPreference,
        sendMessage,
        startNewChat,
        chatVersion,
      }}
    >
      {children}
    </AiChatContext.Provider>
  )
}

/* ─── hook ─────────────────────────────────── */

export function useAiChat() {
  const ctx = useContext(AiChatContext)
  if (!ctx) throw new Error('useAiChat must be used within AiChatProvider')
  return ctx
}
