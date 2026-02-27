// src/lib/bankParser.ts
// Parser estratti conto PDF (MPS e altre banche) via Claude API vision
// Usa PDF.js per renderizzare ogni pagina come immagine, poi Claude per estrarre i dati

// ============================================================
// TYPES
// ============================================================
export interface BankTransaction {
  date: string;           // YYYY-MM-DD
  value_date?: string;    // YYYY-MM-DD
  amount: number;         // positivo = entrata, negativo = uscita
  balance?: number;
  description: string;
  counterparty_name?: string;
  transaction_type?: string;  // bonifico_in, bonifico_out, riba, sdd, pos, ecc.
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
  phase: 'rendering' | 'analyzing' | 'done';
  current: number;
  total: number;
  message: string;
}

// ============================================================
// API KEY
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
async function loadPdfJs() {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib;
  
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Impossibile caricare PDF.js'));
    document.head.appendChild(script);
  });

  const pdfjsLib = (window as any).pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return pdfjsLib;
}

// ============================================================
// RENDER PDF PAGE → base64 JPEG
// ============================================================
async function renderPageToBase64(
  page: any,
  scale = 1.5
): Promise<string> {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  // Rimuoviamo il prefisso data:image/jpeg;base64,
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
}

// ============================================================
// CLAUDE API — analisi singola pagina
// ============================================================
const SYSTEM_PROMPT = `Sei un esperto analista di estratti conto bancari italiani. 
Analizzi immagini di pagine di estratto conto e restituisci SOLO JSON valido senza markdown.

Il JSON deve avere questa struttura:
{
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "value_date": "YYYY-MM-DD",
      "amount": 1234.56,
      "balance": 5678.90,
      "description": "testo completo della descrizione",
      "counterparty_name": "nome controparte se presente",
      "transaction_type": "bonifico_in|bonifico_out|riba|sdd|pos|prelievo|commissione|stipendio|f24|altro",
      "reference": "riferimento CBI o altro codice",
      "invoice_ref": "numero fattura se presente es: 195/FE/25",
      "raw_text": "testo grezzo originale della riga"
    }
  ],
  "account_info": {
    "holder": "intestatario conto",
    "iban": "IBAN se visibile",
    "bank_name": "nome banca",
    "period_from": "YYYY-MM-DD",
    "period_to": "YYYY-MM-DD",
    "opening_balance": 0.00,
    "closing_balance": 0.00
  }
}

REGOLE IMPORTANTI:
- amount: POSITIVO per accrediti (entrate), NEGATIVO per addebiti (uscite)
- Se la colonna è "Dare" = uscita (negativo), "Avere" = entrata (positivo)
- Converti sempre le date in formato YYYY-MM-DD
- Se una colonna non è presente, usa null
- Non includere righe di intestazione, totali o saldi come transazioni
- Se la pagina non contiene transazioni (solo intestazioni/sommari), restituisci {"transactions": [], "account_info": null}
- Non aggiungere markdown, backtick o commenti. Solo JSON puro.`;

async function analyzePageWithClaude(
  base64Image: string,
  apiKey: string,
  pageNum: number
): Promise<{ transactions: BankTransaction[]; accountInfo?: any }> {
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
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `Analizza questa pagina (${pageNum}) dell'estratto conto e restituisci SOLO il JSON con le transazioni trovate.`,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '';
  
  // Pulizia risposta
  const clean = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const parsed = JSON.parse(clean);
  
  const transactions: BankTransaction[] = (parsed.transactions || [])
    .filter((t: any) => t && t.date && t.amount !== undefined && t.amount !== null)
    .map((t: any) => ({
      date: t.date,
      value_date: t.value_date || undefined,
      amount: parseFloat(t.amount) || 0,
      balance: t.balance !== null && t.balance !== undefined ? parseFloat(t.balance) : undefined,
      description: t.description || '',
      counterparty_name: t.counterparty_name || undefined,
      transaction_type: t.transaction_type || 'altro',
      reference: t.reference || undefined,
      invoice_ref: t.invoice_ref || undefined,
      raw_text: t.raw_text || t.description || '',
    }));

  return { transactions, accountInfo: parsed.account_info };
}

