/**
 * useAIJob — React hook for starting/stopping/monitoring a background AI job.
 *
 * Usage:
 *   const { isRunning, progress, startOrStop } = useAIJob('articoli-classify', 'Classificazione Articoli')
 *
 *   <button onClick={() => startOrStop(async (signal, updateProgress, appendLog) => {
 *     for (let i = 0; i < items.length; i++) {
 *       if (signal.aborted) return
 *       await doWork(items[i])
 *       updateProgress(i + 1, items.length, { message: `Elemento ${i + 1}/${items.length}` })
 *       appendLog?.(`Completato elemento ${i + 1}`)
 *     }
 *   }, items.length)}>
 *     {isRunning ? `⏹ Stop (${progress.pct}%)` : '✨ Start'}
 *   </button>
 */
import { useCallback } from 'react'
import {
  useAIJobStore,
  type AIJob,
  type AIJobProgressMeta,
} from '@/stores/useAIJobStore'

export type WorkFn = (
  signal: AbortSignal,
  updateProgress: (current: number, total?: number, meta?: AIJobProgressMeta) => void,
  appendLog?: (text: string) => void,
) => Promise<void>

export interface UseAIJobOptions {
  instanceKey?: string | null
}

export interface UseAIJobReturn {
  isRunning: boolean
  job: AIJob | undefined
  progress: { current: number; total: number; pct: number }
  startOrStop: (workFn: WorkFn, total?: number) => void
  start: (workFn: WorkFn, total?: number) => void
  stop: () => void
}

export function useAIJob(type: string, label: string, options?: UseAIJobOptions): UseAIJobReturn {
  const instanceKey = options?.instanceKey ?? null
  const job = useAIJobStore(s => s.getJobByType(type, instanceKey))
  const isRunning = job?.status === 'running'

  const current = job?.current ?? 0
  const total = job?.total ?? 0
  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  const start = useCallback((workFn: WorkFn, totalEstimate?: number) => {
    const store = useAIJobStore.getState()
    const { id, signal } = store.startJob(type, label, totalEstimate, { instanceKey })

    workFn(
      signal,
      (cur, tot, meta) => {
        useAIJobStore.getState().updateProgress(id, cur, tot, meta)
      },
      (text) => {
        useAIJobStore.getState().appendLog(id, text)
      },
    )
      .then(() => {
        const current = useAIJobStore.getState().jobs[id]
        if (current && current.status === 'running') {
          useAIJobStore.getState().completeJob(id)
        }
      })
      .catch((err: unknown) => {
        // AbortError = user cancelled → don't mark as failed
        if (err instanceof DOMException && err.name === 'AbortError') return
        if (err instanceof Error && err.message === 'AbortError') return
        const current = useAIJobStore.getState().jobs[id]
        if (current && current.status === 'running') {
          const msg = err instanceof Error ? err.message : String(err)
          useAIJobStore.getState().failJob(id, msg)
        }
      })
  }, [type, label, instanceKey])

  const stop = useCallback(() => {
    const store = useAIJobStore.getState()
    const running = store.getJobByType(type, instanceKey)
    if (running?.status === 'running') store.cancelJob(running.id)
  }, [type, instanceKey])

  const startOrStop = useCallback((workFn: WorkFn, totalEstimate?: number) => {
    const store = useAIJobStore.getState()
    const running = store.getJobByType(type, instanceKey)
    if (running?.status === 'running') {
      store.cancelJob(running.id)
    } else {
      start(workFn, totalEstimate)
    }
  }, [type, instanceKey, start])

  return { isRunning, job, progress: { current, total, pct }, startOrStop, start, stop }
}
