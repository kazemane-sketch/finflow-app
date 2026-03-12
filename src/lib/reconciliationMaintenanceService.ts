import { postEdgeJsonWithAuthRetry } from '@/lib/edgeAuthFetch'

export interface ContractRefBackfillResult {
  processed: number
  updated: number
  skipped: number
  remaining: number
}

export interface BankEmbeddingBackfillResult {
  processed: number
  ready: number
  errors: number
  remaining: number
}

export interface ReconciliationBackfillResult {
  contracts: ContractRefBackfillResult
  bankEmbeddings: BankEmbeddingBackfillResult
  currentStep?: string
}

const CONTRACT_BATCH_SIZE = 100
const EMBEDDING_BATCH_SIZE = 50
const MAX_ROUNDS = 40

async function callEdge<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  return await postEdgeJsonWithAuthRetry<T>(path, payload)
}

export async function triggerReconciliationHistoricalAlignment(
  companyId: string,
  onProgress?: (partial: ReconciliationBackfillResult) => void,
): Promise<ReconciliationBackfillResult> {
  const result: ReconciliationBackfillResult = {
    contracts: { processed: 0, updated: 0, skipped: 0, remaining: 0 },
    bankEmbeddings: { processed: 0, ready: 0, errors: 0, remaining: 0 },
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    result.currentStep = 'Riferimenti contratto fatture...'
    onProgress?.({
      ...result,
      contracts: { ...result.contracts },
      bankEmbeddings: { ...result.bankEmbeddings },
    })

    const step = await callEdge<{
      processed?: number
      updated?: number
      skipped?: number
      remaining?: number
    }>('backfill-invoice-contract-refs', {
      company_id: companyId,
      batch_size: CONTRACT_BATCH_SIZE,
    })

    result.contracts.processed += Number(step.processed || 0)
    result.contracts.updated += Number(step.updated || 0)
    result.contracts.skipped += Number(step.skipped || 0)
    result.contracts.remaining = Number(step.remaining || 0)

    onProgress?.({
      ...result,
      contracts: { ...result.contracts },
      bankEmbeddings: { ...result.bankEmbeddings },
    })

    if (
      result.contracts.remaining === 0 ||
      Number(step.processed || 0) === 0 ||
      (Number(step.updated || 0) === 0 && Number(step.skipped || 0) > 0)
    ) break
  }

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    result.currentStep = 'Embedding movimenti banca...'
    onProgress?.({
      ...result,
      contracts: { ...result.contracts },
      bankEmbeddings: { ...result.bankEmbeddings },
    })

    const step = await callEdge<{
      processed?: number
      ready?: number
      errors?: number
      remaining?: number
    }>('bank-embed-transactions', {
      company_id: companyId,
      mode: 'backfill',
      skip_claim: true,
      batch_size: EMBEDDING_BATCH_SIZE,
    })

    result.bankEmbeddings.processed += Number(step.processed || 0)
    result.bankEmbeddings.ready += Number(step.ready || 0)
    result.bankEmbeddings.errors += Number(step.errors || 0)
    result.bankEmbeddings.remaining = Number(step.remaining || 0)

    onProgress?.({
      ...result,
      contracts: { ...result.contracts },
      bankEmbeddings: { ...result.bankEmbeddings },
    })

    if (result.bankEmbeddings.remaining === 0 || Number(step.processed || 0) === 0) break
  }

  result.currentStep = undefined
  return result
}
