// src/lib/aiSearch.ts
// AI-powered invoice search — calls Edge Function + applies filters locally
import { supabase } from '@/integrations/supabase/client';
import type { DBInvoice } from './invoiceSaver';

export interface AISearchFilter {
  counterparty_patterns?: string[];
  line_patterns?: string[];
  date_from?: string;
  date_to?: string;
  doc_types?: string[];
  amount_min?: number;
  amount_max?: number;
  payment_status?: string[];
  number_pattern?: string;
}

export interface AISearchResult {
  ids: string[];
  filter: AISearchFilter;
  raw?: string;
}

/**
 * Converts an ILIKE pattern (SQL-style %term%) to a JavaScript RegExp
 */
function ilike2regex(pattern: string): RegExp {
  // Escape regex special chars except %, then replace % with .*
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // escape all
    .replace(/%/g, '.*');                      // % → .*
  return new RegExp(escaped, 'i');
}

/**
 * AI-powered invoice search
 * 1. Sends natural language query to Edge Function (Haiku)
 * 2. Gets back structured filter JSON
 * 3. Applies filters locally on loaded invoices
 * 4. For line-item searches, queries invoice_lines via Supabase
 */
export async function aiSearchInvoices(
  query: string,
  allInvoices: DBInvoice[]
): Promise<AISearchResult> {
  // 1. Call Edge Function
  const { data, error } = await supabase.functions.invoke('ai-search-invoices', {
    body: { query },
  });

  if (error) throw new Error(error.message || 'Errore ricerca AI');
  if (!data?.filter) throw new Error('Filtro AI vuoto');

  const f: AISearchFilter = data.filter;
  let results = [...allInvoices];

  // 2. Apply local filters

  // Counterparty name patterns
  if (f.counterparty_patterns?.length) {
    const pats = f.counterparty_patterns.map(ilike2regex);
    results = results.filter(inv => {
      const denom = (inv.counterparty as any)?.denom || '';
      return pats.some(p => p.test(denom));
    });
  }

  // Date range
  if (f.date_from) results = results.filter(i => i.date >= f.date_from!);
  if (f.date_to) results = results.filter(i => i.date <= f.date_to!);

  // Amount range
  if (f.amount_min != null) results = results.filter(i => i.total_amount >= f.amount_min!);
  if (f.amount_max != null) results = results.filter(i => i.total_amount <= f.amount_max!);

  // Document type
  if (f.doc_types?.length) results = results.filter(i => f.doc_types!.includes(i.doc_type));

  // Payment status
  if (f.payment_status?.length) results = results.filter(i => f.payment_status!.includes(i.payment_status));

  // Invoice number
  if (f.number_pattern) {
    const pat = ilike2regex(f.number_pattern);
    results = results.filter(i => pat.test(i.number));
  }

  // 3. Line-item search (requires DB query)
  if (f.line_patterns?.length) {
    try {
      // Build OR filter for PostgREST: description.ilike.%term1%,description.ilike.%term2%
      const orFilter = f.line_patterns.map(p => `description.ilike.${p}`).join(',');
      const { data: lines, error: lineErr } = await supabase
        .from('invoice_lines')
        .select('invoice_id')
        .or(orFilter);

      if (!lineErr && lines?.length) {
        const lineInvoiceIds = new Set(lines.map((l: any) => l.invoice_id));

        // If we also have other filters, intersect; otherwise use line results only
        if (f.counterparty_patterns?.length || f.date_from || f.date_to ||
            f.amount_min != null || f.amount_max != null || f.doc_types?.length ||
            f.payment_status?.length || f.number_pattern) {
          // Intersect: keep only invoices that match BOTH local filters AND line search
          results = results.filter(i => lineInvoiceIds.has(i.id));
        } else {
          // Line search is the only criterion — filter allInvoices by matching IDs
          results = allInvoices.filter(i => lineInvoiceIds.has(i.id));
        }
      } else if (!f.counterparty_patterns?.length && !f.date_from && !f.date_to &&
                 f.amount_min == null && f.amount_max == null && !f.doc_types?.length &&
                 !f.payment_status?.length && !f.number_pattern) {
        // Line search was the only criterion and returned nothing
        results = [];
      }
    } catch (e) {
      console.warn('Line search failed, using other filters only:', e);
    }
  }

  return {
    ids: results.map(i => i.id),
    filter: f,
    raw: data.raw,
  };
}
