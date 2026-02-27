// src/lib/bankParser.ts
// Parser estratti conto PDF — STRATEGIA VELOCE:
// 1. Estrae tutto il testo del PDF con PDF.js (istantaneo, nessuna API)
// 2. Manda il testo in batch da 20 pagine a Claude (text API, non vision)
// 3. 80 pagine = ~4 chiamate API invece di 80  → 15x più veloce

// ============================================================
// TYPES
// ============================================================
export interface BankTransaction {
  date: string;           // YYYY-MM-DD
  value_date?: string;
  amount: number;         // positivo = entrata, negativo = uscita
  balance?: number;
  description: string;
  counterparty_name?: string;
  transaction_type?: string;
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
}

export interface BankParseProgress {
  phase: 'extracting' | 'analyzing' | 'saving' | 'done';
  current: number;
  total: number;
  message: string;
}

// ============================================================
// API KEY (localStorage)
// ============================================================
export function getClaudeApiKey(): string {
  return localStorage.getItem('finflow_claude_api_key') || '';
}

export function setClaudeApiKey(key: string): void {
  localStorage.setItem('finflow_claude_api_key', key);
}

// ============================================================
// PDF.js — carica dinamicamente
// ============================================================
async function loadPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib;

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Impossibile caricare PDF.js'));
    document.head.appendChild(script);
  });

  const lib = (window as any).pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return lib;
}

// ============================================================
// FASE 1: estrai testo da tutte le pagine (no API, istantaneo)
// ============================================================
async function extractAllPagesText(
  pdfDoc: any,
  onProgress: (page: number, total: number) => void
): Promise<string[]> {
  const texts: string[] = [];
  const total = pdfDoc.numPages;

  for (let p = 1; p <= total; p++) {
    const page = await pdfDoc.getPage(p);
    const content = await page.getTextContent();

    // Ricostruisce il testo preservando le colonne (ordine spaziale Y poi X)
    const items = content.items as any[];
    
    // Raggruppa per riga (stesso Y approssimativo)
    const rows: Map<number, { x: number; text: string }[]> = new Map();
    for (const item of items) {
      if (!item.str?.trim()) continue;
      const y = Math.round(item.transform[5] / 3) * 3; // arrotonda a 3pt
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y)!.push({ x: item.transform[4], text: item.str });
    }

    // Ordina righe per Y decrescente (alto→basso) e items per X
    const sortedRows = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) =>
        items.sort((a, b) => a.x - b.x).map(i => i.text).join(' ')
      );

    texts.push(sortedRows.join('\n'));
    onProgress(p, total);
  }

  return texts;
}

// ============================================================
// FASE 2: analisi AI in batch (20 pagine per chiamata)
// ============================================================
const BATCH_SIZE = 20;

const SYSTEM_PROMPT = `Sei un esperto analista di estratti conto bancari italiani (MPS, Intesa, UniCredit, ecc.).
Ti viene fornito il testo grezzo estratto da pagine di un estratto conto PDF.
Devi estrarre TUTTE le transazioni e restituire SOLO JSON valido, senza markdown, senza commenti.

Struttura JSON richiesta:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "value_date": "YYYY-MM-DD",
      "amount": -1234.56,
      "balance": 5678.90,
      "description": "testo descrizione movimento",
      "counterparty_name": "nome controparte",
      "transaction_type": "bonifico_in|bonifico_out|riba|sdd|pos|prelievo|commissione|stipendio|f24|altro",
      "reference": "riferimento/CBI",
      "invoice_ref": "numero fattura se presente (es: 195/FE/25)",
      "raw_text": "riga originale completa"
    }
  ],
  "account_info": {
    "holder": "intestatario",
    "iban": "ITXX...",
    "bank_name": "Monte dei Paschi di Siena",
    "period_from": "YYYY-MM-DD",
    "period_to": "YYYY-MM-DD",
    "opening_balance": 0.00,
    "closing_balance": 0.00
  }
}

REGOLE CRITICHE:
- amount NEGATIVO = addebito/uscita (colonna DARE o uscita)
- amount POSITIVO = accredito/entrata (colonna AVERE o entrata)
- Per MPS: la colonna "Dare" = uscita (negativo), "Avere" = entrata (positivo)
- Converti date italiane (gg/mm/aaaa o gg-mm-aaaa) in YYYY-MM-DD
- NON includere righe di intestazione, totali, saldi, intestazioni colonne
- Se una pagina non ha transazioni, transactions: []
- account_info: compila solo se i dati sono presenti, altrimenti null
- Solo JSON puro, zero testo aggiuntivo`;

