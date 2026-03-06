/**
 * useAIJobStore — Global zustand store for AI background jobs.
 *
 * Jobs persist across page navigation because the store lives
 * outside React. Any page can start/stop/monitor jobs, and the
 * AIJobIndicator in the sidebar shows them all.
 *
 * Each job type (e.g. 'articoli-classify') is unique — starting
 * a new job of the same type auto-cancels the previous one.
 */
import { create } from 'zustand'

/* ─── Types ──────────────────────────────────── */

export type AIJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface AIJob {
  id: string
  type: string          // unique key: 'articoli-classify', 'fatture-classify', etc.
  label: string         // display label: 'Classificazione Articoli'
  status: AIJobStatus
  current: number
  total: number
  startedAt: number
  endedAt: number | null
  error: string | null
  _abort: AbortController // internal — not read by UI
}

export interface AIJobStore {
  jobs: Record<string, AIJob>

  startJob: (type: string, label: string, total?: number) => { id: string; signal: AbortSignal }
  updateProgress: (id: string, current: number, total?: number) => void
  completeJob: (id: string) => void
  failJob: (id: string, error?: string) => void
  cancelJob: (id: string) => void
  dismissJob: (id: string) => void

  // Selectors
  isRunning: (type: string) => boolean
  getJobByType: (type: string) => AIJob | undefined
}

/* ─── Helpers ────────────────────────────────── */

export function makeJobId(type: string): string {
  return `${type}-${Date.now()}`
}

/** Find a running job of a given type across all jobs */
function findRunningByType(jobs: Record<string, AIJob>, type: string): AIJob | undefined {
  return Object.values(jobs).find(j => j.type === type && j.status === 'running')
}

/* ─── Store ──────────────────────────────────── */

const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useAIJobStore = create<AIJobStore>((set, get) => ({
  jobs: {},

  startJob(type, label, total = 0) {
    const state = get()

    // Cancel existing running job of same type
    const existing = findRunningByType(state.jobs, type)
    if (existing) {
      existing._abort.abort()
      // Clear any pending auto-dismiss
      const timer = autoDismissTimers.get(existing.id)
      if (timer) { clearTimeout(timer); autoDismissTimers.delete(existing.id) }
    }

    const id = makeJobId(type)
    const abort = new AbortController()
    const job: AIJob = {
      id,
      type,
      label,
      status: 'running',
      current: 0,
      total,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      _abort: abort,
    }

    // Remove the old job of same type (if cancelled above) and add new one
    const newJobs = { ...state.jobs }
    if (existing) delete newJobs[existing.id]
    newJobs[id] = job

    set({ jobs: newJobs })
    return { id, signal: abort.signal }
  },

  updateProgress(id, current, total) {
    set(s => {
      const job = s.jobs[id]
      if (!job || job.status !== 'running') return s
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, current, ...(total !== undefined ? { total } : {}) },
        },
      }
    })
  },

  completeJob(id) {
    set(s => {
      const job = s.jobs[id]
      if (!job) return s
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, status: 'completed', endedAt: Date.now() },
        },
      }
    })
    // Auto-dismiss after 8s
    const timer = setTimeout(() => {
      get().dismissJob(id)
      autoDismissTimers.delete(id)
    }, 8000)
    autoDismissTimers.set(id, timer)
  },

  failJob(id, error) {
    set(s => {
      const job = s.jobs[id]
      if (!job) return s
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, status: 'failed', endedAt: Date.now(), error: error || null },
        },
      }
    })
  },

  cancelJob(id) {
    const job = get().jobs[id]
    if (!job) return
    job._abort.abort()
    set(s => ({
      jobs: {
        ...s.jobs,
        [id]: { ...s.jobs[id], status: 'cancelled', endedAt: Date.now() },
      },
    }))
    // Auto-dismiss after 5s
    const timer = setTimeout(() => {
      get().dismissJob(id)
      autoDismissTimers.delete(id)
    }, 5000)
    autoDismissTimers.set(id, timer)
  },

  dismissJob(id) {
    set(s => {
      const newJobs = { ...s.jobs }
      delete newJobs[id]
      return { jobs: newJobs }
    })
    const timer = autoDismissTimers.get(id)
    if (timer) { clearTimeout(timer); autoDismissTimers.delete(id) }
  },

  isRunning(type) {
    return !!findRunningByType(get().jobs, type)
  },

  getJobByType(type) {
    // Return the most recent job of this type (running first, then latest)
    const all = Object.values(get().jobs).filter(j => j.type === type)
    const running = all.find(j => j.status === 'running')
    if (running) return running
    return all.sort((a, b) => b.startedAt - a.startedAt)[0]
  },
}))
