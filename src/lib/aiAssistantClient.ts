import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/client'
import { getValidAccessToken } from '@/lib/getValidAccessToken'

export interface AiAssistantMessage {
  role: 'assistant' | 'user'
  content: string
}

export interface AiAssistantToolCall {
  name: string
  args: Record<string, unknown>
  result_count: number
}

export interface AiAssistantResponse {
  message?: {
    role?: 'assistant'
    content?: string
    thinking?: string | null
  }
  tool_calls?: AiAssistantToolCall[]
  [key: string]: unknown
}

export async function invokeAiAssistant<T extends AiAssistantResponse = AiAssistantResponse>(
  body: Record<string, unknown>,
): Promise<T> {
  const token = await getValidAccessToken()
  const response = await fetch(`${SUPABASE_URL}/functions/v1/ai-chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : typeof payload?.message === 'string'
        ? payload.message
        : `HTTP ${response.status}`
    throw new Error(message)
  }

  return payload as T
}