async function analyzeBatchWithClaude(
  pagesText: string[],
  startPage: number,
  apiKey: string
): Promise<{ transactions: BankTransaction[]; accountInfo?: any }> {
  const combinedText = pagesText
    .map((t, i) => `\n=== PAGINA ${startPage + i} ===\n${t}`)
    .join('\n');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Estrai tutte le transazioni da questo testo (pagine ${startPage}-${startPage + pagesText.length - 1}):\n\n${combinedText}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Claude API ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const raw = data.content?.[0]?.text || '';
  const clean = raw.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  const parsed = JSON.parse(clean);

  const transactions: BankTransaction[] = (parsed.transactions || [])
    .filter((t: any) => t?.date && t?.amount != null)
    .map((t: any) => ({
      date: t.date,
      value_date: t.value_date || undefined,
      amount: parseFloat(String(t.amount)) || 0,
      balance: t.balance != null ? parseFloat(String(t.balance)) : undefined,
      description: String(t.description || '').trim(),
      counterparty_name: t.counterparty_name || undefined,
      transaction_type: t.transaction_type || 'altro',
      reference: t.reference || undefined,
      invoice_ref: t.invoice_ref || undefined,
      raw_text: String(t.raw_text || t.description || '').trim(),
    }));

  return { transactions, accountInfo: parsed.account_info || null };
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
// MAIN PARSER — PDF → transazioni (FAST)
// ============================================================
export async function parseBankPdf(
  file: File,
  apiKey: string,
  onProgress?: (p: BankParseProgress) => void
): Promise<BankParseResult> {
  if (!apiKey) throw new Error('API key Claude non configurata. Vai in Impostazioni.');

  const result: BankParseResult = {
    transactions: [], pagesProcessed: 0, errors: [],
  };

  // Carica PDF.js
  const pdfjsLib = await loadPdfJs();
  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdfDoc.numPages;

  // ── FASE 1: estrazione testo (tutto insieme, nessuna API) ──
  onProgress?.({ phase: 'extracting', current: 0, total: totalPages, message: `Lettura PDF: ${totalPages} pagine...` });

  const allTexts = await extractAllPagesText(pdfDoc, (p, tot) => {
    onProgress?.({ phase: 'extracting', current: p, total: tot, message: `Lettura pagina ${p}/${tot}...` });
  });

  result.pagesProcessed = totalPages;

  // ── FASE 2: analisi AI in batch ──
  const totalBatches = Math.ceil(totalPages / BATCH_SIZE);
  const allAccountInfos: any[] = [];

  for (let b = 0; b < totalBatches; b++) {
    const start = b * BATCH_SIZE;
    const batchTexts = allTexts.slice(start, start + BATCH_SIZE);
    const batchLabel = `${start + 1}-${Math.min(start + BATCH_SIZE, totalPages)}`;

    onProgress?.({
      phase: 'analyzing',
      current: b + 1,
      total: totalBatches,
      message: `Analisi AI batch ${b + 1}/${totalBatches} (pagine ${batchLabel})...`,
    });

    try {
      const { transactions, accountInfo } = await analyzeBatchWithClaude(batchTexts, start + 1, apiKey);
      result.transactions.push(...transactions);
      if (accountInfo) allAccountInfos.push(accountInfo);
    } catch (e: any) {
      const msg = `Batch ${b + 1} (pag. ${batchLabel}): ${e.message}`;
      result.errors.push(msg);
      console.error(msg);
    }
  }

  // Compila info conto
  const info = allAccountInfos.find(a => a);
  if (info) {
    result.accountHolder = info.holder || undefined;
    result.iban = info.iban || undefined;
    result.bankName = info.bank_name || undefined;
    if (info.period_from && info.period_to)
      result.statementPeriod = { from: info.period_from, to: info.period_to };
    if (info.opening_balance != null) result.openingBalance = parseFloat(info.opening_balance);
    if (info.closing_balance != null) result.closingBalance = parseFloat(info.closing_balance);
  }

  // Deduplica
  const seen = new Set<string>();
  const deduped: BankTransaction[] = [];
  for (const t of result.transactions) {
    const h = await hashTx(t);
    if (!seen.has(h)) { seen.add(h); deduped.push({ ...t, _hash: h } as any); }
  }
  result.transactions = deduped.sort((a, b) => a.date.localeCompare(b.date));

  onProgress?.({
    phase: 'done', current: totalBatches, total: totalBatches,
    message: `✓ ${result.transactions.length} movimenti trovati in ${totalPages} pagine`,
  });

  return result;
}

// ============================================================
// SAVE TO SUPABASE
// ============================================================
import { supabase } from '@/integrations/supabase/client';

export interface SaveBankResult {
  saved: number;
  duplicates: number;
  errors: string[];
}

export async function saveBankTransactions(
  companyId: string,
  bankAccountId: string,
  transactions: BankTransaction[],
  importBatchId: string,
  onProgress?: (current: number, total: number) => void
): Promise<SaveBankResult> {
  let saved = 0, duplicates = 0;
  const errors: string[] = [];

  // Inserimento in batch da 50
  const CHUNK = 50;
  for (let i = 0; i < transactions.length; i += CHUNK) {
    const chunk = transactions.slice(i, i + CHUNK) as any[];
    const rows = chunk.map(t => ({
      company_id: companyId,
      bank_account_id: bankAccountId,
      import_batch_id: importBatchId,
      date: t.date,
      value_date: t.value_date || null,
      amount: t.amount,
      balance: t.balance ?? null,
      description: t.description,
      counterparty_name: t.counterparty_name || null,
      transaction_type: t.transaction_type || 'altro',
      reference: t.reference || null,
      invoice_ref: t.invoice_ref || null,
      raw_text: t.raw_text,
      hash: t._hash || null,
      reconciliation_status: 'unmatched',
    }));

    const { error, data } = await supabase
      .from('bank_transactions')
      .upsert(rows, { onConflict: 'bank_account_id,hash', ignoreDuplicates: true })
      .select('id');

    if (error) {
      errors.push(`Chunk ${Math.floor(i / CHUNK) + 1}: ${error.message}`);
    } else {
      const inserted = data?.length || 0;
      saved += inserted;
      duplicates += chunk.length - inserted;
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
    const { data } = await supabase
      .from('bank_accounts').select('id')
      .eq('company_id', companyId).eq('iban', info.iban).maybeSingle();
    if (data?.id) return data.id;
  }
  const { data: primary } = await supabase
    .from('bank_accounts').select('id')
    .eq('company_id', companyId).eq('is_primary', true).maybeSingle();
  if (primary?.id) return primary.id;

  const { data: newAcc, error } = await supabase
    .from('bank_accounts')
    .insert({
      company_id: companyId,
      name: info.bankName
        ? `${info.bankName}${info.iban ? ' — ...'+info.iban.slice(-4) : ''}`
        : 'Conto principale',
      bank_name: info.bankName || null,
      iban: info.iban || null,
      is_primary: true,
      currency: 'EUR',
    })
    .select('id').single();

  if (error) throw new Error('Errore creazione conto: ' + error.message);
  return newAcc.id;
}

export async function createImportBatch(companyId: string, filename: string): Promise<string> {
  const { data, error } = await supabase
    .from('import_batches')
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
  const { data, error } = await supabase
    .from('bank_transactions').select('*')
    .eq('company_id', companyId)
    .order('date', { ascending: false }).limit(3000);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function loadBankAccounts(companyId: string): Promise<any[]> {
  const { data } = await supabase
    .from('bank_accounts').select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false });
  return data || [];
}
