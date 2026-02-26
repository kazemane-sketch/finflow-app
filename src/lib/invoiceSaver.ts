// src/lib/invoiceSaver.ts
// Salvataggio, caricamento, eliminazione e modifica fatture su Supabase
// Schema REALE: id, company_id, counterparty_id, counterparty(jsonb), direction, doc_type,
// number, date, currency, total_amount, taxable_amount, tax_amount, withholding_amount,
// stamp_amount, payment_method, payment_terms, payment_due_date, payment_status,
// reconciliation_status, sdi_id, notes, raw_xml, xml_version, parse_method,
// source_filename, import_batch_id, xml_hash, created_at, updated_at
import { supabase } from '@/integrations/supabase/client';

// ============================================================
// TYPES
// ============================================================
export interface DBInvoice {
  id: string;
  company_id: string;
  counterparty_id: string | null;
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
  payment_status: string;
  reconciliation_status: string;
  sdi_id: string;
  notes: string;
  source_filename: string;
  parse_method: string;
  xml_hash: string | null;
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

      // Calcola imponibile e imposta dai riepiloghi
      let taxableAmount = 0;
      let taxAmount = 0;
      if (b.riepilogo) {
        for (const rie of b.riepilogo) {
          taxableAmount += parseFloat(rie.imponibile) || 0;
          taxAmount += parseFloat(rie.imposta) || 0;
        }
      }

      // Insert fattura
      const { data: inv, error: invErr } = await supabase
        .from('invoices')
        .insert({
          company_id: companyId,
          direction: 'in',  // in=ricevuta, out=emessa
          doc_type: b.tipo || 'TD01',
          number: b.numero || '',
          date: b.data || new Date().toISOString().split('T')[0],
          currency: b.divisa || 'EUR',
          total_amount: parseFloat(b.totale) || 0,
          taxable_amount: taxableAmount || null,
          tax_amount: taxAmount || null,
          withholding_amount: b.ritenuta?.importo ? parseFloat(b.ritenuta.importo) : null,
          stamp_amount: b.bollo?.importo ? parseFloat(b.bollo.importo) : null,
          counterparty: {
            denom: r.data.ced.denom,
            piva: r.data.ced.piva,
            cf: r.data.ced.cf,
            sede: r.data.ced.sede,
          },
          payment_status: paymentStatus,
          payment_method: b.pagamenti?.[0]?.modalita || '',
          payment_terms: b.condPag || '',
          payment_due_date: paymentDue,
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

      saved++;
      onProgress?.(i + 1, parsedResults.length, 'ok', r.fn);
    } catch (e: any) {
      errors.push({ fn: r.fn, err: e.message });
      onProgress?.(i + 1, parsedResults.length, 'error', r.fn);
    }
  }

  return { saved, duplicates, errors };
}

// ============================================================
// LOAD — carica lista fatture
// ============================================================
export async function loadInvoices(companyId: string): Promise<DBInvoice[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, company_id, counterparty_id, counterparty, direction, doc_type, number, date, currency, total_amount, taxable_amount, tax_amount, withholding_amount, stamp_amount, payment_method, payment_terms, payment_due_date, payment_status, reconciliation_status, sdi_id, notes, source_filename, parse_method, xml_hash, created_at')
    .eq('company_id', companyId)
    .order('date', { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []) as DBInvoice[];
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

  for (let i = 0; i < invoiceIds.length; i += 50) {
    const batch = invoiceIds.slice(i, i + 50);

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

  return { deleted, errors };
}

// ============================================================
// UPDATE — modifica fattura
// ============================================================
export async function updateInvoice(invoiceId: string, updates: InvoiceUpdate): Promise<void> {
  const { error } = await supabase
    .from('invoices')
    .update(updates)
    .eq('id', invoiceId);

  if (error) throw new Error(error.message);
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
