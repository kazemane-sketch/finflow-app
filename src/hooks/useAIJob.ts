/**
 * useAIJob — React hook for starting/stopping/monitoring a background AI job.
 *
 * Usage:
 *   const { isRunning, progress, startOrStop } = useAIJob('articoli-classify', 'Classificazione Articoli')
 *
 *   <button onClick={() => startOrStop(async (signal, updateProgress) => {
 *     for (let i = 0; i < items.length; i++) {
 *       if (signal.aborted) return
 *       await doWork(items[i])
 *       updateProgress(i + 1, items.length)
 *     }
 *   }, items.length)}>
 *     {isRunning ? `⏹ Stop (${progress.pct}%)` : '✨ Start'}
 *   </button>
 */
import { useCallback } from 'react'
import { useAIJobStore, type AIJob } from '@/stores/useAIJobStore'

export type WorkFn = (
  signal: AbortSignal,
  updateProgress: (current: number, total?: number) => void,
) => Promise<void>

export interface UseAIJobReturn {
  isRunning: boolean
  job: AIJob | undefined
  progress: { current: number; total: number; pct: number }
  startOrStop: (workFn: WorkFn, total?: number) => void
  start: (workFn: WorkFn, total?: number) => void
  stop: () => void
}

export function useAIJob(type: string, label: string): UseAIJobReturn {
  // Subscribe reactively to the job for this type
  const job = useAIJobStore(s => s.getJobByType(type))
  const isRunning = job?.status === 'running'

  const current = job?.current ?? 0
  const total = job?.total ?? 0
  const pct = total > 0 ? Math.round((current / total) * 100) : 0

  const start = useCallback((workFn: WorkFn, totalEstimate?: number) => {
    // Use getState() for imperative access (avoids stale closures)
    const store = useAIJobStore.getState()
    const { id, signal } = store.startJob(type, label, totalEstimate)

    // Fire-and-forget — runs even if component unmounts
    workFn(signal, (cur, tot) => {
      useAIJobStore.getState().updateProgress(id, cur, tot)
    })
      .then(() => {
        // Only mark complete if not already cancelled
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
  }, [type, label])

  const stop = useCallback(() => {
    const store = useAIJobStore.getState()
    const running = Object.values(store.jobs).find(j => j.type === type && j.status === 'running')
    if (running) store.cancelJob(running.id)
  }, [type])

  const startOrStop = useCallback((workFn: WorkFn, totalEstimate?: number) => {
    const store = useAIJobStore.getState()
    const running = Object.values(store.jobs).find(j => j.type === type && j.status === 'running')
    if (running) {
      store.cancelJob(running.id)
    } else {
      start(workFn, totalEstimate)
    }
  }, [type, start])

  return { isRunning, job, progress: { current, total, pct }, startOrStop, start, stop }
}
