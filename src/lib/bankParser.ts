// src/lib/bankParser.ts
// Invia il PDF completo all'edge function che usa Gemini Files API
// Nessun chunk, nessuna estrazione testo, nessun timeout

import { supabase } from '@/integrations/supabase/client';

const SUPABASE_URL = 'https://xtuofcwvimaffcpqboou.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh0dW9mY3d2aW1hZmZjcHFib291Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIwNjIyMTUsImV4cCI6MjA4NzYzODIxNX0.kShgRlGkLFkq08kW_Le5G8N0dVbidX08ho6WQ3n9kkw';

// ============================================================
// TYPES
// ============================================================
export interface BankTransaction {
  date: string;
  value_date?: string;
  amount: number;
  commission_amount?: number;
  net_amount?: number;
  balance?: number;
  description: string;
  counterparty_name?: string;
  counterparty_account?: string;
  transaction_type?: string;
  cbi_flow_id?: string;
  branch?: string;
  reference?: string;
  invoice_ref?: string;
  raw_text: string;
}

export interface BankParseResult {
  transactions: BankTransaction[];
  accountHolder?: string;
  iban?: string;
  bankName?: string;
  statementPeriod?: { from: string; to: string };
  openingBalance?: number;
  closingBalance?: number;
  pagesProcessed: number;
  errors: string[];
  failedChunks?: number[];
}

export interface BankParseProgress {
  phase: 'uploading' | 'extracting' | 'analyzing' | 'waiting' | 'saving' | 'done';
  current: number;
  total: number;
  message: string;
}

// Stub — chiave è server-side
export function getClaudeApiKey(): string { return 'server-side'; }
export function setClaudeApiKey(_key: string): void {}

