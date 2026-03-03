import { CheckCircle2, Link2 } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

/**
 * Colored dot indicating a pending reconciliation suggestion.
 * Red for score ≥ 85%, amber for 50-84%.
 * Clicking navigates to reconciliation page with the tx pre-selected.
 */
export function ReconciliationDot({ score, txId }: { score: number; txId?: string }) {
  const navigate = useNavigate()
  const color = score >= 85 ? 'bg-red-500' : score >= 50 ? 'bg-amber-500' : 'bg-gray-400'
  const title = score >= 85
    ? `Suggerimento riconciliazione: ${score}% (alta confidenza)`
    : `Suggerimento riconciliazione: ${score}%`

  return (
    <button
      onClick={e => {
        e.stopPropagation()
        navigate(txId ? `/riconciliazione?tab=suggestions&tx=${txId}` : '/riconciliazione?tab=suggestions')
      }}
      title={title}
      className="inline-flex items-center justify-center"
    >
      <span className={`w-2 h-2 rounded-full ${color} animate-pulse`} />
    </button>
  )
}

/**
 * Green checkmark icon indicating a successfully reconciled item.
 */
export function ReconciledIcon({ size = 14 }: { size?: number }) {
  return (
    <span title="Riconciliato" className="inline-flex items-center">
      <CheckCircle2 className="text-emerald-500" style={{ width: size, height: size }} />
    </span>
  )
}

/**
 * Small badge for sidebar nav — shows count of pending suggestions.
 */
export function ReconciliationBadge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="ml-auto text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
      {count > 99 ? '99+' : count}
    </span>
  )
}
