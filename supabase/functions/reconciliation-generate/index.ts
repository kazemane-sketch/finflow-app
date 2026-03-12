import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BATCH = 100;
const EMBEDDING_MODEL = "gemini-embedding-001";
const RERANK_MODEL = "gemini-3.1-pro-preview";
const EXPECTED_DIMS = 3072;
const RAG_BOOST_THRESHOLD = 0.80;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/* ─── types ────────────────────────────── */

interface TxRow {
  id: string;
  date: string;
  amount: number;
  counterparty_name: string | null;
  description: string | null;
  transaction_type: string | null;
  extracted_refs: Record<string, unknown> | null;
  raw_text: string | null;
  notes: string | null;
  direction: string;
  reconciled_amount: number;
  commission_amount: number | null;
}

/** Net amount = gross - commission. All matching uses net. */
function getTxNetAmount(tx: TxRow): number {
  return Math.abs(Number(tx.amount)) - Math.abs(Number(tx.commission_amount || 0));
}

interface Suggestion {
  bank_transaction_id: string;
  installment_id: string | null;
  invoice_id: string | null;
  match_score: number;
  match_reason: string;
  proposed_by: "deterministic" | "rule" | "ai";
  rule_id: string | null;
  suggestion_data: Record<string, unknown> | null;
}

interface MatchRow {
  invoice_id: string;
  number: string | null;
  total_amount?: number | null;
  date: string | null;
  counterparty_name: string | null;
  installment_id: string | null;
  amount_due?: number | null;
  paid_amount?: number | null;
  due_date?: string | null;
  status?: string | null;
  notes?: string | null;
  primary_contract_ref?: string | null;
  contract_refs?: unknown;
  raw_xml?: string | null;
  is_estimated?: boolean | null;
  estimate_source?: string | null;
  estimate_days?: number | null;
  payment_terms_days?: number | null;
  dso_days_override?: number | null;
  pso_days_override?: number | null;
}

type SqlClient = ReturnType<typeof postgres>;

/* ─── RULE 1: Direction mapping (ABSOLUTE, NO EXCEPTIONS) ─── */

/**
 * Determine which invoice direction to match for a given bank transaction.
 *
 * DB convention:
 *   - invoice direction = 'out' → fattura ATTIVA (emessa da noi, il cliente ci paga)
 *   - invoice direction = 'in'  → fattura PASSIVA (ricevuta, noi paghiamo il fornitore)
 *
 * Bank transaction:
 *   - amount > 0 (entrata) → il cliente ci paga → match fatture ATTIVE (direction='out')
 *   - amount < 0 (uscita)  → noi paghiamo       → match fatture PASSIVE (direction='in')
 */
function getExpectedInvoiceDirection(txAmount: number): string {
  return txAmount > 0 ? "out" : "in";
}

function diffDays(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const left = new Date(a).getTime();
  const right = new Date(b).getTime();
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return (left - right) / 86400000;
}

/* ─── RULE 2: Counterparty matching ─── */

const LEGAL_SUFFIXES = new Set([
  "SRL", "S.R.L.", "SPA", "S.P.A.", "SRLS", "S.R.L.S.",
  "SAS", "S.A.S.", "SNC", "S.N.C.", "SS", "DI", "E", "&",
  "S.R.L", "S.P.A", "SOCIETA", "UNIPERSONALE",
]);

/**
 * Check if the bank transaction counterparty matches the invoice counterparty.
 * Uses significant word matching (ignoring legal suffixes like SRL, SPA).
 * Returns true if no TX counterparty is available (can't filter).
 */
function counterpartyMatches(txName: string | null, invName: string | null): boolean {
  if (!txName || txName.length < 3) return true; // no TX counterparty → don't filter
  if (!invName || invName.length < 3) return false; // TX has name but invoice doesn't → no match

  const txWords = txName.toUpperCase().split(/[\s.,()]+/)
    .filter(w => w.length > 2 && !LEGAL_SUFFIXES.has(w));
  const invUpper = invName.toUpperCase();

  // At least one significant word from TX name must be in invoice counterparty
  return txWords.some(w => invUpper.includes(w));
}

/* ─── RULE 3: Invoice ref parser (strict matching) ─── */

interface RefParts {
  number: string;       // "371"
  suffix: string | null; // "FE"
  year: string | null;   // "24"
  fullYear: number | null; // 2024
  fullRef: string;       // "371/FE/24" (original)
  withFullYear: string | null; // "371/FE/2024"
  withoutYear: string | null;  // "371/FE"
}

/**
 * Parse an invoice reference into structured parts.
 * Handles: "371/FE/24", "371/FE/2024", "371/FE", "5250425719", "SAA25/84119"
 */
function parseInvoiceRef(ref: string): RefParts {
  // Pattern: NUM/SUFFIX/YEAR  (e.g. 371/FE/24, 309/FE/25, 123/NC/2024)
  const slashMatch = ref.match(/^(\d+)\/(FE|PA|NC|NE|FA)\/(\d{2,4})$/i);
  if (slashMatch) {
    const num = slashMatch[1];
    const suffix = slashMatch[2].toUpperCase();
    const yearStr = slashMatch[3];
    const fullYear = yearStr.length === 2 ? 2000 + parseInt(yearStr) : parseInt(yearStr);
    return {
      number: num,
      suffix,
      year: yearStr,
      fullYear,
      fullRef: ref,
      withFullYear: `${num}/${suffix}/${fullYear}`,
      withoutYear: `${num}/${suffix}`,
    };
  }

  // Pattern: NUM/SUFFIX (no year, e.g. 371/FE)
  const noYearMatch = ref.match(/^(\d+)\/(FE|PA|NC|NE|FA)$/i);
  if (noYearMatch) {
    return {
      number: noYearMatch[1],
      suffix: noYearMatch[2].toUpperCase(),
      year: null,
      fullYear: null,
      fullRef: ref,
      withFullYear: null,
      withoutYear: ref,
    };
  }

  // Pattern: pure long numeric (e.g. "5250425719" — SDD invoice number)
  const pureNumMatch = ref.match(/^(\d{6,})$/);
  if (pureNumMatch) {
    return {
      number: pureNumMatch[1],
      suffix: null,
      year: null,
      fullYear: null,
      fullRef: ref,
      withFullYear: null,
      withoutYear: ref,
    };
  }

  // Fallback: keep as-is but extract numeric part
  return {
    number: ref.replace(/[^0-9]/g, ""),
    suffix: null,
    year: null,
    fullYear: null,
    fullRef: ref,
    withFullYear: null,
    withoutYear: ref,
  };
}

/* ─── ref extraction helpers ──────────── */

/**
 * Normalize all the different field names the AI extraction uses for invoice refs.
 * The Anthropic extraction produces inconsistent schemas across batches.
 */
function extractInvoiceRefs(refs: Record<string, unknown> | null): string[] {
  if (!refs) return [];
  if (typeof refs.error === "string") return [];

  const results: string[] = [];

  const arrayFields = [
    "invoice_refs", "numeri_fattura", "fatture", "riferimenti_fattura",
  ];
  for (const field of arrayFields) {
    const val = refs[field];
    if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === "string" && v.length >= 2) results.push(v.trim());
      }
    }
  }

  for (const field of ["numero_fattura"]) {
    const val = refs[field];
    if (typeof val === "string" && val.length >= 2) results.push(val.trim());
  }

  return [...new Set(results)];
}

/**
 * Normalize mandate SDD IDs from various field names.
 */
function extractMandateId(refs: Record<string, unknown> | null): string | null {
  if (!refs) return null;
  if (typeof refs.error === "string") return null;

  for (const field of ["mandate_id", "codice_mandato_sdd", "mandato_sdd"]) {
    const val = refs[field];
    if (typeof val === "string" && val.length >= 3) return val;
  }
  for (const field of ["codici_mandato_sdd"]) {
    const val = refs[field];
    if (Array.isArray(val) && val.length > 0 && typeof val[0] === "string") {
      return val[0];
    }
  }
  return null;
}

function normalizeComparableRef(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/^IT(?=\d)/, "")
    .replace(/[^A-Z0-9]/g, "");
}

function extractContractRefs(refs: Record<string, unknown> | null): string[] {
  if (!refs || typeof refs.error === "string") return [];
  const values: string[] = [];
  const arrayFields = [
    "contract_refs",
    "contract_numbers",
    "numeri_contratto",
    "riferimenti_contratto",
  ];
  const scalarFields = [
    "contract_ref",
    "contract_number",
    "numero_contratto",
    "contratto",
  ];

  for (const field of arrayFields) {
    const val = refs[field];
    if (Array.isArray(val)) {
      for (const item of val) {
        const normalized = normalizeComparableRef(typeof item === "string" ? item : null);
        if (normalized.length >= 3) values.push(normalized);
      }
    }
  }
  for (const field of scalarFields) {
    const val = refs[field];
    const normalized = normalizeComparableRef(typeof val === "string" ? val : null);
    if (normalized.length >= 3) values.push(normalized);
  }
  return [...new Set(values)];
}

