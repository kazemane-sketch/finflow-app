/**
 * Module-level singleton store for invoice AI extraction.
 * Survives React component unmounts so the extraction loop
 * keeps running even when the user navigates away from FatturePage.
 *
 * Compatible with React's useSyncExternalStore:
 * - subscribe must NOT call the listener during subscription
 * - getSnapshot must return a referentially stable object (same ref when state unchanged)
 */
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '@/integrations/supabase/client';
import { getValidAccessToken } from '@/lib/getValidAccessToken';

export interface ExtractionState {
  running: boolean;
  processed: number;
  total: number;
  error: string | null;
  stats: { ready: number; pending: number; total: number } | null;
}

type Listener = () => void;

let state: ExtractionState = {
  running: false,
  processed: 0,
  total: 0,
  error: null,
  stats: null,
};

// Frozen snapshot — only replaced when state actually changes
let snapshot: ExtractionState = { ...state };

const listeners = new Set<Listener>();

function emit() {
  // Create a new frozen snapshot so React detects the change
  snapshot = { ...state };
  listeners.forEach((l) => l());
}

/** useSyncExternalStore-compatible: returns the same object ref until state changes */
export function getExtractionState(): ExtractionState {
  return snapshot;
}

/** useSyncExternalStore-compatible: must NOT call listener during subscribe */
export function subscribeExtraction(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export async function loadExtractionStats(companyId: string, invoiceCount: number) {
  try {
    const token = await getValidAccessToken();
    const res = await fetch(`${SUPABASE_URL}/functions/v1/invoice-extract-summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ company_id: companyId, batch_size: 0 }),
    });
    const data = await res.json();
    if (res.ok) {
      state = {
        ...state,
        stats: {
          ready: invoiceCount - (data.total_pending || 0),
          pending: data.total_pending || 0,
          total: invoiceCount,
        },
      };
      emit();
    }
  } catch { /* ignore */ }
}

export async function startExtraction(companyId: string, invoiceCount: number) {
  if (state.running) return;

  state = { running: true, processed: 0, total: invoiceCount, error: null, stats: state.stats };
  emit();

  let totalProcessed = 0;
  try {
    const token = await getValidAccessToken();
    while (true) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/invoice-extract-summary`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ company_id: companyId, batch_size: 50 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      totalProcessed += (data.processed || 0);
      state = {
        ...state,
        processed: totalProcessed,
        total: totalProcessed + (data.total_pending || 0),
      };
      emit();

      if ((data.total_pending || 0) <= 0) break;
    }

    // Refresh stats after completion
    await loadExtractionStats(companyId, invoiceCount);
  } catch (e: any) {
    const msg = e?.message || String(e);
    console.error('[Invoice Extraction]', msg);
    state = { ...state, error: msg };
    emit();
  }

  state = { ...state, running: false };
  emit();
}
