/**
 * AIJobIndicator — Sidebar widget showing active/completed AI jobs.
 *
 * Renders a compact card for each job in the global store.
 * Running jobs show a progress bar + stop button.
 * Completed/failed/cancelled jobs auto-dismiss (via the store),
 * but also have a manual dismiss button.
 */
import { useAIJobStore, type AIJob, type AIJobStatus } from '@/stores/useAIJobStore'
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Ban,
  X,
  Square,
} from 'lucide-react'
import { useEffect, useState } from 'react'

/* ─── Status config ──────────────────────────── */

const statusConfig: Record<AIJobStatus, {
  icon: typeof Loader2
  color: string
  bgColor: string
  barColor: string
  spin?: boolean
}> = {
  running: {
    icon: Loader2,
    color: 'text-violet-700',
    bgColor: 'bg-violet-50 border-violet-200',
    barColor: 'bg-violet-500',
    spin: true,
  },
  completed: {
    icon: CheckCircle2,
    color: 'text-green-700',
    bgColor: 'bg-green-50 border-green-200',
    barColor: 'bg-green-500',
  },
  failed: {
    icon: XCircle,
    color: 'text-red-700',
    bgColor: 'bg-red-50 border-red-200',
    barColor: 'bg-red-500',
  },
  cancelled: {
    icon: Ban,
    color: 'text-amber-700',
    bgColor: 'bg-amber-50 border-amber-200',
    barColor: 'bg-amber-500',
  },
}

/* ─── Elapsed time helper ────────────────────── */

function useElapsed(startedAt: number, endedAt: number | null) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (endedAt) return // stopped — no need to tick
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endedAt])

  const elapsed = Math.round(((endedAt ?? now) - startedAt) / 1000)
  if (elapsed < 60) return `${elapsed}s`
  const min = Math.floor(elapsed / 60)
  const sec = elapsed % 60
  return `${min}m${sec.toString().padStart(2, '0')}s`
}

/* ─── Single job card ────────────────────────── */

function JobCard({ job }: { job: AIJob }) {
  const cancelJob = useAIJobStore(s => s.cancelJob)
  const dismissJob = useAIJobStore(s => s.dismissJob)
  const cfg = statusConfig[job.status]
  const Icon = cfg.icon
  const elapsed = useElapsed(job.startedAt, job.endedAt)
  const pct = job.total > 0 ? Math.round((job.current / job.total) * 100) : 0

  return (
    <div className={`relative rounded-lg border px-2.5 py-2 ${cfg.bgColor} transition-all`}>
      {/* Header row */}
      <div className="flex items-center gap-1.5">
        <Icon className={`h-3.5 w-3.5 shrink-0 ${cfg.color} ${cfg.spin ? 'animate-spin' : ''}`} />
        <span className={`text-[11px] font-semibold truncate flex-1 ${cfg.color}`}>
          {job.label}
        </span>
        <span className="text-[10px] text-gray-400 tabular-nums">{elapsed}</span>

        {/* Stop button (running) or dismiss button (not running) */}
        {job.status === 'running' ? (
          <button
            onClick={() => cancelJob(job.id)}
            className="p-0.5 rounded hover:bg-violet-200 transition-colors"
            title="Ferma"
          >
            <Square className="h-3 w-3 text-violet-600" />
          </button>
        ) : (
          <button
            onClick={() => dismissJob(job.id)}
            className="p-0.5 rounded hover:bg-gray-200 transition-colors"
            title="Chiudi"
          >
            <X className="h-3 w-3 text-gray-400" />
          </button>
        )}
      </div>

      {/* Progress row (only when running and total > 0) */}
      {job.status === 'running' && job.total > 0 && (
        <div className="mt-1.5">
          <div className="flex items-center justify-between text-[10px] text-gray-500 mb-0.5">
            <span>{job.current}/{job.total}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-1 rounded-full bg-violet-200 overflow-hidden">
            <div
              className={`h-full rounded-full ${cfg.barColor} transition-all duration-300`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Error message */}
      {job.error && (
        <p className="mt-1 text-[10px] text-red-600 truncate" title={job.error}>
          {job.error}
        </p>
      )}
    </div>
  )
}

/* ─── Main indicator ─────────────────────────── */

export default function AIJobIndicator() {
  const jobs = useAIJobStore(s => s.jobs)
  const jobList = Object.values(jobs)

  if (jobList.length === 0) return null

  // Sort: running first, then by startedAt desc
  const sorted = jobList.sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1
    if (b.status === 'running' && a.status !== 'running') return 1
    return b.startedAt - a.startedAt
  })

  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-0.5">
        Operazioni AI
      </div>
      {sorted.map(job => (
        <JobCard key={job.id} job={job} />
      ))}
    </div>
  )
}
