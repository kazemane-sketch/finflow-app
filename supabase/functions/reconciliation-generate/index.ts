import postgres from "npm:postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BATCH = 100;

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
  transaction_type: string | null;
  extracted_refs: Record<string, unknown> | null;
  raw_text: string | null;
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

    const query = `
      SELECT i.id as invoice_id, i.number, i.total_amount, i.date,
             i.counterparty->>'denom' as counterparty_name,
             ii.id as installment_id, ii.amount_due, ii.paid_amount, ii.due_date, ii.status
      FROM invoices i
      LEFT JOIN invoice_installments ii
        ON ii.invoice_id = i.id AND ii.status IN ('pending','overdue','partial')
      WHERE i.company_id = $1
        AND i.direction = $2
        AND (${matchClauses.join(" OR ")})
        ${yearClause}
      ORDER BY i.date DESC
      LIMIT 20`;

    const matches = await sql.unsafe(query, params);

    // RULE 2: Post-filter by counterparty (when TX has counterparty info)
    const filteredMatches = matches.filter((m: Record<string, unknown>) =>
      counterpartyMatches(tx.counterparty_name, m.counterparty_name as string | null)
    );

    for (const m of filteredMatches) {
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
      let reason = `Rif. fattura "${ref}" → Fatt. ${m.number} (${m.counterparty_name})`;

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

      suggestions.push({
        bank_transaction_id: tx.id,
        installment_id: (m.installment_id as string) || null,
        invoice_id: m.invoice_id as string,
        match_score: score,
        match_reason: reason,
        proposed_by: "deterministic",
        rule_id: null,
        suggestion_data: {
          ref,
          amount_diff: amountDiff,
          level: "invoice_ref",
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
            ii.amount_due, ii.paid_amount,
            inv.number as invoice_number,
            inv.counterparty->>'denom' as counterparty_name
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND inv.direction = $2
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $4 * 0.85 AND $4 * 1.15
     ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $4) ASC
     LIMIT 5`,
    [companyId, expectedDirection, cpWord, remainingAmount],
  );

  for (const m of openInst) {
    const instRemaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: 85,
      match_reason: `Mandato SDD "${mandateId}" → ${cpName} + importo simile`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        mandate_id: mandateId,
        counterparty: cpName,
        amount_diff: amountDiff,
        level: "mandate",
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

  const cpMatches = await sql.unsafe(
    `SELECT ii.id as installment_id, ii.invoice_id, ii.due_date,
            ii.amount_due, ii.paid_amount, ii.status,
            inv.number as invoice_number,
            inv.counterparty->>'denom' as counterparty_name
     FROM invoice_installments ii
     JOIN invoices inv ON inv.id = ii.invoice_id
     WHERE ii.company_id = $1
       AND inv.direction = $2
       AND ii.status IN ('pending','overdue','partial')
       AND inv.counterparty->>'denom' ILIKE '%' || $3 || '%'
       AND abs(ii.amount_due - ii.paid_amount) BETWEEN $4 * 0.90 AND $4 * 1.10
     ORDER BY abs(abs(ii.amount_due - ii.paid_amount) - $4) ASC
     LIMIT 5`,
    [companyId, expectedDirection, cpWord, remainingAmount],
  );

  for (const m of cpMatches) {
    const instRemaining = Math.abs(Number(m.amount_due) - Number(m.paid_amount));
    if (instRemaining < 0.01) continue;
    const amountDiff = Math.abs(remainingAmount - instRemaining);
    const amountRatio = remainingAmount > 0 ? amountDiff / remainingAmount : 1;
    const daysDiff = tx.date && m.due_date
      ? Math.abs(
          (new Date(tx.date).getTime() - new Date(m.due_date).getTime()) / 86400000,
        )
      : 999;

    let score = 65;
    if (amountRatio < 0.05 && daysDiff < 30) score = 85;
    else if (amountRatio < 0.05 && daysDiff < 60) score = 80;
    else if (amountRatio < 0.10 && daysDiff < 30) score = 75;
    else if (amountRatio < 0.10) score = 70;

    suggestions.push({
      bank_transaction_id: tx.id,
      installment_id: m.installment_id,
      invoice_id: m.invoice_id,
      match_score: score,
      match_reason: `Controparte "${m.counterparty_name}" + importo simile (diff €${amountDiff.toFixed(2)})${daysDiff < 30 ? " + data vicina" : ""}`,
      proposed_by: "deterministic",
      rule_id: null,
      suggestion_data: {
        counterparty: m.counterparty_name,
        amount_diff: amountDiff,
        days_diff: daysDiff,
        level: "counterparty",
      },
    });
  }

  return suggestions;
}

/* ─── dedup helper ────────────────────── */

function dedup(suggestions: Suggestion[], maxResults: number): Suggestion[] {
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const key = `${s.installment_id || ""}:${s.invoice_id || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.match_score - a.match_score)
    .slice(0, maxResults);
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

  // ── Level 1: Match by invoice refs (highest priority, score 75-98) ──
  if (invoiceRefs.length > 0) {
    const refMatches = await matchByInvoiceRefs(
      sql, companyId, tx, invoiceRefs, remainingAmount,
    );
    if (refMatches.length > 0) {
      return dedup(refMatches, 20);
    }
  }

  // ── Level 2: Match by mandate SDD (score 85) ──
  if (mandateId) {
    const mandateMatches = await matchByMandate(
      sql, companyId, tx, mandateId, remainingAmount,
    );
    if (mandateMatches.length > 0) {
      return dedup(mandateMatches, 5);
    }
  }

  // ── Level 3: Fallback — counterparty + amount (score 65-85) ──
  const fallback = await matchByCounterpartyAmount(
    sql, companyId, tx, remainingAmount,
  );
  return dedup(fallback, 5);
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
    const rows: TxRow[] = await sql`
      SELECT id, date, amount, counterparty_name, transaction_type,
             extracted_refs, raw_text, direction, reconciled_amount, commission_amount
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

    for (const tx of rows) {
      const suggestions = await generateForTransaction(sql, companyId, tx);

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
