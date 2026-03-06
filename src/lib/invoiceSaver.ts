// src/lib/invoiceSaver.ts
// Salvataggio, caricamento, eliminazione e modifica fatture su Supabase
// Schema REALE: id, company_id, counterparty_id, counterparty(jsonb), direction, doc_type,
// number, date, currency, total_amount, taxable_amount, tax_amount, withholding_amount,
// stamp_amount, payment_method, payment_terms, payment_due_date, payment_status,
// reconciliation_status, sdi_id, notes, raw_xml, xml_version, parse_method,
// source_filename, import_batch_id, xml_hash, created_at, updated_at
import { supabase } from '@/integrations/supabase/client';
import { resolveOrCreateCounterpartyFromInvoice } from './counterpartyService';
import { normalizeVatError, recomputeVatPeriodsIncremental, syncVatEntriesForInvoicesBatch } from './vat';
import { syncInstallmentsForInvoice, syncInstallmentsForInvoicesBatch } from './scadenzario';

// ============================================================
// TYPES
// ============================================================
export interface DBInvoice {
  id: string;
  company_id: string;
  counterparty_id: string | null;
  counterparty_status_snapshot: string | null;
  counterparty: {
    denom: string;
    piva: string;
    cf: string;
    sede: string;
  } | null;
  direction: string;
  doc_type: string;
  number: string;
  date: string;
  currency: string;
  total_amount: number;
  taxable_amount: number | null;
  tax_amount: number | null;
  withholding_amount: number | null;
  stamp_amount: number | null;
  payment_method: string;
  payment_terms: string;
  payment_due_date: string | null;
  paid_date: string | null;
  payment_status: string;
  reconciliation_status: string;
  sdi_id: string;
  notes: string;
  source_filename: string;
  parse_method: string;
  xml_hash: string | null;
  classification_status: 'none' | 'ai_suggested' | 'confirmed';
  created_at: string;
}

export interface DBInvoiceDetail extends DBInvoice {
  raw_xml: string;
  invoice_lines: {
    id: string;
    line_number: number;
    description: string;
    quantity: number;
    unit_price: number;
    total_price: number;
    vat_rate: number;
    vat_nature: string;
    article_code: string;
  }[];
}

export interface InvoiceUpdate {
  number?: string;
  date?: string;
  total_amount?: number;
  payment_status?: string;
  payment_due_date?: string | null;
  paid_date?: string | null;
  payment_method?: string;
  notes?: string;
}

