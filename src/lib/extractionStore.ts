/**
 * Module-level singleton store for invoice AI extraction/classification.
 * Survives React component unmounts so the extraction loop
 * keeps running even when the user navigates away from FatturePage.
 *
 * Now uses runClassificationPipeline (v2 cascade) instead of classify-invoice-lines.
 *
 * Compatible with React's useSyncExternalStore:
 * - subscribe must NOT call the listener during subscription
 * - getSnapshot must return a referentially stable object (same ref when state unchanged)
 */
import { supabase } from '@/integrations/supabase/client';
import { runClassificationPipeline } from '@/lib/classificationPipelineService';

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
    const { count, error } = await supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .or('classification_status.is.null,classification_status.eq.pending');
    if (!error) {
      const pending = count || 0;
      state = {
        ...state,
        stats: {
          ready: invoiceCount - pending,
          pending,
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

  const BATCH_SIZE = 10;
  let totalProcessed = 0;
  try {
    while (true) {
      // Fetch a batch of unclassified invoices with their lines
      const { data: pendingInvoices, error: fetchErr } = await supabase
        .from('invoices')
        .select('id, counterparty, direction')
        .eq('company_id', companyId)
        .or('classification_status.is.null,classification_status.eq.pending')
        .limit(BATCH_SIZE);

      if (fetchErr) throw new Error(fetchErr.message);
      if (!pendingInvoices || pendingInvoices.length === 0) break;

      // Classify each invoice via pipeline v2 cascade
      for (const inv of pendingInvoices) {
        // Load invoice lines
        const { data: lines } = await supabase
          .from('invoice_lines')
          .select('id, description, quantity, unit_price, total_price')
          .eq('invoice_id', inv.id);

        if (!lines || lines.length === 0) {
          totalProcessed++;
          continue;
        }

        const cp = inv.counterparty as Record<string, string> | null;
        try {
          await runClassificationPipeline(
            companyId,
            inv.id,
            lines.map(l => ({
              line_id: l.id,
              description: l.description || '',
              quantity: l.quantity,
              unit_price: l.unit_price,
              total_price: l.total_price,
            })),
            (inv.direction || 'in') as 'in' | 'out',
            cp?.piva || null,
            cp?.denom || null,
          );
        } catch (err) {
          console.error(`[Extraction] pipeline v2 failed for ${inv.id}:`, err);
        }

        totalProcessed++;
        state = {
          ...state,
          processed: totalProcessed,
          total: totalProcessed + Math.max(0, (pendingInvoices.length - totalProcessed)),
        };
        emit();
      }

      // Re-count remaining after batch
      const { count } = await supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .or('classification_status.is.null,classification_status.eq.pending');

      const remaining = count || 0;
      state = {
        ...state,
        processed: totalProcessed,
        total: totalProcessed + remaining,
      };
      emit();

      if (remaining <= 0) break;
    }

    // Refresh stats after completion
    await loadExtractionStats(companyId, invoiceCount);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Invoice Extraction]', msg);
    state = { ...state, error: msg };
    emit();
  }

  state = { ...state, running: false };
  emit();
}
