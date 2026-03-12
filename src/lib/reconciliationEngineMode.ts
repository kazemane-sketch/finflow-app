export type ReconciliationEngineMode = 'legacy' | 'contextual' | 'shadow'

const STORAGE_PREFIX = 'finflow:reconciliation-engine-mode'

export function normalizeReconciliationEngineMode(value: unknown): ReconciliationEngineMode {
  return value === 'legacy' || value === 'shadow' ? value : 'contextual'
}

export function getStoredReconciliationEngineMode(companyId?: string | null): ReconciliationEngineMode {
  if (typeof window === 'undefined') return 'contextual'
  try {
    const key = `${STORAGE_PREFIX}:${companyId || 'default'}`
    return normalizeReconciliationEngineMode(window.localStorage.getItem(key))
  } catch {
    return 'contextual'
  }
}

export function setStoredReconciliationEngineMode(
  companyId: string | null | undefined,
  mode: ReconciliationEngineMode,
): void {
  if (typeof window === 'undefined') return
  try {
    const key = `${STORAGE_PREFIX}:${companyId || 'default'}`
    window.localStorage.setItem(key, mode)
  } catch {
    // ignore localStorage failures
  }
}

export function reconciliationEngineModeLabel(mode: ReconciliationEngineMode): string {
  switch (mode) {
    case 'legacy':
      return 'Legacy'
    case 'shadow':
      return 'Shadow'
    default:
      return 'Contestuale'
  }
}

export function reconciliationEngineModeDescription(mode: ReconciliationEngineMode): string {
  switch (mode) {
    case 'legacy':
      return 'Usa il matcher classico senza ranking globale o reranker premium.'
    case 'shadow':
      return 'Pubblica i suggerimenti legacy ma confronta in background il motore contestuale.'
    default:
      return 'Usa il motore nuovo con ranking globale, note, contract_ref e reranker premium.'
  }
}
