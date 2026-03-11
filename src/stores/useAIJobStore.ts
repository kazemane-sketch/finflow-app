/**
 * useAIJobStore — Global zustand store for AI background jobs.
 *
 * Jobs persist across page navigation because the store lives
 * outside React. Any page can start/stop/monitor jobs, and the
 * AIJobIndicator in the sidebar shows them all.
 *
 * Jobs are unique by (type, instanceKey). Batch jobs typically omit
 * instanceKey; per-entity jobs can use it (e.g. invoiceId) so multiple
 * jobs of the same family can run in parallel.
 */
import { create } from 'zustand'

/* ─── Types ──────────────────────────────────── */

export type AIJobStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface AIJobLog {
  at: number
  text: string
}

export interface AIJob {
  id: string
  type: string
  instanceKey: string | null
  label: string
  status: AIJobStatus
  current: number
  total: number
  stage: string | null
  message: string | null
  logs: AIJobLog[]
  startedAt: number
  endedAt: number | null
  error: string | null
  _abort: AbortController
}

export interface AIJobProgressMeta {
  stage?: string | null
  message?: string | null
}

export interface StartJobOptions {
  instanceKey?: string | null
  stage?: string | null
  message?: string | null
}

export interface AIJobStore {
  jobs: Record<string, AIJob>

  startJob: (type: string, label: string, total?: number, options?: StartJobOptions) => { id: string; signal: AbortSignal }
  updateProgress: (id: string, current: number, total?: number, meta?: AIJobProgressMeta) => void
  setStage: (id: string, stage?: string | null, message?: string | null) => void
  appendLog: (id: string, text: string) => void
  completeJob: (id: string) => void
  failJob: (id: string, error?: string) => void
  cancelJob: (id: string) => void
  dismissJob: (id: string) => void

  // Selectors
  isRunning: (type: string, instanceKey?: string | null) => boolean
  getJobByType: (type: string, instanceKey?: string | null) => AIJob | undefined
  getRunningJobs: (type?: string) => AIJob[]
}

/* ─── Helpers ────────────────────────────────── */

export function makeJobId(type: string): string {
  return `${type}-${Date.now()}`
}

function matchesJob(job: AIJob, type: string, instanceKey?: string | null): boolean {
  return job.type === type && job.instanceKey === (instanceKey ?? null)
}

function findRunningByKey(jobs: Record<string, AIJob>, type: string, instanceKey?: string | null): AIJob | undefined {
  return Object.values(jobs).find(j =>
    j.status === 'running' && matchesJob(j, type, instanceKey),
  )
}

/* ─── Store ──────────────────────────────────── */

const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const useAIJobStore = create<AIJobStore>((set, get) => ({
  jobs: {},

  startJob(type, label, total = 0, options) {
    const state = get()
    const instanceKey = options?.instanceKey ?? null

    const existing = findRunningByKey(state.jobs, type, instanceKey)
    if (existing) {
      existing._abort.abort()
      const timer = autoDismissTimers.get(existing.id)
      if (timer) { clearTimeout(timer); autoDismissTimers.delete(existing.id) }
    }

    const id = makeJobId(type)
    const abort = new AbortController()
    const job: AIJob = {
      id,
      type,
      instanceKey,
      label,
      status: 'running',
      current: 0,
      total,
      stage: options?.stage ?? null,
      message: options?.message ?? null,
      logs: [],
      startedAt: Date.now(),
      endedAt: null,
      error: null,
      _abort: abort,
    }

    const newJobs = { ...state.jobs }
    if (existing) delete newJobs[existing.id]
    newJobs[id] = job

    set({ jobs: newJobs })
    return { id, signal: abort.signal }
  },

  updateProgress(id, current, total, meta) {
    set(s => {
      const job = s.jobs[id]
      if (!job || job.status !== 'running') return s
      return {
        jobs: {
          ...s.jobs,
          [id]: {
            ...job,
            current,
            ...(total !== undefined ? { total } : {}),
            ...(meta?.stage !== undefined ? { stage: meta.stage } : {}),
            ...(meta?.message !== undefined ? { message: meta.message } : {}),
          },
        },
      }
    })
  },

  setStage(id, stage, message) {
    set(s => {
      const job = s.jobs[id]
      if (!job || job.status !== 'running') return s
      return {
        jobs: {
          ...s.jobs,
          [id]: {
            ...job,
            ...(stage !== undefined ? { stage } : {}),
            ...(message !== undefined ? { message } : {}),
          },
        },
      }
    })
  },

  appendLog(id, text) {
    const clean = String(text || '').trim()
    if (!clean) return
    set(s => {
      const job = s.jobs[id]
      if (!job) return s
      const logs = [...job.logs, { at: Date.now(), text: clean }].slice(-8)
      return {
        jobs: {
          ...s.jobs,
          [id]: { ...job, logs, message: clean },
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
          [id]: {
            ...job,
            status: 'completed',
            endedAt: Date.now(),
            current: job.total > 0 ? job.total : job.current,
          },
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
          [id]: {
            ...job,
            status: 'failed',
            endedAt: Date.now(),
            error: error || null,
            message: error || job.message,
          },
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
        [id]: {
          ...s.jobs[id],
          status: 'cancelled',
          endedAt: Date.now(),
          message: s.jobs[id].message || 'Operazione interrotta',
        },
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

  isRunning(type, instanceKey) {
    return !!findRunningByKey(get().jobs, type, instanceKey)
  },

  getJobByType(type, instanceKey) {
    const all = Object.values(get().jobs).filter(j => matchesJob(j, type, instanceKey))
    const running = all.find(j => j.status === 'running')
    if (running) return running
    return all.sort((a, b) => b.startedAt - a.startedAt)[0]
  },

  getRunningJobs(type) {
    return Object.values(get().jobs)
      .filter(j => j.status === 'running' && (!type || j.type === type))
      .sort((a, b) => b.startedAt - a.startedAt)
  },
}))