function extractInvoiceContractRefs(row: MatchRow): string[] {
  const normalized = new Set<string>();

  const add = (value: string | null | undefined) => {
    const ref = normalizeComparableRef(value);
    if (ref.length >= 3) normalized.add(ref);
  };

  add(row.primary_contract_ref);

  if (Array.isArray(row.contract_refs)) {
    for (const item of row.contract_refs) {
      add(typeof item === "string" ? item : null);
    }
  } else if (typeof row.contract_refs === "string") {
    try {
      const parsed = JSON.parse(row.contract_refs);
      if (Array.isArray(parsed)) {
        for (const item of parsed) add(typeof item === "string" ? item : null);
      }
    } catch {
      add(row.contract_refs);
    }
  }

  if (!normalized.size && row.raw_xml) {
    for (const m of row.raw_xml.matchAll(/<[^>]*DatiContratto[^>]*>[\s\S]*?<[^>]*IdDocumento[^>]*>([^<]+)<\/[^>]*IdDocumento>/gi)) {
      add(m[1]);
    }
  }

  return [...normalized];
}

type NoteSignals = {
  block: boolean;
  forcedInvoiceRefs: string[];
  forcedContractRefs: string[];
  freeText: string;
};

function parseNoteSignals(note: string | null | undefined): NoteSignals {
  const source = String(note || "").trim();
  if (!source) {
    return { block: false, forcedInvoiceRefs: [], forcedContractRefs: [], freeText: "" };
  }

  const forcedInvoiceRefs = [...source.matchAll(/#rif_fattura[:=]\s*([^\s,;]+)/gi)]
    .map((m) => normalizeComparableRef(m[1]))
    .filter((v) => v.length >= 2);
  const forcedContractRefs = [...source.matchAll(/#contratto[:=]\s*([^\s,;]+)/gi)]
    .map((m) => normalizeComparableRef(m[1]))
    .filter((v) => v.length >= 3);
  const block = /#non_riconciliare\b/i.test(source);
  const freeText = source
    .replace(/#[a-z_]+[:=][^\s,;]+/gi, " ")
    .replace(/#non_riconciliare\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    block,
    forcedInvoiceRefs: [...new Set(forcedInvoiceRefs)],
    forcedContractRefs: [...new Set(forcedContractRefs)],
    freeText,
  };
}

function freeTextIncludes(haystack: string, needle: string | null | undefined): boolean {
  const normalizedNeedle = String(needle || "").trim().toLowerCase();
  if (!haystack || normalizedNeedle.length < 3) return false;
  return haystack.includes(normalizedNeedle);
}

function applyContextSignals(
  tx: TxRow,
  match: MatchRow,
): { scoreDelta: number; blocked: boolean; reasonParts: string[]; extra: Record<string, unknown> } {
  const reasonParts: string[] = [];
  const extra: Record<string, unknown> = {};
  let scoreDelta = 0;

  const txContractRefs = extractContractRefs(tx.extracted_refs);
  const invoiceContractRefs = extractInvoiceContractRefs(match);
  const txNotes = parseNoteSignals(tx.notes);
  const invoiceNotes = parseNoteSignals(match.notes);
  const invoiceNumberNorm = normalizeComparableRef(match.number);
  const freeTextHay = `${txNotes.freeText} ${invoiceNotes.freeText}`.toLowerCase();

  if (txNotes.block || invoiceNotes.block) {
    return {
      scoreDelta: -999,
      blocked: true,
      reasonParts: ["nota utente: non riconciliare"],
      extra: {
        note_block: true,
        tx_note_block: txNotes.block,
        invoice_note_block: invoiceNotes.block,
      },
    };
  }

  if (txContractRefs.length > 0) extra.tx_contract_refs = txContractRefs;
  if (invoiceContractRefs.length > 0) extra.invoice_contract_refs = invoiceContractRefs;

  const contractMatch = txContractRefs.length > 0 && invoiceContractRefs.some((ref) => txContractRefs.includes(ref));
  if (contractMatch) {
    scoreDelta += 16;
    reasonParts.push("contratto coincidente");
    extra.contract_ref_match = true;
  } else if (txContractRefs.length > 0 && invoiceContractRefs.length > 0) {
    scoreDelta -= 20;
    reasonParts.push("contratto incompatibile");
    extra.contract_ref_match = false;
  }

  const forcedInvoiceMatch = txNotes.forcedInvoiceRefs.includes(invoiceNumberNorm) || invoiceNotes.forcedInvoiceRefs.includes(invoiceNumberNorm);
  if (forcedInvoiceMatch) {
    scoreDelta += 18;
    reasonParts.push("nota: rif. fattura esplicito");
    extra.note_invoice_match = true;
  }

  const forcedContractMatch = txNotes.forcedContractRefs.some((ref) => invoiceContractRefs.includes(ref))
    || invoiceNotes.forcedContractRefs.some((ref) => txContractRefs.includes(ref));
  if (forcedContractMatch) {
    scoreDelta += 18;
    reasonParts.push("nota: contratto esplicito");
    extra.note_contract_match = true;
  }

  if (freeTextHay) {
    if (freeTextIncludes(freeTextHay, match.number)) {
      scoreDelta += 8;
      reasonParts.push("nota cita numero fattura");
    }
    if (match.counterparty_name && freeTextIncludes(freeTextHay, match.counterparty_name)) {
      scoreDelta += 4;
      reasonParts.push("nota cita controparte");
    }
    if (invoiceContractRefs.some((ref) => freeTextHay.includes(ref.toLowerCase()))) {
      scoreDelta += 10;
      reasonParts.push("nota cita contratto");
    }
    if (tx.counterparty_name && freeTextIncludes(String(match.notes || "").toLowerCase(), tx.counterparty_name)) {
      scoreDelta += 3;
      reasonParts.push("nota fattura coerente con controparte");
    }
  }

  if (tx.notes) extra.tx_notes_used = true;
  if (match.notes) extra.invoice_notes_used = true;
  if (reasonParts.length > 0) extra.contextual_signals = reasonParts;

  return { scoreDelta, blocked: false, reasonParts, extra };
}

function applyTimingSignals(
  tx: TxRow,
  match: MatchRow,
  strength: "strong" | "medium" | "weak",
): { scoreDelta: number; blocked: boolean; reasonParts: string[]; extra: Record<string, unknown> } {
  const reasonParts: string[] = [];
  const extra: Record<string, unknown> = {};
  let scoreDelta = 0;

  const invoiceDiff = diffDays(tx.date, match.date);
  const dueDiff = diffDays(tx.date, match.due_date);
  const invoiceAfterTx = invoiceDiff !== null && invoiceDiff < 0;
  const futureDays = invoiceAfterTx ? Math.abs(invoiceDiff || 0) : 0;
  const dueDateIsEstimated = Boolean(match.is_estimated);
  const dueDateSource = match.estimate_source || (match.due_date ? "explicit" : null);

  extra.invoice_after_tx = invoiceAfterTx;
  extra.days_from_invoice_date = invoiceDiff === null ? null : Math.round(Math.abs(invoiceDiff));
  extra.invoice_date_relation = invoiceDiff === null
    ? "unknown"
    : invoiceAfterTx
    ? "after"
    : invoiceDiff <= 15
    ? "same_window"
    : "before";
  extra.due_date_is_estimated = dueDateIsEstimated;
  extra.due_date_source = dueDateSource;

  if (invoiceAfterTx) {
    const maxFutureDays = strength === "strong" ? 60 : 15;
    if (futureDays > maxFutureDays) {
      return {
        scoreDelta: -999,
        blocked: true,
        reasonParts: [`fattura datata ${Math.round(futureDays)}gg dopo il movimento`],
        extra: {
          ...extra,
          timing_confidence: "low",
          timing_block: true,
        },
      };
    }

    if (strength === "strong") {
      if (futureDays <= 7) scoreDelta -= 4;
      else if (futureDays <= 15) scoreDelta -= 8;
      else if (futureDays <= 30) scoreDelta -= 12;
      else scoreDelta -= 18;
    } else {
      if (futureDays <= 7) scoreDelta -= 10;
      else scoreDelta -= 16;
    }
    reasonParts.push(`fattura ${Math.round(futureDays)}gg dopo il movimento`);
  }

  if (dueDiff !== null && match.due_date) {
    extra.days_from_due_date = Math.round(Math.abs(dueDiff));
    if (dueDateIsEstimated) {
      if (Math.abs(dueDiff) <= 7) {
        scoreDelta += 1;
      }
      extra.timing_confidence = extra.timing_confidence || "low";
      if (Math.abs(dueDiff) <= 15) {
        reasonParts.push("vicino a scadenza stimata");
      }
    } else {
      if (Math.abs(dueDiff) <= 7) {
        scoreDelta += 4;
        reasonParts.push("vicino a scadenza reale");
      } else if (Math.abs(dueDiff) <= 15) {
        scoreDelta += 2;
        reasonParts.push("timing coerente con scadenza reale");
      }
      extra.timing_confidence = extra.timing_confidence || "high";
    }
  }

  const expectedDays = Number(match.pso_days_override || match.dso_days_override || match.payment_terms_days || 0);
  if (expectedDays > 0 && invoiceDiff !== null && !invoiceAfterTx) {
    const deviation = Math.abs(invoiceDiff - expectedDays);
    extra.expected_days = expectedDays;
    if (deviation <= 10) {
      scoreDelta += dueDateIsEstimated ? 0 : 1;
      reasonParts.push(`finestra pagamento attesa ~${expectedDays}gg`);
    }
  }

  if (!("timing_confidence" in extra)) {
    extra.timing_confidence = dueDateIsEstimated ? "low" : "medium";
  }

  return { scoreDelta, blocked: false, reasonParts, extra };
}

/**
 * Parse raw_text for invoice references when AI extraction didn't capture them.
 */
function parseRawTextForRefs(rawText: string | null): string[] {
  if (!rawText) return [];
  const refs: string[] = [];

  // Pattern 1: "RI: 381/FE/25 377/FE/25..." — multiple refs after RI:
  for (const m of rawText.matchAll(/RI:\s*([\d\/\w\s]+?)(?:CAUS|$)/gi)) {
    const chunk = m[1].trim();
    for (const part of chunk.split(/\s+/)) {
      if (/^\d+\/\w+\/\d{2,4}$/.test(part)) {
        refs.push(part);
      }
    }
  }

  // Pattern 2: Standalone XXX/FE/YY patterns
  for (const m of rawText.matchAll(/(\d+\/FE\/\d{2,4})/gi)) {
    refs.push(m[1]);
  }

  // Pattern 3: "Fattura num. XXXX" / "Fatt. n. XXXX"
  for (const m of rawText.matchAll(
    /(?:Fattura|Fatt\.?)\s+(?:num\.?|n\.?)\s*(\S+)/gi,
  )) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  // Pattern 4: "RIF.FATT: FATTURA N. XXX"
  for (const m of rawText.matchAll(
    /RIF\.?FATT[.:]\s*FATTURA\s+N\.?\s*(\S+)/gi,
  )) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  // Pattern 5: "SALDO FATTURA N. XXX DEL..."
  for (const m of rawText.matchAll(/SALDO\s+FATTURA\s+N\.?\s*(\S+)/gi)) {
    refs.push(m[1].replace(/[,;.]$/, ""));
  }

  return [...new Set(refs)].filter((r) => r.length >= 2);
}

/* ─── Level 1: Match by invoice refs (highest confidence) ─── */

async function matchByInvoiceRefs(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  invoiceRefs: string[],
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const expectedDirection = getExpectedInvoiceDirection(Number(tx.amount));

  for (const ref of invoiceRefs) {
    if (!ref || ref.length < 2) continue;

    const rp = parseInvoiceRef(ref);

    // Build strict matching conditions.
    // NEVER use loose ILIKE with short strings. Match must be EXACT on the number part.
    //
    // Conditions (OR):
    //   1. i.number = fullRef           ("371/FE/24" = "371/FE/24")
    //   2. i.number = withFullYear      ("371/FE/24" matches "371/FE/2024")
    //   3. i.number = withoutYear       ("371/FE/24" matches "371/FE")
    //   4. i.number = number only       (for pure numeric refs like "5250425719")
    //   5. i.number starts with number/ (for "371" matches "371/FE" or "371/FE/2024")
    //      BUT only if number has >= 3 digits to prevent "9" matching "309/FE"
    //
    // Year filter: if ref has year, invoice date must be in that year.
    // Direction filter: ALWAYS applied, no exceptions.

    const matchClauses: string[] = [];
    const params: (string | number)[] = [companyId, expectedDirection];
    let paramIdx = 3;

    // Condition 1: exact match on full ref
    matchClauses.push(`i.number = $${paramIdx}`);
    params.push(rp.fullRef);
    paramIdx++;

    // Condition 2: match with full year (if applicable)
    if (rp.withFullYear && rp.withFullYear !== rp.fullRef) {
      matchClauses.push(`i.number = $${paramIdx}`);
      params.push(rp.withFullYear);
      paramIdx++;
    }

    // Condition 3: match without year (if applicable)
    if (rp.withoutYear && rp.withoutYear !== rp.fullRef) {
      matchClauses.push(`i.number = $${paramIdx}`);
      params.push(rp.withoutYear);
      paramIdx++;
    }

    // Condition 4: pure number match (only for long numeric refs >= 6 digits)
    if (rp.suffix === null && rp.number.length >= 6) {
      matchClauses.push(`i.number = $${paramIdx}`);
      params.push(rp.number);
      paramIdx++;
    }

    // Condition 5: number starts with N/ pattern (only if N >= 3 digits)
    // "371" → matches "371/FE", "371/FE/2024", etc.
    // BUT "9" does NOT match "309/FE" — that's the critical fix
    if (rp.number.length >= 3 && rp.suffix === null) {
      matchClauses.push(`i.number LIKE $${paramIdx}`);
      params.push(`${rp.number}/%`);
      paramIdx++;
    }

    if (matchClauses.length === 0) continue;

    // Year filter clause
    let yearClause = "";
    if (rp.fullYear) {
      yearClause = ` AND EXTRACT(YEAR FROM i.date) = $${paramIdx}`;
      params.push(rp.fullYear);
      paramIdx++;
    }

    // Strong refs can tolerate delayed invoice dating within a wider window.
    const dateClause = tx.date
      ? ` AND i.date <= ($${paramIdx}::date + ($${paramIdx + 1}::int * interval '1 day'))`
      : "";
    if (tx.date) {
      params.push(tx.date);
      params.push(60);
      paramIdx++;
      paramIdx++;
    }

    const query = `
      SELECT i.id as invoice_id, i.number, i.total_amount, i.date,
             i.counterparty->>'denom' as counterparty_name,
             i.notes, i.primary_contract_ref, i.contract_refs, i.raw_xml,
             ii.id as installment_id, ii.amount_due, ii.paid_amount, ii.due_date, ii.status,
             ii.is_estimated, ii.estimate_source, ii.estimate_days
      FROM invoices i
      LEFT JOIN invoice_installments ii
        ON ii.invoice_id = i.id AND ii.status IN ('pending','overdue','partial')
      WHERE i.company_id = $1
        AND i.direction = $2
        AND (${matchClauses.join(" OR ")})
        ${yearClause}
        ${dateClause}
      ORDER BY i.date DESC
      LIMIT 20`;

    const matches = await sql.unsafe(query, params);

    // RULE 2: Post-filter by counterparty (when TX has counterparty info)
    const filteredMatches = matches.filter((m: Record<string, unknown>) =>
      counterpartyMatches(tx.counterparty_name, m.counterparty_name as string | null)
    );

    for (const m of filteredMatches) {
      const context = applyContextSignals(tx, m as MatchRow);
      if (context.blocked) continue;
      const timing = applyTimingSignals(tx, m as MatchRow, "strong");
      if (timing.blocked) continue;

      const instRemaining = m.installment_id
        ? Math.abs(Number(m.amount_due) - Number(m.paid_amount || 0))
        : Math.abs(Number(m.total_amount));

      // Skip fully paid installments
      if (m.installment_id && instRemaining < 0.01) continue;

      const amountDiff = Math.abs(remainingAmount - instRemaining);
      const amountRatio = remainingAmount > 0 ? amountDiff / remainingAmount : 1;

      // If amount is WAY off (> 50% difference), lower confidence significantly
      // A ref match with wildly different amount is suspicious
      let score: number;
      const signedDaysDiff = diffDays(tx.date, m.date as string | null);
      const daysDiff = signedDaysDiff === null ? null : Math.abs(signedDaysDiff);
      const temporalNote = daysDiff !== null
        ? signedDaysDiff !== null && signedDaysDiff < 0
          ? `, fattura ${Math.round(daysDiff)}gg dopo`
          : `, fattura ${Math.round(daysDiff)}gg prima`
        : "";
      let reason = `Rif. fattura "${ref}" → Fatt. ${m.number} (${m.counterparty_name}${temporalNote})`;

      if (amountRatio < 0.05) {
        score = 98;
        reason += " + importo corrispondente";
      } else if (amountRatio < 0.15) {
        score = 95;
        reason += ` (diff €${amountDiff.toFixed(2)})`;
      } else if (amountRatio < 0.50) {
        score = 88;
        reason += ` (diff €${amountDiff.toFixed(2)} — verificare)`;
      } else {
        // Amount > 50% off — still include but with lower confidence
        score = 75;
        reason += ` (⚠ diff €${amountDiff.toFixed(2)} — importo molto diverso)`;
      }
      const combinedReasons = [...context.reasonParts, ...timing.reasonParts];
      if (combinedReasons.length > 0) {
        reason += ` — ${combinedReasons.join(" · ")}`;
      }

      suggestions.push({
        bank_transaction_id: tx.id,
        installment_id: (m.installment_id as string) || null,
        invoice_id: m.invoice_id as string,
        match_score: Math.max(0, Math.min(98, score + context.scoreDelta + timing.scoreDelta)),
        match_reason: reason,
        proposed_by: "deterministic",
        rule_id: null,
        suggestion_data: {
          ref,
          amount_diff: amountDiff,
          level: "invoice_ref",
          ...context.extra,
          ...timing.extra,
        },
      });
    }
  }

  return suggestions;
}

/* ─── Level 2: Match by mandate SDD (recurring payments) ─── */

async function matchByMandate(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  mandateId: string,
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const expectedDirection = getExpectedInvoiceDirection(Number(tx.amount));

  // Find counterparty from other transactions with same mandate
  const mandateMatches = await sql.unsafe(
    `SELECT DISTINCT counterparty_name
     FROM bank_transactions
     WHERE company_id = $1
       AND counterparty_name IS NOT NULL
       AND (
         extracted_refs->>'mandate_id' = $2
         OR extracted_refs->>'codice_mandato_sdd' = $2
         OR extracted_refs->'codici_mandato_sdd' @> to_jsonb($2::text)
       )
     LIMIT 3`,
    [companyId, mandateId],
  );

  if (mandateMatches.length === 0) return [];

  const cpName = mandateMatches[0].counterparty_name;
  const cpWord = cpName.split(/\s+/)[0];
  if (!cpWord || cpWord.length < 3) return [];

  const openInst = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount, ii.is_estimated, ii.estimate_source, ii.estimate_days,
            inv.number as invoice_number,
            inv.date as invoice_date,
            inv.counterparty->>'denom' as counterparty_name,
            inv.notes, inv.primary_contract_ref, inv.contract_refs, inv.raw_xml
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND inv.direction = $2
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $4 * 0.85 AND $4 * 1.15
       AND ($5::date IS NULL OR inv.date <= ($5::date + (60 * interval '1 day')))
     ORDER BY inv.date DESC
     LIMIT 5`,
    [companyId, expectedDirection, cpWord, remainingAmount, tx.date || null],
  );

  for (const m of openInst) {
    const context = applyContextSignals(tx, {
      invoice_id: m.invoice_id as string,
      number: m.invoice_number as string | null,
      date: m.invoice_date as string | null,
      counterparty_name: m.counterparty_name as string | null,
      installment_id: m.installment_id as string | null,
      amount_due: Number(m.amount_due),
      paid_amount: Number(m.paid_amount),
      due_date: m.due_date as string | null,
      is_estimated: Boolean(m.is_estimated),
      estimate_source: (m.estimate_source as string | null) || null,
      estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
      notes: (m.notes as string | null) || null,
      primary_contract_ref: (m.primary_contract_ref as string | null) || null,
      contract_refs: m.contract_refs,
      raw_xml: (m.raw_xml as string | null) || null,
    });
    if (context.blocked) continue;
    const timing = applyTimingSignals(tx, {
      invoice_id: m.invoice_id as string,
      number: m.invoice_number as string | null,
      date: m.invoice_date as string | null,
      counterparty_name: m.counterparty_name as string | null,
      installment_id: m.installment_id as string | null,
      amount_due: Number(m.amount_due),
      paid_amount: Number(m.paid_amount),
      due_date: m.due_date as string | null,
      is_estimated: Boolean(m.is_estimated),
      estimate_source: (m.estimate_source as string | null) || null,
      estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
      notes: (m.notes as string | null) || null,
      primary_contract_ref: (m.primary_contract_ref as string | null) || null,
      contract_refs: m.contract_refs,
      raw_xml: (m.raw_xml as string | null) || null,
    }, "strong");
    if (timing.blocked) continue;

    const instRemaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);

    // Temporal scoring: recent invoices score higher
    const signedDaysDiff = diffDays(tx.date, m.invoice_date as string | null);
    const daysDiff = signedDaysDiff === null ? 60 : Math.abs(signedDaysDiff);
    let score: number;
    if (daysDiff < 30) score = 88;
    else if (daysDiff > 120) score = 80;
    else score = 85;

    const temporalNote = tx.date && m.invoice_date
      ? signedDaysDiff !== null && signedDaysDiff < 0
        ? `, fattura ${Math.round(daysDiff)}gg dopo`
        : `, fattura ${Math.round(daysDiff)}gg prima`
      : "";
    const reasonNoteParts = [...context.reasonParts, ...timing.reasonParts];
    const contextNote = reasonNoteParts.length > 0 ? ` — ${reasonNoteParts.join(" · ")}` : "";

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: Math.max(0, Math.min(98, score + context.scoreDelta + timing.scoreDelta)),
      match_reason: `Mandato SDD "${mandateId}" → ${cpName} + importo simile${temporalNote}${contextNote}`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        mandate_id: mandateId,
        counterparty: cpName,
        amount_diff: amountDiff,
        days_diff: Math.round(daysDiff),
        level: "mandate",
        ...context.extra,
        ...timing.extra,
      },
    });
  }

  return suggestions;
}

/* ─── Level 3: Fallback — counterparty + amount ─── */

async function matchByCounterpartyAmount(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const expectedDirection = getExpectedInvoiceDirection(Number(tx.amount));

  if (!tx.counterparty_name) return [];
  const cpWord = tx.counterparty_name.split(/\s+/)[0];
  if (!cpWord || cpWord.length < 3) return [];

  // v2: wider tolerance 40%-115%, date filter, DSO/PSO join, ORDER BY inv.date DESC
  const cpMatches = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount, ii.status, ii.is_estimated, ii.estimate_source, ii.estimate_days,
            inv.number as invoice_number,
            inv.date as invoice_date,
            inv.counterparty->>'denom' as counterparty_name,
            inv.notes, inv.primary_contract_ref, inv.contract_refs, inv.raw_xml,
            cp.payment_terms_days,
            cp.dso_days_override,
            cp.pso_days_override
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     LEFT JOIN counterparties cp ON cp.id = inv.counterparty_id
     WHERE ii.company_id = $1
       AND inv.direction = $2
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $4 * 0.40 AND $4 * 1.15
       AND ($5::date IS NULL OR inv.date <= ($5::date + (15 * interval '1 day')))
     ORDER BY inv.date DESC
     LIMIT 10`,
    [companyId, expectedDirection, cpWord, remainingAmount, tx.date || null],
  );

  for (const m of cpMatches) {
    const context = applyContextSignals(tx, {
      invoice_id: m.invoice_id as string,
      number: m.invoice_number as string | null,
      date: m.invoice_date as string | null,
      counterparty_name: m.counterparty_name as string | null,
      installment_id: m.installment_id as string | null,
      amount_due: Number(m.amount_due),
      paid_amount: Number(m.paid_amount),
      due_date: m.due_date as string | null,
      status: m.status as string | null,
      is_estimated: Boolean(m.is_estimated),
      estimate_source: (m.estimate_source as string | null) || null,
      estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
      notes: (m.notes as string | null) || null,
      primary_contract_ref: (m.primary_contract_ref as string | null) || null,
      contract_refs: m.contract_refs,
      raw_xml: (m.raw_xml as string | null) || null,
    });
    if (context.blocked) continue;
    const timing = applyTimingSignals(tx, {
      invoice_id: m.invoice_id as string,
      number: m.invoice_number as string | null,
      date: m.invoice_date as string | null,
      counterparty_name: m.counterparty_name as string | null,
      installment_id: m.installment_id as string | null,
      amount_due: Number(m.amount_due),
      paid_amount: Number(m.paid_amount),
      due_date: m.due_date as string | null,
      status: m.status as string | null,
      is_estimated: Boolean(m.is_estimated),
      estimate_source: (m.estimate_source as string | null) || null,
      estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
      payment_terms_days: m.payment_terms_days == null ? null : Number(m.payment_terms_days),
      dso_days_override: m.dso_days_override == null ? null : Number(m.dso_days_override),
      pso_days_override: m.pso_days_override == null ? null : Number(m.pso_days_override),
      notes: (m.notes as string | null) || null,
      primary_contract_ref: (m.primary_contract_ref as string | null) || null,
      contract_refs: m.contract_refs,
      raw_xml: (m.raw_xml as string | null) || null,
    }, "weak");
    if (timing.blocked) continue;

    const instRemaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);
    const amountRatio = remainingAmount > 0 ? amountDiff / remainingAmount : 1;

    // v2: daysDiff from INVOICE DATE (not due_date), always positive due to SQL filter
    const signedDaysDiff = diffDays(tx.date, m.invoice_date as string | null);
    const daysDiff = signedDaysDiff === null ? 999 : Math.abs(signedDaysDiff);

    // ── v2 scoring formula ──
    // base = 50
    // + amountPoints (0-20)
    // + temporalPoints (0-30)
    // + exactBonus (0-10)
    // + dsoBonus (0-5)
    const base = 50;

    // Amount points: how close is the amount match?
    let amountPoints: number;
    if (amountRatio < 0.01) amountPoints = 20;
    else if (amountRatio < 0.05) amountPoints = 16;
    else if (amountRatio < 0.10) amountPoints = 12;
    else if (amountRatio < 0.20) amountPoints = 6;
    else amountPoints = 0;

    // Temporal points: how recent is the invoice?
    let temporalPoints: number;
    if (daysDiff <= 7) temporalPoints = 30;
    else if (daysDiff <= 15) temporalPoints = 27;
    else if (daysDiff <= 30) temporalPoints = 24;
    else if (daysDiff <= 60) temporalPoints = 18;
    else if (daysDiff <= 90) temporalPoints = 12;
    else if (daysDiff <= 180) temporalPoints = 6;
    else temporalPoints = 0;

    // Exact bonus: near-exact amount + recent invoice
    const exactBonus = (amountRatio < 0.02 && daysDiff <= 60) ? 10 : 0;

    // DSO/PSO bonus: payment within expected window
    let dsoBonus = 0;
    const expectedDays = Number(m.pso_days_override || m.dso_days_override || m.payment_terms_days || 0);
    if (!Boolean(m.is_estimated) && expectedDays > 0 && Math.abs(daysDiff - expectedDays) <= 10) {
      dsoBonus = 1;
    }

    const score = Math.min(98, base + amountPoints + temporalPoints + exactBonus + dsoBonus);

    // Amount note for large differences (common Italian patterns)
    let amountNote = "";
    const pctDiff = ((instRemaining - remainingAmount) / instRemaining) * 100;
    if (Math.abs(pctDiff - 20) < 3) {
      amountNote = "Possibile ritenuta d'acconto (20%)";
    } else if (Math.abs(pctDiff - 4) < 2) {
      amountNote = "Possibile split payment IVA";
    } else if (amountRatio > 0.10) {
      amountNote = `Differenza ${pctDiff > 0 ? "+" : ""}${pctDiff.toFixed(0)}%`;
    }

    // v2: rich match_reason with temporal + DSO info
    const dsoNote = dsoBonus > 0 ? ` (in finestra pagamento attesa ${expectedDays}gg)` : "";
    const temporalNote = daysDiff < 999
      ? signedDaysDiff !== null && signedDaysDiff < 0
        ? ` — fattura ${Math.round(daysDiff)}gg dopo${dsoNote}`
        : ` — fattura ${Math.round(daysDiff)}gg prima${dsoNote}`
      : "";
    const reasonNoteParts = [...context.reasonParts, ...timing.reasonParts];
    const contextNote = reasonNoteParts.length > 0 ? ` — ${reasonNoteParts.join(" · ")}` : "";

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: Math.max(0, Math.min(98, score + context.scoreDelta + timing.scoreDelta)),
      match_reason: `Controparte "${m.counterparty_name}" + importo ${amountRatio < 0.02 ? "esatto" : "simile"} (diff €${amountDiff.toFixed(2)})${temporalNote}${amountNote ? ` — ${amountNote}` : ""}${contextNote}`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        counterparty: m.counterparty_name,
        amount_diff: amountDiff,
        days_diff: Math.round(daysDiff),
        level: "counterparty",
        ...(amountNote ? { amount_note: amountNote } : {}),
        ...(dsoBonus > 0 ? { dso_match: true, expected_days: expectedDays } : {}),
        ...context.extra,
        ...timing.extra,
      },
    });
  }

  return suggestions;
}