// ============================================================
// MAIN PARSER — invia PDF base64 all'edge function
// ============================================================
export async function parseBankPdf(
  file: File,
  _apiKey: string,
  onProgress?: (p: BankParseProgress) => void
): Promise<BankParseResult> {

  onProgress?.({ phase: 'uploading', current: 0, total: 1, message: 'Lettura PDF...' });

  const buffer = await file.arrayBuffer();
  const base64 = btoa(
    new Uint8Array(buffer).reduce((d, b) => d + String.fromCharCode(b), '')
  );

  onProgress?.({ phase: 'analyzing', current: 0, total: 1, message: '📤 Upload su Gemini Files API...' });

  // Timeout 5 minuti — Gemini Files API è veloce ma il PDF può essere grande
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);

  let response: Response;
  try {
    response = await fetch(`${SUPABASE_URL}/functions/v1/parse-bank-pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ pdfBase64: base64 }),
      signal: controller.signal,
    });
  } catch (e: any) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') throw new Error('Timeout: il PDF potrebbe essere troppo grande. Prova con un estratto conto più corto.');
    throw new Error('Errore di rete: ' + e.message);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as any;
    throw new Error(err.error || `Errore server ${response.status}`);
  }

  // Legge SSE streaming dalla edge function
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let finalData: any = null;

  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n\n');
      buf = lines.pop() || '';

      for (const line of lines) {
        const dataLine = line.replace(/^data: /, '').trim();
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine);
          if (event.type === 'progress') {
            onProgress?.({
              phase: 'analyzing',
              current: event.found || 0,
              total: 0,
              message: event.message || '🤖 Gemini sta analizzando il PDF...',
            });
          } else if (event.type === 'done') {
            finalData = event;
          }
        } catch { /* skip */ }
      }
    }
  }

  if (!finalData) throw new Error('Nessuna risposta dalla edge function. Verifica che sia deployata su Supabase.');

  const result: BankParseResult = {
    transactions: [],
    pagesProcessed: finalData.count || 0,
    errors: [],
  };

  for (const t of (finalData.transactions || [])) {
    if (!t?.date || t?.amount == null) continue;
    const amount = parseFloat(String(t.amount)) || 0;
    const commission = t.commission != null && t.commission !== 0
      ? -Math.abs(parseFloat(String(t.commission)))
      : undefined;

    result.transactions.push({
      date: parseItalianDate(t.date),
      value_date: t.value_date ? parseItalianDate(t.value_date) : undefined,
      amount,
      commission_amount: commission,
      net_amount: commission ? amount - Math.abs(commission) : amount,
      balance: t.balance != null ? parseFloat(String(t.balance)) : undefined,
      description: String(t.description || '').trim(),
      counterparty_name: t.counterparty_name || undefined,
      counterparty_account: t.counterparty_account || undefined,
      transaction_type: t.transaction_type || 'altro',
      cbi_flow_id: t.cbi_flow_id || undefined,
      branch: t.branch || undefined,
      reference: t.reference || undefined,
      invoice_ref: t.invoice_ref || undefined,
      raw_text: String(t.raw_text || t.description || '').trim(),
    });
  }

  // Deduplica + ordina per data (più recente prima)
  const seen = new Set<string>();
  result.transactions = result.transactions
    .filter(t => {
      const k = `${t.date}|${t.amount}|${t.description.substring(0, 60)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  onProgress?.({
    phase: 'done',
    current: result.transactions.length,
    total: result.transactions.length,
    message: `✓ ${result.transactions.length} movimenti estratti`,
  });

  return result;
}

function parseItalianDate(d: string): string {
  if (!d) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const p = d.split(/[\/\-]/);
  if (p.length === 3) {
    const [a, b, c] = p;
    if (c.length === 4) return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
  }
  return d;
}

// ============================================================
// HASH deduplicazione
// ============================================================
async function hashTx(t: BankTransaction): Promise<string> {
  const s = `${t.date}|${t.amount}|${t.description.substring(0, 80)}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

// ============================================================
// SAVE / LOAD / DELETE
// ============================================================
export interface SaveBankResult { saved: number; duplicates: number; errors: string[] }

export async function saveBankTransactions(
  companyId: string,
  bankAccountId: string,
  transactions: BankTransaction[],
  importBatchId: string,
  onProgress?: (cur: number, tot: number) => void
): Promise<SaveBankResult> {
  let saved = 0, duplicates = 0;
  const errors: string[] = [];
  const CHUNK = 50;

  for (let i = 0; i < transactions.length; i += CHUNK) {
    const chunk = transactions.slice(i, i + CHUNK);
    const rows = await Promise.all(chunk.map(async t => ({
      company_id: companyId,
      bank_account_id: bankAccountId,
      import_batch_id: importBatchId,
      date: t.date,
      value_date: t.value_date || null,
      amount: t.amount,
      commission_amount: t.commission_amount ?? null,
      description: t.description,
      counterparty_name: t.counterparty_name || null,
      counterparty_account: t.counterparty_account || null,
      transaction_type: t.transaction_type || 'altro',
      cbi_flow_id: t.cbi_flow_id || null,
      branch: t.branch || null,
      reference: t.reference || null,
      invoice_ref: t.invoice_ref || null,
      raw_text: t.raw_text,
      hash: await hashTx(t),
      reconciliation_status: 'unmatched',
    })));

    const { error, data } = await supabase
      .from('bank_transactions')
      .upsert(rows, { onConflict: 'bank_account_id,hash', ignoreDuplicates: true })
      .select('id');

    if (error) errors.push(`Chunk ${Math.floor(i / CHUNK) + 1}: ${error.message}`);
    else {
      saved += data?.length || 0;
      duplicates += chunk.length - (data?.length || 0);
    }
    onProgress?.(Math.min(i + CHUNK, transactions.length), transactions.length);
  }
  return { saved, duplicates, errors };
}

export async function ensureBankAccount(
  companyId: string,
  info: { iban?: string; bankName?: string; accountHolder?: string }
): Promise<string> {
  if (info.iban) {
    const { data } = await supabase.from('bank_accounts').select('id')
      .eq('company_id', companyId).eq('iban', info.iban).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data: primary } = await supabase.from('bank_accounts').select('id')
    .eq('company_id', companyId).eq('is_primary', true).maybeSingle();
  if (primary?.id) return primary.id;

  const { data, error } = await supabase.from('bank_accounts').insert({
    company_id: companyId,
    name: info.bankName ? `${info.bankName}${info.iban ? ' — ...' + info.iban.slice(-4) : ''}` : 'Conto principale',
    bank_name: info.bankName || null,
    iban: info.iban || null,
    is_primary: true,
    currency: 'EUR',
  }).select('id').single();
  if (error) throw new Error('Errore conto: ' + error.message);
  return data.id;
}

export async function createImportBatch(companyId: string, filename: string): Promise<string> {
  const { data, error } = await supabase.from('import_batches')
    .insert({ company_id: companyId, type: 'bank_pdf', filename, status: 'processing' })
    .select('id').single();
  if (error) throw new Error('Errore batch: ' + error.message);
  return data.id;
}

export async function updateImportBatch(
  batchId: string,
  stats: { total: number; success: number; errors: number; error_details?: any }
): Promise<void> {
  await supabase.from('import_batches').update({
    status: stats.errors > 0 && stats.success === 0 ? 'failed' : 'completed',
    total_records: stats.total,
    success_count: stats.success,
    error_count: stats.errors,
    error_details: stats.error_details || null,
  }).eq('id', batchId);
}

export async function loadBankTransactions(companyId: string): Promise<any[]> {
  const { data, error } = await supabase.from('bank_transactions').select('*')
    .eq('company_id', companyId).order('date', { ascending: false }).limit(3000);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function loadBankAccounts(companyId: string): Promise<any[]> {
  const { data } = await supabase.from('bank_accounts').select('*')
    .eq('company_id', companyId).order('is_primary', { ascending: false });
  return data || [];
}

export async function deleteBankTransactions(ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await supabase.from('bank_transactions').delete()
      .in('id', ids.slice(i, i + 100));
    if (error) throw new Error(error.message);
  }
}

export async function deleteAllBankTransactions(companyId: string): Promise<number> {
  const { count, error } = await supabase.from('bank_transactions')
    .delete({ count: 'exact' }).eq('company_id', companyId);
  if (error) throw new Error(error.message);
  return count || 0;
}