// ============================================================
// HASH per deduplicazione movimenti
// ============================================================
async function hashTransaction(t: BankTransaction): Promise<string> {
  const str = `${t.date}|${t.amount}|${t.description.substring(0, 60)}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 32);
}

// ============================================================
// MAIN PARSER — PDF → transazioni
// ============================================================
export async function parseBankPdf(
  file: File,
  apiKey: string,
  onProgress?: (p: BankParseProgress) => void
): Promise<BankParseResult> {
  const result: BankParseResult = {
    transactions: [],
    pagesProcessed: 0,
    errors: [],
  };

  if (!apiKey) throw new Error('API key Claude non configurata. Vai in Impostazioni per inserirla.');

  // Carica PDF.js
  const pdfjsLib = await loadPdfJs();

  // Carica PDF
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdf.numPages;

  onProgress?.({ phase: 'rendering', current: 0, total: totalPages, message: `PDF caricato: ${totalPages} pagine` });

  const allAccountInfos: any[] = [];

  // Processa ogni pagina
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      onProgress?.({
        phase: pageNum <= totalPages ? 'rendering' : 'analyzing',
        current: pageNum,
        total: totalPages,
        message: `Rendering pagina ${pageNum}/${totalPages}...`,
      });

      const page = await pdf.getPage(pageNum);
      const base64 = await renderPageToBase64(page);

      onProgress?.({
        phase: 'analyzing',
        current: pageNum,
        total: totalPages,
        message: `Analisi AI pagina ${pageNum}/${totalPages}...`,
      });

      const { transactions, accountInfo } = await analyzePageWithClaude(base64, apiKey, pageNum);

      if (accountInfo) allAccountInfos.push(accountInfo);
      result.transactions.push(...transactions);
      result.pagesProcessed++;

    } catch (e: any) {
      const errMsg = `Pagina ${pageNum}: ${e.message}`;
      result.errors.push(errMsg);
      console.error(errMsg);
    }
  }

  // Estrai info conto dalla prima account_info valida
  const firstInfo = allAccountInfos.find(a => a);
  if (firstInfo) {
    result.accountHolder = firstInfo.holder || undefined;
    result.iban = firstInfo.iban || undefined;
    result.bankName = firstInfo.bank_name || undefined;
    if (firstInfo.period_from && firstInfo.period_to) {
      result.statementPeriod = { from: firstInfo.period_from, to: firstInfo.period_to };
    }
    if (firstInfo.opening_balance != null) result.openingBalance = parseFloat(firstInfo.opening_balance);
    if (firstInfo.closing_balance != null) result.closingBalance = parseFloat(firstInfo.closing_balance);
  }

  // Deduplica (stesso hash)
  const seen = new Set<string>();
  const deduped: BankTransaction[] = [];
  for (const t of result.transactions) {
    const h = await hashTransaction(t);
    if (!seen.has(h)) { seen.add(h); deduped.push({ ...t, _hash: h } as any); }
  }
  result.transactions = deduped;

  // Ordina per data
  result.transactions.sort((a, b) => a.date.localeCompare(b.date));

  onProgress?.({ phase: 'done', current: totalPages, total: totalPages, message: `Completato: ${result.transactions.length} movimenti trovati` });

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

  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i] as any;
    try {
      const { error } = await supabase.from('bank_transactions').insert({
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
      });

      if (error) {
        if (error.code === '23505' || error.message?.includes('idx_bank_tx_dedup')) {
          duplicates++;
        } else {
          errors.push(`${t.date} ${t.amount}: ${error.message}`);
        }
      } else {
        saved++;
      }
    } catch (e: any) {
      errors.push(`${t.date} ${t.amount}: ${e.message}`);
    }
    onProgress?.(i + 1, transactions.length);
  }

  return { saved, duplicates, errors };
}

export async function ensureBankAccount(
  companyId: string,
  info: { iban?: string; bankName?: string; accountHolder?: string }
): Promise<string> {
  // Cerca conto esistente per IBAN
  if (info.iban) {
    const { data } = await supabase
      .from('bank_accounts')
      .select('id')
      .eq('company_id', companyId)
      .eq('iban', info.iban)
      .maybeSingle();
    if (data?.id) return data.id;
  }

  // Cerca conto primario esistente
  const { data: primary } = await supabase
    .from('bank_accounts')
    .select('id')
    .eq('company_id', companyId)
    .eq('is_primary', true)
    .maybeSingle();
  if (primary?.id) return primary.id;

  // Crea nuovo conto
  const { data: newAcc, error } = await supabase
    .from('bank_accounts')
    .insert({
      company_id: companyId,
      name: info.bankName ? `${info.bankName}${info.iban ? ' - ' + info.iban.slice(-4) : ''}` : 'Conto principale',
      bank_name: info.bankName || null,
      iban: info.iban || null,
      is_primary: true,
      currency: 'EUR',
    })
    .select('id')
    .single();

  if (error) throw new Error('Errore creazione conto: ' + error.message);
  return newAcc.id;
}

export async function createImportBatch(
  companyId: string,
  filename: string
): Promise<string> {
  const { data, error } = await supabase
    .from('import_batches')
    .insert({
      company_id: companyId,
      type: 'bank_pdf',
      filename,
      status: 'processing',
    })
    .select('id')
    .single();
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
    .from('bank_transactions')
    .select('*')
    .eq('company_id', companyId)
    .order('date', { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function loadBankAccounts(companyId: string): Promise<any[]> {
  const { data } = await supabase
    .from('bank_accounts')
    .select('*')
    .eq('company_id', companyId)
    .order('is_primary', { ascending: false });
  return data || [];
}