/* ─── Level 1.5: Match by learned rules (Miglioria 3) ─── */

async function matchByRules(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  remainingAmount: number,
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const expectedDirection = getExpectedInvoiceDirection(Number(tx.amount));

  // Find rules matching this transaction pattern
  const rules = await sql.unsafe(
    `SELECT id, rule_name, rule_data, confidence
     FROM reconciliation_rules
     WHERE company_id = $1 AND confidence > 0.3
     ORDER BY confidence DESC
     LIMIT 20`,
    [companyId],
  );

  if (rules.length === 0) return [];

  for (const rule of rules) {
    const rd = rule.rule_data as Record<string, unknown> | null;
    if (!rd) continue;

    // Check if TX matches the rule pattern
    const ruleCounterparty = rd.counterparty_pattern as string | null;
    const ruleType = rd.transaction_type as string | null;
    const ruleContractRef = rd.contract_ref as string | null;
    const txContractRefs = extractContractRefs(tx.extracted_refs);

    // Counterparty must match
    if (ruleCounterparty && !counterpartyMatches(tx.counterparty_name, ruleCounterparty)) continue;
    // Transaction type must match (if specified)
    if (ruleType && tx.transaction_type && !tx.transaction_type.toUpperCase().includes(ruleType.toUpperCase())) continue;
    if (
      ruleContractRef &&
      !txContractRefs.some((ref) => normalizeComparableRef(ref) === normalizeComparableRef(ruleContractRef))
    ) continue;

    // Find matching invoices
    const cpWord = (ruleCounterparty || tx.counterparty_name || "").split(/\s+/)[0];
    if (!cpWord || cpWord.length < 3) continue;

    const ruleMatches = await sql.unsafe(
      `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
              ii.amount_due, ii.paid_amount, ii.is_estimated, ii.estimate_source, ii.estimate_days,
              inv.number as invoice_number,
              inv.date as invoice_date,
              inv.counterparty->>'denom' as counterparty_name,
              inv.notes, inv.primary_contract_ref, inv.contract_refs, inv.raw_xml
       FROM invoice_installments ii
       JOIN invoices inv ON inv.id = ii.invoice_id
       WHERE ii.company_id = $1
         AND inv.direction = $2
         AND ii.status IN ('pending','overdue','partial')
         AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
         AND abs(ii.amount_due - ii.paid_amount) BETWEEN $4 * 0.90 AND $4 * 1.10
         AND ($5::date IS NULL OR inv.date <= ($5::date + (15 * interval '1 day')))
       ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $4) ASC
       LIMIT 3`,
      [companyId, expectedDirection, cpWord, remainingAmount, tx.date || null],
    );

    for (const m of ruleMatches) {
      const context = applyContextSignals(tx, {
        invoice_id: m.invoice_id as string,
        number: m.invoice_number as string | null,
        date: m.invoice_date as string | null,
        counterparty_name: m.counterparty_name as string | null,
        installment_id: m.installment_id as string | null,
        amount_due: Number(m.amount_due),
        paid_amount: Number(m.paid_amount),
        due_date: m.due_date as string | null,
        is_estimated: Boolean(m.is_estimated),
        estimate_source: (m.estimate_source as string | null) || null,
        estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
        notes: (m.notes as string | null) || null,
        primary_contract_ref: (m.primary_contract_ref as string | null) || null,
        contract_refs: m.contract_refs,
        raw_xml: (m.raw_xml as string | null) || null,
      });
      if (context.blocked) continue;
      const timing = applyTimingSignals(tx, {
        invoice_id: m.invoice_id as string,
        number: m.invoice_number as string | null,
        date: m.invoice_date as string | null,
        counterparty_name: m.counterparty_name as string | null,
        installment_id: m.installment_id as string | null,
        amount_due: Number(m.amount_due),
        paid_amount: Number(m.paid_amount),
        due_date: m.due_date as string | null,
        is_estimated: Boolean(m.is_estimated),
        estimate_source: (m.estimate_source as string | null) || null,
        estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
        notes: (m.notes as string | null) || null,
        primary_contract_ref: (m.primary_contract_ref as string | null) || null,
        contract_refs: m.contract_refs,
        raw_xml: (m.raw_xml as string | null) || null,
      }, ruleContractRef ? "strong" : "medium");
      if (timing.blocked) continue;

      const instRemaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
      if (instRemaining < 0.01) continue;
      const amountDiff = Math.abs(remainingAmount - instRemaining);

      // Score based on rule confidence (70-90 range)
      const ruleConf = Number(rule.confidence);
      const score = Math.round(70 + ruleConf * 20); // 0.3 → 76, 0.6 → 82, 1.0 → 90

      suggestions.push({
        bank_transaction_id: tx.id,
        installment_id: m.installment_id,
        invoice_id: m.invoice_id,
        match_score: Math.max(0, Math.min(98, Math.min(score, 90) + context.scoreDelta + timing.scoreDelta)),
        match_reason: `Regola "${rule.rule_name}" (conf. ${(ruleConf * 100).toFixed(0)}%) → ${m.counterparty_name}${[...context.reasonParts, ...timing.reasonParts].length > 0 ? ` — ${[...context.reasonParts, ...timing.reasonParts].join(" · ")}` : ""}`,
        proposed_by: "rule",
        rule_id: rule.id,
        suggestion_data: {
          rule_name: rule.rule_name,
          rule_confidence: ruleConf,
          amount_diff: amountDiff,
          level: "rule",
          ...context.extra,
          ...timing.extra,
        },
      });
    }
  }

  return suggestions;
}

