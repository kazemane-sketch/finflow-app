/**
 * Module-level singleton store for counterparty ATECO enrichment.
 * Same pattern as extractionStore.ts — survives React unmounts,
 * compatible with useSyncExternalStore.
 */
import { enrichCounterparties } from '@/lib/counterpartyService';

export interface EnrichmentState {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
}

type Listener = () => void;

let state: EnrichmentState = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
};

let snapshot: EnrichmentState = { ...state };

const listeners = new Set<Listener>();

function emit() {
  snapshot = { ...state };
  listeners.forEach((l) => l());
}

export function getEnrichmentState(): EnrichmentState {
  return snapshot;
}

export function subscribeEnrichment(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function startEnrichment(companyId: string, total: number) {
  if (state.running) return;

  state = { running: true, processed: 0, total, error: null };
  emit();

  try {
    const result = await enrichCounterparties(companyId, undefined, false);
    state = {
      ...state,
      processed: result.enriched + result.skipped + result.errors,
    };
    emit();
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error('[Counterparty Enrichment]', msg);
    state = { ...state, error: msg };
    emit();
  }

  state = { ...state, running: false };
  emit();
}