// ============================================================
// HASH per deduplicazione
// ============================================================
async function hashXml(xml: string): Promise<string> {
  const enc = new TextEncoder().encode(xml);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function minIsoDate(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

// ============================================================
// SAVE — salva fatture parsate su DB
// ============================================================
export async function saveInvoicesToDB(
  companyId: string,
  parsedResults: any[],
  onProgress?: (current: number, total: number, status: 'ok' | 'duplicate' | 'error', filename: string) => void
): Promise<{ saved: number; duplicates: number; errors: { fn: string; err: string }[] }> {
  let saved = 0;
  let duplicates = 0;
  const errors: { fn: string; err: string }[] = [];
  const savedInvoiceIds: string[] = [];
  const parsedByInvoiceId: Record<string, any> = {};

  // Fetch company PIVA/CF to auto-detect direction
  let companyPiva = '';
  let companyCf = '';
  try {
    const { data: comp } = await supabase.from('companies').select('vat_number, fiscal_code').eq('id', companyId).single();
    if (comp) { companyPiva = (comp.vat_number || '').replace(/\s/g, ''); companyCf = (comp.fiscal_code || '').replace(/\s/g, ''); }
  } catch {}

  for (let i = 0; i < parsedResults.length; i++) {
    const r = parsedResults[i];
    if (r.err || !r.data) {
      errors.push({ fn: r.fn, err: r.err || 'Nessun dato' });
      onProgress?.(i + 1, parsedResults.length, 'error', r.fn);
      continue;
    }

    try {
      const xmlHash = await hashXml(r.rawXml);
      const b = r.data.bodies[0];
      if (!b) throw new Error('Nessun body nella fattura');

      // Determina stato pagamento (DB values: pending, overdue, paid, partial)
      let paymentStatus = 'pending';
      const paymentDue = b.pagamenti?.[0]?.scadenza || null;
      if (paymentDue) {
        const due = new Date(paymentDue);
        if (due < new Date()) paymentStatus = 'overdue';
      }

      // Estrai denom con fallback robusto (gestisce CDATA, Nome/Cognome, etc.)
      const cedPiva = (r.data.ced.piva || '').replace(/\s/g, '');
      const cedCf = (r.data.ced.cf || '').replace(/\s/g, '');
      const cesPiva = (r.data.ces.piva || '').replace(/\s/g, '');
      const cesCf = (r.data.ces.cf || '').replace(/\s/g, '');

      // Auto-detect direction: if company is cedente → out (attiva), else → in (passiva)
      const companyIsCedente = (companyPiva && cedPiva.includes(companyPiva.replace(/^IT/i, ''))) ||
                               (companyCf && cedCf === companyCf);
      const direction = companyIsCedente ? 'out' : 'in';

      // Counterparty = the OTHER party (not the company)
      const cpSource = companyIsCedente ? r.data.ces : r.data.ced;
      const rawDenom = (cpSource.denom || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
      const counterpartyData = {
        denom: rawDenom || r.fn.replace(/\.xml(\.p7m)?$/i, '').replace(/^IT\d+_/, ''),
        piva: cpSource.piva,
        cf: cpSource.cf,
        sede: cpSource.sede,
      };
      const resolved = await resolveOrCreateCounterpartyFromInvoice(
        companyId,
        {
          name: counterpartyData.denom,
          vat_number: counterpartyData.piva,
          fiscal_code: counterpartyData.cf,
          address: counterpartyData.sede,
          source_context: 'invoice_import',
        },
        direction as 'in' | 'out',
      );

      let taxableAmount = 0;
      let taxAmount = 0;
      if (b.riepilogo) {
        for (const rie of b.riepilogo) {
          taxableAmount += parseFloat(rie.imponibile) || 0;
          taxAmount += parseFloat(rie.imposta) || 0;
        }
      }

      // Calcola sconto/maggiorazione totale
      let scontoImporto = 0;
      if (b.sconti?.length) {
        for (const s of b.sconti) {
          const imp = parseFloat(s.importo) || 0;
          scontoImporto += s.tipo === 'SC' ? imp : -imp; // SC=sconto(sottrai), MG=maggiorazione(aggiungi)
        }
      }

      // total_amount: usa ImportoTotaleDocumento se presente, altrimenti calcola
      const totalFromXml = parseFloat(b.totale);
      const totalAmount = !isNaN(totalFromXml) && b.totale !== ''
        ? totalFromXml
        : Math.max(0, taxableAmount + taxAmount - scontoImporto);

      // Insert fattura
      const { data: inv, error: invErr } = await supabase
        .from('invoices')
        .insert({
          company_id: companyId,
          direction: direction,  // in=ricevuta(passiva), out=emessa(attiva)
          doc_type: b.tipo || 'TD01',
          number: b.numero || '',
          date: b.data || new Date().toISOString().split('T')[0],
          currency: b.divisa || 'EUR',
          total_amount: totalAmount,
          taxable_amount: taxableAmount || null,
          tax_amount: taxAmount || null,
          withholding_amount: b.ritenuta?.importo ? parseFloat(b.ritenuta.importo) : null,
          stamp_amount: b.bollo?.importo ? parseFloat(b.bollo.importo) : null,
          counterparty_id: resolved.counterpartyId,
          counterparty_status_snapshot: resolved.status,
          counterparty: counterpartyData,
          payment_status: paymentStatus,
          payment_method: b.pagamenti?.[0]?.modalita || '',
          payment_terms: b.condPag || '',
          payment_due_date: paymentDue,
          paid_date: null,
          raw_xml: r.rawXml,
          xml_version: r.data.ver || '',
          source_filename: r.fn,
          parse_method: r.method,
          notes: b.causali?.join(' | ') || '',
          xml_hash: xmlHash,
        })
        .select('id')
        .single();

      if (invErr) {
        if (invErr.code === '23505' || invErr.message?.includes('duplicate') || invErr.message?.includes('xml_hash')) {
          duplicates++;
          onProgress?.(i + 1, parsedResults.length, 'duplicate', r.fn);
          continue;
        }
        throw new Error(invErr.message);
      }

      // Insert righe dettaglio
      if (inv?.id && b.linee?.length > 0) {
        const lines = b.linee.map((l: any) => ({
          invoice_id: inv.id,
          line_number: parseInt(l.numero) || 0,
          description: l.descrizione || '',
          quantity: parseFloat(l.quantita) || 1,
          unit_price: parseFloat(l.prezzoUnitario) || 0,
          total_price: parseFloat(l.prezzoTotale) || 0,
          vat_rate: parseFloat(l.aliquotaIVA) || 0,
          vat_nature: l.natura || '',
          article_code: l.codiceArticolo || '',
        }));

        const { error: linesErr } = await supabase
          .from('invoice_lines')
          .insert(lines);

        if (linesErr) {
          console.warn('Errore inserimento righe per', r.fn, linesErr.message);
        }
      }

      if (inv?.id) {
        savedInvoiceIds.push(String(inv.id));
        parsedByInvoiceId[String(inv.id)] = r.data;
      }
      saved++;
      onProgress?.(i + 1, parsedResults.length, 'ok', r.fn);
    } catch (e: any) {
      errors.push({ fn: r.fn, err: e.message });
      onProgress?.(i + 1, parsedResults.length, 'error', r.fn);
    }
  }

  if (savedInvoiceIds.length > 0) {
    try {
      await syncInstallmentsForInvoicesBatch(companyId, savedInvoiceIds, parsedByInvoiceId);
    } catch (e: any) {
      errors.push({
        fn: 'SCADENZARIO_SYNC',
        err: e.message || 'Errore sincronizzazione rate scadenzario',
      });
    }

    try {
      const vatSync = await syncVatEntriesForInvoicesBatch(companyId, savedInvoiceIds);
      if (vatSync.global_min_effective_date_impacted) {
        await recomputeVatPeriodsIncremental(companyId, vatSync.global_min_effective_date_impacted);
      }
    } catch (e: any) {
      const vatError = normalizeVatError(e);
      errors.push({
        fn: 'VAT_SYNC',
        err: `${vatError.message}${vatError.code ? ` [${vatError.code}]` : ''}`,
      });
    }
  }

  return { saved, duplicates, errors };
}

// ============================================================
// LOAD — carica lista fatture con filtri e paginazione
// ============================================================
const INVOICE_LIST_COLS = 'id, company_id, counterparty_id, counterparty_status_snapshot, counterparty, direction, doc_type, number, date, currency, total_amount, taxable_amount, tax_amount, withholding_amount, stamp_amount, payment_method, payment_terms, payment_due_date, paid_date, payment_status, reconciliation_status, sdi_id, notes, source_filename, parse_method, xml_hash, extraction_status, classification_status, created_at';

export interface InvoiceFilters {
  direction?: 'all' | 'in' | 'out';
  status?: 'all' | 'pending' | 'overdue' | 'paid';
  dateFrom?: string;
  dateTo?: string;
  query?: string;
  candidateIds?: string[];
  amountMin?: number;
  amountMax?: number;
  counterpartyPattern?: string;
  classificationStatus?: 'ai_suggested';
}

export async function loadInvoices(
  companyId: string,
  filters?: InvoiceFilters,
  pagination?: { page: number; pageSize: number },
): Promise<{ data: DBInvoice[]; count: number }> {
  const page = pagination?.page ?? 0;
  const pageSize = pagination?.pageSize ?? 50;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let q = supabase.from('invoices')
    .select(INVOICE_LIST_COLS, { count: 'exact' })
    .eq('company_id', companyId);

  let overrideCount: number | null = null;

  if (filters?.candidateIds?.length) {
    // Sentinel UUID → guaranteed empty result
    const SENTINEL = '00000000-0000-0000-0000-000000000000';
    if (filters.candidateIds.length === 1 && filters.candidateIds[0] === SENTINEL) {
      return { data: [], count: 0 };
    }
    // Paginate through candidateIds client-side: pass only the current page
    // slice to .in() to avoid exceeding PostgREST URL length limits (~8KB).
    const pageIds = filters.candidateIds.slice(from, to + 1);
    if (pageIds.length === 0) {
      return { data: [], count: filters.candidateIds.length };
    }
    q = q.in('id', pageIds);
    overrideCount = filters.candidateIds.length;
  } else {
    if (filters?.direction && filters.direction !== 'all') {
      q = q.eq('direction', filters.direction);
    }
    if (filters?.status && filters.status !== 'all') {
      q = q.eq('payment_status', filters.status);
    }
    if (filters?.dateFrom) q = q.gte('date', filters.dateFrom);
    if (filters?.dateTo) q = q.lte('date', filters.dateTo);
    if (filters?.query) {
      const p = `%${filters.query}%`;
      q = q.or(`number.ilike.${p},source_filename.ilike.${p},counterparty->>denom.ilike.${p},counterparty->>name.ilike.${p}`);
    }
    // Amount range (total_amount is always positive — no ABS needed)
    if (filters?.amountMin != null) q = q.gte('total_amount', filters.amountMin);
    if (filters?.amountMax != null) q = q.lte('total_amount', filters.amountMax);
    // Counterparty name pattern
    if (filters?.counterpartyPattern) {
      q = q.ilike('counterparty->>denom', `%${filters.counterpartyPattern}%`);
    }
    // AI suggestion status filter
    if (filters?.classificationStatus) {
      q = q.eq('classification_status', filters.classificationStatus);
    }
  }

  // When candidateIds pagination is active, skip .range() — pagination is handled by ID slicing
  q = q.order('date', { ascending: false });
  if (overrideCount == null) q = q.range(from, to);

  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  const rows = (data || []) as DBInvoice[];

  // Enrich counterparty status
  const hasLinkedCounterparty = rows.some((r) => Boolean(r.counterparty_id));
  const totalCount = overrideCount ?? count ?? 0;
  if (!hasLinkedCounterparty) return { data: rows, count: totalCount };

  const { data: statuses, error: statusErr } = await supabase
    .from('counterparties')
    .select('id, status')
    .eq('company_id', companyId);

  if (statusErr || !statuses) return { data: rows, count: totalCount };

  const statusMap = new Map<string, string>(
    statuses
      .filter((s: any) => s?.id && s?.status)
      .map((s: any) => [String(s.id), String(s.status)]),
  );

  const enriched = rows.map((row) => ({
    ...row,
    counterparty_status_snapshot: row.counterparty_id
      ? (statusMap.get(row.counterparty_id) || row.counterparty_status_snapshot)
      : row.counterparty_status_snapshot,
  }));

  return { data: enriched, count: totalCount };
}

/* ─── Classification metadata for invoice list icons ──── */

export interface InvoiceClassificationMeta {
  line_count: number
  assigned_count: number    // verified=true article assignments
  has_category: boolean
  has_account: boolean
  has_cost_center: boolean
}

/**
 * Load lightweight classification metadata for a batch of invoices.
 * Used to show 📦🏷️🏗️📒 icons in the sidebar invoice list.
 * Runs 4 parallel queries per batch of 100 IDs.
 */
export async function loadInvoiceClassificationMeta(
  companyId: string,
  invoiceIds: string[],
): Promise<Map<string, InvoiceClassificationMeta>> {
  if (invoiceIds.length === 0) return new Map()

  const result = new Map<string, InvoiceClassificationMeta>()
  const BATCH = 100

  for (let i = 0; i < invoiceIds.length; i += BATCH) {
    const batchIds = invoiceIds.slice(i, i + BATCH)

    const [linesRes, assignedRes, classifRes, projRes] = await Promise.all([
      // 1. Line count per invoice
      supabase
        .from('invoice_lines')
        .select('invoice_id')
        .in('invoice_id', batchIds),
      // 2. Assigned (verified=true) count per invoice
      supabase
        .from('invoice_line_articles')
        .select('invoice_id')
        .eq('company_id', companyId)
        .eq('verified', true)
        .in('invoice_id', batchIds),
      // 3. Invoice classifications (category + account)
      supabase
        .from('invoice_classifications')
        .select('invoice_id, category_id, account_id')
        .in('invoice_id', batchIds),
      // 4. Invoice projects (cost centers)
      supabase
        .from('invoice_projects')
        .select('invoice_id')
        .in('invoice_id', batchIds),
    ])

    // Count lines per invoice
    const lineCounts = new Map<string, number>()
    for (const row of (linesRes.data || [])) {
      lineCounts.set(row.invoice_id, (lineCounts.get(row.invoice_id) || 0) + 1)
    }

    // Count assigned per invoice
    const assignedCounts = new Map<string, number>()
    for (const row of (assignedRes.data || [])) {
      assignedCounts.set(row.invoice_id, (assignedCounts.get(row.invoice_id) || 0) + 1)
    }

    // Category/account per invoice
    const classifMap = new Map<string, { has_category: boolean; has_account: boolean }>()
    for (const row of (classifRes.data || []) as any[]) {
      classifMap.set(row.invoice_id, {
        has_category: !!row.category_id,
        has_account: !!row.account_id,
      })
    }

    // Cost center per invoice
    const projSet = new Set<string>()
    for (const row of (projRes.data || [])) {
      projSet.add(row.invoice_id)
    }

    // Merge for each invoice in this batch
    for (const id of batchIds) {
      const lc = lineCounts.get(id) || 0
      const ac = assignedCounts.get(id) || 0
      const cf = classifMap.get(id)
      result.set(id, {
        line_count: lc,
        assigned_count: ac,
        has_category: cf?.has_category || false,
        has_account: cf?.has_account || false,
        has_cost_center: projSet.has(id),
      })
    }
  }

  return result
}

/** Load invoice stats (counts by status) — lightweight HEAD queries */
export async function loadInvoiceStats(
  companyId: string,
  filters?: Omit<InvoiceFilters, 'candidateIds'>,
): Promise<{ total: number; daPagare: number; scadute: number; pagate: number }> {
  const buildQ = (status?: string) => {
    let q = supabase.from('invoices').select('id', { count: 'exact', head: true }).eq('company_id', companyId);
    if (filters?.direction && filters.direction !== 'all') q = q.eq('direction', filters.direction);
    if (filters?.dateFrom) q = q.gte('date', filters.dateFrom);
    if (filters?.dateTo) q = q.lte('date', filters.dateTo);
    if (filters?.query) { const p = `%${filters.query}%`; q = q.or(`number.ilike.${p},source_filename.ilike.${p},counterparty->>denom.ilike.${p},counterparty->>name.ilike.${p}`); }
    if (filters?.amountMin != null) q = q.gte('total_amount', filters.amountMin);
    if (filters?.amountMax != null) q = q.lte('total_amount', filters.amountMax);
    if (filters?.counterpartyPattern) q = q.ilike('counterparty->>denom', `%${filters.counterpartyPattern}%`);
    if (status) q = q.eq('payment_status', status);
    return q;
  };
  const [total, pending, overdue, paid] = await Promise.all([
    buildQ(), buildQ('pending'), buildQ('overdue'), buildQ('paid'),
  ]);
  return {
    total: total.count ?? 0,
    daPagare: pending.count ?? 0,
    scadute: overdue.count ?? 0,
    pagate: paid.count ?? 0,
  };
}

// ─── Server-side KPI aggregates (via RPC) ────────────────────

export interface InvoiceAggregates {
  total_count: number;
  pending_count: number;
  overdue_count: number;
  paid_count: number;
  total_amount: number;
  counterparty_count: number;
}

export async function fetchInvoiceAggregates(
  companyId: string,
  filters?: InvoiceFilters,
): Promise<InvoiceAggregates> {
  const params: Record<string, unknown> = { p_company_id: companyId };

  if (filters?.candidateIds?.length) {
    params.p_candidate_ids = filters.candidateIds;
  } else {
    params.p_direction = filters?.direction || 'all';
    params.p_status = filters?.status || 'all';
    if (filters?.dateFrom) params.p_date_from = filters.dateFrom;
    if (filters?.dateTo) params.p_date_to = filters.dateTo;
    if (filters?.query) params.p_query = filters.query;
  }

  // Amount / counterparty filters (applied regardless of candidateIds mode)
  if (filters?.amountMin != null) params.p_amount_min = filters.amountMin;
  if (filters?.amountMax != null) params.p_amount_max = filters.amountMax;
  if (filters?.counterpartyPattern) params.p_counterparty_pattern = filters.counterpartyPattern;

  const { data, error } = await supabase.rpc('invoice_aggregates', params);
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    total_count: Number(row?.total_count || 0),
    pending_count: Number(row?.pending_count || 0),
    overdue_count: Number(row?.overdue_count || 0),
    paid_count: Number(row?.paid_count || 0),
    total_amount: Number(row?.total_amount || 0),
    counterparty_count: Number(row?.counterparty_count || 0),
  };
}

// ============================================================
// LOAD DETAIL — carica fattura singola con righe
// ============================================================
export async function loadInvoiceDetail(invoiceId: string): Promise<DBInvoiceDetail | null> {
  const { data: inv, error: invErr } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .single();

  if (invErr || !inv) return null;

  const { data: lines } = await supabase
    .from('invoice_lines')
    .select('*')
    .eq('invoice_id', invoiceId)
    .order('line_number', { ascending: true });

  return { ...inv, invoice_lines: lines || [] } as DBInvoiceDetail;
}

// ============================================================
// DELETE — elimina fatture (con righe associate)
// ============================================================
export async function deleteInvoices(invoiceIds: string[]): Promise<{ deleted: number; errors: string[] }> {
  let deleted = 0;
  const errors: string[] = [];
  const normalizedIds = Array.from(new Set(invoiceIds.map((id) => String(id || '').trim()).filter(Boolean)));
  if (!normalizedIds.length) return { deleted: 0, errors };

  const { data: invoicesToDelete, error: beforeInvErr } = await supabase
    .from('invoices')
    .select('id, company_id, date')
    .in('id', normalizedIds);

  if (beforeInvErr) {
    errors.push(`Errore lettura fatture pre-delete: ${beforeInvErr.message}`);
  }

  const impactedByCompany = new Map<string, string | null>();
  for (const inv of (invoicesToDelete || []) as Array<{ id: string; company_id: string; date: string | null }>) {
    const companyId = String(inv.company_id || '');
    if (!companyId) continue;
    impactedByCompany.set(companyId, minIsoDate(impactedByCompany.get(companyId) || null, inv.date ? String(inv.date) : null));
  }

  for (let i = 0; i < normalizedIds.length; i += 500) {
    const chunk = normalizedIds.slice(i, i + 500);
    const { data: oldVatRows, error: oldVatErr } = await supabase
      .from('invoice_vat_entries')
      .select('company_id, effective_date, invoice_date')
      .eq('is_manual', false)
      .in('invoice_id', chunk);

    if (oldVatErr) {
      errors.push(`Errore lettura entries IVA pre-delete: ${oldVatErr.message}`);
      continue;
    }

    for (const row of (oldVatRows || []) as Array<{ company_id: string; effective_date: string | null; invoice_date: string | null }>) {
      const companyId = String(row.company_id || '');
      if (!companyId) continue;
      const impactedDate = row.effective_date || row.invoice_date || null;
      impactedByCompany.set(companyId, minIsoDate(impactedByCompany.get(companyId) || null, impactedDate));
    }
  }

  for (let i = 0; i < normalizedIds.length; i += 50) {
    const batch = normalizedIds.slice(i, i + 50);

    const { error: linesErr } = await supabase
      .from('invoice_lines')
      .delete()
      .in('invoice_id', batch);

    if (linesErr) {
      errors.push(`Errore eliminazione righe: ${linesErr.message}`);
    }

    const { error: invErr, count } = await supabase
      .from('invoices')
      .delete({ count: 'exact' })
      .in('id', batch);

    if (invErr) {
      errors.push(`Errore eliminazione fatture: ${invErr.message}`);
    } else {
      deleted += count || batch.length;
    }
  }

  for (const [companyId, impactedStart] of impactedByCompany.entries()) {
    if (!impactedStart) continue;
    try {
      await recomputeVatPeriodsIncremental(companyId, impactedStart);
    } catch (e: any) {
      const vatErr = normalizeVatError(e);
      errors.push(`Errore ricalcolo IVA post-delete (${companyId}): ${vatErr.message}${vatErr.code ? ` [${vatErr.code}]` : ''}`);
    }
  }

  return { deleted, errors };
}

// ============================================================
// UPDATE — modifica fattura
// ============================================================
export async function updateInvoice(invoiceId: string, updates: InvoiceUpdate): Promise<void> {
  const { data: beforeInvoice, error: beforeInvoiceErr } = await supabase
    .from('invoices')
    .select('id, company_id, date')
    .eq('id', invoiceId)
    .single();

  if (beforeInvoiceErr || !beforeInvoice) {
    throw new Error(beforeInvoiceErr?.message || 'Fattura non trovata');
  }

  let oldMinImpactedDate: string | null = null;
  const { data: oldVatRows, error: oldVatErr } = await supabase
    .from('invoice_vat_entries')
    .select('effective_date, invoice_date')
    .eq('company_id', beforeInvoice.company_id)
    .eq('is_manual', false)
    .eq('invoice_id', invoiceId);

  if (oldVatErr) throw new Error(oldVatErr.message);
  for (const row of (oldVatRows || []) as Array<{ effective_date: string | null; invoice_date: string | null }>) {
    oldMinImpactedDate = minIsoDate(oldMinImpactedDate, row.effective_date || row.invoice_date || null);
  }

  const payload: InvoiceUpdate = { ...updates };
  if (payload.payment_status === 'paid' && payload.paid_date === undefined) {
    payload.paid_date = new Date().toISOString().slice(0, 10);
  }
  if (payload.payment_status && payload.payment_status !== 'paid' && payload.paid_date === undefined) {
    payload.paid_date = null;
  }

  const { error } = await supabase
    .from('invoices')
    .update(payload)
    .eq('id', invoiceId);

  if (error) throw new Error(error.message);

  await syncInstallmentsForInvoice(beforeInvoice.company_id, invoiceId);

  const vatSync = await syncVatEntriesForInvoicesBatch(beforeInvoice.company_id, [invoiceId]);
  const impactedStart = minIsoDate(
    minIsoDate(oldMinImpactedDate, vatSync.global_min_effective_date_impacted),
    beforeInvoice.date ? String(beforeInvoice.date) : null,
  );

  if (impactedStart) {
    await recomputeVatPeriodsIncremental(beforeInvoice.company_id, impactedStart);
  }
}

// ============================================================
// VERIFY PASSWORD — ri-autenticazione per operazioni sensibili
// ============================================================
export async function verifyPassword(password: string): Promise<boolean> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return false;

  const { error } = await supabase.auth.signInWithPassword({
    email: user.email,
    password,
  });

  return !error;
}

// ============================================================
// FIX ALL — ri-estrae counterparty e direction dal raw_xml
// Usa il parser reale, non regex SQL
// ============================================================
export async function fixAllCounterparties(
  companyId: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ fixed: number; errors: number }> {
  // 1. Get company P.IVA
  const { data: comp } = await supabase.from('companies').select('vat_number, fiscal_code').eq('id', companyId).single();
  const companyPiva = (comp?.vat_number || '').replace(/\s/g, '').replace(/^IT/i, '');
  const companyCf = (comp?.fiscal_code || '').replace(/\s/g, '');

  // 2. Load all invoice IDs
  const { data: allInvs } = await supabase
    .from('invoices')
    .select('id')
    .eq('company_id', companyId)
    .order('date', { ascending: false });

  if (!allInvs?.length) return { fixed: 0, errors: 0 };

  const { reparseXml } = await import('./invoiceParser');
  let fixed = 0, errors = 0;

  // 3. Process in batches of 20
  for (let i = 0; i < allInvs.length; i += 20) {
    const batchIds = allInvs.slice(i, i + 20).map(inv => inv.id);
    const { data: batch } = await supabase
      .from('invoices')
      .select('id, raw_xml')
      .in('id', batchIds);

    if (!batch) continue;

    for (const inv of batch) {
      if (!inv.raw_xml) { errors++; continue; }
      try {
        const parsed = reparseXml(inv.raw_xml);
        const cedPiva = (parsed.ced.piva || '').replace(/^IT/i, '');
        const cedCf = parsed.ced.cf || '';

        // Direction: if company is cedente → out (attiva)
        const isOut = (companyPiva && cedPiva.includes(companyPiva)) ||
                      (companyCf && cedCf === companyCf);
        const direction = isOut ? 'out' : 'in';

        // Counterparty = the OTHER party
        const cp = isOut ? parsed.ces : parsed.ced;
        const counterparty = {
          denom: cp.denom || '',
          piva: cp.piva || '',
          cf: cp.cf || '',
          sede: cp.sede || '',
        };

        await supabase.from('invoices').update({ direction, counterparty }).eq('id', inv.id);
        fixed++;
      } catch {
        errors++;
      }
    }

    onProgress?.(Math.min(i + 20, allInvs.length), allInvs.length);
  }

  return { fixed, errors };
}

// ============================================================
// FIX ALL TOTALS — ricalcola total_amount da raw_xml per
// tutte le fatture con totale = 0 (es. fatture con sconto)
// ============================================================
export async function fixAllTotals(
  companyId: string,
  onProgress?: (current: number, total: number) => void
): Promise<{ fixed: number; errors: number }> {
  const { data: allInvs } = await supabase
    .from('invoices')
    .select('id')
    .eq('company_id', companyId)
    .eq('total_amount', 0);

  if (!allInvs?.length) return { fixed: 0, errors: 0 };

  const { reparseXml } = await import('./invoiceParser');
  let fixed = 0, errors = 0;

  for (let i = 0; i < allInvs.length; i += 20) {
    const batchIds = allInvs.slice(i, i + 20).map(inv => inv.id);
    const { data: batch } = await supabase
      .from('invoices')
      .select('id, raw_xml')
      .in('id', batchIds);

    if (!batch) continue;

    for (const inv of batch) {
      if (!inv.raw_xml) { errors++; continue; }
      try {
        const parsed = reparseXml(inv.raw_xml);
        const b = parsed.bodies[0];
        if (!b) { errors++; continue; }

        let taxableAmount = 0, taxAmount = 0;
        for (const r of b.riepilogo || []) {
          taxableAmount += parseFloat(r.imponibile) || 0;
          taxAmount += parseFloat(r.imposta) || 0;
        }

        let scontoImporto = 0;
        for (const s of b.sconti || []) {
          const imp = parseFloat(s.importo) || 0;
          scontoImporto += s.tipo === 'SC' ? imp : -imp;
        }

        const totalFromXml = parseFloat(b.totale);
        const totalAmount = !isNaN(totalFromXml) && b.totale !== ''
          ? totalFromXml
          : Math.max(0, taxableAmount + taxAmount - scontoImporto);

        await supabase.from('invoices').update({
          total_amount: totalAmount,
          taxable_amount: taxableAmount || null,
          tax_amount: taxAmount || null,
        }).eq('id', inv.id);
        fixed++;
      } catch { errors++; }
    }
    onProgress?.(Math.min(i + 20, allInvs.length), allInvs.length);
  }
  return { fixed, errors };
}