/* ─── dedup helper ────────────────────── */

function dedup(suggestions: Suggestion[], _maxResults: number): Suggestion[] {
  const seen = new Set<string>();
  const unique = suggestions
    .filter((s) => {
      const key = `${s.installment_id || ""}:${s.invoice_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match_score - a.match_score);
  return unique.slice(0, _maxResults);
}

/* ─── smartRank: reduce suggestions to the clearest matches ─── */

function smartRank(suggestions: Suggestion[]): Suggestion[] {
  if (suggestions.length <= 1) return suggestions;

  // Cumulative groups: return all unmodified (they form a set)
  if (suggestions.some(s => s.suggestion_data?.level === "cumulative")) return suggestions;

  const sorted = [...suggestions].sort((a, b) => b.match_score - a.match_score);
  const best = sorted[0].match_score;
  const second = sorted.length > 1 ? sorted[1].match_score : 0;

  // Clear winner → 1 result
  if (best >= 85 && best - second >= 10) return [sorted[0]];
  // Strong match → top 2
  if (best >= 80) return sorted.slice(0, 2);
  // Uncertain → top 3
  return sorted.slice(0, 3);
}

/* ─── Miglioria 1: Cumulative payments (1 TX → N invoices) ─── */

async function matchCumulativePayment(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  remainingAmount: number,
): Promise<Suggestion[]> {
  if (!tx.counterparty_name) return [];
  const cpWord = tx.counterparty_name.split(/\s+/)[0];
  if (!cpWord || cpWord.length < 3) return [];

  const expectedDirection = getExpectedInvoiceDirection(Number(tx.amount));

  // Fetch all open installments for this counterparty (invoice date <= payment date)
  const openInst = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount, ii.is_estimated, ii.estimate_source, ii.estimate_days,
            inv.number as invoice_number,
            inv.date as invoice_date,
            inv.counterparty->>'denom' as counterparty_name,
            inv.notes, inv.primary_contract_ref, inv.contract_refs, inv.raw_xml,
            abs(ii.amount_due - ii.paid_amount) as remaining
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND inv.direction = $2
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
       AND abs(ii.amount_due - ii.paid_amount) > 0.01
       AND ($4::date IS NULL OR inv.date <= ($4::date + (15 * interval '1 day')))
     ORDER BY ii.due_date ASC
     LIMIT 10`,
    [companyId, expectedDirection, cpWord, tx.date || null],
  );

  if (openInst.length < 2) return []; // Need at least 2 invoices for cumulative

  // Try combinations of 2-3 invoices
  const target = remainingAmount;
  const tolerance = 0.05; // ±5%

  // Try pairs
  for (let i = 0; i < openInst.length; i++) {
    for (let j = i + 1; j < openInst.length; j++) {
      const sum = Number(openInst[i].remaining) + Number(openInst[j].remaining);
      const ratio = Math.abs(sum - target) / target;
      if (ratio <= tolerance) {
        const groupId = crypto.randomUUID();
        const score = ratio < 0.02 ? 75 : 65;
        const items = [openInst[i], openInst[j]];
        return items.flatMap((m) => {
          const context = applyContextSignals(tx, {
            invoice_id: m.invoice_id as string,
            number: m.invoice_number as string | null,
            date: m.invoice_date as string | null,
            counterparty_name: m.counterparty_name as string | null,
            installment_id: m.installment_id as string | null,
            amount_due: Number(m.amount_due),
            paid_amount: Number(m.paid_amount),
            due_date: m.due_date as string | null,
            is_estimated: Boolean(m.is_estimated),
            estimate_source: (m.estimate_source as string | null) || null,
            estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
            notes: (m.notes as string | null) || null,
            primary_contract_ref: (m.primary_contract_ref as string | null) || null,
            contract_refs: m.contract_refs,
            raw_xml: (m.raw_xml as string | null) || null,
          });
          if (context.blocked) return [];
          const timing = applyTimingSignals(tx, {
            invoice_id: m.invoice_id as string,
            number: m.invoice_number as string | null,
            date: m.invoice_date as string | null,
            counterparty_name: m.counterparty_name as string | null,
            installment_id: m.installment_id as string | null,
            amount_due: Number(m.amount_due),
            paid_amount: Number(m.paid_amount),
            due_date: m.due_date as string | null,
            is_estimated: Boolean(m.is_estimated),
            estimate_source: (m.estimate_source as string | null) || null,
            estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
            notes: (m.notes as string | null) || null,
            primary_contract_ref: (m.primary_contract_ref as string | null) || null,
            contract_refs: m.contract_refs,
            raw_xml: (m.raw_xml as string | null) || null,
          }, "weak");
          if (timing.blocked) return [];
          return [{
            bank_transaction_id: tx.id,
            installment_id: m.installment_id,
            invoice_id: m.invoice_id,
            match_score: Math.max(0, Math.min(98, score + context.scoreDelta + timing.scoreDelta)),
            match_reason: `Pagamento cumulativo: ${items.map(x => x.invoice_number).join(" + ")} = €${sum.toFixed(2)} (TX €${target.toFixed(2)})${[...context.reasonParts, ...timing.reasonParts].length > 0 ? ` — ${[...context.reasonParts, ...timing.reasonParts].join(" · ")}` : ""}`,
            proposed_by: "deterministic" as const,
            rule_id: null,
            suggestion_data: {
              group_id: groupId,
              group_total: sum,
              level: "cumulative",
              counterparty: m.counterparty_name,
              amount_diff: Math.abs(sum - target),
              ...context.extra,
              ...timing.extra,
            },
          }];
        });
      }
    }
  }

  // Try triples (only if pairs didn't match)
  for (let i = 0; i < Math.min(openInst.length, 6); i++) {
    for (let j = i + 1; j < Math.min(openInst.length, 7); j++) {
      for (let k = j + 1; k < Math.min(openInst.length, 8); k++) {
        const sum = Number(openInst[i].remaining) + Number(openInst[j].remaining) + Number(openInst[k].remaining);
        const ratio = Math.abs(sum - target) / target;
        if (ratio <= tolerance) {
          const groupId = crypto.randomUUID();
          const score = ratio < 0.02 ? 70 : 60;
          const items = [openInst[i], openInst[j], openInst[k]];
          return items.flatMap((m) => {
            const context = applyContextSignals(tx, {
              invoice_id: m.invoice_id as string,
              number: m.invoice_number as string | null,
              date: m.invoice_date as string | null,
              counterparty_name: m.counterparty_name as string | null,
              installment_id: m.installment_id as string | null,
              amount_due: Number(m.amount_due),
              paid_amount: Number(m.paid_amount),
              due_date: m.due_date as string | null,
              is_estimated: Boolean(m.is_estimated),
              estimate_source: (m.estimate_source as string | null) || null,
              estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
              notes: (m.notes as string | null) || null,
              primary_contract_ref: (m.primary_contract_ref as string | null) || null,
              contract_refs: m.contract_refs,
              raw_xml: (m.raw_xml as string | null) || null,
            });
            if (context.blocked) return [];
            const timing = applyTimingSignals(tx, {
              invoice_id: m.invoice_id as string,
              number: m.invoice_number as string | null,
              date: m.invoice_date as string | null,
              counterparty_name: m.counterparty_name as string | null,
              installment_id: m.installment_id as string | null,
              amount_due: Number(m.amount_due),
              paid_amount: Number(m.paid_amount),
              due_date: m.due_date as string | null,
              is_estimated: Boolean(m.is_estimated),
              estimate_source: (m.estimate_source as string | null) || null,
              estimate_days: m.estimate_days == null ? null : Number(m.estimate_days),
              notes: (m.notes as string | null) || null,
              primary_contract_ref: (m.primary_contract_ref as string | null) || null,
              contract_refs: m.contract_refs,
              raw_xml: (m.raw_xml as string | null) || null,
            }, "weak");
            if (timing.blocked) return [];
            return [{
              bank_transaction_id: tx.id,
              installment_id: m.installment_id,
              invoice_id: m.invoice_id,
              match_score: Math.max(0, Math.min(98, score + context.scoreDelta + timing.scoreDelta)),
              match_reason: `Pagamento cumulativo: ${items.map(x => x.invoice_number).join(" + ")} = €${sum.toFixed(2)}${[...context.reasonParts, ...timing.reasonParts].length > 0 ? ` — ${[...context.reasonParts, ...timing.reasonParts].join(" · ")}` : ""}`,
              proposed_by: "deterministic" as const,
              rule_id: null,
              suggestion_data: {
                group_id: groupId,
                group_total: sum,
                level: "cumulative",
                counterparty: m.counterparty_name,
                amount_diff: Math.abs(sum - target),
                ...context.extra,
                ...timing.extra,
              },
            }];
          });
        }
      }
    }
  }

  return [];
}

/* ─── RAG score boost for ambiguous suggestions ── */

function toVectorLiteral(values: number[]): string {
  return `[${values.map((v) => Number.isFinite(v) ? v.toFixed(8) : "0").join(",")}]`;
}

async function callGeminiEmbedding(apiKey: string, text: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_QUERY",
      outputDimensionality: EXPECTED_DIMS,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Gemini error: ${payload?.error?.message || response.status}`);
  const values = payload?.embedding?.values;
  if (!Array.isArray(values) || values.length !== EXPECTED_DIMS) throw new Error("Bad embedding dims");
  return values.map((v: unknown) => Number(v));
}

async function ragBoostSuggestions(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
  suggestions: Suggestion[],
  geminiKey: string,
): Promise<Suggestion[]> {
  if (suggestions.length === 0 || !geminiKey) return suggestions;

  // Only boost ambiguous suggestions (score 60-85)
  const toBoost = suggestions.filter(s => s.match_score >= 60 && s.match_score <= 85);
  if (toBoost.length === 0) return suggestions;

  try {
    // Embed the transaction description
    const extractedContractRefs = extractContractRefs(tx.extracted_refs);
    const txTextParts = [
      `TX: ${tx.counterparty_name || ""} ${tx.date || ""} ${Math.abs(Number(tx.amount))} EUR`,
      tx.description || "",
      tx.notes || "",
    ];
    if (extractedContractRefs.length > 0) {
      txTextParts.push(`Contratti: ${extractedContractRefs.join(" | ")}`);
    }
    const txText = txTextParts.filter(Boolean).join(" | ");
    const vec = await callGeminiEmbedding(geminiKey, txText);
    const vecLiteral = toVectorLiteral(vec);

    const matches = await sql.unsafe(
      `SELECT output_label, metadata, (1 - (embedding <=> $1::halfvec(3072)))::float as similarity
       FROM learning_examples
       WHERE company_id = $2
         AND domain = 'reconciliation'
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::halfvec(3072)
       LIMIT 5`,
      [vecLiteral, companyId],
    );

    if (matches.length > 0) {
      for (const s of suggestions) {
        for (const m of matches) {
          if (m.similarity >= RAG_BOOST_THRESHOLD && m.metadata?.invoice_id === s.invoice_id) {
            s.match_score = Math.min(98, s.match_score + 10);
            s.match_reason += ` + RAG confermato (${(m.similarity * 100).toFixed(0)}%)`;
            s.suggestion_data = {
              ...(s.suggestion_data || {}),
              rag_boost: true,
              rag_similarity: Number(m.similarity.toFixed(3)),
            };
            break; // Only boost once per suggestion
          }
        }
      }
    }
  } catch (err) {
    console.warn("[reconciliation-generate] RAG boost error:", err);
  }

  return suggestions;
}

function shouldUsePremiumReranker(suggestions: Suggestion[]): boolean {
  if (suggestions.length < 2) return false;
  if (suggestions.some((s) => s.suggestion_data?.level === "cumulative")) return false;
  const sorted = [...suggestions].sort((a, b) => b.match_score - a.match_score);
  const best = sorted[0]?.match_score || 0;
  const second = sorted[1]?.match_score || 0;
  return best < 92 || (best - second) < 8;
}

async function maybePremiumRerank(
  tx: TxRow,
  suggestions: Suggestion[],
  apiKey: string,
): Promise<Suggestion[]> {
  if (!apiKey || !shouldUsePremiumReranker(suggestions)) return suggestions;

  const top = [...suggestions].sort((a, b) => b.match_score - a.match_score).slice(0, 4);
  const candidateMap = new Map<string, Suggestion>();
  const candidatePayload = top.map((s, index) => {
    const key = suggestionEntityKey(s) || `cand:${index}`;
    candidateMap.set(key, s);
    return {
      key,
      invoice_id: s.invoice_id,
      installment_id: s.installment_id,
      score: s.match_score,
      reason: s.match_reason,
      level: s.suggestion_data?.level || null,
      contract_ref_match: s.suggestion_data?.contract_ref_match || false,
      invoice_after_tx: s.suggestion_data?.invoice_after_tx || false,
      due_date_is_estimated: s.suggestion_data?.due_date_is_estimated || false,
      contextual_signals: s.suggestion_data?.contextual_signals || [],
    };
  });

  const prompt = [
    "Sei un revisore senior di riconciliazione bancaria italiana.",
    "Devi SOLO riordinare una shortlist di candidati gia generati dal motore deterministico.",
    "Non creare nuovi candidati. Se il caso resta ambiguo, mantieni review_required=true.",
    "",
    `MOVIMENTO: ${JSON.stringify({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      counterparty_name: tx.counterparty_name,
      description: tx.description,
      notes: tx.notes,
      extracted_refs: tx.extracted_refs,
    })}`,
    "",
    `CANDIDATI: ${JSON.stringify(candidatePayload)}`,
    "",
    "Rispondi SOLO con JSON:",
    '{"ranked_keys":["key1","key2"],"review_required":true,"top_confidence":0-100,"reasoning":"max 20 parole"}',
  ].join("\n");

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${RERANK_MODEL}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message || String(response.status));
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || !text.trim()) return suggestions;
    const parsed = JSON.parse(text) as {
      ranked_keys?: string[];
      review_required?: boolean;
      top_confidence?: number;
      reasoning?: string;
    };
    if (!Array.isArray(parsed.ranked_keys) || parsed.ranked_keys.length === 0) return suggestions;

    const rankIndex = new Map<string, number>();
    parsed.ranked_keys.forEach((key, index) => rankIndex.set(key, index));

    return suggestions.map((s) => {
      const key = suggestionEntityKey(s);
      const idx = key ? rankIndex.get(key) : undefined;
      if (idx == null) return s;

      const rankBoost = Math.max(0, 6 - idx * 3);
      const confidence = Math.max(0, Math.min(100, Number(parsed.top_confidence || 0)));
      return {
        ...s,
        match_score: Math.max(0, Math.min(98, s.match_score + rankBoost)),
        match_reason: `${s.match_reason} — reranked by ${RERANK_MODEL}${parsed.reasoning ? `: ${parsed.reasoning}` : ""}`,
        suggestion_data: {
          ...(s.suggestion_data || {}),
          reranked_by_model: RERANK_MODEL,
          rerank_rank: idx + 1,
          review_required: parsed.review_required !== false,
          auto_match_eligible: parsed.review_required === false && idx === 0 && confidence >= 97,
          rerank_confidence: confidence,
        },
      };
    }).sort((a, b) => b.match_score - a.match_score);
  } catch (err) {
    console.warn("[reconciliation-generate] premium reranker error:", err);
    return suggestions;
  }
}

function suggestionEntityKey(s: Suggestion): string | null {
  if (s.installment_id) return `inst:${s.installment_id}`;
  if (s.invoice_id) return `inv:${s.invoice_id}`;
  return null;
}

function applyGlobalCompetition(suggestionsByTx: Map<string, Suggestion[]>): Map<string, Suggestion[]> {
  const adjusted = new Map<string, Suggestion[]>();
  const flat = [...suggestionsByTx.values()].flat()
    .filter((s) => s.suggestion_data?.level !== "cumulative");

  const winners = new Map<string, Suggestion>();
  const sorted = [...flat].sort((a, b) => b.match_score - a.match_score);
  const assignedTx = new Set<string>();
  const assignedEntities = new Set<string>();

  for (const s of sorted) {
    const entityKey = suggestionEntityKey(s);
    if (!entityKey) continue;
    if (assignedTx.has(s.bank_transaction_id) || assignedEntities.has(entityKey)) continue;
    if (s.match_score < 72) continue;
    winners.set(s.bank_transaction_id, s);
    assignedTx.add(s.bank_transaction_id);
    assignedEntities.add(entityKey);
  }

  const winnerByEntity = new Map<string, Suggestion>();
  for (const winner of winners.values()) {
    const entityKey = suggestionEntityKey(winner);
    if (entityKey) winnerByEntity.set(entityKey, winner);
  }

  for (const [txId, list] of suggestionsByTx.entries()) {
    const txWinner = winners.get(txId);
    adjusted.set(txId, list.map((s) => {
      if (s.suggestion_data?.level === "cumulative") return s;

      const entityKey = suggestionEntityKey(s);
      const entityWinner = entityKey ? winnerByEntity.get(entityKey) : null;
      const isWinner = txWinner
        && suggestionEntityKey(txWinner) === entityKey
        && txWinner.invoice_id === s.invoice_id
        && txWinner.installment_id === s.installment_id;

      const extra = { ...(s.suggestion_data || {}) } as Record<string, unknown>;
      const reasonParts: string[] = [];
      let delta = 0;

      if (isWinner) {
        delta += 3;
        extra.global_assignment_rank = 1;
        extra.global_winner = true;
      } else {
        if (entityWinner && entityWinner.bank_transaction_id !== s.bank_transaction_id) {
          const diff = entityWinner.match_score - s.match_score;
          const penalty = Math.max(6, Math.min(18, 8 + Math.round(Math.max(0, diff) / 2)));
          delta -= penalty;
          reasonParts.push("declassato: rata contesa da altro movimento migliore");
          extra.global_competition_penalty = Math.abs(Number(extra.global_competition_penalty || 0)) + penalty;
          extra.contested_by_tx = entityWinner.bank_transaction_id;
        }
        if (txWinner && suggestionEntityKey(txWinner) !== entityKey) {
          const diff = txWinner.match_score - s.match_score;
          const penalty = Math.max(4, Math.min(12, 4 + Math.round(Math.max(0, diff) / 3)));
          delta -= penalty;
          reasonParts.push("declassato: il movimento ha un match migliore");
          extra.global_tx_penalty = Math.abs(Number(extra.global_tx_penalty || 0)) + penalty;
        }
      }

      return {
        ...s,
        match_score: Math.max(0, Math.min(98, s.match_score + delta)),
        match_reason: reasonParts.length > 0 ? `${s.match_reason} — ${reasonParts.join(" · ")}` : s.match_reason,
        suggestion_data: extra,
      };
    }).sort((a, b) => b.match_score - a.match_score));
  }

  return adjusted;
}

/* ─── main generator per transaction ──── */

async function generateForTransaction(
  sql: SqlClient,
  companyId: string,
  tx: TxRow,
): Promise<Suggestion[]> {
  const netAmount = getTxNetAmount(tx);
  const remainingAmount = netAmount - Number(tx.reconciled_amount || 0);
  if (remainingAmount < 0.01) return [];

  // ── Normalize refs from the inconsistent AI extraction schemas ──
  let invoiceRefs = extractInvoiceRefs(tx.extracted_refs);
  const mandateId = extractMandateId(tx.extracted_refs);

  // ── Fallback: parse raw_text if no refs were extracted ──
  if (invoiceRefs.length === 0) {
    invoiceRefs = parseRawTextForRefs(tx.raw_text);
  }

  const collected: Suggestion[] = [];

  // ── Level 1: Match by invoice refs (highest priority, score 75-98) ──
  if (invoiceRefs.length > 0) {
    collected.push(...await matchByInvoiceRefs(
      sql, companyId, tx, invoiceRefs, remainingAmount,
    ));
  }

  // ── Level 1.5: Match by learned rules (Miglioria 3, score 70-90) ──
  collected.push(...await matchByRules(sql, companyId, tx, remainingAmount));

  // ── Level 2: Match by mandate SDD (score 85) ──
  if (mandateId) {
    collected.push(...await matchByMandate(
      sql, companyId, tx, mandateId, remainingAmount,
    ));
  }

  // ── Level 3: Fallback — counterparty + amount (score 50-85) ──
  collected.push(...await matchByCounterpartyAmount(
    sql, companyId, tx, remainingAmount,
  ));
  let results = dedup(collected, 12);

  // ── Level 3.5: Cumulative payments (Miglioria 1) ──
  if (results.length === 0 && !invoiceRefs.length && !mandateId) {
    const cumulative = await matchCumulativePayment(sql, companyId, tx, remainingAmount);
    if (cumulative.length > 0) {
      results = cumulative;
    }
  }

  // ── RAG boost: boost ambiguous suggestions with confirmed examples ──
  const geminiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
  if (geminiKey && results.length > 0) {
    results = await ragBoostSuggestions(sql, companyId, tx, results, geminiKey);
  }

  // ── Miglioria 4: filter previously rejected pairs ──
  return filterRejected(sql, companyId, results);
}

/* ─── Miglioria 4: Filter previously rejected pairs ─── */

async function filterRejected(
  sql: SqlClient,
  companyId: string,
  suggestions: Suggestion[],
): Promise<Suggestion[]> {
  if (suggestions.length === 0) return [];

  const filtered: Suggestion[] = [];
  for (const s of suggestions) {
    if (!s.invoice_id) {
      filtered.push(s);
      continue;
    }

    const [{ cnt }] = await sql.unsafe(
      `SELECT count(*)::int as cnt
       FROM reconciliation_log
       WHERE company_id = $1
         AND bank_transaction_id = $2
         AND invoice_id = $3
         AND accepted = false`,
      [companyId, s.bank_transaction_id, s.invoice_id],
    );

    if (cnt === 0) {
      filtered.push(s);
    }
  }
  return filtered;
}

/* ─── main handler ────────────────────── */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  const dbUrl = (Deno.env.get("SUPABASE_DB_URL") ?? "").trim();
  if (!dbUrl) return json({ error: "SUPABASE_DB_URL non configurato" }, 503);

  let body: { company_id?: string; batch_size?: number };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body JSON non valido" }, 400);
  }

  const companyId = body.company_id;
  if (!companyId) return json({ error: "company_id richiesto" }, 400);

  const batchSize = Math.min(Math.max(body.batch_size ?? 50, 1), MAX_BATCH);
  const sql = postgres(dbUrl, { max: 1 });

  try {
    const geminiKey = (Deno.env.get("GEMINI_API_KEY") || "").trim();
    const rows: TxRow[] = await sql`
      SELECT id, date, amount, counterparty_name, transaction_type,
             description, extracted_refs, raw_text, notes, direction, reconciled_amount, commission_amount
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status IN ('unmatched', 'partial')
        AND abs(amount) - reconciled_amount > 0.01
        AND id NOT IN (
          SELECT DISTINCT bank_transaction_id
          FROM reconciliation_suggestions
          WHERE company_id = ${companyId} AND status = 'pending'
        )
      ORDER BY
        CASE WHEN extraction_status = 'ready' THEN 0 ELSE 1 END,
        date DESC
      LIMIT ${batchSize}
    `;

    let totalSuggestions = 0;
    let txProcessed = 0;
    const suggestionsByTx = new Map<string, Suggestion[]>();

    for (const tx of rows) {
      const suggestions = await generateForTransaction(sql, companyId, tx);
      suggestionsByTx.set(tx.id, suggestions);
    }

    const globallyRanked = applyGlobalCompetition(suggestionsByTx);

    for (const tx of rows) {
      let suggestions = globallyRanked.get(tx.id) || [];
      if (geminiKey && suggestions.length > 1) {
        suggestions = await maybePremiumRerank(tx, suggestions, geminiKey);
      }
      suggestions = smartRank(suggestions);
      for (const s of suggestions) {
        if (s.match_score < 50) continue;

        await sql`
          INSERT INTO reconciliation_suggestions
            (company_id, bank_transaction_id, installment_id, invoice_id,
             match_score, match_reason, proposed_by, rule_id, suggestion_data)
          VALUES
            (${companyId}, ${s.bank_transaction_id}, ${s.installment_id}, ${s.invoice_id},
             ${s.match_score}, ${s.match_reason}, ${s.proposed_by}, ${s.rule_id},
             ${s.suggestion_data ? JSON.stringify(s.suggestion_data) : null}::jsonb)
        `;
        totalSuggestions++;
      }
      txProcessed++;
    }

    const [{ pending_count }] = await sql`
      SELECT count(*)::int as pending_count
      FROM reconciliation_suggestions
      WHERE company_id = ${companyId} AND status = 'pending'
    `;

    const [{ unmatched_count }] = await sql`
      SELECT count(*)::int as unmatched_count
      FROM bank_transactions
      WHERE company_id = ${companyId}
        AND reconciliation_status IN ('unmatched', 'partial')
    `;

    const [{ matched_count }] = await sql`
      SELECT count(*)::int as matched_count
      FROM bank_transactions
      WHERE company_id = ${companyId} AND reconciliation_status = 'matched'
    `;

    return json({
      processed: txProcessed,
      new_suggestions: totalSuggestions,
      totals: {
        pending_suggestions: pending_count,
        unmatched_transactions: unmatched_count,
        matched_transactions: matched_count,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reconciliation-generate] Error:", msg);
    return json({ error: msg }, 500);
  } finally {
    await sql.end();
  }
});
