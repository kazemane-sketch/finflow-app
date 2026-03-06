/**
 * PageEntityContext — Shares selected entity info from pages with the AI widget.
 *
 * Pages set the entity when a user selects an invoice, transaction, etc.
 * The AI widget reads it and includes it as context in messages.
 *
 * Pattern:
 *   Page → useSetPageEntity(entity) (via useEffect)
 *   Widget → usePageEntity() → reads entity.summary
 */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react'

/* ─── types ───────────────────────────────── */

export interface PageEntityInfo {
  type: 'invoice' | 'transaction' | 'counterparty' | 'article' | 'installment'
  summary: string // Human-readable summary for AI context (e.g. "Fattura 001/2024 — CAVECO SRL — €1,234.56")
}

interface PageEntityContextValue {
  entity: PageEntityInfo | null
  setEntity: (e: PageEntityInfo | null) => void
}

/* ─── context ─────────────────────────────── */

const PageEntityContext = createContext<PageEntityContextValue>({
  entity: null,
  setEntity: () => {},
})

/* ─── provider ────────────────────────────── */

export function PageEntityProvider({ children }: { children: ReactNode }) {
  const [entity, setEntity] = useState<PageEntityInfo | null>(null)
  return (
    <PageEntityContext.Provider value={{ entity, setEntity }}>
      {children}
    </PageEntityContext.Provider>
  )
}

/* ─── hooks ───────────────────────────────── */

/** Read the current page entity (used by the widget) */
export function usePageEntity() {
  return useContext(PageEntityContext)
}

/**
 * Declarative hook: automatically sets the page entity when `info` changes,
 * and clears it on unmount. Use in pages like:
 *
 *   useSetPageEntity(selectedInvoice ? { type: 'invoice', summary: '...' } : null)
 */
export function useSetPageEntity(info: PageEntityInfo | null) {
  const { setEntity } = useContext(PageEntityContext)
  useEffect(() => {
    setEntity(info)
    return () => setEntity(null)
  }, [info, setEntity])
}
